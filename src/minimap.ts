import { getPackageDir } from "@earendil-works/pi-coding-agent";
import { getCapabilities, getCellDimensions, type ImageProtocol } from "@earendil-works/pi-tui";
import { Worker } from "node:worker_threads";
import type { Snapshot } from "./model.ts";
import { rasterPng, rasterPngAsync, rectanglePng, viewportPng, viewportPngAsync } from "./png.ts";

const CONTENT_REFRESH_MS = 80;
const SOURCE_CHARS = 16 * 1024;
const MAX_SOURCE_ROWS = 8192;
const MAX_SOURCE_CHARS = 4 * 1024 * 1024;
const MAX_LINE_CHARS = 64 * 1024;
function rasterSize(width: number, height: number): [number, number] {
  width = Math.max(8, Math.round(width)); height = Math.max(1, Math.round(height));
  const scale = Math.min(1, 1024 / width, 4096 / height);
  // Limit memory without independently squeezing one image axis.
  return [Math.max(8, Math.round(width * scale)), Math.max(1, Math.round(height * scale))];
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
function viewportRect(geometry: MiniGeometry, rows: number, height: number, position?: DragPosition): { top: number; bottom: number } {
  const size = Math.max(1, Math.min(height, Math.round(geometry.size / Math.max(1, rows) * height)));
  const top = Math.max(0, Math.min(height - size, Math.round((position?.top ?? geometry.top / Math.max(1, rows)) * height)));
  return { top, bottom: top + size };
}
function imageKey(frame: Pick<MiniFrame, "version" | "offset" | "top" | "bottom">, dark: boolean, dragging: boolean): string {
  return `${frame.version}:${frame.offset}:${frame.top}:${frame.bottom}:${dark}:${dragging}`;
}

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
  layers: boolean;
  view: { offset: number; height: number; top: number; bottom: number };
}
function sameRequest(a: Request, b?: Request): boolean {
  if (!b || a.key !== b.key || a.offset !== b.offset || a.height !== b.height || a.lines.length !== b.lines.length) return false;
  let compared = 0;
  for (let i = 0; i < a.lines.length; i++) {
    compared += a.lines[i].length;
    if (compared > 128 * 1024 || a.lines[i] !== b.lines[i] || a.sourceRows[i] !== b.sourceRows[i]) return false;
  }
  return true;
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
  private running?: { request: Request; id: number; epoch: number; row: number; offset: number; uploading: boolean; waiting: boolean; timer?: ReturnType<typeof setTimeout> };
  private epoch = 0;
  private serial = 0;
  private nextRenderAt = 0;
  private png?: Buffer;
  private pngKey = "";
  private background?: { version: number; width: number; height: number; png: Buffer };
  private encoded?: { version: number; background?: Buffer; composite?: { key: string; png: Buffer } };
  private rectangle?: { key: string; png: Buffer };
  private pixels?: Uint8Array;
  private rasterVersion = 0;
  private sourceLines?: readonly string[];
  private completed?: Request;
  private displayed?: MiniFrame;
  private failure?: Error;
  private solidBackground?: { key: string; png: Buffer };
  geometry?: MiniGeometry;

  constructor(private ready: () => void = () => {}, private failed: (error: unknown) => void = () => {}) {}
  get isPending(): boolean { return !!(this.running || this.pending || this.timer); }

  render(snapshot: Snapshot, width: number, height: number, dark: boolean, dragging = false, position?: DragPosition): Buffer | undefined {
    const frame = this.frame(snapshot, width, height, dark, position);
    if (!frame) return undefined;
    const pngKey = imageKey(frame, dark, dragging);
    if (pngKey !== this.pngKey) {
      const encoded = this.encoded?.composite;
      if (encoded?.key === pngKey) this.png = encoded.png;
      else {
        const pixels = frame.pixels.subarray(frame.offset * frame.width * 4, (frame.offset + frame.height) * frame.width * 4);
        this.png = viewportPng(pixels, frame.width, frame.height, frame.top, frame.bottom, dark, dragging);
      }
      this.pngKey = pngKey;
    }
    return this.png;
  }

  renderLayers(snapshot: Snapshot, width: number, height: number, dark: boolean, dragging = false, position?: DragPosition): MinimapLayers | undefined {
    const frame = this.frame(snapshot, width, height, dark, position, true);
    if (!frame) {
      // Placeholder only when a cached background already exists; avoids extra uploads on cold start.
      if (snapshot.preparing) return undefined;
      const [rasterW, rasterH] = rasterSize(width, height);
      return this.background?.width === rasterW && this.background?.height === rasterH
        ? this.placeholder(snapshot, width, height, dark, dragging, position) : undefined;
    }
    if (this.background?.version !== frame.version) {
      const encoded = this.encoded?.version === frame.version ? this.encoded.background : undefined;
      this.background = { version: frame.version, width: frame.width, height: frame.rasterHeight, png: encoded ?? rasterPng(frame.pixels, frame.width, frame.rasterHeight) };
    }
    const key = `${frame.width}:${frame.bottom - frame.top}:${dark}:${dragging}`;
    if (this.rectangle?.key !== key) this.rectangle = { key, png: rectanglePng(frame.width, frame.bottom - frame.top, dark, dragging) };
    return { background: this.background.png, backgroundTop: frame.offset, backgroundHeight: frame.height, viewport: this.rectangle.png, top: frame.top / frame.height, fullHeight: frame.bottom - frame.top === frame.height };
  }

  private placeholder(snapshot: Snapshot, width: number, height: number, dark: boolean, dragging: boolean, position?: DragPosition): MinimapLayers | undefined {
    [width, height] = rasterSize(width, height);
    const geometry = minimapGeometry(snapshot, width, height);
    this.geometry = geometry;
    // Reuse the existing cached background PNG instead of uploading a new solid one.
    const background = this.background?.png ?? this.solidBackground?.png;
    if (!background) return undefined;
    // Viewport rectangle position
    const rect = viewportRect(geometry, snapshot.height, height, position);
    const rectKey = `${width}:${rect.bottom - rect.top}:${dark}:${dragging}`;
    if (this.rectangle?.key !== rectKey) this.rectangle = { key: rectKey, png: rectanglePng(width, rect.bottom - rect.top, dark, dragging) };
    return { background, backgroundTop: 0, backgroundHeight: height, viewport: this.rectangle.png, top: rect.top / height, fullHeight: rect.bottom - rect.top === height };
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

  private frame(snapshot: Snapshot, width: number, height: number, dark: boolean, position?: DragPosition, layers = false): MiniFrame | undefined {
    if (this.failure) throw this.failure;
    [width, height] = rasterSize(width, height);
    // Pointer feedback uses only the last displayed immutable raster, never history or a worker.
    if (position?.preview || snapshot.preparing) return position ? this.previewFrame(position.top, width, height) : undefined;
    const geometry = minimapGeometry(snapshot, width, height);
    this.geometry = geometry;
    const key = `${width}:${height}:${snapshot.width}:${geometry.lineHeight}:${dark}`;
    const viewOffset = Math.round(geometry.start * geometry.lineHeight);
    const rectangle = viewportRect(geometry, snapshot.height, height, position);
    const covers = (request?: Request) => !!request && request.key === key && viewOffset >= request.offset && viewOffset + height <= request.offset + request.height;
    if (!covers(this.requested) || this.sourceLines !== snapshot.lines) {
      // Reserve forward pixels even past the current end, so new streamed rows do not clear a valid image.
      const cacheHeight = Math.max(height, Math.min(4096, height * 3));
      const offset = covers(this.requested) && this.requested!.height === cacheHeight ? this.requested!.offset
        : Math.max(0, viewOffset - Math.floor((cacheHeight - height) / 2));
      const first = Math.floor(offset / geometry.lineHeight);
      const end = Math.min(snapshot.contentHeight, Math.ceil((offset + cacheHeight) / geometry.lineHeight));
      const previous = this.requested;
      const reuse = previous?.key === key && previous.offset === offset && previous.height === cacheHeight &&
        previous.sourceRows[0] === first && previous.sourceRows.length === end - first && unchangedWindow(snapshot, this.sourceLines, first, end);
      if (!reuse) {
        if (end - first > MAX_SOURCE_ROWS) throw new Error("Minimap preview is too tall; reduce the terminal size");
        const sourceRows = Array.from({ length: Math.max(0, end - first) }, (_, i) => first + i);
        let chars = 0;
        const lines = sourceRows.map(row => {
          const line = snapshot.lines[row] ?? "";
          chars += line.length;
          if (line.length > MAX_LINE_CHARS || chars > MAX_SOURCE_CHARS) throw new Error("Minimap preview text exceeds its safe size limit");
          return line;
        });
        const request: Request = {
          key, lines, sourceRows, width, height: cacheHeight, offset,
          columns: snapshot.width, geometry: { ...geometry, start: offset / geometry.lineHeight }, dark, layers,
          view: { offset: viewOffset - offset, height, ...rectangle },
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
    return this.displayed = { width, height, offset: viewOffset - this.completed!.offset, ...rectangle,
      pixels: this.pixels, rasterHeight: this.completed!.height, version: this.rasterVersion };
  }

  private schedule(): void {
    if (!this.pending || this.running || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      try { this.start(); } catch (error) { this.fail(error); }
    }, Math.max(0, this.nextRenderAt - performance.now()));
  }

  private start(): void {
    const request = this.pending, epoch = this.epoch;
    if (!request) return;
    if (!this.worker) {
      const worker = new Worker(new URL("./minimap-worker.mjs", import.meta.url), {
        execArgv: [], stdout: true, stderr: true,
        workerData: { agentDir: getPackageDir(), capabilities: getCapabilities(), maxRows: MAX_SOURCE_ROWS, maxChars: MAX_SOURCE_CHARS, maxLine: MAX_LINE_CHARS },
        resourceLimits: { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 16 },
      });
      this.worker = worker;
      // Do not read/ref-count captured stdio; an idle worker must not keep Pi alive.
      worker.on("message", async (message: { id: number; type?: string; pixels?: Uint8Array; error?: string }) => {
        if (this.worker !== worker || this.running?.id !== message.id) return;
        const job = this.running, request = job.request, view = request.view;
        if (message.type === "credit") {
          if (job.uploading && job.waiting) {
            job.waiting = false;
            job.timer = setTimeout(() => {
              job.timer = undefined;
              try { this.sendRows(job); } catch (error) { this.fail(error); }
            }, 0);
          }
          return;
        }
        let pixels: Uint8Array | undefined, png: Buffer | undefined;
        try {
          if (job.epoch === this.epoch) {
            if (message.error || !message.pixels || message.pixels.byteLength !== request.width * request.height * 4) {
              throw new Error(message.error || "Invalid minimap raster");
            }
            pixels = message.pixels;
            // Keep this latest-only job active until compression finishes off the interactive thread.
            png = request.layers ? await rasterPngAsync(pixels, request.width, request.height)
              : await viewportPngAsync(pixels.subarray(view.offset * request.width * 4, (view.offset + view.height) * request.width * 4),
                request.width, view.height, view.top, view.bottom, request.dark, false);
          }
        } catch (error) {
          if (this.worker === worker && this.running === job) {
            this.running = undefined; worker.unref();
            if (job.epoch === this.epoch) this.fail(error);
            else this.schedule();
          }
          return;
        }
        if (this.worker !== worker || this.running !== job) return;
        this.running = undefined;
        worker.unref();
        if (job.epoch === this.epoch && pixels && png) {
          this.pixels = pixels;
          this.completed = request;
          const version = ++this.rasterVersion;
          this.encoded = request.layers ? { version, background: png }
            : { version, composite: { key: imageKey({ ...view, version }, request.dark, false), png } };
          try { this.ready(); } catch (error) { this.fail(error); }
        }
        this.schedule();
      });
      worker.on("error", error => { if (this.worker === worker) this.fail(error); });
      worker.on("exit", () => { if (this.worker === worker) this.fail(new Error("Minimap worker exited unexpectedly")); });
      worker.unref();
    }
    this.pending = undefined;
    this.running = { request, id: ++this.serial, epoch, row: 0, offset: 0, uploading: true, waiting: true };
    this.nextRenderAt = performance.now() + CONTENT_REFRESH_MS;
    this.worker.ref();
    this.worker.postMessage({ type: "start", id: this.serial, frame: { ...request, lines: undefined } });
  }

  private sendRows(job: NonNullable<Minimap["running"]>): void {
    if (this.running !== job || !this.worker) return;
    if (job.epoch !== this.epoch || (this.pending && this.pending !== job.request)) {
      this.worker.postMessage({ type: "cancel", id: job.id });
      this.running = undefined; this.worker.unref(); this.schedule(); return;
    }
    let text = "";
    const ends: number[] = [], lines = job.request.lines;
    while (job.row < lines.length && text.length < SOURCE_CHARS && ends.length < 128) {
      const line = lines[job.row], count = Math.min(SOURCE_CHARS - text.length, line.length - job.offset);
      text += line.slice(job.offset, job.offset + count); job.offset += count;
      if (job.offset === line.length) { ends.push(text.length); job.row++; job.offset = 0; }
    }
    const done = job.row === lines.length;
    job.waiting = job.uploading = !done;
    this.worker.postMessage({ type: "rows", id: job.id, text, ends, done });
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
    this.encoded = undefined;
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
    clearTimeout(this.running?.timer); this.running = undefined;
    this.nextRenderAt = 0;
    void worker?.terminate().catch(() => {});
  }
}
