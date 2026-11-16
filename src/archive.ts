import * as host from "@earendil-works/pi-coding-agent";
import { Container, type Component, type TuiMouseEvent } from "@earendil-works/pi-tui";

const CHUNK_SIZE = 64;
const ASYNC_THRESHOLD = 512;
const PREPARE_BUDGET_MS = 4;

/** Keep two recent widths per immutable block; an expansion only invalidates its own block. */
class ArchivedChunk extends Container {
  private widths = new Map<number, string[]>();
  private epoch: number;
  private hideThinkingBlock: boolean;
  constructor(private collecting: () => boolean, private changed: () => void, private currentEpoch: () => number, private currentHideThinkingBlock: () => boolean) {
    super(); this.epoch = currentEpoch(); this.hideThinkingBlock = currentHideThinkingBlock();
  }
  has(width: number): boolean { return this.epoch === this.currentEpoch() && this.widths.has(width); }
  clearCache(): void { this.widths.clear(); this.changed(); }
  invalidate(): void { this.clearCache(); super.invalidate(); this.epoch = this.currentEpoch(); }
  render(width: number): string[] {
    if (this.epoch !== this.currentEpoch()) {
      this.epoch = this.currentEpoch();
      this.widths.clear();
      const hidden = this.currentHideThinkingBlock();
      if (hidden !== this.hideThinkingBlock) {
        this.hideThinkingBlock = hidden;
        for (const child of this.children) if (child instanceof host.AssistantMessageComponent) child.setHideThinkingBlock(hidden);
      }
      super.invalidate();
    }
    if (!this.collecting()) return super.render(width);
    let lines = this.widths.get(width);
    if (!lines) lines = super.render(width);
    this.widths.delete(width);
    this.widths.set(width, lines);
    if (this.widths.size > 2) this.widths.delete(this.widths.keys().next().value!);
    return lines;
  }
  addChild(component: Component): void {
    // Keep a partly built chunk uniform until its lazy settings update, even across rapid toggles.
    if (component instanceof host.AssistantMessageComponent && this.hideThinkingBlock !== this.currentHideThinkingBlock()) component.setHideThinkingBlock(this.hideThinkingBlock);
    const watch = (child: Component) => {
      if (child instanceof host.ToolExecutionComponent || child instanceof host.SkillInvocationMessageComponent || child instanceof host.CustomMessageComponent) {
        const original = child.setExpanded;
        child.setExpanded = expanded => { this.clearCache(); original.call(child, expanded); };
        if (child instanceof host.ToolExecutionComponent) {
          const update = child.updateResult;
          child.updateResult = (...args) => { this.clearCache(); update.apply(child, args); };
        }
      } else if (child.constructor === Container) (child as Container).children.forEach(watch);
    };
    watch(component); this.clearCache(); super.addChild(component);
  }
  removeChild(component: Component): void { this.clearCache(); super.removeChild(component); }
  handleMouse(event: TuiMouseEvent) {
    const result = super.handleMouse(event);
    if (event.type !== "move" || (result && result.render !== false)) this.clearCache();
    return result;
  }
  setExpanded(expanded: boolean): void {
    const visit = (component: Component) => {
      if (component instanceof host.ToolExecutionComponent || component instanceof host.SkillInvocationMessageComponent || component instanceof host.CustomMessageComponent) component.setExpanded(expanded);
      else if (component.constructor === Container) (component as Container).children.forEach(visit);
    };
    this.children.forEach(visit);
  }
}

/** Prepare large layouts off the input path, then swap exact lines atomically; never estimate heights. */
export class ArchivedHistory extends Container {
  private cached?: { width: number; revision: number; lines: string[] };
  private revision = 0;
  private epoch = 0;
  private count = 0;
  private preparation?: { width: number; next: number; timer?: ReturnType<typeof setTimeout> };
  private construction?: { next: () => boolean; timer?: ReturnType<typeof setTimeout> };
  private disposed = false;
  constructor(
    private collecting: () => boolean,
    private collect: (render: () => string[]) => string[],
    private ready: () => void,
    private failed: (error: unknown) => void,
    private marker = "",
    private hideThinkingBlock = false,
  ) { super(); }

  get collectedLines(): readonly string[] | undefined { return this.cached?.lines; }
  get isBuilding(): boolean { return !!this.construction; }
  get isPending(): boolean {
    // Construction finishing only queues layout; readiness means its exact lines were published.
    return !this.disposed && (!!(this.preparation || this.construction) || this.cached?.revision !== this.revision);
  }

  /** Construct archived views in short batches too, not just their rendered lines. */
  populate(next: () => boolean): void {
    if (this.disposed || this.construction) return;
    const work = { next, timer: undefined as ReturnType<typeof setTimeout> | undefined };
    this.construction = work;
    const step = () => {
      if (this.disposed || this.construction !== work) return;
      const deadline = performance.now() + PREPARE_BUDGET_MS;
      try {
        do {
          if (!work.next()) { this.construction = undefined; this.ready(); return; }
        } while (performance.now() < deadline);
        work.timer = setTimeout(step, 0);
      } catch (error) {
        this.construction = undefined;
        this.failed(error);
      }
    };
    work.timer = setTimeout(step, 0);
  }

  private changed(): void { this.revision++; this.cancelPreparation(); }
  // Defer descendant invalidation to each preparation batch, rather than walking history on resize.
  clearCache(): void { this.epoch++; this.changed(); }
  invalidate(): void { this.clearCache(); }
  addChild(component: Component): void {
    let chunk = this.children.at(-1) as ArchivedChunk | undefined;
    if (!chunk || chunk.children.length >= CHUNK_SIZE) {
      chunk = new ArchivedChunk(this.collecting, () => this.changed(), () => this.epoch, () => this.hideThinkingBlock);
      super.addChild(chunk);
    }
    chunk.addChild(component);
    this.count++;
  }
  removeChild(component: Component): void {
    const chunk = this.children.find(child => (child as ArchivedChunk).children.includes(component)) as ArchivedChunk | undefined;
    if (!chunk) return;
    chunk.removeChild(component); this.count--;
    if (!chunk.children.length) super.removeChild(chunk);
  }
  render(width: number): string[] {
    // Explicit legacy/full output must include views still awaiting background construction.
    if (!this.collecting()) {
      const work = this.construction;
      if (work) {
        clearTimeout(work.timer);
        while (work.next()) { /* Full output is necessarily proportional to its size. */ }
        this.construction = undefined;
      }
      return super.render(width);
    }
    if (this.construction) return this.cached?.lines ?? [];
    if (this.cached?.width === width && this.cached.revision === this.revision) return this.cached.lines;
    if (this.count > ASYNC_THRESHOLD && this.children.some(child => !(child as ArchivedChunk).has(width))) {
      this.prepare(width);
      // On resize keep the last exact layout (temporarily clipped), not a partial/estimated history.
      return this.cached?.lines ?? [];
    }
    this.cancelPreparation();
    const lines = super.render(width);
    if (lines.length) lines[0] = this.marker + lines[0];
    this.cached = { width, revision: this.revision, lines };
    return lines;
  }
  handleMouse(event: TuiMouseEvent) {
    // A prepared child can already have new hit geometry while the old layout is still displayed.
    // Cache dirtiness alone must not swallow a release/click following a press.
    if (this.preparation || this.construction) return undefined;
    return super.handleMouse(event);
  }
  private prepare(width: number): void {
    if (this.disposed || this.preparation?.width === width) return;
    this.cancelPreparation();
    const work = { width, next: 0, timer: undefined as ReturnType<typeof setTimeout> | undefined };
    this.preparation = work;
    const step = () => {
      if (this.disposed || this.preparation !== work) return;
      const deadline = performance.now() + PREPARE_BUDGET_MS;
      try {
        while (work.next < this.children.length) {
          const child = this.children[work.next++] as ArchivedChunk;
          if (!child.has(width)) this.collect(() => child.render(width));
          if (performance.now() >= deadline) break;
        }
        if (work.next < this.children.length) work.timer = setTimeout(step, 0);
        else { work.timer = undefined; this.ready(); }
      } catch (error) {
        work.timer = undefined;
        this.failed(error);
      }
    };
    work.timer = setTimeout(step, 0);
  }
  private cancelPreparation(): void {
    clearTimeout(this.preparation?.timer);
    this.preparation = undefined;
  }
  setHideThinkingBlock(hidden: boolean): void {
    if (hidden === this.hideThinkingBlock) return;
    this.hideThinkingBlock = hidden;
    this.clearCache();
  }
  setExpanded(expanded: boolean): void { for (const child of this.children) (child as ArchivedChunk).setExpanded(expanded); }
  dispose(): void {
    this.disposed = true;
    this.cancelPreparation();
    clearTimeout(this.construction?.timer);
    this.construction = undefined;
  }
}
