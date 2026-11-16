import { getCellDimensions, sliceByColumn, stripTerminalSequences, visibleWidth, type ImageProtocol } from "@earendil-works/pi-tui";
import { Worker } from "node:worker_threads";
import type { Snapshot } from "./model.ts";
import { rasterPng, rectanglePng, viewportPng } from "./png.ts";

const CONTENT_REFRESH_MS = 80;
const PREPARE_SLICE_MS = 2;
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

/** Keep the measured text scale; scroll the map window only when the scaled document exceeds it. */
export function minimapGeometry(snapshot: Snapshot, widthPx: number, heightPx: number): MiniGeometry {
  [widthPx, heightPx] = rasterSize(widthPx, heightPx);
  const cells = getCellDimensions();
  const fontSize = (widthPx - 4) / Math.max(1, snapshot.width) / 0.6;
  const lineHeight = Math.min(heightPx / Math.max(1, snapshot.height), (widthPx - 4) / Math.max(1, snapshot.width) * cells.heightPx / cells.widthPx);
  const count = heightPx / lineHeight;
  const total = Math.max(1, snapshot.contentHeight);
  const max = Math.max(0, snapshot.contentHeight - snapshot.height);
  const position = Math.max(0, Math.min(max, snapshot.top));
  const start = max ? position / max * Math.max(0, total - count) : 0;
  const rowScale = lineHeight * snapshot.height / heightPx;
  const size = Math.min(snapshot.height, total) * rowScale;
  const travel = Math.max(0, Math.min(snapshot.height - size, max * rowScale));
  const samples = Math.max(0, Math.min(snapshot.contentHeight, Math.ceil(start + count)) - Math.floor(start));
  return { start, count, samples, fontSize, lineHeight, top: max ? position / max * travel : 0, size, travel, max };
}

export interface MinimapLayers {
  background: Buffer;
  backgroundTop: number;
  backgroundHeight: number;
  viewport: Buffer;
  top: number;
  fullHeight: boolean;
}

interface MiniFrame {
  width: number;
  height: number;
  offset: number;
  top: number;
  bottom: number;
  pixels: Uint8Array;
  rasterHeight: number;
  version: number;
}
interface DragPosition { top: number; preview?: boolean }

interface Request {
  key: string;
  lines: readonly string[];
  width: number;
  height: number;
  offset: number;
  columns: number;
  sourceRows: number[];
  geometry: MiniGeometry;
  dark: boolean;
}
function sameRequest(a: Request, b?: Request): boolean {
  return !!b && a.key === b.key && a.offset === b.offset && a.height === b.height && a.lines.length === b.lines.length &&
    a.lines.every((line, i) => line === b.lines[i] && a.sourceRows[i] === b.sourceRows[i]);
}

function unchangedWindow(snapshot: Snapshot, previous: readonly string[] | undefined, start: number, end: number): boolean {
  const change = snapshot.lineChange;
  return !!previous && change?.previous.deref() === previous &&
    (change.from >= end || (change.oldEnd === change.end && change.end <= start));
}

/** One running raster job and one replaceable latest request, never a queue of old scroll positions. */
export class Minimap {
  private worker?: Worker;
  private timer?: ReturnType<typeof setTimeout>;
  private requested?: Request;
  private pending?: Request;
  private preparing = false;
  private running?: { request: Request; id: number; epoch: number };
  private epoch = 0;
  private serial = 0;
  private nextRenderAt = 0;
  private png?: Buffer;
  private pngKey = "";
  private background?: { version: number; png: Buffer };
  private rectangle?: { key: string; png: Buffer };
  private pixels?: Uint8Array;
  private rasterVersion = 0;
  private sourceLines?: readonly string[];
  private completed?: Request;
  private displayed?: MiniFrame;
  private prepared = new Map<string, { column: number; color: string; glyphs: string[] }[]>();
  private failure?: Error;
  geometry?: MiniGeometry;

  constructor(private ready: () => void = () => {}, private failed: (error: unknown) => void = () => {}) {}
  get isPending(): boolean { return !!(this.preparing || this.running || this.pending || this.timer); }

  render(snapshot: Snapshot, width: number, height: number, dark: boolean, dragging = false, position?: DragPosition): Buffer | undefined {
    const frame = this.frame(snapshot, width, height, dark, position);
    if (!frame) return undefined;
    const pngKey = `${frame.version}:${frame.offset}:${frame.top}:${frame.bottom}:${dark}:${dragging}`;
    if (pngKey !== this.pngKey) {
      const pixels = frame.pixels.subarray(frame.offset * frame.width * 4, (frame.offset + frame.height) * frame.width * 4);
      this.png = viewportPng(pixels, frame.width, frame.height, frame.top, frame.bottom, dark, dragging);
      this.pngKey = pngKey;
    }
    return this.png;
  }

  renderLayers(snapshot: Snapshot, width: number, height: number, dark: boolean, dragging = false, position?: DragPosition): MinimapLayers | undefined {
    const frame = this.frame(snapshot, width, height, dark, position);
    if (!frame) return undefined;
    if (this.background?.version !== frame.version) this.background = { version: frame.version, png: rasterPng(frame.pixels, frame.width, frame.rasterHeight) };
    const key = `${frame.width}:${frame.bottom - frame.top}:${dark}:${dragging}`;
    if (this.rectangle?.key !== key) this.rectangle = { key, png: rectanglePng(frame.width, frame.bottom - frame.top, dark, dragging) };
    return { background: this.background.png, backgroundTop: frame.offset, backgroundHeight: frame.height, viewport: this.rectangle.png, top: frame.top / frame.height, fullHeight: frame.bottom - frame.top === frame.height };
  }

  viewportBounds(width: number, height: number, protocol: ImageProtocol): { top: number; bottom: number } | undefined {
    const [rasterWidth, rasterHeight] = rasterSize(width, height), frame = this.displayed;
    if (frame?.width !== rasterWidth || frame.height !== rasterHeight) return undefined;
    if (protocol === "kitty") {
      // Match KittyLayers: column-scaled height and integer physical-pixel placement after raster limits.
      const size = frame.bottom - frame.top === rasterHeight ? height : Math.round((frame.bottom - frame.top) * width / rasterWidth);
      const top = Math.max(0, Math.min(height - size, Math.round(frame.top / rasterHeight * height)));
      return { top: top / height, bottom: (top + size) / height };
    }
    return { top: frame.top / rasterHeight, bottom: frame.bottom / rasterHeight };
  }

  private previewFrame(top: number, width: number, height: number): MiniFrame | undefined {
    const frame = this.displayed;
    if (!frame || frame.width !== width || frame.height !== height) return undefined;
    const size = frame.bottom - frame.top;
    top = Math.max(0, Math.min(height - size, Math.round(top * height)));
    return this.displayed = { ...frame, top, bottom: top + size };
  }

  private frame(snapshot: Snapshot, width: number, height: number, dark: boolean, position?: DragPosition): MiniFrame | undefined {
    if (this.failure) throw this.failure;
    [width, height] = rasterSize(width, height);
    // Pointer feedback uses only the last displayed immutable raster, never history or a worker.
    if (position?.preview || snapshot.preparing) return position ? this.previewFrame(position.top, width, height) : undefined;
    const geometry = minimapGeometry(snapshot, width, height);
    this.geometry = geometry;
    const key = `${width}:${height}:${snapshot.width}:${geometry.lineHeight}:${dark}`;
    const viewOffset = Math.round(geometry.start * geometry.lineHeight);
    const covers = (request?: Request) => !!request && request.key === key && viewOffset >= request.offset && viewOffset + height <= request.offset + request.height;
    if (!covers(this.requested) || this.sourceLines !== snapshot.lines) {
      // Cache up to three map screens, not the full history; nearby scrolling is just a pixel crop.
      const cacheHeight = Math.max(height, Math.min(4096, height * 3, Math.ceil(snapshot.contentHeight * geometry.lineHeight)));
      const offset = covers(this.requested) && this.requested!.height === cacheHeight ? this.requested!.offset
        : Math.max(0, Math.min(Math.round(snapshot.contentHeight * geometry.lineHeight) - cacheHeight, viewOffset - height));
      const first = Math.floor(offset / geometry.lineHeight);
      const end = Math.min(snapshot.contentHeight, Math.ceil((offset + cacheHeight) / geometry.lineHeight));
      const previous = this.requested;
      const reuse = previous?.key === key && previous.offset === offset && previous.height === cacheHeight &&
        previous.sourceRows[0] === first && previous.sourceRows.length === end - first && unchangedWindow(snapshot, this.sourceLines, first, end);
      if (!reuse) {
        const sourceRows = Array.from({ length: Math.max(0, end - first) }, (_, i) => first + i);
        const request: Request = {
          key, lines: sourceRows.map(row => snapshot.lines[row] ?? ""), sourceRows, width, height: cacheHeight, offset,
          columns: snapshot.width, geometry: { ...geometry, start: offset / geometry.lineHeight }, dark,
        };
        if (!sameRequest(request, previous)) {
          this.requested = this.pending = request;
          this.schedule();
        }
      }
      this.sourceLines = snapshot.lines;
    }
    // During a drag the rectangle stays responsive while the independent background catches up.
    if (!this.pixels || !covers(this.completed)) return position ? this.previewFrame(position.top, width, height) : undefined;
    const size = Math.max(1, Math.min(height, Math.round(geometry.size / Math.max(1, snapshot.height) * height)));
    const top = Math.max(0, Math.min(height - size, Math.round((position?.top ?? geometry.top / Math.max(1, snapshot.height)) * height)));
    return this.displayed = { width, height, offset: viewOffset - this.completed!.offset, top, bottom: top + size,
      pixels: this.pixels, rasterHeight: this.completed!.height, version: this.rasterVersion };
  }

  private schedule(): void {
    if (!this.pending || this.preparing || this.running || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.start().catch(error => this.fail(error));
    }, Math.max(0, this.nextRenderAt - performance.now()));
  }

  private async start(): Promise<void> {
    const request = this.pending, epoch = this.epoch;
    if (!request) return;
    this.preparing = true;
    try {
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
        worker.unref();
      }
      const foreground = request.dark ? "#d4d4d4" : "#333333";
      const widths = new Map<string, number>(), rows: { column: number; color: string; glyphs: string[] }[][] = [];
      let yieldAt = performance.now() + PREPARE_SLICE_MS;
      for (const line of request.lines) {
        const key = `${request.columns}:${foreground}:${line}`;
        let runs = this.prepared.get(key);
        if (!runs) {
          runs = coloredRuns(sliceByColumn(line, 0, request.columns, true), foreground).map(run => ({
            column: run.column, color: run.color, glyphs: Array.from(segmenter.segment(run.text), part => part.segment),
          }));
          this.prepared.set(key, runs);
        }
        for (const run of runs) for (const glyph of run.glyphs) if (!widths.has(glyph)) widths.set(glyph, visibleWidth(glyph));
        rows.push(runs);
        while (this.prepared.size > 512) this.prepared.delete(this.prepared.keys().next().value!);
        // Glyph preparation is main-thread work too; let pointer input run between short batches.
        if (performance.now() >= yieldAt) {
          await new Promise<void>(resolve => setImmediate(resolve));
          if (epoch !== this.epoch || this.pending !== request) return;
          yieldAt = performance.now() + PREPARE_SLICE_MS;
        }
      }
      this.pending = undefined;
      this.running = { request, id: ++this.serial, epoch };
      this.nextRenderAt = performance.now() + CONTENT_REFRESH_MS;
      this.worker.ref();
      this.worker.postMessage({ id: this.serial, frame: { ...request, lines: undefined, rows, widths } });
    } finally {
      this.preparing = false;
      this.schedule();
    }
  }

  private fail(error: unknown): void {
    this.dispose();
    this.failure = error instanceof Error ? error : new Error(String(error));
    this.failed(this.failure);
  }

  clear(keepDisplayed = false): void {
    this.epoch++;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.requested = this.pending = undefined;
    // Invalidating background content is not a mouse release; keep pointer feedback available.
    if (!keepDisplayed) {
      this.png = undefined;
      this.pngKey = "";
      this.background = this.rectangle = undefined;
      this.displayed = undefined;
    }
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
