import * as host from "@earendil-works/pi-coding-agent";
import { Container, type Component, type TuiMouseEvent } from "@earendil-works/pi-tui";

const CHUNK_SIZE = 64;
const ASYNC_THRESHOLD = 512;
const PREPARE_BUDGET_MS = 8;

/** Keep two recent widths per immutable block; an expansion only invalidates its own block. */
class ArchivedChunk extends Container {
  private widths = new Map<number, string[]>();
  constructor(private collecting: () => boolean, private changed: () => void) { super(); }
  has(width: number): boolean { return this.widths.has(width); }
  clearCache(): void { this.widths.clear(); this.changed(); }
  invalidate(): void { this.clearCache(); super.invalidate(); }
  render(width: number): string[] {
    if (!this.collecting()) return super.render(width);
    let lines = this.widths.get(width);
    if (!lines) lines = super.render(width);
    this.widths.delete(width);
    this.widths.set(width, lines);
    if (this.widths.size > 2) this.widths.delete(this.widths.keys().next().value!);
    return lines;
  }
  addChild(component: Component): void {
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
  private count = 0;
  private preparation?: { width: number; next: number; timer?: ReturnType<typeof setTimeout> };
  private disposed = false;
  constructor(
    private collecting: () => boolean,
    private collect: (render: () => string[]) => string[],
    private ready: () => void,
    private failed: (error: unknown) => void,
  ) { super(); }

  get isPending(): boolean { return !!this.preparation; }
  private changed(): void { this.revision++; this.cancelPreparation(); }
  clearCache(): void { for (const child of this.children) (child as ArchivedChunk).clearCache(); }
  addChild(component: Component): void {
    let chunk = this.children.at(-1) as ArchivedChunk | undefined;
    if (!chunk || chunk.children.length >= CHUNK_SIZE) {
      chunk = new ArchivedChunk(this.collecting, () => this.changed());
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
    // The marker-bearing caches are private to the document collection pass.
    if (!this.collecting()) return super.render(width);
    if (this.cached?.width === width && this.cached.revision === this.revision) return this.cached.lines;
    if (this.count > ASYNC_THRESHOLD && this.children.some(child => !(child as ArchivedChunk).has(width))) {
      this.prepare(width);
      // On resize keep the last exact layout (temporarily clipped), not a partial/estimated history.
      return this.cached?.lines ?? [];
    }
    this.cancelPreparation();
    const lines = super.render(width);
    this.cached = { width, revision: this.revision, lines };
    return lines;
  }
  handleMouse(event: TuiMouseEvent) {
    // A prepared child can already have new hit geometry while the old layout is still displayed.
    if (this.isPending) return undefined;
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
  setExpanded(expanded: boolean): void { for (const child of this.children) (child as ArchivedChunk).setExpanded(expanded); }
  dispose(): void { this.disposed = true; this.cancelPreparation(); }
}
