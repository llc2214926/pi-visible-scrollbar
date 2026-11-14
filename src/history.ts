import * as host from "@earendil-works/pi-coding-agent";
import { Container, Spacer, Text, stripTerminalSequences, type Component, type TUI, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { randomUUID } from "node:crypto";
import { label, type Anchor, type Prompt } from "./model.ts";

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

class ArchivedHistory extends Container {
  private cached?: { width: number; lines: string[] };
  constructor(private collecting: () => boolean) { super(); }
  clearCache(): void { this.cached = undefined; }
  invalidate(): void { this.clearCache(); super.invalidate(); }
  render(width: number): string[] {
    // Archived entries are immutable; expansions and theme/mouse changes invalidate this display cache.
    // Never reuse private anchor markers outside the document's collection pass.
    if (!this.collecting()) { this.clearCache(); return super.render(width); }
    if (this.cached?.width === width) return this.cached.lines;
    const lines = super.render(width);
    this.cached = { width, lines };
    return lines;
  }
  addChild(component: Component): void {
    const watch = (child: Component) => {
      if (child instanceof host.ToolExecutionComponent || child instanceof host.SkillInvocationMessageComponent || child instanceof host.CustomMessageComponent) {
        const original = child.setExpanded;
        child.setExpanded = expanded => { this.clearCache(); original.call(child, expanded); };
      } else if (child.constructor === Container) (child as Container).children.forEach(watch);
    };
    watch(component); this.clearCache(); super.addChild(component);
  }
  handleMouse(event: TuiMouseEvent) {
    const result = super.handleMouse(event);
    if (event.type !== "move" || (result && result.render !== false)) this.clearCache();
    return result;
  }
  setExpanded(expanded: boolean): void {
    this.clearCache();
    const visit = (component: Component) => {
      if (component instanceof host.ToolExecutionComponent || component instanceof host.SkillInvocationMessageComponent || component instanceof host.CustomMessageComponent) component.setExpanded(expanded);
      else if (component.constructor === Container) (component as Container).children.forEach(visit);
    };
    this.children.forEach(visit);
  }
}

/** Display-only supplementation. Never writes session entries or changes the active leaf. */
export class History {
  anchors: Anchor[] = [];
  lines: readonly string[] = [];
  width = 0;
  prompts: Prompt[] = [];
  private branch: Entry[] = [];
  private leaf: string | null | undefined;
  private rawChildren: Component[] = [];
  private archiveCache?: { key: string; component: ArchivedHistory; users: Map<Component, Prompt> };
  private owned = new Set<Component>();
  private bound = new Map<Component, { original: Component["render"]; wrapped: Component["render"]; own: boolean }>();
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
      const cached = this.renderCache;
      if (cached?.width === width && rendered.length === cached.marked.length && rendered.every((line, i) => line === cached.marked[i])) return cached.clean;
      const found = new Map<number, Anchor>();
      const clean = rendered.map((line, row) => {
        if (!line.includes(this.marker)) return line;
        return line.replace(this.markerPattern, (_match, side: string, key: string) => {
          const token = Number(key), prompt = this.tokens.get(token);
          if (prompt) {
            if (side === "s") found.set(token, { ...prompt, row, end: row + 1 });
            else { const anchor = found.get(token); if (anchor) anchor.end = row + 1; }
          }
          return "";
        });
      });
      this.anchors = [...found.values()].sort((a, b) => a.row - b.row);
      this.lines = clean;
      this.width = width;
      this.renderCache = { width, marked: rendered.slice(), clean };
      return clean;
    };
    document.render = this.wrappedRender;
  }

  invalidate(): void { this.dirty = true; }

  private bind(component: Component, prompt: Prompt): void {
    const original = component.render;
    const token = this.tokens.size;
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
    this.bound.set(component, { original, wrapped, own: Object.hasOwn(component, "render") });
    component.render = wrapped;
  }

  private unbind(): void {
    for (const [component, binding] of this.bound) {
      if (component.render !== binding.wrapped) continue;
      if (binding.own) component.render = binding.original;
      else delete (component as Partial<Component>).render;
    }
    this.bound.clear();
    this.tokens.clear();
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
    const key = entries.map(e => e.id).join(":");
    if (this.archiveCache?.key === key) {
      this.archiveCache.component.clearCache(); // Rebinding can change marker tokens even when visible text is identical.
      for (const [component, prompt] of this.archiveCache.users) this.bind(component, prompt);
      return this.archiveCache.component;
    }
    const archive = new ArchivedHistory(() => this.collecting);
    const users = new Map<Component, Prompt>();
    if (!entries.some(e => userText(e) !== undefined)) return archive;
    archive.addChild(new Text(" Earlier history · read-only · model context unchanged", 0, 1));
    const tools = new Map<string, host.ToolExecutionComponent>();
    for (const entry of entries) {
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
    archive.addChild(new Text(" End of earlier history", 0, 1));
    this.archiveCache = { key, component: archive, users };
    return archive;
  }

  private sync(): void {
    if (this.disposed) return;
    const leaf = this.ctx.sessionManager.getLeafId();
    const raw = this.chat.children.filter(c => !this.owned.has(c));
    const changed = raw.length !== this.rawChildren.length || raw.some((c, i) => c !== this.rawChildren[i]);
    if (!this.dirty && leaf === this.leaf && !changed) return;
    this.renderCache = undefined; // Identical text can acquire different entry IDs after a branch rebuild.
    this.dirty = false;
    this.leaf = leaf;
    this.rawChildren = raw;
    this.branch = this.ctx.sessionManager.getBranch();
    this.prompts = this.branch.flatMap((e, i) => { const prompt = promptFor(e, i); return prompt ? [prompt] : []; });
    const prompts = new Map(this.prompts.map(p => [p.id, p]));
    this.unbind();
    this.chat.children = raw.slice();
    this.owned.clear();
    const native = boundaries(raw);
    const signatures = this.branch.map(entrySignature);
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
      additions.set(slot, [...(additions.get(slot) ?? []), component]);
    };
    const archive = this.archive(this.branch.slice(0, prefixEnd), prompts);
    if (archive.children.length) add(0, archive);
    const present = new Set(matches.filter(m => m.boundary.prompt).map(m => this.branch[m.index].id));
    for (const prompt of this.prompts) {
      if (prompt.entryIndex < prefixEnd || present.has(prompt.id)) continue;
      // Pi does not render image-only inputs. Give each one its own chronological anchor.
      const next = matches.find(m => m.index > prompt.entryIndex);
      const entry = this.branch[prompt.entryIndex];
      const timestamp = entry.type === "message" ? entry.message.timestamp : Infinity;
      const streaming = native.find(n => !matches.some(m => m.boundary === n) && n.signature.startsWith("assistant:") && Number(n.signature.slice(10)) >= timestamp);
      add(next?.boundary.slot ?? streaming?.slot ?? raw.length, this.makeUser(entry, prompt));
    }
    this.chat.children = raw.flatMap((component, i) => [...(additions.get(i) ?? []), component]);
    this.chat.children.push(...(additions.get(raw.length) ?? []));
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unbind();
    this.chat.children = this.chat.children.filter(c => !this.owned.has(c));
    this.owned.clear();
    if (this.document.render === this.wrappedRender) {
      if (this.hadOwnRender) this.document.render = this.originalRender;
      else delete (this.document as Partial<Component>).render;
    }
    this.lines = [];
    this.anchors = [];
    this.archiveCache = undefined;
    this.renderCache = undefined;
  }
}
