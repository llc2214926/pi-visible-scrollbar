import * as host from "@earendil-works/pi-coding-agent";
import { Container, Spacer, Text, stripTerminalSequences, type Component, type TUI } from "@earendil-works/pi-tui";
import { randomUUID } from "node:crypto";
import { anchorIndex, label, nearestAnchor, type Anchor, type LineChange, type Prompt } from "./model.ts";
import { ArchivedHistory } from "./archive.ts";
import { SessionBranch } from "./branch.ts";

const ARCHIVE_FRAME_MIN_ROWS = 8192;
type MouseChildren = { component: Component; height: number }[];
type RenderLines = ReturnType<Component["render"]>;

type Entry = host.SessionEntry;
interface NativeFields {
  text?: unknown;
  skillBlock?: Partial<host.ParsedSkillBlock>;
  lastMessage?: { timestamp?: unknown };
  message?: { customType?: unknown; content?: unknown };
  status?: unknown;
  messageId?: unknown;
  markdownTransformers?: unknown;
  mouseLayout?: { width: number; children: MouseChildren };
  childLines?: { width: number; children: readonly Component[]; parts: readonly (readonly string[])[] };
}
function nativeFields(component: Component): NativeFields {
  // SAFETY: Only stock Container instances have their mouse layout published here.
  return component as unknown as NativeFields;
}
const mouseLayouts = new WeakMap<object, { width: number; children: MouseChildren }>();
function mouseLayout(component: Component) {
  const fields = nativeFields(component), layout = fields.childLines;
  if (!layout) return fields.mouseLayout;
  let cached = mouseLayouts.get(layout);
  if (!cached) {
    cached = { width: layout.width, children: layout.children.map((component, i) => ({ component, height: layout.parts[i].length })) };
    mouseLayouts.set(layout, cached);
  }
  return cached;
}
interface Boundary { component: Component; slot: number; signature: string; prompt: boolean }
interface RenderSpan { row: number; source: readonly string[]; run?: { from: number; end: number; first: number; next: number } }
interface NativeRender {
  original: Component["render"];
  wrapped: Component["render"];
  own: boolean;
  cacheable: boolean;
  widths: Map<number, RenderLines>;
  source?: RenderLines;
  restore: (() => void)[];
}
interface ArchiveState {
  key: string;
  count: number;
  built: number;
  lastId: string;
  component: ArchivedHistory;
  users: Map<Component, Prompt>;
  tools: Map<string, host.ToolExecutionComponent>;
  footer: Component;
}

export function userText(entry: Entry): string | undefined {
  if (entry.type !== "message" || entry.message.role !== "user") return undefined;
  const content = entry.message.content ?? [];
  // Pi joins text blocks without inserting separators when it creates the native card.
  return typeof content === "string" ? content : content.filter(c => c.type === "text").map(c => c.text).join("");
}
function attachments(entry: Entry): number {
  if (entry.type !== "message" || entry.message.role !== "user") return 0;
  const content = entry.message.content;
  return Array.isArray(content) ? content.filter(c => c.type === "image").length : 0;
}
function signature(text: string): string {
  const skill = host.parseSkillBlock(text);
  return skill ? `skill:${JSON.stringify([skill.name, skill.content, skill.userMessage])}` : `user:${text}`;
}
function customSignature(customType: string, content: unknown): string {
  return `custom:${JSON.stringify([customType, content])}`;
}
function bashSignature(command: string, output: string): string {
  // Native bash cards remove terminal escapes and normalize line endings.
  return `bash:${JSON.stringify([command, stripTerminalSequences(output).replace(/\r\n?/g, "\n")])}`;
}
function entrySignature(entry: Entry): string | undefined {
  if (entry.type === "custom_message") return customSignature(entry.customType, entry.content);
  const text = userText(entry);
  if (text !== undefined && text.length) return signature(text);
  if (entry.type === "message") {
    const message = entry.message;
    if (message.role === "assistant") return `assistant:${message.timestamp}`;
    if (message.role === "custom") return customSignature(message.customType, message.content);
    if (message.role === "bashExecution") return bashSignature(message.command, message.output);
  }
  return undefined;
}
function promptFor(entry: Entry, index: number): Prompt | undefined {
  const text = userText(entry);
  if (text === undefined) return undefined;
  const images = attachments(entry);
  const display = text || (images ? `[Image input: ${images} attachment${images === 1 ? "" : "s"}]` : "[Empty input]");
  const skill = host.parseSkillBlock(text);
  return { id: entry.id, entryIndex: index, text: display, label: label(skill ? `/skill:${skill.name} ${skill.userMessage ?? ""}` : display) };
}

function skillCard(component: Component): Pick<host.ParsedSkillBlock, "name" | "content" | "userMessage"> | undefined {
  if (!(component instanceof host.SkillInvocationMessageComponent)) return undefined;
  const block = nativeFields(component).skillBlock;
  if (typeof block?.name === "string" && typeof block.content === "string" &&
      (block.userMessage === undefined || typeof block.userMessage === "string")) {
    return { name: block.name, content: block.content, userMessage: block.userMessage };
  }
  return undefined;
}

// Recognize native cards, not OSC133: Pi also marks assistant replies with OSC133.
function boundaries(children: readonly Component[]): Boundary[] {
  const result: Boundary[] = [];
  function visit(component: Component, slot: number): void {
    if (component instanceof host.UserMessageComponent) {
      const text = nativeFields(component).text;
      if (typeof text === "string") result.push({ component, slot, signature: `user:${text}`, prompt: true });
    } else if (component instanceof host.SkillInvocationMessageComponent) {
      const skill = skillCard(component);
      if (skill) result.push({ component, slot, signature: `skill:${JSON.stringify([skill.name, skill.content, skill.userMessage])}`, prompt: true });
    } else if (component instanceof host.AssistantMessageComponent) {
      const message = nativeFields(component).lastMessage;
      if (typeof message?.timestamp === "number") result.push({ component, slot, signature: `assistant:${message.timestamp}`, prompt: false });
    } else if (component instanceof host.CustomMessageComponent) {
      const message = nativeFields(component).message;
      if (typeof message?.customType === "string" && (typeof message.content === "string" || Array.isArray(message.content))) {
        result.push({ component, slot, signature: customSignature(message.customType, message.content), prompt: false });
      }
    } else if (component instanceof host.BashExecutionComponent) {
      // A running command is not persisted yet, even if its output matches an older command.
      const status = nativeFields(component).status;
      if (status === "complete" || status === "cancelled" || status === "error") {
        result.push({ component, slot, signature: bashSignature(component.getCommand(), component.getOutput()), prompt: false });
      }
    } else if (component.constructor === Container) {
      const list = (component as Container).children;
      for (let i = 0; i < list.length; i++) {
        visit(list[i], slot);
        if (skillCard(list[i])?.userMessage) {
          while (list[i + 1] instanceof Spacer) i++;
          if (list[i + 1] instanceof host.UserMessageComponent) i++;
        }
      }
    }
  }
  for (let i = 0; i < children.length; i++) {
    visit(children[i], i);
    if (skillCard(children[i])?.userMessage) {
      while (children[i + 1] instanceof Spacer) i++;
      if (children[i + 1] instanceof host.UserMessageComponent) i++;
    }
  }
  return result;
}

/** Display-only supplementation. Never writes session entries or changes the active leaf. */
export class History {
  anchors: Anchor[] = [];
  lines: readonly string[] = [];
  lineChange?: LineChange;
  width = 0;
  prompts: Prompt[] = [];
  private ancestry = new SessionBranch();
  private get branch(): Entry[] { return this.ancestry.entries; }
  private signatures: (string | undefined)[] = [];
  private signaturePositions = new Map<string, number[]>();
  private promptById = new Map<string, Prompt>();
  private promptRanks = new Map<string, number>();
  private supplements = new Map<string, Component>();
  private leaf: string | null | undefined;
  private rawChildren: Component[] = [];
  private childrenAtSync?: Component[];
  private childrenLength = -1;
  private rawChanged = false;
  private observingRaw = false;
  private rawCursor = 0;
  private nativeSourcesChanged = true;
  private chatHeight = -1;
  private spanOffset = -1;
  private nativeRenderers = new Map<Component, NativeRender>();
  private originalChatRender: Component["render"];
  private wrappedChatRender: Component["render"];
  private restoreChat: (() => void)[] = [];
  private archiveCache?: ArchiveState;
  private preparationError?: Error;
  private hideThinkingBlock = false;
  private owned = new Set<Component>();
  private bound = new Map<Component, { original: Component["render"]; wrapped: Component["render"]; own: boolean; token: number; id: string; marked?: string[]; clear: () => void }>();
  private bindingPass = new Set<Component>();
  private nativeBound = new Set<Component>();
  private tokenSerial = 0;
  private tokens = new Map<number, Prompt>();
  private collecting = false;
  private dirty = true;
  private disposed = false;
  private marker = `\x1b]777;pi-visible-scrollbar-${randomUUID()};`;
  private archiveMarker = `${this.marker}a\x07`;
  private markerPattern = new RegExp(`${this.marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(s|e);(\\d+)\\x07`, "g");
  private originalRender: Component["render"];
  private wrappedRender: Component["render"];
  private hadOwnRender: boolean;
  private renderCache?: { width: number; marked: RenderLines; clean: string[]; archive?: { row: number; source: readonly string[] }; spans?: RenderSpan[]; spanOffset?: number };
  private anchorById = new Map<string, Anchor>();
  private frameCache?: Map<number, string[]>;

  constructor(private document: Component, private chat: Container, private ctx: host.ExtensionContext, private tui: TUI, private onError?: (error: unknown) => void, private getHideThinkingBlock: () => boolean = () => false) {
    this.originalRender = document.render;
    this.hadOwnRender = Object.hasOwn(document, "render");
    this.originalChatRender = chat.render;
    const ownChat = Object.getOwnPropertyDescriptor(chat, "render");
    this.wrappedChatRender = width => {
      this.observingRaw = this.collecting && this.originalChatRender === Container.prototype.render;
      this.rawCursor = 0;
      this.rawChanged = false;
      this.nativeSourcesChanged = false;
      try {
        const lines = this.originalChatRender.call(chat, width);
        if (this.collecting) {
          if (lines.length !== this.chatHeight) this.nativeSourcesChanged = true;
          this.chatHeight = lines.length;
        }
        return lines;
      }
      finally {
        if (this.observingRaw && this.rawCursor !== this.rawChildren.length) this.rawChanged = true;
        this.observingRaw = false;
      }
    };
    chat.render = this.wrappedChatRender;
    this.restoreChat.push(() => {
      if (chat.render !== this.wrappedChatRender) return;
      if (ownChat) Object.defineProperty(chat, "render", ownChat);
      else delete (chat as Partial<Container>).render;
    });
    for (const key of ["addChild", "removeChild", "clear"] as const) {
      const original = chat[key], own = Object.getOwnPropertyDescriptor(chat, key);
      const wrapped = (...args: Component[]) => { this.invalidate(); return original.apply(chat, args as [Component]); };
      chat[key] = wrapped;
      this.restoreChat.push(() => {
        if (chat[key] !== wrapped) return;
        if (own) Object.defineProperty(chat, key, own);
        else delete (chat as Partial<Container>)[key];
      });
    }
    this.wrappedRender = (width) => {
      const ready = this.frameCache?.get(width);
      if (ready && this.width === width && this.lines === ready) return ready;
      try { this.sync(); }
      catch (error) { return this.restoreOnError(error, width); }
      this.collecting = true;
      let rendered: RenderLines;
      try {
        const archive = this.readyArchiveForFrame();
        rendered = archive ? this.renderArchivedDocument(width, archive) : this.originalRender.call(document, width);
        // Validate topology during Pi's existing child traversal, not with another scan on every key.
        if (this.rawChanged && chat.render === this.wrappedChatRender) {
          try {
            this.dirty = true;
            this.sync();
            const archive = this.readyArchiveForFrame();
            rendered = archive ? this.renderArchivedDocument(width, archive) : this.originalRender.call(document, width);
            if (this.rawChanged) throw new Error("Transcript components changed while rendering");
          } catch (error) { return this.restoreOnError(error, width); }
        }
      }
      finally { this.collecting = false; }
      const lines = this.collectLines(rendered, width);
      this.frameCache?.set(width, lines);
      return lines;
    };
    document.render = this.wrappedRender;
  }

  private restoreOnError(error: unknown, width: number): RenderLines {
    this.collecting = false;
    this.dispose();
    if (!this.onError) throw error;
    this.onError(error);
    return this.originalRender.call(this.document, width);
  }

  beginFrame(): void { this.frameCache = new Map(); }
  endFrame(): void { this.frameCache = undefined; }

  private readyArchiveForFrame(): ArchivedHistory | undefined {
    const archive = this.archiveCache?.component;
    // Pi 1.6.0 已缓存原生子布局；沿用宿主合成，避免写入已移除的 mouseLayout。
    if ("childLines" in nativeFields(this.document)) return undefined;
    if (!this.frameCache || !archive || (archive.collectedLines?.length ?? 0) < ARCHIVE_FRAME_MIN_ROWS ||
        this.originalRender !== Container.prototype.render || this.originalChatRender !== Container.prototype.render ||
        this.document.constructor !== Container || this.chat.constructor !== Container ||
        this.chat.render !== this.wrappedChatRender || archive.render !== ArchivedHistory.prototype.render ||
        this.chat.children[0] !== archive) return undefined;
    return archive;
  }

  private renderArchivedDocument(width: number, archive: ArchivedHistory): RenderLines {
    const document = this.document as Container;
    // Like Container.render, call children in order and publish immediate-child hit heights.
    // Keep the immutable archive separate until we know whether the flat document changed.
    const head: string[] = [], tail: string[] = [], documentChildren: MouseChildren = [];
    let source: readonly string[] | undefined;
    for (const component of document.children) {
      if (component !== this.chat || component.render !== this.wrappedChatRender || source) {
        const lines = component.render(width);
        documentChildren.push({ component, height: lines.length });
        for (const line of lines) (source ? tail : head).push(line);
        continue;
      }

      const chatChildren: MouseChildren = [];
      this.observingRaw = true;
      this.rawCursor = 0;
      this.rawChanged = false;
      this.nativeSourcesChanged = false;
      let height = 0;
      try {
        for (const child of this.chat.children) {
          const lines = child.render(width);
          chatChildren.push({ component: child, height: lines.length });
          height += lines.length;
          if (child === archive && chatChildren.length === 1 && lines === archive.collectedLines) source = lines;
          else for (const line of lines) (source ? tail : head).push(line);
        }
        if (height !== this.chatHeight) this.nativeSourcesChanged = true;
        this.chatHeight = height;
        nativeFields(this.chat).mouseLayout = { width, children: chatChildren };
      } finally {
        if (this.rawCursor !== this.rawChildren.length) this.rawChanged = true;
        this.observingRaw = false;
      }
      documentChildren.push({ component, height });
    }
    nativeFields(document).mouseLayout = { width, children: documentChildren };
    if (!source) return head;

    const cached = this.renderCache, after = head.length + source.length;
    if (cached?.archive?.source === source && cached.archive.row === head.length &&
        cached.marked.length === after + tail.length &&
        head.every((line, i) => line === cached.marked[i]) && tail.every((line, i) => line === cached.marked[after + i])) {
      return cached.marked;
    }
    return head.concat(source, tail);
  }

  private archiveSpan(rendered: readonly string[]): { row: number; source: readonly string[] } | undefined {
    const archive = this.archiveCache?.component, source = archive?.collectedLines;
    // Only native concatenation guarantees that our immutable block is copied verbatim.
    // A foreign renderer keeps the fully checked path, even if it preserves the boundary marker.
    if (!source?.length || this.originalRender !== Container.prototype.render || this.chat.render !== this.wrappedChatRender ||
        this.originalChatRender !== Container.prototype.render || archive?.render !== ArchivedHistory.prototype.render) return undefined;
    const row = rendered.indexOf(source[0]);
    if (row >= 0 && rendered[row + source.length - 1] === source[source.length - 1]) return { row, source };
    return undefined;
  }

  private nativeSpans(rendered: readonly string[], width: number): RenderSpan[] {
    this.spanOffset = -1;
    if (this.originalRender !== Container.prototype.render || this.chat.render !== this.wrappedChatRender ||
        this.originalChatRender !== Container.prototype.render) return [];
    const document = mouseLayout(this.document), chat = mouseLayout(this.chat);
    if (document?.width !== width || chat?.width !== width || !Array.isArray(document.children) || !Array.isArray(chat.children)) return [];
    let offset = 0;
    let foundChat = false;
    for (const child of document.children) {
      if (child.component === this.chat) { foundChat = true; break; }
      if (!Number.isInteger(child.height) || child.height < 0) return [];
      offset += child.height;
    }
    if (!foundChat) return [];
    this.spanOffset = offset;
    const cached = this.renderCache;
    if (!this.nativeSourcesChanged && cached?.width === width && cached.spanOffset === offset && cached.spans) return cached.spans;
    const spans: RenderSpan[] = [];
    for (const child of chat.children) {
      if (!Number.isInteger(child.height) || child.height < 0) return [];
      const state = this.nativeRenderers.get(child.component), binding = this.bound.get(child.component);
      const source = state?.cacheable && state.widths.get(width) === state.source &&
        (child.component.render === state.wrapped || child.component.render === binding?.wrapped)
        ? binding?.marked ?? state.source : undefined;
      if (source?.length === child.height && source.length && rendered[offset] === source[0] &&
          rendered[offset + source.length - 1] === source[source.length - 1]) spans.push({ row: offset, source });
      offset += child.height;
    }
    let run: RenderSpan["run"];
    for (let i = 0; i < spans.length; i++) {
      const span = spans[i];
      if (!run || run.end !== span.row) run = { from: span.row, end: span.row, first: i, next: i };
      run.end += span.source.length; run.next = i + 1;
      span.run = run;
    }
    return spans;
  }

  private collectLines(rendered: RenderLines, width: number): string[] {
    const cached = this.renderCache, archive = this.archiveSpan(rendered), spans = this.nativeSpans(rendered, width);
    const sameArchive = archive && cached?.archive?.source === archive.source;
    let from = cached?.marked === rendered ? rendered.length : 0, oldEnd = cached?.marked.length ?? 0, end = rendered.length;
    if (cached) {
      const previous = cached.spans ?? [];
      let nextSpan = 0, oldSpan = 0;
      while (from < Math.min(oldEnd, end)) {
        while (nextSpan < spans.length && spans[nextSpan].row < from) nextSpan++;
        while (oldSpan < previous.length && previous[oldSpan].row < from) oldSpan++;
        const next = spans[nextSpan], old = previous[oldSpan];
        if (spans === previous && next?.row === from && next.run) {
          from = next.run.end; nextSpan = oldSpan = next.run.next;
        } else if (next?.row === from && old?.row === from && next.source === old.source) from += next.source.length;
        else if (sameArchive && from === archive.row && from === cached.archive!.row) from += archive.source.length;
        else if (rendered[from] === cached.marked[from]) from++;
        else break;
      }
      if (from === oldEnd && from === end) {
        cached.archive = archive; cached.spans = spans; cached.spanOffset = this.spanOffset; cached.width = width; this.width = width;
        return cached.clean;
      }
      nextSpan = spans.length - 1; oldSpan = previous.length - 1;
      while (oldEnd > from && end > from) {
        while (nextSpan >= 0 && spans[nextSpan].row + spans[nextSpan].source.length > end) nextSpan--;
        while (oldSpan >= 0 && previous[oldSpan].row + previous[oldSpan].source.length > oldEnd) oldSpan--;
        const next = spans[nextSpan], old = previous[oldSpan];
        if (spans === previous && next?.run && next.run.from >= from && oldEnd === end &&
            next.row + next.source.length === end) {
          end = oldEnd = next.run.from; nextSpan = oldSpan = next.run.first - 1;
        } else if (next && old && next.row >= from && old.row >= from && next.row + next.source.length === end &&
            old.row + old.source.length === oldEnd && next.source === old.source) {
          end -= next.source.length; oldEnd -= old.source.length;
        } else if (sameArchive && archive.row >= from && end === archive.row + archive.source.length &&
            oldEnd === cached.archive!.row + archive.source.length) {
          end -= archive.source.length; oldEnd -= archive.source.length;
        } else if (rendered[end - 1] === cached.marked[oldEnd - 1]) { oldEnd--; end--; }
        else break;
      }
      // A changed middle line must include both markers of the user card that encloses it.
      const first = nearestAnchor(this.anchors, from);
      if (first && first.row < from && first.end > from) from = first.row;
      const last = nearestAnchor(this.anchors, oldEnd);
      if (last && last.row < oldEnd && last.end > oldEnd) { end += last.end - oldEnd; oldEnd = last.end; }
    }
    const found = new Map<number, Anchor>();
    const middle = rendered.slice(from, end).map((line, index) => {
      if (!line.includes(this.marker)) return line;
      const row = from + index;
      return line.replace(this.archiveMarker, "").replace(this.markerPattern, (_match, side: string, key: string) => {
        const token = Number(key), prompt = this.tokens.get(token);
        if (prompt) {
          if (side === "s") found.set(token, { ...prompt, row, end: row + 1 });
          else { const anchor = found.get(token); if (anchor) anchor.end = row + 1; }
        }
        return "";
      });
    });
    const clean = (cached?.clean.slice(0, from) ?? []).concat(middle, cached?.clean.slice(oldEnd) ?? []);
    this.updateAnchors([...found.values()], from, oldEnd, end - oldEnd, !!cached);
    // A minimap may skip an unchanged local window, without retaining another full-history array.
    this.lineChange = cached ? { previous: new WeakRef(cached.clean), from, oldEnd, end } : undefined;
    this.lines = clean;
    this.width = width;
    // Native Container allocates a new array every render. Other renderers may reuse mutable arrays.
    this.renderCache = { width, marked: this.originalRender === Container.prototype.render ? rendered : rendered.slice(), clean, archive, spans, spanOffset: this.spanOffset };
    return clean;
  }

  private updateAnchors(found: Anchor[], from: number, oldEnd: number, delta: number, cached: boolean): void {
    const before = cached ? anchorIndex(this.anchors, from) : 0;
    const after = cached ? anchorIndex(this.anchors, oldEnd) : this.anchors.length;
    if (found.length === after - before && (!delta || after === this.anchors.length) && found.every((anchor, i) => {
      const old = this.anchors[before + i];
      return anchor.id === old.id && anchor.row === old.row && anchor.end === old.end;
    })) return;
    for (let i = before; i < after; i++) this.anchorById.delete(this.anchors[i].id);
    const tail = this.anchors.slice(after).map(anchor => delta ? { ...anchor, row: anchor.row + delta, end: anchor.end + delta } : anchor);
    for (const anchor of found) this.anchorById.set(anchor.id, anchor);
    if (delta) for (const anchor of tail) this.anchorById.set(anchor.id, anchor);
    this.anchors = this.anchors.slice(0, before).concat(found, tail);
  }

  anchor(id: string): Anchor | undefined { return this.anchorById.get(id); }

  get isPending(): boolean { return this.archiveCache?.component.isPending ?? false; }
  invalidate(): void { this.dirty = true; this.frameCache?.clear(); }

  hasPrompt(id: string): boolean { return this.promptById.has(id); }
  promptRank(id: string): number { return this.promptRanks.get(id) ?? -1; }

  private bind(component: Component, prompt: Prompt, archived = false): void {
    if (!archived) { this.bindingPass.add(component); this.nativeBound.add(component); }
    const previous = this.bound.get(component);
    if (previous?.id === prompt.id && component.render === previous.wrapped) return;
    if (previous) this.unbind([component]);
    if (!archived) this.nativeBound.add(component);
    const original = component.render;
    const token = this.tokenSerial++;
    this.tokens.set(token, prompt);
    let cached: { source: readonly string[]; marked: string[] } | undefined;
    const wrapped = (width: number) => {
      const lines = original.call(component, width);
      if (this.disposed || !this.collecting || this.bound.get(component)?.wrapped !== wrapped || !lines.length) return lines;
      const trusted = this.nativeRenderers.get(component)?.widths.get(width) === lines;
      const prior = cached;
      if (prior && ((trusted && lines === prior.source) || (lines.length === prior.source.length && lines.every((line, i) => line === prior.source[i])))) {
        if (trusted) prior.source = lines;
        const binding = this.bound.get(component);
        if (binding) binding.marked = prior.marked;
        return prior.marked;
      }
      const marked = lines.slice();
      marked[0] = `${this.marker}s;${token}\x07${marked[0]}`;
      marked[marked.length - 1] += `${this.marker}e;${token}\x07`;
      cached = { source: trusted ? lines : lines.slice(), marked };
      const binding = this.bound.get(component);
      if (binding) binding.marked = marked;
      return marked;
    };
    this.bound.set(component, { original, wrapped, own: Object.hasOwn(component, "render"), token, id: prompt.id, clear: () => { cached = undefined; } });
    component.render = wrapped;
  }

  private unbind(components: Iterable<Component> = this.bound.keys()): void {
    for (const component of components) {
      const binding = this.bound.get(component);
      if (!binding) continue;
      if (component.render === binding.wrapped) {
        if (binding.own) component.render = binding.original;
        else delete (component as Partial<Component>).render;
      }
      binding.clear(); binding.marked = undefined;
      this.bound.delete(component);
      this.nativeBound.delete(component);
      this.tokens.delete(binding.token);
      this.renderCache = undefined;
    }
  }

  private makeUser(entry: Entry, prompt: Prompt, archived = false): Component {
    const group = new Container();
    const text = userText(entry) ?? prompt.text;
    const skill = host.parseSkillBlock(text);
    if (skill) {
      const component = new host.SkillInvocationMessageComponent(skill);
      component.setExpanded(this.ctx.ui.getToolsExpanded());
      group.addChild(component);
      if (skill.userMessage) group.addChild(new host.UserMessageComponent(skill.userMessage));
    } else group.addChild(new host.UserMessageComponent(prompt.text));
    this.bind(group, prompt, archived);
    return group;
  }

  private archive(entries: Entry[], count: number, prompts: Map<string, Prompt>): Container {
    // Session entries are immutable, and the final ID identifies its entire parent chain.
    const lastId = entries[count - 1]?.id ?? "", key = `${count}:${lastId}`;
    if (this.archiveCache?.key === key) return this.archiveCache.component;
    if (!this.prompts.length || this.prompts[0].entryIndex >= count) {
      this.releaseArchive();
      return new Container();
    }
    const previous = this.archiveCache;
    let state: ArchiveState;
    if (previous && count > previous.count && entries[previous.count - 1]?.id === previous.lastId) {
      state = previous;
      state.component.removeChild(state.footer);
      state.count = count; state.key = key; state.lastId = lastId;
    } else {
      this.releaseArchive();
      const component = new ArchivedHistory(
        () => this.collecting,
        render => { const wasCollecting = this.collecting; this.collecting = true; try { return render(); } finally { this.collecting = wasCollecting; } },
        () => { if (!this.disposed) this.tui.requestRender(); },
        error => { if (!this.disposed) { this.preparationError = error instanceof Error ? error : new Error(String(error)); this.tui.requestRender(); } },
        this.archiveMarker,
        this.hideThinkingBlock,
      );
      component.addChild(new Text(" Earlier history · read-only · model context unchanged", 0, 1));
      state = { key, count, built: 0, lastId, component, users: new Map(), tools: new Map(), footer: new Text(" End of earlier history", 0, 1) };
    }
    this.archiveCache = state;
    const next = () => {
      if (state.built === state.count) { state.component.addChild(state.footer); return false; }
      const entry = entries[state.built];
      this.appendArchived(entry, prompts.get(entry.id), state);
      state.built++;
      return true;
    };
    if (!state.component.isBuilding) {
      if (state.count - state.built > 512) state.component.populate(next);
      else while (next()) { /* Small updates stay synchronous. */ }
    }
    return state.component;
  }

  private appendArchived(entry: Entry, prompt: Prompt | undefined, { component: archive, users, tools }: ArchiveState): void {
    if (prompt) {
      const component = this.makeUser(entry, prompt, true);
      users.set(component, prompt);
      archive.addChild(component);
      return;
    }
    for (const message of host.sessionEntryToContextMessages(entry)) {
      if (message.role === "assistant") {
        archive.addChild(new host.AssistantMessageComponent(message, this.hideThinkingBlock));
        for (const content of message.content) {
          if (content.type !== "toolCall") continue;
          // An empty renderer selects Pi's expandable fallbacks, not its legacy full-output path.
          const tool = new host.ToolExecutionComponent(content.name, content.id, content.arguments, { showImages: false }, {}, this.tui, this.ctx.cwd);
          tool.setExpanded(this.ctx.ui.getToolsExpanded());
          if (message.stopReason === "aborted" || message.stopReason === "error") {
            const text = message.errorMessage || (message.stopReason === "aborted" ? "Operation aborted" : "Error");
            tool.updateResult({ content: [{ type: "text", text }], isError: true });
          }
          tools.set(content.id, tool);
          archive.addChild(tool);
        }
      } else if (message.role === "toolResult") {
        const tool = tools.get(message.toolCallId);
        if (tool) tool.updateResult(message);
        else archive.addChild(new Text(stripTerminalSequences(message.content.filter(c => c.type === "text").map(c => c.text).join("\n")), 1, 1));
      } else if (message.role === "custom" && message.display) {
        archive.addChild(new host.CustomMessageComponent(message));
      } else if (message.role === "bashExecution") {
        archive.addChild(new Text(stripTerminalSequences(`$ ${message.command}\n${message.output}`), 1, 1));
      }
    }
  }

  private releaseArchive(): void {
    if (!this.archiveCache) return;
    this.archiveCache.component.dispose();
    this.unbind(this.archiveCache.users.keys());
    this.archiveCache = undefined;
  }

  private match(signature: string, cursor: number): number {
    const positions = this.signaturePositions.get(signature);
    if (!positions) return -1;
    let low = 0, high = positions.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (positions[middle] <= cursor) low = middle + 1;
      else high = middle;
    }
    return positions[low - 1] ?? -1;
  }

  private indexBranch(from: number): void {
    const branch = this.branch;
    for (let i = this.signatures.length - 1; i >= from; i--) {
      const key = this.signatures[i];
      if (key === undefined) continue;
      const positions = this.signaturePositions.get(key)!;
      positions.pop();
      if (!positions.length) this.signaturePositions.delete(key);
    }
    this.signatures.length = from;
    let retained = this.prompts.length;
    while (retained && this.prompts[retained - 1].entryIndex >= from) {
      const id = this.prompts[--retained].id;
      this.promptById.delete(id);
      this.promptRanks.delete(id);
    }
    const added: Prompt[] = [];
    for (let i = from; i < branch.length; i++) {
      const prompt = promptFor(branch[i], i);
      if (prompt) {
        this.promptRanks.set(prompt.id, retained + added.length);
        added.push(prompt); this.promptById.set(prompt.id, prompt);
      }
      const key = entrySignature(branch[i]);
      this.signatures.push(key);
      if (key !== undefined) {
        const positions = this.signaturePositions.get(key);
        if (positions) positions.push(i);
        else this.signaturePositions.set(key, [i]);
      }
    }
    if (retained !== this.prompts.length || added.length) this.prompts = this.prompts.slice(0, retained).concat(added);
  }

  private watchNative(component: Component): void {
    const previous = this.nativeRenderers.get(component), binding = this.bound.get(component);
    if (previous && (component.render === previous.wrapped ||
        (component.render === binding?.wrapped && binding.original === previous.wrapped))) return;
    if (previous) { this.unbind([component]); this.releaseNative(component); }
    const original = component.render;
    const prototype = component.constructor === host.UserMessageComponent ? host.UserMessageComponent.prototype
      : component.constructor === host.AssistantMessageComponent ? host.AssistantMessageComponent.prototype : undefined;
    const transforms = prototype ? nativeFields(component).markdownTransformers : undefined;
    const state: NativeRender = {
      original, wrapped: original, own: Object.hasOwn(component, "render"),
      cacheable: !!prototype && original === prototype.render && !(Array.isArray(transforms) && transforms.length),
      widths: new Map(), restore: [],
    };
    const wrapped = (width: number) => {
      if (this.disposed || this.nativeRenderers.get(component) !== state) return original.call(component, width);
      if (this.observingRaw && this.rawChildren[this.rawCursor++] !== component) this.rawChanged = true;
      if (component.render !== wrapped) {
        const binding = this.bound.get(component);
        if (component.render !== binding?.wrapped || binding.original !== wrapped) {
          this.rawChanged = true; this.nativeSourcesChanged = true; state.cacheable = false; state.widths.clear(); state.source = undefined;
        }
      }
      if (state.cacheable) {
        const transforms = nativeFields(component).markdownTransformers;
        if (Array.isArray(transforms) && transforms.length) {
          state.cacheable = false; state.widths.clear(); state.source = undefined; this.nativeSourcesChanged = true;
        }
      }
      let lines = this.collecting && state.cacheable ? state.widths.get(width) : undefined;
      if (!lines) {
        lines = original.call(component, width);
        if (this.collecting && state.cacheable) {
          state.widths.set(width, lines);
          if (state.widths.size > 2) state.widths.delete(state.widths.keys().next().value!);
        }
      }
      if (this.collecting) {
        if (!state.source || (state.cacheable ? state.source !== lines : state.source.length !== lines.length)) this.nativeSourcesChanged = true;
        state.source = lines;
      }
      return lines;
    };
    state.wrapped = wrapped;
    this.nativeRenderers.set(component, state);
    if (state.cacheable) {
      type Mutation = "invalidate" | "addChild" | "removeChild" | "clear" | "rebuild" | "updateContent";
      // SAFETY: Only the native methods below are wrapped, after checking their function and descriptor capabilities.
      const mutations = component as unknown as Partial<Record<Mutation, (...args: unknown[]) => unknown>>;
      const methods: Mutation[] = ["invalidate", "addChild", "removeChild", "clear", prototype === host.UserMessageComponent.prototype ? "rebuild" : "updateContent"];
      for (const key of methods) {
        const method = mutations[key], own = Object.getOwnPropertyDescriptor(component, key);
        if (typeof method !== "function" || (own && !own.configurable && !own.writable)) { state.cacheable = false; continue; }
        const invalidate = (...args: unknown[]) => {
          state.widths.clear();
          this.frameCache?.clear();
          return method.apply(component, args);
        };
        mutations[key] = invalidate;
        state.restore.push(() => {
          if (mutations[key] !== invalidate) return;
          if (own) Object.defineProperty(component, key, own);
          else delete mutations[key];
        });
      }
    }
    component.render = wrapped;
  }

  private releaseNative(component: Component): void {
    const state = this.nativeRenderers.get(component);
    if (!state) return;
    this.nativeRenderers.delete(component);
    if (component.render === state.wrapped) {
      if (state.own) component.render = state.original;
      else delete (component as Partial<Component>).render;
    }
    for (const restore of state.restore.splice(0).reverse()) restore();
    state.widths.clear(); state.source = undefined;
  }

  private sync(): void {
    if (this.disposed) return;
    if (this.preparationError) throw this.preparationError;
    // Pi's native thinking toggle only visits top-level cards, not our archived descendants.
    const hidden = this.getHideThinkingBlock();
    if (hidden !== this.hideThinkingBlock) {
      this.hideThinkingBlock = hidden;
      this.archiveCache?.component.setHideThinkingBlock(hidden);
    }
    const leaf = this.ctx.sessionManager.getLeafId();
    if (!this.dirty && leaf === this.leaf && !this.rawChanged && this.chat.children === this.childrenAtSync &&
        this.chat.children.length === this.childrenLength && this.chat.render === this.wrappedChatRender &&
        this.originalChatRender === Container.prototype.render) return;
    const raw = this.chat.children.filter(c => !this.owned.has(c));
    const changed = this.rawChanged || raw.length !== this.rawChildren.length || raw.some((c, i) => c !== this.rawChildren[i]);
    this.rawChanged = false;
    const oldLength = this.signatures.length;
    const from = this.ancestry.sync(this.ctx.sessionManager);
    this.dirty = false;
    this.leaf = leaf;
    if (from === oldLength && this.branch.length === oldLength && !changed) {
      this.childrenAtSync = this.chat.children; this.childrenLength = this.chat.children.length;
      return;
    }
    this.indexBranch(from);
    this.rawChildren = raw;
    for (const component of raw) this.watchNative(component);
    const prompts = this.promptById;
    this.bindingPass.clear();
    this.chat.children = raw.slice();
    this.owned.clear();
    const native = boundaries(raw);
    const matches: { boundary: Boundary; index: number }[] = [];
    let cursor = this.branch.length - 1;
    // Backward matching distinguishes repeated identical prompts in a retained suffix.
    for (let i = native.length - 1; i >= 0; i--) {
      const boundary = native[i];
      const id = nativeFields(boundary.component).messageId;
      const identified = typeof id === "string" ? this.ancestry.indexOf(id) : undefined;
      const index = identified !== undefined && identified <= cursor && this.signatures[identified] === boundary.signature
        ? identified : this.match(boundary.signature, cursor);
      if (index < 0) continue; // A streaming card can precede persistence of its entry.
      matches.push({ boundary, index });
      cursor = index - 1;
      const prompt = prompts.get(this.branch[index].id);
      if (boundary.prompt && prompt) this.bind(boundary.component, prompt);
    }
    matches.reverse();
    const prefixEnd = matches[0]?.index ?? this.branch.length;
    const additions = new Map<number, Component[]>();
    const add = (slot: number, component: Component) => {
      this.owned.add(component);
      const list = additions.get(slot);
      if (list) list.push(component);
      else additions.set(slot, [component]);
    };
    const archive = this.archive(this.branch, prefixEnd, prompts);
    if (archive.children.length) add(0, archive);
    const present = new Set(matches.filter(m => m.boundary.prompt).map(m => this.branch[m.index].id));
    const matched = new Set(matches.map(m => m.boundary));
    const streaming = native.filter(n => !matched.has(n) && n.signature.startsWith("assistant:"));
    let firstPrompt = 0, lastPrompt = this.prompts.length;
    while (firstPrompt < lastPrompt) {
      const middle = (firstPrompt + lastPrompt) >>> 1;
      if (this.prompts[middle].entryIndex < prefixEnd) firstPrompt = middle + 1;
      else lastPrompt = middle;
    }
    let nextIndex = 0;
    for (let i = firstPrompt; i < this.prompts.length; i++) {
      const prompt = this.prompts[i];
      if (present.has(prompt.id)) continue;
      // Pi does not render image-only inputs. Walk the sorted matches once, not once per input.
      while (nextIndex < matches.length && matches[nextIndex].index <= prompt.entryIndex) nextIndex++;
      const next = matches[nextIndex];
      const entry = this.branch[prompt.entryIndex];
      const timestamp = entry.type === "message" ? entry.message.timestamp : Infinity;
      const pending = next ? undefined : streaming.find(n => Number(n.signature.slice(10)) >= timestamp);
      const component = this.supplements.get(prompt.id) ?? this.makeUser(entry, prompt);
      this.supplements.set(prompt.id, component);
      this.bind(component, prompt);
      add(next?.boundary.slot ?? pending?.slot ?? raw.length, component);
    }
    for (const [id, component] of this.supplements) if (!this.owned.has(component)) this.supplements.delete(id);
    for (const component of this.nativeBound) if (!this.bindingPass.has(component)) this.unbind([component]);
    const presentRaw = new Set(raw);
    for (const component of this.nativeRenderers.keys()) if (!presentRaw.has(component)) this.releaseNative(component);
    if (!additions.size) this.chat.children = raw;
    else {
      const children: Component[] = [];
      for (let i = 0; i <= raw.length; i++) {
        for (const component of additions.get(i) ?? []) children.push(component);
        if (i < raw.length) children.push(raw[i]);
      }
      this.chat.children = children;
    }
    this.childrenAtSync = this.chat.children; this.childrenLength = this.chat.children.length;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.archiveCache?.component.dispose();
    this.unbind();
    for (const component of this.nativeRenderers.keys()) this.releaseNative(component);
    for (const restore of this.restoreChat.reverse()) restore();
    this.chat.children = this.chat.children.filter(c => !this.owned.has(c));
    this.owned.clear();
    if (this.document.render === this.wrappedRender) {
      if (this.hadOwnRender) this.document.render = this.originalRender;
      else delete (this.document as Partial<Component>).render;
    }
    this.lines = [];
    this.lineChange = undefined;
    this.anchors = [];
    this.anchorById.clear();
    this.prompts = [];
    this.ancestry.clear();
    this.signatures = [];
    this.signaturePositions.clear();
    this.rawChildren = [];
    this.childrenAtSync = undefined;
    this.promptById.clear();
    this.promptRanks.clear();
    this.supplements.clear();
    this.bindingPass.clear();
    this.archiveCache = undefined;
    this.frameCache = undefined;
    this.renderCache = undefined;
  }
}
