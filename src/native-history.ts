import * as host from "@earendil-works/pi-coding-agent";
import { Container, Spacer, type Component, type TUI } from "@earendil-works/pi-tui";
import { createHash } from "node:crypto";
import { encodeHistoryJson, HistoryClient, isHistoryCancelled } from "./history-client.ts";
import type { HistoryMatch, HistoryRequests, HistorySummary } from "./history-protocol.ts";
import type { Anchor, LineChange } from "./model.ts";

/** Metadata and gutter pixels do not invalidate the native document's cached text. */
export function requestViewFrame(tui: TUI): void {
  const renderer = tui.valueOf() as { requestViewRender?: () => void };
  if (typeof renderer.requestViewRender === "function") renderer.requestViewRender();
  else tui.requestRender();
}

interface ChildLines {
  width: number;
  children: readonly Component[];
  parts: readonly (readonly string[])[];
  lines: readonly string[];
}
interface NativeFields {
  childLines?: ChildLines;
  zoneLines?: { lines?: readonly string[] };
  cache?: { lines?: readonly string[] };
  messageId?: unknown;
  text?: unknown;
  skillBlock?: Partial<host.ParsedSkillBlock>;
  lastMessage?: { timestamp?: unknown };
  message?: { customType?: unknown; content?: unknown };
  status?: unknown;
  command?: unknown;
  outputLines?: unknown;
}
// SAFETY: Pi 1.6.0's optional fields are checked below; private state is never mutated.
const fields = (component: Component) => component as unknown as NativeFields;
function layout(component: Component): ChildLines | undefined {
  const value = fields(component).childLines;
  return value && Array.isArray(value.children) && Array.isArray(value.parts) && Array.isArray(value.lines) &&
    value.children.length === value.parts.length ? value : undefined;
}
export interface NativeFrame { document: ChildLines; chat: ChildLines | Component[]; offset: number; lines: readonly string[] }
export function transcriptOffset(document: Container, child: Component, width: number, lines: readonly string[]): number | undefined {
  const parent = layout(document);
  return parent?.width === width && parent.lines === lines && parent.children.length === 3 && parent.children[2] === child
    ? parent.parts[0].length + parent.parts[1].length : undefined;
}
export function nativeFrame(document: Container, chat: Container, width: number, lines: readonly string[]): NativeFrame | undefined {
  const parent = layout(document), body = layout(chat);
  if (!parent || parent.width !== width || parent.lines !== lines || parent.children.length !== 3 || parent.children[2] !== chat) return undefined;
  const stock = chat.render === Container.prototype.render;
  // Stock Container already proved text equality; identical text can still have new child identities.
  const measured = body?.width === width && (parent.parts[2] === body.lines || (stock && parent.parts[2].length === body.lines.length));
  if (!measured && stock) return undefined;
  // A folding renderer may return a different container's rows without populating chat.childLines.
  return { document: parent, chat: measured ? body : chat.children, offset: parent.parts[0].length + parent.parts[1].length, lines };
}

type NativeAnchor = Anchor & { rank: number };
type Candidate = {
  component: Component; source: readonly string[]; row: number; end: number;
  skillArgument?: boolean;
  input: HistoryRequests["match"]["candidates"][number]; payload?: unknown[]; match?: HistoryMatch | null;
};
type Binding = { source: readonly string[]; signature?: string; match: HistoryMatch | null; revision: number; leaf: string | null };
type Indexed = { frame: NativeFrame; anchors: NativeAnchor[]; byId: Map<string, NativeAnchor> };
const EMPTY: NativeAnchor[] = [];
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));

function candidate(component: Component, source: readonly string[], row: number): Candidate | undefined {
  const value = fields(component);
  let payload: unknown[] | undefined, signature: string | undefined;
  if (component instanceof host.UserMessageComponent && typeof value.text === "string") payload = ["user", value.text];
  else if (component instanceof host.SkillInvocationMessageComponent) {
    const skill = value.skillBlock;
    if (typeof skill?.name === "string" && typeof skill.content === "string") payload = ["skill", skill.name, skill.content, skill.userMessage ?? null];
  } else if (component instanceof host.AssistantMessageComponent && typeof value.lastMessage?.timestamp === "number") {
    signature = `assistant:${value.lastMessage.timestamp}`;
  } else if (component instanceof host.CustomMessageComponent && typeof value.message?.customType === "string") {
    payload = ["custom", value.message.customType, value.message.content];
  } else if (component instanceof host.BashExecutionComponent && ["complete", "cancelled", "error"].includes(String(value.status)) &&
      typeof value.command === "string" && Array.isArray(value.outputLines)) {
    payload = ["bash", value.command, value.outputLines.length ? value.outputLines : [""]];
  }
  if (!payload && !signature) return undefined;
  const id = typeof value.messageId === "string" && value.messageId.length <= 256 ? value.messageId : undefined;
  return { component, source, row, end: row + source.length, input: { id, signature }, payload: id ? undefined : payload };
}

function cachedInputRows(component: Component): readonly string[] | undefined {
  // UserMessageComponent adds OSC zones after Container.render; SkillInvocationMessageComponent is a padded Box.
  const rows = component instanceof host.UserMessageComponent ? fields(component).zoneLines?.lines
    : component instanceof host.SkillInvocationMessageComponent ? fields(component).cache?.lines : undefined;
  return Array.isArray(rows) ? rows : undefined;
}

function* cards(root: NativeFrame["chat"], offset: number, depth = 0): Generator<Candidate | undefined> {
  if (depth > 64) throw new Error("Native transcript is too deeply nested");
  const projected = Array.isArray(root), children = projected ? root : root.children;
  // Without rendered rows there is no stable cache key for a card's signature across frames.
  const unmeasured: readonly string[] = [];
  let row = offset, skillArguments = false;
  for (let i = 0; i < children.length; i++) {
    const component = children[i], source = projected ? cachedInputRows(component) ?? unmeasured : root.parts[i], start = row;
    row += source.length;
    if (skillArguments && component instanceof Spacer) { yield undefined; continue; }
    const skip = skillArguments && component instanceof host.UserMessageComponent;
    skillArguments = false;
    if (skip && !projected) { yield undefined; continue; }
    const value = candidate(component, source, start);
    if (value) {
      if (skip) value.skillArgument = true; // A projection still has to account for these visible rows.
      skillArguments = component instanceof host.SkillInvocationMessageComponent && !!fields(component).skillBlock?.userMessage;
      yield value;
    } else if (component instanceof Container && Object.getPrototypeOf(component) === Container.prototype) {
      if (projected) { yield* cards(component.children, 0, depth + 1); continue; }
      const child = layout(component);
      if (child?.width === root.width && (child.lines === source ||
          (component.render === Container.prototype.render && child.lines.length === source.length))) yield* cards(child, start, depth + 1);
      else yield undefined;
    } else yield undefined;
  }
}

// A folded history rail precedes the styled row, but Pi's OSC 133 zones stay at column zero.
const foldRail = /^((?:\x1b\]133;[ABC](?:\x07|\x1b\\))*)(?:\x1b\[[\d;:]*m)*│(?:\x1b\[[\d;:]*m)* /;

type Span = { count: number; seen: number };
type RowNode = { next?: Map<string, RowNode>; span?: Span };
type Hit = { span: Span; row: number; first?: Candidate };

function* displayedSpans(root: RowNode, lines: readonly string[], offset: number): Generator<undefined, Hit[]> {
  const hits: Hit[] = [];
  for (let start = 0; start < lines.length; start++) {
    let node = root;
    for (let row = start; row < lines.length; row++) {
      const line = lines[row], next = node.next?.get(line) ?? node.next?.get(line.replace(foldRail, "$1"));
      if (!next) break;
      node = next;
      if (node.span && ++node.span.seen <= node.span.count) hits.push({ span: node.span, row: offset + start });
      if ((row - start) % 128 === 127) yield undefined;
    }
    if (start % 128 === 127) yield undefined;
  }
  // A span repeated more often on screen than in the source cannot identify a card.
  let count = 0;
  for (const hit of hits) { if (hit.span.seen <= hit.span.count) hits[count++] = hit; yield undefined; }
  hits.length = count;
  return hits;
}

// Index complete cached input spans, not prompt labels or the heights of hidden raw children.
function* projectedCards(children: Component[], lines: readonly string[], offset: number): Generator<Candidate | undefined> {
  const root: RowNode = {}, ordered: { card: Candidate; span?: Span }[] = [];
  for (const card of cards(children, 0)) {
    if (card) {
      let node = root;
      for (let i = 0; i < card.source.length; i++) {
        const children = node.next ??= new Map<string, RowNode>(), line = card.source[i];
        let child = children.get(line);
        if (!child) children.set(line, child = {});
        node = child;
        if (i % 128 === 127) yield undefined;
      }
      const span = card.source.length ? node.span ??= { count: 0, seen: 0 } : undefined;
      if (span) span.count++;
      card.row = card.end = 0;
      ordered.push({ card, span });
    }
    yield undefined;
  }
  const hits = yield* displayedSpans(root, lines, offset);
  // Only publish a visible row if matching from either end identifies the same source card.
  let pos = 0;
  for (const { card, span } of ordered) {
    if (span && hits[pos]?.span === span) hits[pos++].first = card;
    yield undefined;
  }
  if (pos === hits.length) {
    for (let i = ordered.length - 1; pos && i >= 0; i--) {
      const { card, span } = ordered[i], hit = hits[pos - 1];
      if (span === hit.span) {
        if (card === hit.first) { card.row = hit.row; card.end = hit.row + card.source.length; }
        pos--;
      }
      yield undefined;
    }
  }
  for (const { card } of ordered) yield card.skillArgument ? undefined : card;
}

function sameChat(a?: NativeFrame, b?: NativeFrame): boolean {
  return !!a && !!b && a.chat === b.chat && a.offset === b.offset && a.document.width === b.document.width &&
    a.document.parts[2] === b.document.parts[2];
}

/** Geometry and identity work is coalesced into short tasks, never part of transcript rendering. */
export class NativeHistory {
  private latest?: NativeFrame;
  private indexed?: Indexed;
  private bindings = new WeakMap<Component, Binding>();
  private timer?: ReturnType<typeof setTimeout>;
  private running = false;
  private dirty = false;
  private generation = 0;
  private disposed = false;
  private failure = false;
  lineChange?: LineChange;

  constructor(private client: HistoryClient, private ready: () => Promise<HistorySummary>,
    private changed: (redraw: boolean) => void, private failed: (error: unknown) => void) {}

  private current(): Indexed | undefined {
    return !this.dirty && sameChat(this.indexed?.frame, this.latest) ? this.indexed : undefined;
  }
  get anchors(): NativeAnchor[] {
    const previous = this.indexed, latest = this.latest;
    if (!previous || !latest) return EMPTY;
    const frame = previous.frame;
    // A projection can hide any input. Only the native layout keeps its dots while new rows are measured.
    if (Array.isArray(frame.chat) || Array.isArray(latest.chat)) return sameChat(frame, latest) ? previous.anchors : EMPTY;
    return frame.document.width === latest.document.width && frame.offset === latest.offset ? previous.anchors : EMPTY;
  }
  anchor(id: string): NativeAnchor | undefined { return this.current()?.byId.get(id); }
  get isPending(): boolean { return !!this.latest && !this.current(); }

  capture(frame: NativeFrame | undefined): void {
    if (this.disposed || this.failure) return;
    if (!frame) { this.latest = undefined; this.lineChange = undefined; return; }
    if (this.latest?.document === frame.document && this.latest.chat === frame.chat && this.latest.offset === frame.offset) return;
    this.latest = frame;
    const indexed = this.current();
    if (indexed) {
      if (indexed.frame.lines !== frame.lines) this.lineChange = { previous: new WeakRef(indexed.frame.lines), from: 0, oldEnd: indexed.frame.offset, end: frame.offset };
      indexed.frame = frame;
    } else { this.lineChange = undefined; this.schedule(); }
  }

  reset(): void {
    this.bindings = new WeakMap(); this.indexed = undefined; this.failure = false;
    this.refresh();
  }

  refresh(): void {
    this.generation++; this.client.cancel("match");
    this.dirty = true; this.lineChange = undefined; this.failure = false;
    this.schedule();
  }

  private schedule(): void {
    if (this.disposed || this.failure || this.running || this.timer || !this.latest || this.current()) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.run();
    }, 0);
  }

  private async run(): Promise<void> {
    if (!this.latest || this.disposed) return;
    this.running = true;
    const generation = this.generation, frame = this.latest;
    const check = () => { if (this.disposed || this.generation !== generation) throw new DOMException("Native history changed", "AbortError"); };
    let deadline = performance.now() + 2;
    const pause = async () => { await tick(); check(); deadline = performance.now() + 2; };
    try {
      const summary = await this.ready(); check();
      const candidates: Candidate[] = [];
      const visible = Array.isArray(frame.chat) ? projectedCards(frame.chat, frame.document.parts[2], frame.offset) : cards(frame.chat, frame.offset);
      for (const card of visible) {
        if (card) candidates.push(card);
        if (performance.now() >= deadline) await pause();
      }
      let cursor = summary.entries - 1, index = candidates.length - 1;
      while (index >= 0) {
        const card = candidates[index], cached = this.bindings.get(card.component);
        const valid = cached?.revision === summary.revision && cached.source === card.source &&
          (cached.match ? cached.match.entryIndex <= cursor : cached.leaf === summary.leaf);
        if (valid) { card.match = cached.match; if (cached.match) cursor = cached.match.entryIndex - 1; index--; }
        else {
          const batch: Candidate[] = [];
          do {
            const next = candidates[index], prior = this.bindings.get(next.component);
            if (batch.length && prior?.revision === summary.revision && prior.source === next.source && prior.match && prior.match.entryIndex <= cursor) break;
            if (next.payload) {
              if (prior?.source === next.source && prior.signature) next.input.signature = prior.signature;
              else {
                const hash = createHash("sha256");
                for (const part of encodeHistoryJson(next.payload)) {
                  hash.update(part);
                  if (performance.now() >= deadline) await pause();
                }
                next.input.signature = hash.digest("hex");
              }
            }
            batch.push(next); index--;
            if (performance.now() >= deadline) await pause();
          } while (index >= 0 && batch.length < 128);
          const result = await this.client.request("match", { candidates: batch.map(card => card.input), cursor }); check();
          cursor = result.cursor;
          for (let i = 0; i < batch.length; i++) {
            const card = batch[i]; card.match = result.matches[i];
            this.bindings.set(card.component, { source: card.source, signature: card.input.signature, match: card.match,
              revision: summary.revision, leaf: summary.leaf });
          }
        }
        if (performance.now() >= deadline) await pause();
      }
      const previous = this.indexed, anchors: NativeAnchor[] = [], byId = new Map<string, NativeAnchor>();
      let same = !!previous;
      for (const card of candidates) {
        const prompt = card.match?.prompt;
        if (prompt && card.end > card.row) {
          const old = previous?.anchors[anchors.length];
          const anchor = old?.id === prompt.id && old.row === card.row && old.end === card.end && old.rank === prompt.rank
            ? old : { ...prompt, row: card.row, end: card.end };
          same &&= anchor === old;
          anchors.push(anchor); byId.set(prompt.id, anchor);
        }
        if (performance.now() >= deadline) await pause();
      }
      same &&= anchors.length === previous?.anchors.length;
      let from = frame.offset, oldEnd = previous?.frame.offset ?? 0, end = frame.offset;
      if (previous && !Array.isArray(previous.frame.chat) && !Array.isArray(frame.chat) &&
          previous.frame.document.parts[0] === frame.document.parts[0] && previous.frame.document.parts[1] === frame.document.parts[1]) {
        const old = previous.frame.chat;
        let oldRow = previous.frame.offset, row = frame.offset, first = true;
        for (let i = 0; i < Math.max(old.parts.length, frame.chat.parts.length); i++) {
          const before = old.parts[i], after = frame.chat.parts[i];
          if (before !== after || old.children[i] !== frame.chat.children[i]) {
            if (first) { from = row; first = false; }
            oldEnd = oldRow + (before?.length ?? 0); end = row + (after?.length ?? 0);
          }
          oldRow += before?.length ?? 0; row += after?.length ?? 0;
          if (performance.now() >= deadline) await pause();
        }
      } else { from = 0; oldEnd = previous?.frame.lines.length ?? 0; end = frame.lines.length; }
      check();
      // A newer render may arrive during the scan. Keep the useful bindings, not stale hit targets.
      if (sameChat(this.latest, frame)) {
        this.lineChange = previous ? { previous: new WeakRef(previous.frame.lines), from, oldEnd, end } : undefined;
        const redraw = !same || this.anchors.length !== anchors.length;
        this.dirty = false;
        this.indexed = { frame, anchors: same ? previous!.anchors : anchors, byId: same ? previous!.byId : byId };
        this.changed(redraw);
      }
    } catch (error) {
      if (!isHistoryCancelled(error) && !this.disposed) { this.latest = undefined; this.indexed = undefined; this.lineChange = undefined; this.failure = true; this.failed(error); }
    } finally { this.running = false; this.schedule(); }
  }

  dispose(): void {
    this.disposed = true; this.generation++;
    clearTimeout(this.timer); this.timer = undefined;
    this.client.cancel("match");
    this.latest = this.indexed = undefined; this.bindings = new WeakMap(); this.lineChange = undefined;
  }
}
