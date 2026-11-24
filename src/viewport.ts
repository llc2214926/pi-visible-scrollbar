import { VERSION, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Container, ScrollView, compositeTuiLine, sliceByColumn, type Component, type ScrollViewScrollbar, type StackEntry, type TUI } from "@earendil-works/pi-tui";
import { History } from "./history.ts";
import { nearestAnchor, type Anchor, type Snapshot } from "./model.ts";

const MINIMAP_RATIO = 0.06;
interface Rect { x: number; y: number; width: number; height: number }
interface LayoutBox { component: Component; rect: Rect; clip: Rect; children: LayoutBox[]; parent?: LayoutBox; scrollView?: ScrollView; layer?: number }
interface HostInternals {
  getMountedRoots?: () => readonly Component[];
  routeWheel?: (pointer: { x: number; y: number }, delta: number) => void;
  doRender?: () => void;
  compositeScrollToEndIndicator?: (screen: string[], layout: { root: LayoutBox }, width: number) => string[];
  resetTextSelection?: () => void;
}
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

interface Mount { entry: StackEntry; scroll: ScrollView; document: Container; chat: Container }
function findMount(tui: TUI): Mount {
  if (VERSION !== "1.6.0") throw new Error("Visible scrollbar requires Pi 1.6.0; the native layout was left unchanged.");
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
        // Pi 1.6.0's document is [header, loaded resources, chat]. Never guess another slot.
        if (child.children.length !== 1 || document?.constructor !== Container ||
            (document as Container).children.length !== 3 || (document as Container).children[2]?.constructor !== Container) {
          throw new Error("Unsupported Pi transcript layout; the original scrollbar was left unchanged.");
        }
        candidates.push({ entry, scroll: child, document: document as Container, chat: (document as Container).children[2] as Container });
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
  private gutter?: { component: Component; width: number; proportional: boolean };
  private restoreHost: (() => void)[] = [];
  private scrollbar: ScrollViewScrollbar;
  private originalUpdate: ScrollView["updateLayout"];
  private wrappedUpdate: ScrollView["updateLayout"];
  private hadOwnUpdate: boolean;
  private originalScrollTo: ScrollView["scrollTo"];
  private originalScrollToEnd: ScrollView["scrollToEnd"];
  private restoreNavigation: (() => void)[] = [];
  private previousAnchors: Anchor[] = [];
  private previousTop = -1;
  private navigationVersion = 0;
  private pendingPageTop = false;
  private nativePosition?: { top: number; following: boolean; height: number; anchors: Anchor[] };
  private preparationBookmark?: { id: string; offset: number };
  private disposed = false;

  constructor(readonly tui: TUI, private ctx: ExtensionContext, getHideThinkingBlock: () => boolean = () => false, getOutputPad: () => number = () => 1) {
    this.mount = findMount(tui);
    const { scroll, document, chat } = this.mount;
    this.scrollbar = scroll.scrollbar;
    const host = tui.valueOf() as HostInternals;
    if (typeof host.doRender !== "function" || typeof host.compositeScrollToEndIndicator !== "function") {
      throw new Error("Pi 1.6.0 transcript compositor is unavailable; the native layout was left unchanged.");
    }
    this.originalScrollTo = scroll.scrollTo.bind(scroll);
    this.originalScrollToEnd = scroll.scrollToEnd.bind(scroll);
    this.history = new History(document, chat, ctx, tui, error => this.disable(error), getHideThinkingBlock,
      mode => this.changeView(mode), () => scroll.scrollTop, getOutputPad);
    // Native input is consumed before extension listeners. Cancel superseded jumps here,
    // including no-op Ctrl+End; internal layout restoration uses the saved methods instead.
    const navigation = <Args extends unknown[], Result>(original: (...args: Args) => Result) => (...args: Args): Result => {
      this.navigationVersion++;
      this.history.cancelNavigation();
      this.preparationBookmark = undefined;
      return original.apply(scroll, args);
    };
    const wrappedNavigation = {
      scrollTo: navigation(scroll.scrollTo),
      scrollBy: navigation(scroll.scrollBy),
      scrollToStart: navigation(scroll.scrollToStart),
      scrollToEnd: navigation(() => { this.history.closePage(); return this.originalScrollToEnd(); }),
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
      if (this.history.isPending && !following && !this.pendingPageTop && !this.preparationBookmark) {
        const anchor = nearestAnchor(this.previousAnchors, before);
        if (anchor) this.preparationBookmark = { id: anchor.id, offset: before - anchor.row };
      }
      const previous = !following && before === this.previousTop && this.history.anchors !== this.previousAnchors
        ? nearestAnchor(this.previousAnchors, before) : undefined;
      this.originalUpdate.call(scroll, total, height, requestRender);
      if (this.pendingPageTop && this.history.inPage) {
        this.originalScrollTo(this.history.pageOffset, { disableFollow: true });
        this.pendingPageTop = false;
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
    };
    scroll.updateLayout = this.wrappedUpdate;
    const originalWidth = scroll.getContentWidth;
    const ownWidth = Object.getOwnPropertyDescriptor(scroll, "getContentWidth");
    const contentWidth = (available: number) => {
      if (this.disposed || !this.gutter) return originalWidth.call(scroll, available);
      const width = this.gutter.width;
      const reserve = width + (this.gutter.proportional ? Math.round(Math.max(0, available - width) * MINIMAP_RATIO / (1 + MINIMAP_RATIO)) : 0);
      return Math.max(1, available - reserve);
    };
    scroll.getContentWidth = contentWidth;
    this.restoreHost.push(() => {
      if (scroll.getContentWidth !== contentWidth) return;
      if (ownWidth) Object.defineProperty(scroll, "getContentWidth", ownWidth);
      else delete (scroll as Partial<ScrollView>).getContentWidth;
    });
    const originalComposite = host.compositeScrollToEndIndicator;
    const ownComposite = Object.getOwnPropertyDescriptor(host, "compositeScrollToEndIndicator");
    const composite = (screen: string[], layout: { root: LayoutBox }, width: number) => {
      if (!this.disposed) {
        try { this.paintGutter(screen, layout.root, width); }
        catch (error) { this.disable(error); }
      }
      return originalComposite.call(host, screen, layout, width);
    };
    host.compositeScrollToEndIndicator = composite;
    this.restoreHost.push(() => {
      if (host.compositeScrollToEndIndicator !== composite) return;
      if (ownComposite) Object.defineProperty(host, "compositeScrollToEndIndicator", ownComposite);
      else delete host.compositeScrollToEndIndicator;
    });
    const originalRender = host.doRender;
    const ownRender = Object.getOwnPropertyDescriptor(host, "doRender");
    const render = () => {
      if (this.disposed) { originalRender.call(host); return; }
      this.history.beginFrame();
      try { originalRender.call(host); }
      finally { this.history.endFrame(); }
    };
    host.doRender = render;
    this.restoreHost.push(() => {
      if (host.doRender !== render) return;
      if (ownRender) Object.defineProperty(host, "doRender", ownRender);
      else delete host.doRender;
    });
    scroll.setScrollbar("always");
  }

  private changeView(mode: "page" | "live" | "end"): void {
    const { scroll } = this.mount;
    if (mode === "page") {
      this.nativePosition ??= { top: scroll.scrollTop, following: scroll.isFollowingEnd, height: this.history.nativeHeight, anchors: this.previousAnchors };
      this.pendingPageTop = true;
      this.preparationBookmark = undefined; this.previousAnchors = [];
      this.originalScrollTo(0, { disableFollow: true });
    } else if (mode === "end") this.originalScrollToEnd();
    else {
      const position = this.nativePosition;
      this.nativePosition = undefined; this.pendingPageTop = false; this.preparationBookmark = undefined;
      if (position) {
        // Restore against the last native extent, not the short page's clamped scroll range.
        this.originalUpdate.call(scroll, this.history.nativeHeight || position.height, scroll.viewportHeight, () => this.tui.requestRender());
        if (position.following) this.originalScrollToEnd();
        else this.originalScrollTo(position.top, { disableFollow: true });
        this.previousAnchors = position.anchors; this.previousTop = scroll.scrollTop;
      }
    }
    const host = this.tui.valueOf() as HostInternals;
    host.resetTextSelection?.();
  }

  private disable(error: unknown): void {
    this.failure = error instanceof Error ? error.message : String(error);
    this.dispose();
  }

  setGutter(component: Component, width: number, proportional = false): void {
    if (this.mount.entry.component !== this.mount.scroll) throw new Error("Another extension replaced the transcript slot.");
    this.gutter = { component, width, proportional };
    this.tui.requestRender();
  }

  private paintGutter(screen: string[], root: LayoutBox, width: number): void {
    const gutter = this.gutter;
    if (!gutter) return;
    const find = (box: LayoutBox): LayoutBox | undefined => box.scrollView === this.mount.scroll ? box : box.children.map(find).find(Boolean);
    const scroll = find(root);
    if (!scroll || !scroll.children.length) return;
    const body = scroll.children[0].rect.width;
    const rect = { x: scroll.rect.x + body, y: scroll.rect.y, width: Math.max(0, scroll.rect.width - body), height: scroll.rect.height };
    if (rect.width < 2 || rect.height < 1) return;
    const clip = {
      x: Math.max(rect.x, scroll.clip.x), y: Math.max(rect.y, scroll.clip.y),
      width: Math.max(0, Math.min(rect.x + rect.width, scroll.clip.x + scroll.clip.width) - Math.max(rect.x, scroll.clip.x)),
      height: Math.max(0, Math.min(rect.y + rect.height, scroll.clip.y + scroll.clip.height) - Math.max(rect.y, scroll.clip.y)),
    };
    // Add only gutter hit geometry; the native document remains the first child and is never measured again.
    scroll.children.push({ component: gutter.component, rect, clip, children: [], parent: scroll, layer: scroll.layer });
    const lines = gutter.component.render(rect.width);
    const first = Math.max(rect.y, clip.y, 0), end = Math.min(rect.y + rect.height, clip.y + clip.height, screen.length);
    for (let row = first; row < end; row++) {
      // The final column is painted and captured by Pi's native scrollbar, not by the extension.
      const line = sliceByColumn(lines[row - rect.y] ?? "", 0, rect.width - 1, true);
      screen[row] = compositeTuiLine(screen[row] ?? "", line, rect.x, rect.width - 1, width);
    }
  }

  get mounted(): boolean {
    return !this.disposed && !!this.gutter && this.tui.mode === "fullscreen" && this.mount.entry.component === this.mount.scroll &&
      roots(this.tui).some(root => contains(root, this.mount.scroll));
  }

  snapshot(): Snapshot {
    const { scroll } = this.mount;
    // Keep the native scrollbar visible and remember settings changes for cleanup.
    if (!this.disposed && scroll.scrollbar !== "always") { this.scrollbar = scroll.scrollbar; scroll.setScrollbar("always"); }
    return { anchors: this.history.anchors, lines: this.history.lines, width: this.history.width,
      height: scroll.viewportHeight, top: scroll.scrollTop, contentHeight: this.history.lines.length,
      preparing: this.history.isFramePending,
      lineChange: this.history.lineChange };
  }

  async jump(id: string): Promise<boolean> {
    if (!this.mounted) return false;
    const version = ++this.navigationVersion;
    this.history.cancelNavigation(true); this.preparationBookmark = undefined;
    try { await this.history.ready(); } catch { return false; }
    if (!this.mounted || version !== this.navigationVersion) return false;
    const anchor = this.history.anchor(id), start = this.history.currentPage?.start;
    if (anchor && !(start?.id === id && start.line > 0)) {
      this.originalScrollTo(anchor.row, { disableFollow: true }); return true;
    }
    return this.history.open(id);
  }

  async step(direction: -1 | 1): Promise<boolean> {
    if (!this.mounted) return false;
    const version = ++this.navigationVersion;
    this.history.cancelNavigation(true);
    try {
      await this.history.ready();
      if (!this.mounted || version !== this.navigationVersion) return false;
      if (!this.history.inPage && this.history.isPending) {
        this.ctx.ui.notify?.("Input positions are loading in background; /scrollbar list is available.");
        return false;
      }
      const snapshot = this.snapshot(), anchor = nearestAnchor(snapshot.anchors, snapshot.top), page = this.history.currentPage;
      let rank: number;
      if (anchor) {
        rank = this.history.promptRank(anchor.id);
        if (direction > 0 && anchor.row <= snapshot.top) rank++;
        if (direction < 0 && anchor.row >= snapshot.top) rank--;
      } else if (page?.current) rank = page.current.rank + (direction > 0 ? 1 : 0);
      else return false;
      const target = await this.history.prompt({ rank });
      return target && this.mounted && version === this.navigationVersion ? this.jump(target.id) : false;
    } catch { return false; }
  }

  // ScrollView already requests Pi's view-only frame; do not invalidate unchanged native text.
  scrollTo(row: number): void { this.mount.scroll.scrollTo(row); }
  scrollBy(delta: number, pointer?: { x: number; y: number }): void {
    const host = this.tui.valueOf() as HostInternals;
    if (pointer && typeof host.routeWheel === "function") host.routeWheel(pointer, delta);
    else this.mount.scroll.scrollBy(delta);
  }
  end(): void { this.mount.scroll.scrollToEnd(); }
  refresh(reset = false): void { if (reset) this.navigationVersion++; this.history.invalidate(reset); this.tui.requestRender(); }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const gutter: (Component & { dispose?: () => void }) | undefined = this.gutter?.component;
    // Dispose the outer image hook before restoring this viewport's inner frame hook.
    if (typeof gutter?.dispose === "function") gutter.dispose();
    const { scroll } = this.mount;
    this.history.dispose();
    for (const restore of this.restoreNavigation.splice(0)) restore();
    for (const restore of this.restoreHost.splice(0).reverse()) restore();
    if (scroll.updateLayout === this.wrappedUpdate) {
      if (this.hadOwnUpdate) scroll.updateLayout = this.originalUpdate;
      else delete (scroll as Partial<ScrollView>).updateLayout;
    }
    if (scroll.scrollbar === "always") scroll.setScrollbar(this.scrollbar);
    this.gutter = undefined;
    this.previousAnchors = []; this.nativePosition = undefined; this.pendingPageTop = false; this.preparationBookmark = undefined;
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
