import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Container, HStack, ScrollView, type Component, type ScrollViewScrollbar, type StackEntry, type TUI } from "@earendil-works/pi-tui";
import { History } from "./history.ts";
import { nearestAnchor, type Anchor, type Snapshot } from "./model.ts";

const MINIMAP_RATIO = 0.06;
interface HostInternals { getMountedRoots?: () => readonly Component[]; requestImmediateRender?: () => void }
interface StackInternals { entries?: StackEntry[]; children?: Component[] }
function internals(component: Component): StackInternals {
  // SAFETY: These optional Pi layout fields are validated before mutation, and restored by identity.
  return component as unknown as StackInternals;
}
function roots(tui: TUI): readonly Component[] {
  // SAFETY: The private getter is capability-checked; unsupported hosts never have their layout changed.
  const host = tui as unknown as HostInternals;
  return host.getMountedRoots?.() ?? [];
}

interface Mount { parent: StackInternals; entry: StackEntry; scroll: ScrollView; document: Container; chat: Container }
function findMount(tui: TUI): Mount {
  if (tui.mode !== "fullscreen") throw new Error("Visible scrollbar requires Pi fullscreen mode.");
  const candidates: Mount[] = [];
  const seen = new Set<Component>();
  function visit(component: Component): void {
    if (seen.has(component)) return;
    seen.add(component);
    const parent = internals(component);
    if (!Array.isArray(parent.entries) || !Array.isArray(parent.children)) return;
    for (const entry of parent.entries) {
      const child = entry.component;
      if (child instanceof ScrollView && child.primary) {
        const document = child.children[0];
        // Pi 1.5.2's document is [header, loaded resources, chat]. Never guess another slot.
        if (child.children.length !== 1 || document?.constructor !== Container ||
            (document as Container).children.length !== 3 || (document as Container).children[2]?.constructor !== Container) {
          throw new Error("Unsupported Pi transcript layout; the original scrollbar was left unchanged.");
        }
        candidates.push({ parent, entry, scroll: child, document: document as Container, chat: (document as Container).children[2] as Container });
      } else visit(child);
    }
  }
  for (const root of roots(tui)) visit(root);
  if (candidates.length !== 1) throw new Error("Cannot identify one native transcript ScrollView; the original layout was left unchanged.");
  return candidates[0];
}

export class Viewport {
  readonly history: History;
  failure = "";
  private mount: Mount;
  private replacement?: HStack;
  private scrollbar: ScrollViewScrollbar;
  private originalUpdate: ScrollView["updateLayout"];
  private wrappedUpdate: ScrollView["updateLayout"];
  private hadOwnUpdate: boolean;
  private originalScrollTo: ScrollView["scrollTo"];
  private restoreNavigation: (() => void)[] = [];
  private previousAnchors: Anchor[] = [];
  private previousTop = -1;
  private previousHeight = -1;
  private pendingId?: string;
  private preparationBookmark?: { id: string; offset: number };
  private disposed = false;

  constructor(readonly tui: TUI, ctx: ExtensionContext, getHideThinkingBlock: () => boolean = () => false) {
    this.mount = findMount(tui);
    const { scroll, document, chat } = this.mount;
    this.scrollbar = scroll.scrollbar;
    this.history = new History(document, chat, ctx, tui, error => {
      this.failure = error instanceof Error ? error.message : String(error);
      this.dispose();
    }, getHideThinkingBlock);
    this.originalScrollTo = scroll.scrollTo.bind(scroll);
    // Native input is consumed before extension listeners; cancel at the shared navigation methods,
    // including no-op Ctrl+End. Internal layout restoration uses the saved scrollTo instead.
    const navigation = <Args extends unknown[], Result>(original: (...args: Args) => Result) => (...args: Args): Result => {
      this.pendingId = undefined;
      this.preparationBookmark = undefined;
      return original.apply(scroll, args);
    };
    const wrappedNavigation = {
      scrollTo: navigation(scroll.scrollTo),
      scrollBy: navigation(scroll.scrollBy),
      scrollToStart: navigation(scroll.scrollToStart),
      scrollToEnd: navigation(scroll.scrollToEnd),
    };
    for (const key of ["scrollTo", "scrollBy", "scrollToStart", "scrollToEnd"] as const) {
      const original = Object.getOwnPropertyDescriptor(scroll, key);
      this.restoreNavigation.push(() => {
        if (scroll[key] !== wrappedNavigation[key]) return;
        if (original) Object.defineProperty(scroll, key, original);
        else delete (scroll as Partial<ScrollView>)[key];
      });
    }
    Object.assign(scroll, wrappedNavigation);
    this.originalUpdate = scroll.updateLayout;
    this.hadOwnUpdate = Object.hasOwn(scroll, "updateLayout");
    this.wrappedUpdate = (total, height, requestRender) => {
      const before = scroll.scrollTop;
      const following = scroll.isFollowingEnd;
      if (this.preparationBookmark && (before !== this.previousTop || following)) this.preparationBookmark = undefined;
      if (this.history.isPending && !following && !this.pendingId && !this.preparationBookmark) {
        const anchor = nearestAnchor(this.previousAnchors, before);
        if (anchor) this.preparationBookmark = { id: anchor.id, offset: before - anchor.row };
      }
      const previous = !following && before === this.previousTop && this.history.anchors !== this.previousAnchors
        ? nearestAnchor(this.previousAnchors, before) : undefined;
      this.originalUpdate.call(scroll, total, height, requestRender);
      if (!this.history.isPending && this.pendingId && !this.history.hasPrompt(this.pendingId)) this.pendingId = undefined;
      const target = !this.history.isPending && this.pendingId ? this.history.anchor(this.pendingId) : undefined;
      if (target) {
        this.originalScrollTo(target.row, { disableFollow: true });
        this.pendingId = undefined;
        this.preparationBookmark = undefined;
      } else if (this.preparationBookmark) {
        if (this.history.isPending) this.originalScrollTo(before, { disableFollow: true });
        else {
          const anchor = this.history.anchor(this.preparationBookmark.id);
          if (anchor) this.originalScrollTo(anchor.row + this.preparationBookmark.offset, { disableFollow: true });
          this.preparationBookmark = undefined;
        }
      } else if (!following && before === this.previousTop && previous) {
        const moved = this.history.anchor(previous.id);
        if (moved) this.originalScrollTo(moved.row + before - previous.row, { disableFollow: true });
      }
      this.previousTop = scroll.scrollTop;
      this.previousAnchors = this.history.anchors;
      // HStack measures the gutter before allocating the final viewport height.
      if (this.previousHeight !== height) { this.previousHeight = height; requestRender(); }
    };
    scroll.updateLayout = this.wrappedUpdate;
    scroll.setScrollbar("hidden");
  }

  setGutter(component: Component, width: number, proportional = false): void {
    const { parent, entry, scroll } = this.mount;
    const previous = this.replacement ?? scroll;
    let gutter: StackEntry | undefined;
    // Pi 1.5.2 distributes grow weights sequentially, not proportionally. Measure this slot once
    // before allocation; body + map + fixed markers = available, with map = body * 6%.
    const measure: Component = {
      render(available) { if (gutter) gutter.basis = width + Math.round(Math.max(0, available - width) * MINIMAP_RATIO / (1 + MINIMAP_RATIO)); return []; },
      invalidate() {},
    };
    const replacement = new HStack([
      { component: scroll, basis: 0, grow: 1, minSize: 1 },
      ...(proportional ? [{ component: measure, basis: "auto" as const, minSize: 0, maxSize: 0, shrink: 0 }] : []),
      { component, basis: width, minSize: width, ...(proportional ? {} : { maxSize: width }), shrink: 0 },
    ]);
    gutter = internals(replacement).entries!.at(-1);
    if (entry.component !== previous) throw new Error("Another extension replaced the transcript slot.");
    const index = parent.children!.indexOf(previous);
    if (index < 0) throw new Error("The transcript layout changed.");
    entry.component = replacement;
    parent.children![index] = replacement;
    this.replacement = replacement;
    this.tui.requestRender();
  }

  get mounted(): boolean {
    return !this.disposed && this.tui.mode === "fullscreen" && this.mount.entry.component === this.replacement &&
      roots(this.tui).some(root => contains(root, this.replacement!));
  }

  snapshot(): Snapshot {
    const { scroll } = this.mount;
    // Remember later settings changes, but keep only our custom scrollbar visible while mounted.
    if (!this.disposed && scroll.scrollbar !== "hidden") { this.scrollbar = scroll.scrollbar; scroll.setScrollbar("hidden"); }
    return { anchors: this.history.anchors, lines: this.history.lines, width: this.history.width,
      height: scroll.viewportHeight, top: scroll.scrollTop, contentHeight: this.history.lines.length, preparing: this.history.isPending,
      lineChange: this.history.lineChange };
  }

  jump(id: string): boolean {
    if (!this.mounted || !this.history.hasPrompt(id)) return false;
    this.preparationBookmark = undefined;
    this.pendingId = id;
    const anchor = this.history.anchor(id);
    if (anchor) {
      this.originalScrollTo(anchor.row, { disableFollow: true });
      if (!this.history.isPending) this.pendingId = undefined;
    }
    this.tui.requestRender();
    return true;
  }

  scrollTo(row: number, immediate = false): void {
    const scroll = this.mount.scroll, before = scroll.scrollTop, following = scroll.isFollowingEnd;
    scroll.scrollTo(row);
    if (scroll.scrollTop === before && scroll.isFollowingEnd === following) return;
    // Use Pi's keyboard-input fast path for dragging, without forcing a full-screen/image clear.
    // SAFETY: Pi 1.5.2's optional fast path is checked before calling; other hosts use requestRender.
    const host = this.tui as unknown as HostInternals;
    if (immediate && typeof host.requestImmediateRender === "function") host.requestImmediateRender();
    else this.tui.requestRender();
  }
  scrollBy(delta: number): void { this.mount.scroll.scrollBy(delta); this.tui.requestRender(); }
  end(): void { this.mount.scroll.scrollToEnd(); this.tui.requestRender(); }
  refresh(): void { this.history.invalidate(); this.tui.requestRender(); }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const { scroll, entry, parent } = this.mount;
    this.history.dispose();
    for (const restore of this.restoreNavigation.splice(0)) restore();
    if (scroll.updateLayout === this.wrappedUpdate) {
      if (this.hadOwnUpdate) scroll.updateLayout = this.originalUpdate;
      else delete (scroll as Partial<ScrollView>).updateLayout;
    }
    if (scroll.scrollbar === "hidden") scroll.setScrollbar(this.scrollbar);
    if (entry.component === this.replacement) entry.component = scroll;
    const index = parent.children?.indexOf(this.replacement!);
    if (index !== undefined && index >= 0) parent.children![index] = scroll;
    this.tui.requestRender();
  }
}

function contains(root: Component, target: Component): boolean {
  const seen = new Set<Component>();
  function visit(component: Component): boolean {
    if (component === target) return true;
    if (seen.has(component)) return false;
    seen.add(component);
    return internals(component).children?.some(visit) ?? false;
  }
  return visit(root);
}
