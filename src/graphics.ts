import { encodeITerm2, getCapabilities, getCellDimensions, sliceByColumn, visibleWidth, type CellDimensions, type Component, type ImageProtocol, type TUI } from "@earendil-works/pi-tui";
import { KittyLayers } from "./kitty.ts";
import type { MinimapComposite, MinimapLayers } from "./minimap.ts";

type GraphicImage = { protocol: "iterm2"; png: Buffer } | { protocol: "kitty"; layers: MinimapLayers } | { protocol: "kitty"; composite: MinimapComposite };

const BEGIN = "\x1b[?2026h", END = "\x1b[?2026l", SAVE = "\x1b7", RESTORE = "\x1b8";
const isImageLine = (line: string) => line.includes("\x1b_G") || line.includes("\x1b]1337;File=");
interface Box { component: Component; rect: { x: number; y: number; width: number; height: number }; children: Box[] }
interface Renderer {
  doRender(): void;
  resetRenderState(): void;
  getScreenLines(): string[];
  currentLayout?: { root: Box };
  imageProtocol?: ImageProtocol;
}
function renderer(tui: TUI): Renderer {
  // Pi 1.5.2's stable proxy binds every method, including valueOf, to the real renderer.
  // Hook that instance: proxy reads wrap functions and proxy deletes do not reach the host.
  return tui.valueOf() as Renderer;
}

export function legacyItermKitty(): boolean {
  if (process.env.TERM_PROGRAM !== "iTerm.app") return false;
  const version = /^(\d+)\.(\d+)\.(\d+)(?:\.|$)/.exec(process.env.TERM_PROGRAM_VERSION ?? "");
  return version !== null && Number(version[1]) === 3 && Number(version[2]) === 6 && Number(version[3]) < 5;
}
export function minimapProtocol(tui: TUI): ImageProtocol {
  if (process.env.TMUX !== undefined || process.env.ZELLIJ !== undefined || process.env.STY !== undefined || /^(tmux|screen)/i.test(process.env.TERM ?? "")) return null;
  // Fullscreen Pi disables generic iTerm images after saving its negotiated imageProtocol.
  const protocol = renderer(tui).imageProtocol ?? getCapabilities().images;
  // iTerm2 3.6+ Kitty placements avoid the terminal's draggable inline-file images.
  if (protocol === "iterm2" && process.env.TERM_PROGRAM === "iTerm.app") {
    const version = /^(\d+)\.(\d+)(?:\.|$)/.exec(process.env.TERM_PROGRAM_VERSION ?? "");
    if (version && (Number(version[1]) > 3 || (Number(version[1]) === 3 && Number(version[2]) >= 6))) return "kitty";
  }
  return protocol === "kitty" || protocol === "iterm2" ? protocol : null;
}

/** Append only our reserved image cells to Pi's existing synchronized frame; never run another TUI. */
export class GraphicMinimap {
  private original: Renderer["doRender"];
  private wrapped: Renderer["doRender"];
  private hadOwn: boolean;
  private kitty?: KittyLayers;
  private removeInput: () => void;
  private painted = false;
  private lastImage?: Buffer;
  private lastBox = "";
  private shown?: { root: Box; rect: { x: number; y: number; width: number; height: number }; cells: CellDimensions };
  private queriedSize = "";
  private disposed = false;

  constructor(private tui: TUI, private component: Component, private png: (width: number, height: number, protocol: Exclude<ImageProtocol, null>, preview: boolean) => GraphicImage | undefined, private failed: (error: unknown) => void) {
    this.tui = tui.valueOf() as TUI;
    const host = renderer(this.tui);
    if (typeof host.doRender !== "function" || typeof host.resetRenderState !== "function" || typeof host.getScreenLines !== "function") throw new Error("Pi 1.5.2 frame compositor is unavailable.");
    this.original = host.doRender;
    this.hadOwn = Object.hasOwn(host, "doRender");
    this.removeInput = this.tui.addInputListener(data => {
      const reply = this.kitty?.response(data);
      if (!reply) return undefined;
      if (reply.retry) this.tui.requestRender();
      if (reply.error) queueMicrotask(() => { if (!this.disposed) this.failed(new Error(reply.error)); });
      return { consume: true };
    });
    this.wrapped = () => {
      if (this.disposed) { this.original.call(host); return; }
      // Remove the image before modal UI paints; a forced frame also restores unchanged overlay rows.
      const overlays = this.tui.hasOverlay();
      if (overlays && this.painted) host.resetRenderState();
      const before = host.getScreenLines();
      const terminal = this.tui.terminal, write = terminal.write, packets: string[] = [];
      const collect = (data: string) => { packets.push(data); };
      terminal.write = collect;
      try { this.original.call(host); }
      catch (error) { write.call(terminal, packets.join("")); throw error; }
      finally { if (terminal.write === collect) terminal.write = write; }
      if (!packets.length) return;
      const frame = { output: packets.join("") };
      let sequence = "";
      try {
        if (!this.disposed) {
          if (this.tui.hasOverlay()) {
            sequence = this.clearImage();
          } else sequence = this.draw(before, frame);
        }
      } catch (error) {
        this.failed(error);
      }
      const end = frame.output.lastIndexOf(END);
      if (sequence && end >= 0) frame.output = frame.output.slice(0, end) + sequence + frame.output.slice(end);
      write.call(terminal, frame.output);
    };
    host.doRender = this.wrapped;
  }

  get isPainted(): boolean { return this.painted; }

  /** Paint only our image cells; pointer previews use the cached raster without reading history. */
  redraw(preview = true): boolean {
    const shown = this.shown, cells = getCellDimensions(), protocol = minimapProtocol(this.tui);
    if (this.disposed || !this.painted || !shown || !protocol || this.tui.hasOverlay() ||
        renderer(this.tui).currentLayout?.root !== shown.root || cells.widthPx !== shown.cells.widthPx || cells.heightPx !== shown.cells.heightPx) return false;
    try {
      const image = this.png(shown.rect.width * cells.widthPx, shown.rect.height * cells.heightPx, protocol, preview);
      if (!image) return false;
      const sequence = this.paint(image, shown.rect, cells, true, false);
      if (sequence) this.tui.terminal.write(`${BEGIN}${sequence}${END}`);
      return true;
    } catch (error) { this.failed(error); return false; }
  }

  private draw(before: string[], frame: { output: string }): string {
    const cleared = frame.output.includes("\x1b[2J") || /\x1b_Ga=d,d=[aA],/.test(frame.output);
    const protocol = minimapProtocol(this.tui);
    const root = renderer(this.tui).currentLayout?.root;
    const visit = (box: Box): Box | undefined => box.component === this.component ? box : box.children.map(visit).find(Boolean);
    const box = root && visit(root);
    if (!protocol || !root || !box || box.rect.width <= 3 || box.rect.height < 1) {
      if (this.painted) {
        this.tui.requestRender(true);
        return this.clearImage();
      }
      return "";
    }
    const { x, y, height } = box.rect, width = box.rect.width - 3;
    const terminalSize = `${this.tui.terminal.columns}:${this.tui.terminal.rows}`;
    const query = terminalSize !== this.queriedSize ? "\x1b[16t" : "";
    this.queriedSize = terminalSize;
    // Fullscreen Pi skips this query for iTerm2 after disabling generic images. Its normal input
    // handler still consumes the reply and updates cell dimensions; do not change capabilities.
    const cells = getCellDimensions();
    const image = this.png(width * cells.widthPx, height * cells.heightPx, protocol, false);
    if (!image) {
      if (!this.painted) return query;
      if (!cleared) this.tui.requestRender(true);
      return query + this.clearImage();
    }
    const after = renderer(this.tui).getScreenLines();
    const position = `${x}:${y}:${width}:${height}`;
    const preserved = this.painted && !cleared && this.lastBox === position &&
      this.preserveImage(frame, before, after, x, y, width, height);
    this.shown = { root, rect: { x, y, width, height }, cells: { ...cells } };
    return query + this.paint(image, this.shown.rect, cells, preserved, cleared);
  }

  private paint(image: GraphicImage, box: { x: number; y: number; width: number; height: number }, cells: CellDimensions, preserved: boolean, cleared: boolean): string {
    const { x, y, width, height } = box;
    const position = `${x}:${y}:${width}:${height}`;
    if (image.protocol === "kitty") {
      this.kitty ??= new KittyLayers(legacyItermKitty());
      const sequence = "layers" in image
        ? this.kitty.draw(image.layers, box, cells, preserved, cleared)
        : this.kitty.drawComposite(image.composite, box, cells, preserved, cleared);
      this.painted = true;
      this.lastImage = undefined;
      this.lastBox = position;
      return sequence ? `${SAVE}${sequence}${RESTORE}` : "";
    }
    if (preserved && this.lastImage === image.png) return "";
    const remove = this.kitty?.clear() ?? "";
    this.painted = true;
    this.lastImage = image.png;
    this.lastBox = position;
    const sequence = encodeITerm2(image.png.toString("base64"), { width, height, preserveAspectRatio: false, inline: true });
    // Exact cell bounds are essential: preserveAspectRatio can silently letterbox the image
    // when terminal metrics are rounded or a cell-size reply has not arrived yet.
    return `${SAVE}${remove}\x1b[${y + 1};${x + 1}H${sequence}${RESTORE}`;
  }

  private preserveImage(frame: { output: string }, before: string[], after: string[], x: number, y: number, width: number, height: number): boolean {
    let preserved = true;
    for (let row = y; row < y + height; row++) {
      const line = after[row] ?? "";
      if (line === before[row]) continue;
      // Pi 1.5.2 rewrites entire rows. Leave the image cells untouched when only text/markers change.
      // Native image rows use a different renderer path: keep those packets intact and repaint our PNG.
      const original = `\x1b[${row + 1};1H\x1b[2K${line}`;
      if (isImageLine(line) || isImageLine(before[row] ?? "") || !frame.output.includes(original)) { preserved = false; continue; }
      const left = sliceByColumn(line, 0, x, true);
      const rightWidth = this.tui.terminal.columns - x - width;
      const right = sliceByColumn(line, x + width, rightWidth, true);
      const reset = "\x1b[0m\x1b]8;;\x07";
      const replacement = `\x1b[${row + 1};1H${left}${" ".repeat(Math.max(0, x - visibleWidth(left)))}${reset}\x1b[${row + 1};${x + width + 1}H${right}${" ".repeat(Math.max(0, rightWidth - visibleWidth(right)))}${reset}`;
      frame.output = frame.output.replace(original, () => replacement);
    }
    return preserved;
  }

  private clearImage(): string {
    this.painted = false;
    this.lastImage = undefined;
    this.shown = undefined;
    return this.kitty?.clear() ?? "";
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const host = renderer(this.tui);
    if (host.doRender === this.wrapped) {
      if (this.hadOwn) host.doRender = this.original;
      else delete (host as Partial<Renderer>).doRender;
    }
    this.removeInput();
    const clear = this.clearImage();
    if (clear) this.tui.terminal.write(`${BEGIN}${clear}${END}`);
    this.tui.requestRender(true);
  }
}
