import { parentPort, workerData } from "node:worker_threads";
import { open, stat as statFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { setImmediate as yieldTurn } from "node:timers/promises";
import { isSupportedPiVersion } from "./compat.mjs";

const require = createRequire(join(workerData.agentDir, "package.json"));
const agentURL = pathToFileURL(join(workerData.agentDir, "dist/index.js")).href;
const tuiURL = pathToFileURL(require.resolve("@earendil-works/pi-tui")).href;
const [host, tui, themes] = await Promise.all([
  import(agentURL), import(tuiURL),
  import(new URL("./modes/interactive/theme/theme.js", agentURL)),
]);
if (host.VERSION !== workerData.version || !isSupportedPiVersion(workerData.version)) throw new Error("History renderer requires Pi >=1.6.0 and must match the host version");
const PAGE_ROWS = workerData.pageRows, PACKET_BYTES = workerData.packetBytes, COPY_BYTES = workerData.copyBytes;
const CACHE_BYTES = 64 * 1024 * 1024, ENTRY_BYTES = 64 * 1024 * 1024;
const queue = new Map(), sources = new Map(), credits = new Map();
let active, sourceSerial = 0, draining = false;
const abort = () => new DOMException("History request cancelled", "AbortError");
const check = job => { if (job.cancelled) throw abort(); };
const send = message => parentPort.postMessage(message);
const safeError = error => tui.stripTerminalSequences(error instanceof Error ? error.message : String(error)).replace(/[\x00-\x1f\x7f-\x9f]/g, " ").slice(0, 240);
function textContent(content, separator = "") {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter(block => block?.type === "text" && typeof block.text === "string").map(block => block.text).join(separator);
}
function digest(value) { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function summaryLabel(text) {
  const clean = tui.stripTerminalSequences(text).replace(/[\x00-\x1f\x7f-\x9f]/g, " ").trim().replace(/\s+/g, " ");
  let preview = "", count = 0;
  for (const character of clean) { if (count++ === 160) break; preview += character; }
  return preview || "[Empty input]";
}
function metadata(entry, location) {
  if (!entry || typeof entry !== "object" || typeof entry.id !== "string" || !entry.id.length || entry.id.length > 256 ||
      !(entry.parentId === null || (typeof entry.parentId === "string" && entry.parentId.length <= 256)) ||
      typeof entry.type !== "string" || entry.type.length > 64) {
    throw new Error("Invalid stored history entry");
  }
  const meta = { id: entry.id, parentId: entry.parentId, location, display: false };
  const message = entry.type === "message" ? entry.message : undefined;
  if (message?.role === "user") {
    const text = textContent(message.content), images = Array.isArray(message.content) ? message.content.filter(c => c?.type === "image").length : 0;
    const display = text || (images ? `[Image input: ${images} attachment${images === 1 ? "" : "s"}]` : "[Empty input]");
    const skill = host.parseSkillBlock(text);
    meta.label = summaryLabel(skill ? `/skill:${skill.name} ${skill.userMessage ?? ""}` : display);
    meta.signature = digest(skill ? ["skill", skill.name, skill.content, skill.userMessage ?? null] : ["user", text]);
    meta.user = true; meta.display = true;
  } else if (message?.role === "assistant") {
    meta.signature = `assistant:${message.timestamp}`;
    meta.calls = Array.isArray(message.content) ? message.content.filter(c => c?.type === "toolCall" && typeof c.id === "string").map(c => c.id) : [];
    meta.display = true;
  } else if (message?.role === "toolResult") {
    meta.callId = message.toolCallId;
    meta.display = true;
  } else if (message?.role === "bashExecution") {
    const output = tui.stripTerminalSequences(message.output ?? "").replace(/\r\n?/g, "\n");
    meta.signature = digest(["bash", message.command, output.split("\n")]);
    meta.display = true;
  } else if (message?.role === "custom" || entry.type === "custom_message") {
    const custom = message ?? entry;
    meta.signature = digest(["custom", custom.customType, custom.content]);
    meta.display = !!custom.display;
  } else if (entry.type === "compaction" || entry.type === "branch_summary") {
    meta.display = true;
  }
  return meta;
}

class Source {
  entries = new Map();
  file;
  handle;
  offset = 0;
  identity;
  modified;
  sessionId;
  unavailable = false;

  async refresh(file, sessionId, job) {
    if (file !== this.file || sessionId !== this.sessionId) {
      await this.handle?.close(); this.handle = undefined;
      this.file = file; this.sessionId = sessionId; this.entries.clear();
      this.offset = 0; this.identity = undefined; this.modified = undefined; this.unavailable = false;
    }
    if (!file || this.unavailable) return;
    try {
      if (!this.handle) this.handle = await open(file, "r");
      const [stat, current] = await Promise.all([this.handle.stat(), statFile(file)]), identity = `${stat.dev}:${stat.ino}`;
      if (`${current.dev}:${current.ino}` !== identity || (this.identity && this.identity !== identity) || stat.size < this.offset ||
          (stat.size === this.offset && this.modified !== undefined && stat.mtimeMs !== this.modified)) {
        await this.fallback(); return;
      }
      this.identity = identity;
      const buffer = Buffer.allocUnsafe(256 * 1024);
      let position = this.offset, start = this.offset, parts = [], bytes = 0, records = 0;
      while (position < stat.size) {
        check(job);
        const { bytesRead } = await this.handle.read(buffer, 0, Math.min(buffer.length, stat.size - position), position);
        if (!bytesRead) break;
        let from = 0;
        for (;;) {
          const newline = buffer.indexOf(10, from);
          if (newline < 0 || newline >= bytesRead) break;
          const piece = Buffer.from(buffer.subarray(from, newline));
          parts.push(piece); bytes += piece.length;
          if (bytes > ENTRY_BYTES) { await this.fallback(); return; }
          const length = position + newline - start;
          let entry;
          try { entry = JSON.parse(Buffer.concat(parts, bytes).toString("utf8")); }
          catch { entry = undefined; }
          if (start === 0) {
            if (entry?.type !== "session" || entry.id !== sessionId || entry.version !== 3) { await this.fallback(); return; }
          } else if (entry?.id && entry.type !== "session") {
            const previous = this.entries.get(entry.id), next = metadata(entry, { position: start, length });
            if (previous?.location || (previous && (previous.parentId !== next.parentId || previous.signature !== next.signature))) {
              await this.fallback(); return;
            }
            this.entries.set(entry.id, next);
          }
          start = position + newline + 1; this.offset = start;
          parts = []; bytes = 0; from = newline + 1;
          if (++records % 128 === 0) { await yieldTurn(); check(job); }
        }
        if (from < bytesRead) { const piece = Buffer.from(buffer.subarray(from, bytesRead)); parts.push(piece); bytes += piece.length; }
        if (bytes > ENTRY_BYTES) { await this.fallback(); return; }
        position += bytesRead;
      }
      // An incomplete final line stays unread; use the authoritative SessionManager instead.
      this.modified = stat.mtimeMs;
    } catch (error) {
      if (error?.name === "AbortError") throw error;
      if (error?.code === "ENOENT" || error?.code === "EACCES" || error?.code === "EPERM") { await this.fallback(); return; }
      throw error;
    }
  }

  async fallback() {
    await this.handle?.close(); this.handle = undefined;
    this.unavailable = true; this.entries.clear(); this.offset = 0;
  }

  fromHost(first, ancestors, stop, job) {
    check(job);
    return new Promise((resolve, reject) => {
      const id = ++sourceSerial;
      sources.set(id, { job, resolve, reject, pieces: [], bytes: 0, result: undefined });
      send({ type: "source", id, first, ancestors, stop });
    });
  }

  async meta(id, stop, job) {
    if (!this.entries.has(id)) await this.fromHost(id, true, stop, job);
    check(job);
    const meta = this.entries.get(id);
    if (!meta) throw new Error("Invalid session ancestry: missing entry");
    return meta;
  }

  async read(id, job) {
    check(job);
    const meta = this.entries.get(id);
    if (meta?.location && this.handle) {
      const { position, length } = meta.location;
      const buffer = Buffer.allocUnsafe(length);
      let got = 0;
      while (got < length) {
        check(job);
        const { bytesRead } = await this.handle.read(buffer, got, length - got, position + got);
        if (!bytesRead) break;
        got += bytesRead;
      }
      let entry;
      try { entry = JSON.parse(buffer.toString("utf8", 0, got)); } catch { /* File changed: ask the authoritative reader. */ }
      if (entry?.id === id && entry.parentId === meta.parentId) return entry;
    }
    return this.fromHost(id, false, null, job);
  }
}
const source = new Source();

class Branch {
  entries = [];
  positions = new Map();
  prompts = [];
  promptById = new Map();
  signatures = new Map();
  calls = new Map();
  results = new Map();
  paired = new Set();
  units = [];
  unitById = new Map();
  leaf = null;
  sessionId;
  revision = 0;
  valid = true;

  async sync(input, job) {
    await source.refresh(input.file, input.sessionId, job);
    if (this.sessionId !== input.sessionId || !this.valid) {
      this.entries = []; this.positions.clear(); this.leaf = null; this.revision++;
      this.resetIndexes(); cache.clear(); cacheBytes = 0;
    }
    this.sessionId = input.sessionId;
    const added = [], seen = new Set();
    let id = input.leaf, prefix = 0;
    while (id !== null) {
      check(job);
      const known = this.positions.get(id);
      if (known !== undefined) { prefix = known + 1; break; }
      if (seen.has(id)) throw new Error("Invalid session ancestry: cyclic parent chain");
      seen.add(id);
      const meta = await source.meta(id, this.leaf, job);
      added.push(meta); id = meta.parentId;
      if (added.length % 128 === 0) await yieldTurn();
    }
    check(job);
    const replace = prefix !== this.entries.length;
    this.valid = false;
    if (replace) {
      this.revision++;
      this.entries = this.entries.slice(0, prefix);
      this.positions = new Map();
      this.resetIndexes();
      for (let i = 0; i < this.entries.length; i++) {
        this.positions.set(this.entries[i].id, i); this.index(this.entries[i], i);
        if (i % 128 === 0) { await yieldTurn(); check(job); }
      }
    } else if (!this.entries.length) this.resetIndexes();
    for (let i = added.length - 1; i >= 0; i--) {
      const meta = added[i], index = this.entries.length;
      this.entries.push(meta); this.positions.set(meta.id, index); this.index(meta, index);
      if (i % 128 === 0) { await yieldTurn(); check(job); }
    }
    this.leaf = input.leaf; this.valid = true;
    return { leaf: this.leaf, entries: this.entries.length, prompts: this.prompts.length, revision: this.revision };
  }

  resetIndexes() {
    this.prompts = []; this.promptById = new Map(); this.signatures = new Map();
    this.calls = new Map(); this.results = new Map(); this.paired = new Set(); this.units = []; this.unitById = new Map();
  }

  index(meta, entryIndex) {
    if (meta.user) {
      const prompt = { id: meta.id, label: meta.label, text: meta.label, entryIndex, rank: this.prompts.length };
      this.prompts.push(prompt); this.promptById.set(meta.id, prompt);
    }
    if (meta.signature) {
      let list = this.signatures.get(meta.signature);
      if (!list) this.signatures.set(meta.signature, list = []);
      list.push(entryIndex);
    }
    for (let i = 0; i < (meta.calls?.length ?? 0); i++) this.calls.set(meta.calls[i], { owner: meta.id, slot: i });
    const call = this.calls.get(meta.callId);
    if (call) { this.results.set(`${call.owner}:${call.slot}`, meta.id); this.paired.add(meta.id); }
    if (meta.display && !this.paired.has(meta.id)) { this.unitById.set(meta.id, this.units.length); this.units.push(meta); }
  }

  match(candidates, cursor = this.entries.length - 1) {
    const matches = [];
    for (const candidate of candidates) {
      let index = candidate.id ? this.positions.get(candidate.id) : undefined;
      if (index === undefined || index > cursor) {
        const list = candidate.signature ? this.signatures.get(candidate.signature) : undefined;
        let low = 0, high = list?.length ?? 0;
        while (low < high) { const mid = (low + high) >>> 1; if (list[mid] <= cursor) low = mid + 1; else high = mid; }
        index = low ? list[low - 1] : undefined;
      }
      if (index === undefined || index > cursor) matches.push(null);
      else { matches.push({ entryIndex: index, prompt: this.promptById.get(this.entries[index].id) }); cursor = index - 1; }
    }
    return { matches, cursor };
  }

  current(entryIndex) {
    let low = 0, high = this.prompts.length;
    while (low < high) { const mid = (low + high) >>> 1; if (this.prompts[mid].entryIndex <= entryIndex) low = mid + 1; else high = mid; }
    return this.prompts[Math.max(0, low - 1)];
  }
}
const branch = new Branch();

let layoutKey = "", cacheBytes = 0;
const cache = new Map();
function configure(layout) {
  if (!layout || !Number.isInteger(layout.width) || layout.width < 1 || layout.width > 4096) throw new Error("Unsupported history page width");
  const key = JSON.stringify(layout);
  if (key === layoutKey) return;
  const { foreground, background, mode, appearance, dim } = layout.theme;
  tui.setCapabilities(layout.capabilities);
  tui.setKeybindings(new tui.KeybindingsManager(Object.fromEntries(Object.entries(layout.keybindings).map(([id, defaultKeys]) => [id, { defaultKeys, description: id }]))));
  themes.setThemeInstance(new host.Theme(foreground, background, mode, { appearance, dim }));
  layoutKey = key; cache.clear(); cacheBytes = 0;
}

async function unit(meta, layout, job) {
  check(job);
  const resultIds = (meta.calls ?? []).map((_call, i) => branch.results.get(`${meta.id}:${i}`));
  const key = `${meta.id}:${resultIds.join(":")}`;
  const cached = cache.get(key);
  if (cached) { cache.delete(key); cache.set(key, cached); return cached.lines; }
  const entry = await source.read(meta.id, job);
  check(job);
  const group = new tui.Container();
  if (meta.user) {
    const text = textContent(entry.message.content), prompt = branch.promptById.get(meta.id), skill = host.parseSkillBlock(text);
    if (skill) {
      const view = new host.SkillInvocationMessageComponent(skill);
      view.setExpanded(layout.expanded); view.setOutputPad?.(layout.outputPad); group.addChild(view);
      if (skill.userMessage) group.addChild(new host.UserMessageComponent(skill.userMessage, undefined, layout.outputPad));
    } else {
      group.addChild(new host.UserMessageComponent(text || prompt.label, undefined, layout.outputPad));
    }
  } else {
    for (const message of host.sessionEntryToContextMessages(entry)) {
      if (message.role === "assistant") {
        group.addChild(new host.AssistantMessageComponent(message, layout.hideThinkingBlock, undefined, undefined, layout.outputPad));
        let slot = 0;
        for (const content of message.content) {
          if (content.type !== "toolCall") continue;
          // Stock fallbacks only need requestRender; this worker never owns a terminal or executes tools.
          const tool = new host.ToolExecutionComponent(content.name, content.id, content.arguments,
            { showImages: false, outputPad: layout.outputPad }, {}, { requestRender() {} }, workerData.cwd ?? "");
          tool.setExpanded(layout.expanded);
          const resultId = resultIds[slot++];
          if (resultId) tool.updateResult((await source.read(resultId, job)).message);
          else if (message.stopReason === "error" || message.stopReason === "aborted") {
            tool.updateResult({ content: [{ type: "text", text: message.errorMessage || (message.stopReason === "aborted" ? "Operation aborted" : "Error") }], isError: true });
          }
          group.addChild(tool);
        }
      } else if (message.role === "toolResult") {
        group.addChild(new tui.Text(tui.stripTerminalSequences(textContent(message.content, "\n")), 1, 1));
      } else if (message.role === "custom" && message.display) {
        const view = new host.CustomMessageComponent(message); view.setExpanded(layout.expanded); view.setOutputPad?.(layout.outputPad); group.addChild(view);
      } else if (message.role === "bashExecution") {
        group.addChild(new tui.Text(tui.stripTerminalSequences(`$ ${message.command}\n${message.output}`), 1, 1));
        if (typeof message.fullOutputError === "string" && message.fullOutputError.trim()) {
          const warning = tui.stripTerminalSequences(`Could not save the full output: ${message.fullOutputError}`).replace(/[\x00-\x1f\x7f-\x9f]/g, " ");
          group.addChild(new tui.Text(themes.theme.fg("warning", warning), 1, 0));
        }
      } else if (message.role === "compactionSummary" || message.role === "branchSummary") {
        const view = message.role === "compactionSummary" ? new host.CompactionSummaryMessageComponent(message) : new host.BranchSummaryMessageComponent(message);
        view.setExpanded(layout.expanded); group.addChild(view);
      }
    }
  }
  check(job);
  const lines = group.render(layout.width);
  let bytes = 0;
  for (const line of lines) {
    if (typeof line !== "string") throw new Error("Invalid history renderer output");
    const size = Buffer.byteLength(line);
    if (size > PACKET_BYTES / 2) throw new Error("A rendered history line is too large to display safely");
    bytes += size + 16;
  }
  if (bytes <= CACHE_BYTES) {
    while (cache.size && (cacheBytes + bytes > CACHE_BYTES || cache.size >= 128)) {
      const oldest = cache.keys().next().value; cacheBytes -= cache.get(oldest).bytes; cache.delete(oldest);
    }
    cache.set(key, { lines, bytes }); cacheBytes += bytes;
  }
  await yieldTurn(); check(job);
  return lines;
}

const cursorAt = (index, line = 0) => ({ id: branch.units[index].id, line });
const rowCost = line => Buffer.byteLength(JSON.stringify(line)) + 8;
function unitCost(meta) {
  const prompt = branch.promptById.get(meta.id);
  return Buffer.byteLength(JSON.stringify(meta.id)) + 96 + (prompt ? Buffer.byteLength(JSON.stringify(prompt)) + 80 : 0);
}
function resolveCursor(cursor, id) {
  const target = cursor?.id ?? id ?? branch.units[0]?.id;
  const index = branch.unitById.get(target);
  if (index === undefined) throw new Error("That message is no longer in the current branch");
  const line = cursor?.line ?? 0;
  if (!Number.isSafeInteger(line) || line < 0) throw new Error("Invalid history position");
  return { index, line };
}

async function previous(position, layout, job) {
  let { index, line } = position, rows = 0, bytes = 4096, start = { index, line };
  if (!line) index--;
  while (index >= 0 && rows < PAGE_ROWS) {
    const meta = branch.units[index], lines = await unit(meta, layout, job);
    let row = line ? Math.min(line, lines.length) - 1 : lines.length - 1;
    let first = true;
    for (; row >= 0 && rows < PAGE_ROWS; row--) {
      const cost = rowCost(lines[row]) + (first ? unitCost(meta) : 0);
      if (bytes + cost > PACKET_BYTES) return start;
      bytes += cost; rows++; first = false; start = { index, line: row };
    }
    index--; line = 0;
  }
  return start;
}

async function page(input, job) {
  configure(input.layout);
  let position = resolveCursor(input.cursor, input.id);
  if (input.before) position = await previous(position, input.layout, job);
  let { index, line } = position, bytes = 4096;
  const lines = [], anchors = [], spans = [];
  let start;
  while (index < branch.units.length && lines.length < PAGE_ROWS) {
    const meta = branch.units[index], rendered = await unit(meta, input.layout, job);
    line = Math.min(line, Math.max(0, rendered.length - 1));
    if (!rendered.length) { index++; line = 0; continue; }
    const prompt = branch.promptById.get(meta.id), begin = lines.length;
    let anchor, span;
    while (line < rendered.length && lines.length < PAGE_ROWS) {
      const cost = rowCost(rendered[line]) + (lines.length === begin ? unitCost(meta) : 0);
      if (bytes + cost > PACKET_BYTES) break;
      bytes += cost;
      if (!start) start = cursorAt(index, line);
      if (!span) { span = { id: meta.id, row: lines.length, end: lines.length, line }; spans.push(span); }
      if (prompt && !anchor) { anchor = { ...prompt, row: lines.length, end: lines.length }; anchors.push(anchor); }
      lines.push(rendered[line++]);
      span.end = lines.length;
      if (anchor) anchor.end = lines.length;
    }
    if (line < rendered.length) break;
    index++; line = 0;
  }
  if (!start || !lines.length) throw new Error("No displayable history at this position");
  const startIndex = branch.unitById.get(start.id);
  const result = { lines, spans, anchors, start, next: index < branch.units.length ? cursorAt(index, line) : undefined,
    hasPrevious: startIndex > 0 || start.line > 0, current: branch.current(branch.positions.get(start.id)), width: input.layout.width };
  if (Buffer.byteLength(JSON.stringify(result)) > PACKET_BYTES) throw new Error("History page exceeded its transport bound");
  return result;
}

async function query(input, job) {
  const text = input.text.trim().toLocaleLowerCase(), items = [];
  if (!text) return { items: branch.prompts.slice(input.offset, input.offset + input.limit), total: branch.prompts.length, offset: input.offset };
  let total = 0;
  for (let i = 0; i < branch.prompts.length; i++) {
    const prompt = branch.prompts[i];
    if (!text || `${prompt.rank + 1} ${prompt.label}`.toLocaleLowerCase().includes(text)) {
      if (total >= input.offset && items.length < input.limit) items.push(prompt);
      total++;
    }
    if (i % 256 === 0) { await yieldTurn(); check(job); }
  }
  return { items, total, offset: input.offset };
}

function firstMatch(lines, query, from) {
  let tail = "", tailRows = [];
  for (let row = from; row < lines.length; row++) {
    const text = tui.stripTerminalSequences(lines[row]).trim().replace(/\s+/g, " ").toLocaleLowerCase();
    const joined = `${tail}${tail && text ? " " : ""}${text}`;
    const at = joined.indexOf(query);
    if (at >= 0) return at < tail.length ? tailRows[at] : row;
    const keep = Math.min(query.length - 1, joined.length);
    const rows = tailRows.concat(tail && text ? [row] : [], Array(text.length).fill(row));
    tail = joined.slice(joined.length - keep); tailRows = rows.slice(rows.length - keep);
  }
  return undefined;
}

async function find(input, job) {
  configure(input.layout);
  const text = input.text.trim().replace(/\s+/g, " ").toLocaleLowerCase();
  if (!text) return undefined;
  const start = input.after ? resolveCursor(input.after) : { index: 0, line: 0 };
  for (let count = 0; count <= branch.units.length; count++) {
    const index = (start.index + count) % branch.units.length, meta = branch.units[index];
    if (!meta) return undefined;
    const lines = await unit(meta, input.layout, job);
    const from = count === 0 ? start.line : 0;
    const row = firstMatch(lines, text, from);
    if (row !== undefined && (count < branch.units.length || row < start.line)) return page({ cursor: cursorAt(index, row), layout: input.layout }, job);
  }
  return undefined;
}

async function copy(input, job) {
  configure(input.layout);
  const first = branch.prompts[input.first], last = branch.prompts[input.last];
  if (!first || !last || input.last < input.first) throw new Error("Invalid input range to copy");
  const end = branch.prompts[input.last + 1]?.entryIndex ?? branch.entries.length;
  let text = "", bytes = 0;
  const flush = async () => {
    if (!text) return;
    const chunk = text; text = "";
    await new Promise((resolve, reject) => { credits.set(job.id, { resolve, reject }); send({ type: "copyChunk", id: job.id, text: chunk }); });
    check(job);
  };
  for (let i = branch.unitById.get(first.id); i < branch.units.length; i++) {
    const meta = branch.units[i];
    if (branch.positions.get(meta.id) >= end) break;
    for (const line of await unit(meta, input.layout, job)) {
      const plain = `${tui.stripTerminalSequences(line).trimEnd()}\n`, size = Buffer.byteLength(plain);
      bytes += size;
      if (bytes > COPY_BYTES) throw new Error("Copy exceeds 32 MiB; choose a smaller input range");
      if (Buffer.byteLength(text) + size > PACKET_BYTES / 2) await flush();
      text += plain;
    }
  }
  await flush();
}

function validate(kind, input) {
  if (!input || typeof input !== "object") throw new Error("Invalid history request");
  if ((kind === "query" || kind === "find") && (typeof input.text !== "string" || input.text.length > 1024)) throw new Error("History search is limited to 1024 characters");
  if (kind === "query" && (!Number.isInteger(input.offset) || input.offset < 0 || !Number.isInteger(input.limit) || input.limit < 1 || input.limit > 64)) throw new Error("Invalid history query page");
  if (kind === "match" && (!Array.isArray(input.candidates) || input.candidates.length > 128)) throw new Error("Invalid native history batch");
  if (kind === "sync" && (!(input.leaf === null || typeof input.leaf === "string") || typeof input.sessionId !== "string")) throw new Error("Invalid history session");
  if (kind === "copy" && (!Number.isInteger(input.first) || !Number.isInteger(input.last) || input.first < 0)) throw new Error("Invalid history copy range");
}

async function run(job) {
  const { kind, input } = job;
  validate(kind, input);
  if (kind === "sync") return branch.sync(input, job);
  if (!branch.valid) throw new Error("History index changed while loading; retry after indexing completes");
  if (kind === "query") return query(input, job);
  if (kind === "match") return branch.match(input.candidates, input.cursor);
  if (kind === "prompt") {
    const prompt = input.id ? branch.promptById.get(input.id) : branch.prompts[input.rank ?? 0];
    return prompt && input.step ? branch.prompts[prompt.rank + input.step] : prompt;
  }
  if (kind === "page") return page(input, job);
  if (kind === "find") return find(input, job);
  if (kind === "copy") return copy(input, job);
  throw new Error("Unknown history operation");
}

async function drain() {
  if (draining) return;
  draining = true;
  try {
    while (queue.size) {
      const kind = ["sync", "page", "prompt", "match", "query", "find", "copy"].find(key => queue.has(key));
      const job = queue.get(kind); queue.delete(kind); active = job;
      try {
        const data = await run(job);
        if (!job.cancelled) send({ type: "reply", id: job.id, data });
      } catch (error) { if (!job.cancelled) send({ type: "reply", id: job.id, error: safeError(error) }); }
      finally { active = undefined; }
    }
  } finally { draining = false; }
}

function cancel(id) {
  if (active?.id === id) active.cancelled = true;
  for (const [kind, job] of queue) if (job.id === id) queue.delete(kind);
  for (const [key, request] of sources) if (request.job.id === id) {
    request.reject(abort()); sources.delete(key); send({ type: "sourceCancel", id: key });
  }
  const credit = credits.get(id);
  if (credit) { credits.delete(id); credit.reject(abort()); }
}

parentPort.on("message", message => {
  if (!message || !Number.isSafeInteger(message.id)) return;
  if (message.type === "request") {
    if (!["sync", "page", "prompt", "match", "query", "find", "copy"].includes(message.kind)) return;
    queue.set(message.kind, { id: message.id, kind: message.kind, input: message.input, cancelled: false });
    void drain();
  } else if (message.type === "cancel") cancel(message.id);
  else if (message.type === "credit") { const credit = credits.get(message.id); credits.delete(message.id); credit?.resolve(); }
  else if (message.type === "sourceChunk") {
    const request = sources.get(message.id);
    if (!request) return;
    try {
      if (message.error) throw new Error(message.error);
      if (typeof message.text !== "string" || Buffer.byteLength(message.text) > PACKET_BYTES) throw new Error("Invalid history source packet");
      let from = 0;
      for (;;) {
        const newline = message.text.indexOf("\n", from);
        if (newline < 0) break;
        const piece = message.text.slice(from, newline);
        request.pieces.push(piece); request.bytes += Buffer.byteLength(piece);
        if (request.bytes > ENTRY_BYTES) throw new Error("A history entry exceeds the safe 64 MiB reader limit");
        const entry = JSON.parse(request.pieces.join(""));
        const meta = metadata(entry);
        source.entries.set(meta.id, meta); request.result = entry;
        request.pieces = []; request.bytes = 0; from = newline + 1;
      }
      const rest = message.text.slice(from);
      if (rest) { request.pieces.push(rest); request.bytes += Buffer.byteLength(rest); }
      if (request.bytes > ENTRY_BYTES) throw new Error("A history entry exceeds the safe 64 MiB reader limit");
      if (message.done) {
        if (request.pieces.length) throw new Error("Incomplete history source packet");
        sources.delete(message.id); request.resolve(request.result);
      } else send({ type: "sourceCredit", id: message.id });
    } catch (error) {
      sources.delete(message.id); request.reject(error); send({ type: "sourceCancel", id: message.id });
    }
  }
});
