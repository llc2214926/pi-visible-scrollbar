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
export interface NativeFrame { document: ChildLines; chat: ChildLines; offset: number; lines: readonly string[] }
export function transcriptOffset(document: Container, child: Component, width: number, lines: readonly string[]): number | undefined {
  const parent = layout(document);
  return parent?.width === width && parent.lines === lines && parent.children.length === 3 && parent.children[2] === child
    ? parent.parts[0].length + parent.parts[1].length : undefined;
}
export function nativeFrame(document: Container, chat: Container, width: number, lines: readonly string[]): NativeFrame | undefined {
  const parent = layout(document), body = layout(chat);
  if (!parent || !body || parent.width !== width || body.width !== width || parent.lines !== lines ||
      parent.children.length !== 3 || parent.children[2] !== chat) return undefined;
  // Stock Container already proved text equality; identical text can still have new child identities.
  if (parent.parts[2] !== body.lines && (chat.render !== Container.prototype.render || parent.parts[2].length !== body.lines.length)) return undefined;
  return { document: parent, chat: body, offset: parent.parts[0].length + parent.parts[1].length, lines };
}

type NativeAnchor = Anchor & { rank: number };
type Candidate = {
  component: Component; source: readonly string[]; row: number; end: number;
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

function* cards(root: ChildLines, offset: number, depth = 0): Generator<Candidate | undefined> {
  if (depth > 64) throw new Error("Native transcript is too deeply nested");
  let row = offset, skillArguments = false;
  for (let i = 0; i < root.children.length; i++) {
    const component = root.children[i], source = root.parts[i], start = row;
    row += source.length;
    if (skillArguments && component instanceof Spacer) { yield undefined; continue; }
    const skip = skillArguments && component instanceof host.UserMessageComponent;
    skillArguments = false;
    if (skip) { yield undefined; continue; }
    const value = candidate(component, source, start);
    if (value) {
      skillArguments = component instanceof host.SkillInvocationMessageComponent && !!fields(component).skillBlock?.userMessage;
      yield value;
    } else if (component instanceof Container && Object.getPrototypeOf(component) === Container.prototype) {
      const child = layout(component);
      if (child?.width === root.width && (child.lines === source ||
          (component.render === Container.prototype.render && child.lines.length === source.length))) yield* cards(child, start, depth + 1);
      else yield undefined;
    } else yield undefined;
  }
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
    return !this.dirty && this.indexed?.frame.chat === this.latest?.chat && this.indexed?.frame.offset === this.latest?.offset ? this.indexed : undefined;
  }
  get anchors(): NativeAnchor[] {
    const previous = this.indexed, latest = this.latest;
    // Keep stable visual dots during background work; anchor() still rejects unverified hit positions.
    return this.current()?.anchors ?? (previous && latest && previous.frame.chat.width === latest.chat.width &&
      previous.frame.offset === latest.offset ? previous.anchors : EMPTY);
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
      for (const card of cards(frame.chat, frame.offset)) {
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
      if (previous && previous.frame.document.parts[0] === frame.document.parts[0] && previous.frame.document.parts[1] === frame.document.parts[1]) {
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
      if (this.latest?.chat === frame.chat && this.latest.offset === frame.offset) {
        this.lineChange = previous ? { previous: new WeakRef(previous.frame.lines), from, oldEnd, end } : undefined;
        this.dirty = false;
        this.indexed = { frame, anchors: same ? previous!.anchors : anchors, byId: same ? previous!.byId : byId };
        this.changed(!same);
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
