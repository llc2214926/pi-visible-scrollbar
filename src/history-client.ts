import { getPackageDir, VERSION, type ExtensionContext, type SessionEntry, type Theme, type ThemeBg, type ThemeColor } from "@earendil-works/pi-coding-agent";
import { getCapabilities, getKeybindings } from "@earendil-works/pi-tui";
import { Worker } from "node:worker_threads";
import { isSupportedPiVersion } from "./compat.mjs";
import {
  HISTORY_COPY_BYTES, HISTORY_PACKET_BYTES, HISTORY_PAGE_ROWS, HISTORY_SOURCE_CHARS,
  type HistoryLayout, type HistoryReplies, type HistoryRequestKind, type HistoryRequests, type HistoryTheme,
} from "./history-protocol.ts";

const SLICE_MS = 2;
const cancelled = () => new DOMException("History request cancelled", "AbortError");
export const isHistoryCancelled = (error: unknown): boolean => error instanceof Error && error.name === "AbortError";

/** JSON.stringify semantics for session data, without stringifying a giant entry on the UI thread. */
export function* encodeHistoryJson(value: unknown, parents = new Set<object>()): Generator<string> {
  if (typeof value === "string") {
    yield '"';
    for (let i = 0; i < value.length;) {
      let end = Math.min(value.length, i + 4096);
      if (end < value.length && value.charCodeAt(end - 1) >= 0xd800 && value.charCodeAt(end - 1) <= 0xdbff &&
          value.charCodeAt(end) >= 0xdc00 && value.charCodeAt(end) <= 0xdfff) end--;
      yield JSON.stringify(value.slice(i, end)).slice(1, -1);
      i = end;
    }
    yield '"';
  } else if (value === null || typeof value !== "object") {
    if (typeof value === "bigint") throw new Error("History contains non-JSON data");
    yield JSON.stringify(value) ?? "null";
  } else {
    if (parents.has(value) || parents.size >= 128) throw new Error("History contains cyclic or excessively nested data");
    if (value instanceof Date) { yield JSON.stringify(value.toJSON()); return; }
    parents.add(value);
    try {
      if (Array.isArray(value)) {
        yield "[";
        for (let i = 0; i < value.length; i++) {
          if (i) yield ",";
          yield* encodeHistoryJson(value[i], parents);
        }
        yield "]";
      } else {
        yield "{";
        let comma = false;
        for (const key in value) {
          if (!Object.hasOwn(value, key)) continue;
          const field = (value as Record<string, unknown>)[key];
          if (field === undefined || typeof field === "function" || typeof field === "symbol") continue;
          if (comma) yield ",";
          comma = true;
          yield* encodeHistoryJson(key, parents);
          yield ":";
          yield* encodeHistoryJson(field, parents);
        }
        yield "}";
      }
    } finally { parents.delete(value); }
  }
}

/** Metadata never transports old tool bodies, binary images or non-display custom data. */
function* encodeHistoryIndex(entry: SessionEntry): Generator<string> {
  const base = { id: entry.id, parentId: entry.parentId, type: entry.type };
  if (entry.type !== "message") {
    yield* encodeHistoryJson(entry.type === "custom_message"
      ? { ...base, customType: entry.customType, content: entry.content, display: entry.display } : base);
    return;
  }
  const message = entry.message;
  if (message.role === "user" || message.role === "assistant") {
    if (message.timestamp !== undefined && typeof message.timestamp !== "number") throw new Error("Invalid history message timestamp");
    // The fixed-size header is validated before reaching this generator.
    yield `${JSON.stringify({ ...base, message: { role: message.role, timestamp: message.timestamp } }).slice(0, -2)},"content":`;
    const content = message.content;
    if (typeof content === "string") yield* encodeHistoryJson(content);
    else {
      yield "[";
      let comma = false;
      for (const block of content ?? []) {
        const value = message.role === "user"
          ? block?.type === "text" ? { type: "text", text: block.text } : block?.type === "image" ? { type: "image" } : undefined
          : block?.type === "toolCall" ? { type: "toolCall", id: block.id } : undefined;
        if (value) { if (comma) yield ","; comma = true; yield* encodeHistoryJson(value); }
        else yield "";
      }
      yield "]";
    }
    yield "}}";
    return;
  }
  const value = message.role === "toolResult" ? { role: message.role, toolCallId: message.toolCallId }
    : message.role === "bashExecution" ? { role: message.role, command: message.command, output: message.output }
    : message.role === "custom" ? { role: message.role, customType: message.customType, content: message.content, display: message.display }
    : { role: message.role };
  yield* encodeHistoryJson({ ...base, message: value });
}

/** Preserve terminal-default and faint tokens, not approximations from theme.colors. */
export function historyTheme(theme: Theme): HistoryTheme {
  const foreground: Record<string, string | number> = {}, background: Record<string, string | number> = {}, dim: string[] = [];
  for (const token of Object.keys(theme.colors)) {
    const bg = token.endsWith("Bg");
    const ansi = bg ? theme.getBgAnsi(token as ThemeBg) : theme.getFgAnsi(token as ThemeColor);
    let color: string | number = "";
    for (const match of ansi.matchAll(/\x1b\[([\d;]+)m/g)) {
      const parts = match[1].split(";").map(Number), first = parts[0];
      if (first === 38 || first === 48) {
        if (parts[1] === 5) color = parts[2];
        else if (parts[1] === 2) color = `#${parts.slice(2, 5).map(n => n.toString(16).padStart(2, "0")).join("")}`;
      } else if (first >= 30 && first <= 37) color = first - 30;
      else if (first >= 40 && first <= 47) color = first - 40;
      else if (first >= 90 && first <= 97) color = first - 90 + 8;
      else if (first >= 100 && first <= 107) color = first - 100 + 8;
      else if (first === 2 && !bg) dim.push(token);
    }
    (bg ? background : foreground)[token] = color;
  }
  return { foreground, background, dim, mode: theme.getColorMode(), appearance: theme.appearance };
}

export function historyLayout(ctx: ExtensionContext, width: number, hideThinkingBlock: boolean, outputPad = 1): HistoryLayout {
  return { width, hideThinkingBlock, outputPad, expanded: ctx.ui.getToolsExpanded(), theme: historyTheme(ctx.ui.theme),
    capabilities: { ...getCapabilities(), images: null }, keybindings: getKeybindings().getResolvedBindings() };
}

type Job = {
  kind: HistoryRequestKind; input: HistoryRequests[HistoryRequestKind];
  resolve: (value: unknown) => void; reject: (error: Error) => void;
  chunks?: string[]; bytes?: number;
};
type Source = { iterator: Generator<string>; rest: string; waiting: boolean; timer?: ReturnType<typeof setTimeout> };

/** One replaceable request per operation; entry transport has one bounded packet in flight. */
export class HistoryClient {
  private worker?: Worker;
  private launch?: ReturnType<typeof setTimeout>;
  private jobs = new Map<number, Job>();
  private kinds = new Map<HistoryRequestKind, number>();
  private sources = new Map<number, Source>();
  private serial = 0;
  private disposed = false;
  private failure?: Error;

  constructor(private reader: ExtensionContext["sessionManager"], private failed: (error: Error) => void = () => {}, private cwd = reader.getCwd()) {}

  request<K extends HistoryRequestKind>(kind: K, input: HistoryRequests[K]): Promise<HistoryReplies[K]> {
    if (this.disposed || this.failure) return Promise.reject(this.failure ?? cancelled());
    if (("text" in input && input.text.length > 1024) ||
        ("id" in input && input.id && input.id.length > 256) ||
        ("cursor" in input && typeof input.cursor === "object" && input.cursor?.id.length > 256) ||
        ("after" in input && input.after && input.after.id.length > 256) ||
        ("leaf" in input && ((input.leaf?.length ?? 0) > 256 || input.sessionId.length > 256 || (input.file?.length ?? 0) > 16 * 1024)) ||
        ("candidates" in input && (input.candidates.length > 128 || input.candidates.some(item => (item.id?.length ?? 0) > 256 || (item.signature?.length ?? 0) > 128)))) {
      return Promise.reject(new Error("History request exceeds its transport bounds"));
    }
    this.cancel(kind);
    return new Promise<HistoryReplies[K]>((resolve, reject) => {
      const id = ++this.serial;
      this.jobs.set(id, { kind, input, resolve: value => resolve(value as HistoryReplies[K]), reject });
      this.kinds.set(kind, id);
      if (this.worker) this.post(id);
      else if (!this.launch) this.launch = setTimeout(() => this.start(), 0);
    });
  }

  cancel(kind: HistoryRequestKind): void {
    const id = this.kinds.get(kind);
    if (id === undefined) return;
    this.kinds.delete(kind);
    const job = this.jobs.get(id);
    this.jobs.delete(id);
    job?.reject(cancelled());
    this.send({ type: "cancel", id });
    if (!this.jobs.size) this.worker?.unref();
  }

  private start(): void {
    this.launch = undefined;
    if (this.disposed || this.worker || !this.jobs.size) return;
    try {
      if (!isSupportedPiVersion(VERSION)) throw new Error("Paged history requires Pi >=1.6.0");
      const worker = new Worker(new URL("./history-worker.mjs", import.meta.url), {
        execArgv: [], stdout: true, stderr: true,
        workerData: { agentDir: getPackageDir(), version: VERSION, cwd: this.cwd, pageRows: HISTORY_PAGE_ROWS, packetBytes: HISTORY_PACKET_BYTES, copyBytes: HISTORY_COPY_BYTES },
        resourceLimits: { maxOldGenerationSizeMb: 384, maxYoungGenerationSizeMb: 16 },
      });
      this.worker = worker;
      // Capture diagnostics without reading/ref-counting stdio: idle workers must not keep Pi alive.
      worker.on("message", message => { if (this.worker === worker) this.receive(message); });
      worker.on("error", error => { if (this.worker === worker) this.fail(error); });
      worker.on("exit", () => { if (this.worker === worker) this.fail(new Error("History worker exited; toggle the scrollbar off/on to retry")); });
      for (const id of this.jobs.keys()) this.post(id);
    } catch (error) { this.fail(error instanceof Error ? error : new Error(String(error))); }
  }

  private post(id: number): void {
    const job = this.jobs.get(id);
    if (!job || !this.worker) return;
    try {
      this.worker.ref();
      this.worker.postMessage({ type: "request", id, kind: job.kind, input: job.input });
    } catch (error) { this.fail(error instanceof Error ? error : new Error(String(error))); }
  }

  private send(message: unknown): void {
    try { this.worker?.postMessage(message); }
    catch (error) { this.fail(error instanceof Error ? error : new Error(String(error))); }
  }

  private receive(message: unknown): void {
    if (!message || typeof message !== "object") { this.fail(new Error("Invalid history worker response")); return; }
    const reply = message as { type?: string; id?: number; kind?: string; error?: string; data?: unknown; text?: string; first?: string; ancestors?: boolean; stop?: string | null };
    if (!Number.isSafeInteger(reply.id)) { this.fail(new Error("Invalid history worker request ID")); return; }
    const id = reply.id!;
    if (reply.type === "source") {
      if (typeof reply.first !== "string" || reply.first.length > 256 || (reply.stop?.length ?? 0) > 256 || this.sources.has(id) || this.sources.size >= 2) {
        this.fail(new Error("Invalid history source request")); return;
      }
      const source: Source = { iterator: this.entries(reply.first, !!reply.ancestors, reply.stop), rest: "", waiting: false };
      this.sources.set(id, source);
      source.timer = setTimeout(() => this.pump(id, source), 0);
      return;
    }
    if (reply.type === "sourceCredit") {
      const source = this.sources.get(id);
      if (source?.waiting) {
        source.waiting = false;
        source.timer = setTimeout(() => this.pump(id, source), 0);
      }
      return;
    }
    if (reply.type === "sourceCancel") { this.closeSource(id); return; }
    const job = this.jobs.get(id);
    if (reply.type === "copyChunk") {
      if (job?.kind !== "copy") { this.send({ type: "credit", id }); return; }
      if (typeof reply.text !== "string" || Buffer.byteLength(reply.text) > HISTORY_PACKET_BYTES) {
        this.fail(new Error("History copy packet exceeded its bound")); return;
      }
      job.bytes = (job.bytes ?? 0) + Buffer.byteLength(reply.text);
      if (job.bytes > HISTORY_COPY_BYTES) { this.fail(new Error("History copy exceeded its size limit")); return; }
      (job.chunks ??= []).push(reply.text);
      this.send({ type: "credit", id });
      return;
    }
    if (reply.type !== "reply" || !job) return;
    this.jobs.delete(id);
    if (this.kinds.get(job.kind) === id) this.kinds.delete(job.kind);
    if (reply.error) job.reject(new Error(reply.error));
    else if (job.kind === "copy") job.resolve(job.chunks?.join("") ?? "");
    else job.resolve(reply.data);
    if (!this.jobs.size) this.worker?.unref();
  }

  private *entries(first: string, ancestors: boolean, stop?: string | null): Generator<string> {
    const seen = new Set<string>();
    let id: string | null = first;
    for (let count = 0; id !== null && count < (ancestors ? 128 : 1); count++) {
      if (count && id === stop) break;
      if (seen.has(id)) throw new Error("Invalid session ancestry: cycle");
      seen.add(id);
      const entry = this.reader.getEntry(id);
      if (!entry || entry.id !== id) throw new Error("History entry is no longer available");
      if (!entry.id.length || entry.id.length > 256 || (entry.parentId !== null && (typeof entry.parentId !== "string" || entry.parentId.length > 256)) ||
          typeof entry.type !== "string" || entry.type.length > 64) throw new Error("Invalid history entry header");
      if (ancestors || (entry.type === "message" && entry.message.role === "user")) yield* encodeHistoryIndex(entry);
      else yield* encodeHistoryJson(entry);
      yield "\n";
      id = entry.parentId;
    }
  }

  private pump(id: number, source: Source): void {
    source.timer = undefined;
    if (this.disposed || this.sources.get(id) !== source || source.waiting) return;
    try {
      const deadline = performance.now() + SLICE_MS;
      let text = "", done = false;
      while (text.length < HISTORY_SOURCE_CHARS && performance.now() < deadline) {
        if (!source.rest) {
          const part = source.iterator.next();
          if (part.done) { done = true; break; }
          source.rest = part.value;
        }
        const count = Math.min(HISTORY_SOURCE_CHARS - text.length, source.rest.length);
        text += source.rest.slice(0, count);
        source.rest = source.rest.slice(count);
      }
      source.waiting = !done;
      this.send({ type: "sourceChunk", id, text, done });
      if (done) this.closeSource(id);
    } catch (error) {
      this.send({ type: "sourceChunk", id, error: error instanceof Error ? error.message.slice(0, 240) : "Could not read history" });
      this.closeSource(id);
    }
  }

  private closeSource(id: number): void {
    const source = this.sources.get(id);
    if (!source) return;
    clearTimeout(source.timer);
    source.iterator.return(undefined);
    this.sources.delete(id);
  }

  private fail(error: Error): void {
    if (this.disposed || this.failure) return;
    this.failure = error;
    this.stop(error);
    this.failed(error);
  }

  private stop(error: Error): void {
    clearTimeout(this.launch); this.launch = undefined;
    const worker = this.worker; this.worker = undefined;
    for (const id of this.sources.keys()) this.closeSource(id);
    for (const job of this.jobs.values()) job.reject(error);
    this.jobs.clear(); this.kinds.clear();
    if (worker) void worker.terminate().catch(() => {});
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stop(cancelled());
  }
}
