import { sliceByColumn, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { Worker } from "node:worker_threads";
import type { Snapshot } from "./model.ts";
import { viewportPng } from "./png.ts";

const CONTENT_REFRESH_MS = 80;
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
function rasterSize(width: number, height: number): [number, number] {
  width = Math.max(8, Math.round(width)); height = Math.max(1, Math.round(height));
  const scale = Math.min(1, 1024 / width, 4096 / height);
  // Limit memory without independently squeezing one image axis.
  return [Math.max(8, Math.round(width * scale)), Math.max(1, Math.round(height * scale))];
}
const ANSI = ["#000000", "#cd3131", "#0dbc79", "#e5e510", "#2472c8", "#bc3fbc", "#11a8cd", "#e5e5e5", "#666666", "#f14c4c", "#23d18b", "#f5f543", "#3b8eea", "#d670d6", "#29b8db", "#ffffff"];
function indexedColor(index: number): string {
  if (index < 16) return ANSI[Math.max(0, index)];
  if (index >= 232) { const gray = Math.min(255, 8 + (index - 232) * 10); return `rgb(${gray},${gray},${gray})`; }
  const n = index - 16, levels = [0, 95, 135, 175, 215, 255];
  return `rgb(${levels[Math.floor(n / 36) % 6]},${levels[Math.floor(n / 6) % 6]},${levels[n % 6]})`;
}

/** Keep actual text and SGR foreground colors; never replace characters with density dots. */
export function coloredRuns(line: string, foreground: string): { text: string; color: string; column: number; cells: number }[] {
  const runs: { text: string; color: string; column: number; cells: number }[] = [];
  let column = 0, color = foreground, last = 0;
  const add = (text: string) => {
    text = stripTerminalSequences(text).replace(/[\x00-\x1f\x7f-\x9f]/g, "");
    const cells = visibleWidth(text);
    if (text) runs.push({ text, color, column, cells });
    column += cells;
  };
  for (const match of line.matchAll(/\x1b\[([\d;]*)m/g)) {
    add(line.slice(last, match.index));
    const codes = (match[1] || "0").split(";").map(Number);
    for (let i = 0; i < codes.length; i++) {
      const code = codes[i];
      if (code === 0 || code === 39) color = foreground;
      else if (code >= 30 && code <= 37) color = ANSI[code - 30];
      else if (code >= 90 && code <= 97) color = ANSI[code - 90 + 8];
      else if (code === 38 || code === 48) {
        const foregroundCode = code === 38;
        if (codes[i + 1] === 2 && codes.length > i + 4) {
          if (foregroundCode) color = `rgb(${codes.slice(i + 2, i + 5).map(n => Math.max(0, Math.min(255, n))).join(",")})`;
          i += 4;
        } else if (codes[i + 1] === 5 && codes.length > i + 2) {
          if (foregroundCode) color = indexedColor(Math.max(0, Math.min(255, codes[i + 2])));
          i += 2;
        }
      }
    }
    last = match.index! + match[0].length;
  }
  add(line.slice(last));
  return runs;
}

export interface MiniGeometry {
  start: number;
  count: number;
  samples: number;
  lineHeight: number;
  fontSize: number;
  top: number;
  size: number;
  travel: number;
  max: number;
}

/** Fixed full-history overview. Sampling depends on document/layout, never the scroll position. */
export function minimapGeometry(snapshot: Snapshot, widthPx: number, heightPx: number): MiniGeometry {
  [widthPx, heightPx] = rasterSize(widthPx, heightPx);
  const fontSize = (widthPx - 4) / Math.max(1, snapshot.width) / 0.6;
  const desiredLineHeight = Math.max(1, fontSize * 1.6);
  const count = Math.max(1, snapshot.contentHeight);
  const samples = Math.min(count, Math.max(1, Math.min(384, Math.floor(heightPx / desiredLineHeight))));
  const lineHeight = heightPx / count;
  const minimum = Math.min(3, Math.max(1, snapshot.height - 1));
  // Map the entire document to the full viewport height, including short histories.
  // Keep a usable rectangle rather than a one-row strip, but leave travel in small views.
  const size = Math.min(snapshot.height, Math.max(minimum, snapshot.height * snapshot.height / count));
  const travel = Math.max(0, snapshot.height - size);
  const max = Math.max(0, snapshot.contentHeight - snapshot.height);
  const fraction = max ? Math.max(0, Math.min(1, snapshot.top / max)) : 0;
  return { start: 0, count, samples, fontSize, lineHeight, top: fraction * travel, size, travel, max };
}

export function minimapDragTop(pointer: number, grab: number, geometry: MiniGeometry): number {
  return geometry.travel ? Math.round(Math.max(0, Math.min(geometry.travel, pointer - grab)) * geometry.max / geometry.travel) : 0;
}

interface Request {
  key: string;
  lines: readonly string[];
  width: number;
  height: number;
  columns: number;
  sourceRows: number[];
  geometry: MiniGeometry;
  dark: boolean;
}
function sameRequest(a: Request, b?: Request): boolean {
  return !!b && a.key === b.key && a.lines.length === b.lines.length && a.lines.every((line, i) => line === b.lines[i]);
}

/** One running raster job and one replaceable latest request, never a queue of old scroll positions. */
export class Minimap {
  private worker?: Worker;
  private timer?: ReturnType<typeof setTimeout>;
  private requested?: Request;
  private pending?: Request;
  private running?: { request: Request; id: number; epoch: number };
  private epoch = 0;
  private serial = 0;
  private nextRenderAt = 0;
  private png?: Buffer;
  private pngKey = "";
  private pixels?: Uint8Array;
  private rasterVersion = 0;
  private sourceLines?: readonly string[];
  private completed?: Request;
  private prepared = new Map<string, { column: number; color: string; glyphs: string[] }[]>();
  private failure?: Error;
  geometry?: MiniGeometry;

  constructor(private ready: () => void = () => {}, private failed: (error: unknown) => void = () => {}) {}
  get isPending(): boolean { return !!(this.running || this.pending || this.timer); }

  render(snapshot: Snapshot, width: number, height: number, dark: boolean, dragging = false): Buffer | undefined {
    if (this.failure) throw this.failure;
    [width, height] = rasterSize(width, height);
    const geometry = minimapGeometry(snapshot, width, height);
    this.geometry = geometry;
    const key = `${width}:${height}:${snapshot.width}:${geometry.count}:${dark}`;
    if (key !== this.requested?.key || this.sourceLines !== snapshot.lines) {
      const sourceRows = Array.from({ length: geometry.samples }, (_, i) => {
        const start = Math.floor(i * geometry.count / geometry.samples);
        const end = Math.floor((i + 1) * geometry.count / geometry.samples);
        // Prefer real text to blank separators, but keep one representative line per fixed history band.
        for (let row = start; row < end; row++) if (stripTerminalSequences(snapshot.lines[row] ?? "").trim()) return row;
        return start;
      });
      const request: Request = {
        key, lines: sourceRows.map(row => snapshot.lines[row] ?? ""), sourceRows, width, height,
        columns: snapshot.width, geometry, dark,
      };
      this.sourceLines = snapshot.lines;
      if (!sameRequest(request, this.requested)) {
        this.requested = this.pending = request;
        this.schedule();
      }
    }
    // The worker only supplies an immutable background. Rectangle movement never waits for it.
    if (!this.pixels || this.completed?.width !== width || this.completed.height !== height) return undefined;
    const top = Math.max(0, Math.min(height - 1, Math.round(geometry.top / Math.max(1, snapshot.height) * height)));
    const bottom = Math.max(top + 1, Math.min(height, Math.round((geometry.top + geometry.size) / Math.max(1, snapshot.height) * height)));
    const pngKey = `${this.rasterVersion}:${top}:${bottom}:${dark}:${dragging}`;
    if (pngKey !== this.pngKey) {
      this.png = viewportPng(this.pixels, width, height, top, bottom, dark, dragging);
      this.pngKey = pngKey;
    }
    return this.png;
  }

  private schedule(): void {
    if (!this.pending || this.running || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      try { this.start(); } catch (error) { this.fail(error); }
    }, Math.max(0, this.nextRenderAt - performance.now()));
  }

  private start(): void {
    const request = this.pending;
    if (!request) return;
    if (!this.worker) {
      const worker = new Worker(new URL("./minimap-worker.mjs", import.meta.url), {
        // The plain ESM raster stage needs no host/test flags; many process flags are invalid in workers.
        execArgv: [],
      });
      this.worker = worker;
      worker.on("message", (message: { id: number; pixels?: Uint8Array; error?: string }) => {
        if (this.worker !== worker || this.running?.id !== message.id) return;
        const job = this.running;
        this.running = undefined;
        worker.unref();
        if (job.epoch === this.epoch) {
          if (message.error || message.pixels?.byteLength !== job.request.width * job.request.height * 4) {
            this.fail(new Error(message.error || "Invalid minimap raster")); return;
          }
          this.pixels = message.pixels;
          this.completed = job.request;
          this.rasterVersion++;
          this.ready();
        }
        this.schedule();
      });
      worker.on("error", error => { if (this.worker === worker) this.fail(error); });
      worker.on("exit", () => { if (this.worker === worker) this.fail(new Error("Minimap worker exited unexpectedly")); });
    }
    const foreground = request.dark ? "#d4d4d4" : "#333333";
    const widths = new Map<string, number>();
    const rows = request.lines.map(line => {
      const key = `${request.columns}:${foreground}:${line}`;
      let runs = this.prepared.get(key);
      if (!runs) {
        runs = coloredRuns(sliceByColumn(line, 0, request.columns, true), foreground).map(run => ({
          column: run.column, color: run.color, glyphs: Array.from(segmenter.segment(run.text), part => part.segment),
        }));
        this.prepared.set(key, runs);
      }
      for (const run of runs) for (const glyph of run.glyphs) if (!widths.has(glyph)) widths.set(glyph, visibleWidth(glyph));
      return runs;
    });
    while (this.prepared.size > 512) this.prepared.delete(this.prepared.keys().next().value!);
    this.pending = undefined;
    this.running = { request, id: ++this.serial, epoch: this.epoch };
    this.nextRenderAt = performance.now() + CONTENT_REFRESH_MS;
    this.worker.ref();
    this.worker.postMessage({ id: this.serial, frame: { ...request, lines: undefined, rows, widths } });
  }

  private fail(error: unknown): void {
    this.dispose();
    this.failure = error instanceof Error ? error : new Error(String(error));
    this.failed(this.failure);
  }

  clear(): void {
    this.epoch++;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.requested = this.pending = undefined;
    this.png = undefined;
    this.pngKey = "";
    this.pixels = undefined;
    this.sourceLines = undefined;
    this.completed = undefined;
    this.geometry = undefined;
    this.failure = undefined;
  }

  dispose(): void {
    this.clear();
    const worker = this.worker;
    this.worker = undefined;
    this.running = undefined;
    this.nextRenderAt = 0;
    this.prepared.clear();
    void worker?.terminate();
  }
}
