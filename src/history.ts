import * as host from "@earendil-works/pi-coding-agent";
import { Container, Spacer, Text, stripTerminalSequences, type Component, type TUI } from "@earendil-works/pi-tui";
import { randomUUID } from "node:crypto";
import { anchorIndex, label, nearestAnchor, type Anchor, type LineChange, type Prompt } from "./model.ts";
import { ArchivedHistory } from "./archive.ts";
import { SessionBranch } from "./branch.ts";

type Entry = host.SessionEntry;
interface NativeFields {
  text?: unknown;
  skillBlock?: Partial<host.ParsedSkillBlock>;
  lastMessage?: { timestamp?: unknown };
  message?: { customType?: unknown; content?: unknown };
  status?: unknown;
}
function nativeFields(component: Component): NativeFields {
  // SAFETY: Pi's private card fields are read-only here; every consumed field is checked at runtime.
  return component as unknown as NativeFields;
}
interface Boundary { component: Component; slot: number; signature: string; prompt: boolean }
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
  private archiveCache?: ArchiveState;
  private preparationError?: Error;
  private hideThinkingBlock = false;
  private owned = new Set<Component>();
  private bound = new Map<Component, { original: Component["render"]; wrapped: Component["render"]; own: boolean; token: number; id: string }>();
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
  private renderCache?: { width: number; marked: string[]; clean: string[]; archive?: { row: number; source: readonly string[] } };
  private anchorById = new Map<string, Anchor>();

  constructor(private document: Component, private chat: Container, private ctx: host.ExtensionContext, private tui: TUI, private onError?: (error: unknown) => void, private getHideThinkingBlock: () => boolean = () => false) {
    this.originalRender = document.render;
    this.hadOwnRender = Object.hasOwn(document, "render");
    this.wrappedRender = (width) => {
      try { this.sync(); }
      catch (error) {
        this.dispose();
        if (!this.onError) throw error;
        this.onError(error);
        return this.originalRender.call(document, width);
      }
      this.collecting = true;
      let rendered: string[];
      try { rendered = this.originalRender.call(document, width); }
      finally { this.collecting = false; }
      return this.collectLines(rendered, width);
    };
    document.render = this.wrappedRender;
  }

  private archiveSpan(rendered: readonly string[]): { row: number; source: readonly string[] } | undefined {
    const archive = this.archiveCache?.component, source = archive?.collectedLines;
    // Only native concatenation guarantees that our immutable block is copied verbatim.
    // A foreign renderer keeps the fully checked path, even if it preserves the boundary marker.
    if (!source?.length || this.originalRender !== Container.prototype.render || this.chat.render !== Container.prototype.render ||
        archive?.render !== ArchivedHistory.prototype.render) return undefined;
    const row = rendered.indexOf(source[0]);
    if (row >= 0 && rendered[row + source.length - 1] === source[source.length - 1]) return { row, source };
    return undefined;
  }

  private collectLines(rendered: string[], width: number): string[] {
    const cached = this.renderCache, archive = this.archiveSpan(rendered);
    const sameArchive = archive && cached?.archive?.source === archive.source;
    let from = 0, oldEnd = cached?.marked.length ?? 0, end = rendered.length;
    if (cached) {
      while (from < Math.min(oldEnd, end)) {
        if (sameArchive && from === archive.row && from === cached.archive!.row) from += archive.source.length;
        else if (rendered[from] === cached.marked[from]) from++;
        else break;
      }
      if (from === oldEnd && from === end) {
        cached.archive = archive; cached.width = width; this.width = width;
        return cached.clean;
      }
      while (oldEnd > from && end > from) {
        if (sameArchive && archive.row >= from && end === archive.row + archive.source.length &&
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
    this.renderCache = { width, marked: this.originalRender === Container.prototype.render ? rendered : rendered.slice(), clean, archive };
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
  invalidate(): void { this.dirty = true; }

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
    let cached: { source: string[]; marked: string[] } | undefined;
    const wrapped = (width: number) => {
      const lines = original.call(component, width);
      if (!this.collecting || !lines.length) return lines;
      if (cached && lines.length === cached.source.length && lines.every((line, i) => line === cached!.source[i])) return cached.marked;
      const marked = lines.slice();
      marked[0] = `${this.marker}s;${token}\x07${marked[0]}`;
      marked[marked.length - 1] += `${this.marker}e;${token}\x07`;
      cached = { source: lines.slice(), marked };
      return marked;
    };
    this.bound.set(component, { original, wrapped, own: Object.hasOwn(component, "render"), token, id: prompt.id });
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
    const raw = this.chat.children.filter(c => !this.owned.has(c));
    const changed = raw.length !== this.rawChildren.length || raw.some((c, i) => c !== this.rawChildren[i]);
    if (!this.dirty && leaf === this.leaf && !changed) return;
    const oldLength = this.signatures.length;
    const from = this.ancestry.sync(this.ctx.sessionManager);
    this.dirty = false;
    this.leaf = leaf;
    if (from === oldLength && this.branch.length === oldLength && !changed) return;
    this.indexBranch(from);
    this.rawChildren = raw;
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
      const index = this.match(boundary.signature, cursor);
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
    if (!additions.size) this.chat.children = raw;
    else {
      const children: Component[] = [];
      for (let i = 0; i <= raw.length; i++) {
        for (const component of additions.get(i) ?? []) children.push(component);
        if (i < raw.length) children.push(raw[i]);
      }
      this.chat.children = children;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.archiveCache?.component.dispose();
    this.unbind();
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
    this.promptById.clear();
    this.promptRanks.clear();
    this.supplements.clear();
    this.bindingPass.clear();
    this.archiveCache = undefined;
    this.renderCache = undefined;
  }
}
