import * as host from "@earendil-works/pi-coding-agent";
import { Container, Spacer, Text, stripTerminalSequences, type Component, type TUI } from "@earendil-works/pi-tui";
import { randomUUID } from "node:crypto";
import { label, type Anchor, type Prompt } from "./model.ts";
import { ArchivedHistory } from "./archive.ts";

type Entry = host.SessionEntry;
interface NativeFields {
  text?: unknown;
  skillBlock?: Partial<host.ParsedSkillBlock>;
  lastMessage?: { timestamp?: unknown };
}
function nativeFields(component: Component): NativeFields {
  // SAFETY: Pi's private card fields are read-only here; every consumed field is checked at runtime.
  return component as unknown as NativeFields;
}
interface Boundary { component: Component; slot: number; signature: string; prompt: boolean }

export function userText(entry: Entry): string | undefined {
  if (entry.type !== "message" || entry.message.role !== "user") return undefined;
  const content = entry.message.content;
  return typeof content === "string" ? content : content.filter(c => c.type === "text").map(c => c.text).join("\n");
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
function entrySignature(entry: Entry): string | undefined {
  const text = userText(entry);
  if (text !== undefined && text.length) return signature(text);
  if (entry.type === "message" && entry.message.role === "assistant") return `assistant:${entry.message.timestamp}`;
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
  width = 0;
  prompts: Prompt[] = [];
  private branch: Entry[] = [];
  private signatures: (string | undefined)[] = [];
  private promptById = new Map<string, Prompt>();
  private supplements = new Map<string, Component>();
  private leaf: string | null | undefined;
  private rawChildren: Component[] = [];
  private archiveCache?: { key: string; count: number; lastId: string; component: ArchivedHistory; users: Map<Component, Prompt>; tools: Map<string, host.ToolExecutionComponent>; footer: Component };
  private preparationError?: Error;
  private owned = new Set<Component>();
  private bound = new Map<Component, { original: Component["render"]; wrapped: Component["render"]; own: boolean; token: number; id: string }>();
  private bindingPass = new Set<Component>();
  private tokenSerial = 0;
  private tokens = new Map<number, Prompt>();
  private collecting = false;
  private dirty = true;
  private disposed = false;
  private marker = `\x1b]777;pi-visible-scrollbar-${randomUUID()};`;
  private markerPattern = new RegExp(`${this.marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(s|e);(\\d+)\\x07`, "g");
  private originalRender: Component["render"];
  private wrappedRender: Component["render"];
  private hadOwnRender: boolean;
  private renderCache?: { width: number; marked: string[]; clean: string[] };

  constructor(private document: Component, private chat: Container, private ctx: host.ExtensionContext, private tui: TUI, private onError?: (error: unknown) => void) {
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

  private collectLines(rendered: string[], width: number): string[] {
    const cached = this.renderCache;
    let from = 0, oldEnd = cached?.marked.length ?? 0, end = rendered.length;
    if (cached?.width === width) {
      while (from < Math.min(oldEnd, end) && rendered[from] === cached.marked[from]) from++;
      if (from === oldEnd && from === end) return cached.clean;
      while (oldEnd > from && end > from && rendered[end - 1] === cached.marked[oldEnd - 1]) { oldEnd--; end--; }
      // A changed middle line must include both markers of the user card that encloses it.
      const first = this.anchors.find(anchor => anchor.end > from);
      if (first && first.row < from) from = first.row;
      const last = this.anchors.find(anchor => anchor.row < oldEnd && anchor.end > oldEnd);
      if (last) { end += last.end - oldEnd; oldEnd = last.end; }
    }
    const found = new Map<number, Anchor>();
    const middle = rendered.slice(from, end).map((line, index) => {
      if (!line.includes(this.marker)) return line;
      const row = from + index;
      return line.replace(this.markerPattern, (_match, side: string, key: string) => {
        const token = Number(key), prompt = this.tokens.get(token);
        if (prompt) {
          if (side === "s") found.set(token, { ...prompt, row, end: row + 1 });
          else { const anchor = found.get(token); if (anchor) anchor.end = row + 1; }
        }
        return "";
      });
    });
    const clean = (cached?.clean.slice(0, from) ?? []).concat(middle, cached?.clean.slice(oldEnd) ?? []);
    const delta = end - oldEnd;
    const anchors = (cached ? this.anchors.filter(anchor => anchor.end <= from) : []).concat(
      [...found.values()],
      cached ? this.anchors.filter(anchor => anchor.row >= oldEnd).map(anchor => delta ? { ...anchor, row: anchor.row + delta, end: anchor.end + delta } : anchor) : [],
    );
    if (anchors.length !== this.anchors.length || anchors.some((anchor, i) => anchor.id !== this.anchors[i].id || anchor.row !== this.anchors[i].row || anchor.end !== this.anchors[i].end)) this.anchors = anchors;
    this.lines = clean;
    this.width = width;
    this.renderCache = { width, marked: rendered.slice(), clean };
    return clean;
  }

  get isPending(): boolean { return this.archiveCache?.component.isPending ?? false; }
  invalidate(): void { this.dirty = true; }

  private bind(component: Component, prompt: Prompt): void {
    this.bindingPass.add(component);
    const previous = this.bound.get(component);
    if (previous?.id === prompt.id && component.render === previous.wrapped) return;
    if (previous) this.unbind(new Set([...this.bound.keys()].filter(c => c !== component)));
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

  private unbind(keep?: ReadonlySet<Component>): void {
    for (const [component, binding] of this.bound) {
      if (keep?.has(component)) continue;
      if (component.render === binding.wrapped) {
        if (binding.own) component.render = binding.original;
        else delete (component as Partial<Component>).render;
      }
      this.bound.delete(component);
      this.tokens.delete(binding.token);
      this.renderCache = undefined;
    }
  }

  private makeUser(entry: Entry, prompt: Prompt): Component {
    const group = new Container();
    const text = userText(entry) ?? prompt.text;
    const skill = host.parseSkillBlock(text);
    if (skill) {
      group.addChild(new host.SkillInvocationMessageComponent(skill));
      if (skill.userMessage) group.addChild(new host.UserMessageComponent(skill.userMessage));
    } else group.addChild(new host.UserMessageComponent(prompt.text));
    this.bind(group, prompt);
    return group;
  }

  private archive(entries: Entry[], prompts: Map<string, Prompt>): Container {
    // Session entries are immutable, and the final ID identifies its entire parent chain.
    const key = `${entries.length}:${entries.at(-1)?.id ?? ""}`;
    if (this.archiveCache?.key === key) {
      for (const [component, prompt] of this.archiveCache.users) this.bind(component, prompt);
      return this.archiveCache.component;
    }
    if (!entries.some(e => userText(e) !== undefined)) {
      this.archiveCache?.component.dispose();
      this.archiveCache = undefined;
      return new Container();
    }
    const previous = this.archiveCache;
    const extending = previous && entries.length > previous.count && entries[previous.count - 1]?.id === previous.lastId;
    const archive = extending ? previous.component : new ArchivedHistory(
      () => this.collecting,
      render => { const wasCollecting = this.collecting; this.collecting = true; try { return render(); } finally { this.collecting = wasCollecting; } },
      () => { if (!this.disposed) this.tui.requestRender(); },
      error => { if (!this.disposed) { this.preparationError = error instanceof Error ? error : new Error(String(error)); this.tui.requestRender(); } },
    );
    const users = extending ? previous.users : new Map<Component, Prompt>();
    const tools = extending ? previous.tools : new Map<string, host.ToolExecutionComponent>();
    if (extending) {
      archive.removeChild(previous.footer);
      for (const [component, prompt] of users) this.bind(component, prompt);
    } else {
      previous?.component.dispose();
      archive.addChild(new Text(" Earlier history · read-only · model context unchanged", 0, 1));
    }
    for (const entry of entries.slice(extending ? previous.count : 0)) {
      const prompt = prompts.get(entry.id);
      if (prompt) {
        const component = this.makeUser(entry, prompt);
        users.set(component, prompt);
        archive.addChild(component);
        continue;
      }
      for (const message of host.sessionEntryToContextMessages(entry)) {
        if (message.role === "assistant") {
          archive.addChild(new host.AssistantMessageComponent(message, true));
          for (const content of message.content) {
            if (content.type !== "toolCall") continue;
            // An empty renderer selects Pi's expandable fallbacks, not its legacy full-output path.
            const tool = new host.ToolExecutionComponent(content.name, content.id, content.arguments, { showImages: false }, {}, this.tui, this.ctx.cwd);
            tool.setExpanded(this.ctx.ui.getToolsExpanded());
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
    const footer = new Text(" End of earlier history", 0, 1);
    archive.addChild(footer);
    this.archiveCache = { key, count: entries.length, lastId: entries.at(-1)!.id, component: archive, users, tools, footer };
    return archive;
  }

  private sync(): void {
    if (this.disposed) return;
    if (this.preparationError) throw this.preparationError;
    const leaf = this.ctx.sessionManager.getLeafId();
    const raw = this.chat.children.filter(c => !this.owned.has(c));
    const changed = raw.length !== this.rawChildren.length || raw.some((c, i) => c !== this.rawChildren[i]);
    if (!this.dirty && leaf === this.leaf && !changed) return;
    const branch = this.ctx.sessionManager.getBranch();
    const appendOnly = this.branch.length <= branch.length && this.branch.every((entry, i) => entry.id === branch[i].id);
    this.dirty = false;
    this.leaf = leaf;
    if (appendOnly && branch.length === this.branch.length && !changed) return;
    const from = appendOnly ? this.branch.length : 0;
    if (!appendOnly) { this.promptById.clear(); this.signatures = []; }
    const added: Prompt[] = [];
    for (let i = from; i < branch.length; i++) {
      const prompt = promptFor(branch[i], i);
      if (prompt) { added.push(prompt); this.promptById.set(prompt.id, prompt); }
      this.signatures.push(entrySignature(branch[i]));
    }
    if (!appendOnly || added.length) this.prompts = [...(appendOnly ? this.prompts : []), ...added];
    this.branch = branch;
    this.rawChildren = raw;
    const prompts = this.promptById;
    this.bindingPass.clear();
    this.chat.children = raw.slice();
    this.owned.clear();
    const native = boundaries(raw);
    const signatures = this.signatures;
    const matches: { boundary: Boundary; index: number }[] = [];
    let cursor = this.branch.length - 1;
    // Backward matching distinguishes repeated identical prompts in a retained suffix.
    for (let i = native.length - 1; i >= 0; i--) {
      const boundary = native[i];
      let index = cursor;
      while (index >= 0 && signatures[index] !== boundary.signature) index--;
      if (index < 0) continue; // A streaming card can precede persistence of its entry.
      matches.push({ boundary, index });
      cursor = index - 1;
      const prompt = prompts.get(this.branch[index].id);
      if (boundary.prompt && prompt) this.bind(boundary.component, prompt);
    }
    matches.sort((a, b) => a.index - b.index);
    const prefixEnd = matches[0]?.index ?? this.branch.length;
    const additions = new Map<number, Component[]>();
    const add = (slot: number, component: Component) => {
      this.owned.add(component);
      const list = additions.get(slot);
      if (list) list.push(component);
      else additions.set(slot, [component]);
    };
    const archive = this.archive(this.branch.slice(0, prefixEnd), prompts);
    if (archive.children.length) add(0, archive);
    const present = new Set(matches.filter(m => m.boundary.prompt).map(m => this.branch[m.index].id));
    const matched = new Set(matches.map(m => m.boundary));
    const streaming = native.filter(n => !matched.has(n) && n.signature.startsWith("assistant:"));
    let nextIndex = 0;
    for (const prompt of this.prompts) {
      if (prompt.entryIndex < prefixEnd || present.has(prompt.id)) continue;
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
    this.unbind(this.bindingPass);
    this.chat.children = raw.flatMap((component, i) => [...(additions.get(i) ?? []), component]);
    this.chat.children.push(...(additions.get(raw.length) ?? []));
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
    this.anchors = [];
    this.prompts = [];
    this.branch = [];
    this.signatures = [];
    this.rawChildren = [];
    this.promptById.clear();
    this.supplements.clear();
    this.bindingPass.clear();
    this.archiveCache = undefined;
    this.renderCache = undefined;
  }
}
