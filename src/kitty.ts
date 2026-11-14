import { allocateImageId, deleteKittyImage, encodeKitty, type CellDimensions } from "@earendil-works/pi-tui";
import type { MinimapLayers } from "./minimap.ts";

/** Two owned images and stable placement IDs. Moving the viewport never retransmits its background. */
export class KittyLayers {
  readonly backgroundId = allocateImageId();
  readonly viewportId: number;
  private background?: Buffer;
  private viewport?: Buffer;
  private position = "";
  private viewportPosition = "";
  private uploaded = false;
  private failures = new Set<number>();

  constructor() {
    const id = allocateImageId();
    this.viewportId = id === this.backgroundId ? (id === 0xffffffff ? 1 : id + 1) : id;
  }

  draw(layers: MinimapLayers, box: { x: number; y: number; width: number; height: number }, cells: CellDimensions, preserved: boolean, cleared: boolean): string {
    if (cleared) this.forget();
    const backgroundChanged = this.background !== layers.background;
    const viewportChanged = this.viewport !== layers.viewport;
    const position = `${box.x}:${box.y}:${box.width}:${box.height}:${cells.widthPx}:${cells.heightPx}`;
    const viewportHeight = layers.fullHeight ? box.height * cells.heightPx
      : Math.round(layers.viewport.readUInt32BE(20) * box.width * cells.widthPx / layers.viewport.readUInt32BE(16));
    const pixelTop = Math.max(0, Math.min(box.height * cells.heightPx - viewportHeight, Math.round(layers.top * box.height * cells.heightPx)));
    const row = box.y + Math.floor(pixelTop / cells.heightPx), offset = pixelTop % cells.heightPx;
    const viewportPosition = `${position}:${pixelTop}:${layers.fullHeight}`;
    let output = "";
    const upload = (id: number, png: Buffer) => {
      if (this.uploaded) output += deleteKittyImage(id);
      // Reuse Pi's PNG chunking, but transmit without placing; placement has its own identity/layer.
      output += encodeKitty(png.toString("base64"), { imageId: id }).replace("\x1b_Ga=T,", "\x1b_Ga=t,");
    };
    if (backgroundChanged) upload(this.backgroundId, layers.background);
    if (viewportChanged) upload(this.viewportId, layers.viewport);
    if (backgroundChanged || !preserved || position !== this.position) {
      output += `\x1b[${box.y + 1};${box.x + 1}H\x1b_Ga=p,i=${this.backgroundId},p=1,C=1,q=0,c=${box.width},r=${box.height},z=0\x1b\\`;
    }
    if (backgroundChanged || viewportChanged || !preserved || viewportPosition !== this.viewportPosition) {
      // Only specifying columns preserves fractional-row image height; Y is an in-cell pixel offset.
      const rows = layers.fullHeight ? `,r=${box.height}` : "";
      output += `\x1b[${row + 1};${box.x + 1}H\x1b_Ga=p,i=${this.viewportId},p=1,C=1,q=0,c=${box.width}${rows},Y=${offset},z=1\x1b\\`;
    }
    this.background = layers.background;
    this.viewport = layers.viewport;
    this.position = position;
    this.viewportPosition = viewportPosition;
    this.uploaded = true;
    return output;
  }

  response(data: string): { retry?: boolean; error?: string } | undefined {
    const reply = /^\x1b_G([^;]+);([^\x1b]*)\x1b\\$/.exec(data);
    const id = reply && Number(/(?:^|,)i=(\d+)(?:,|$)/.exec(reply[1])?.[1]);
    if (!reply || (id !== this.backgroundId && id !== this.viewportId)) return undefined;
    if (reply[2] === "OK") { this.failures.delete(id); return {}; }
    if (reply[2].startsWith("ENOENT") && !this.failures.has(id)) {
      this.failures.add(id); this.forget(); return { retry: true };
    }
    return { error: `Kitty minimap placement failed: ${reply[2].replace(/[\x00-\x1f\x7f-\x9f]/g, " ").slice(0, 160)}` };
  }

  private forget(): void {
    this.background = this.viewport = undefined;
    this.position = this.viewportPosition = "";
  }
  clear(): string {
    const output = this.uploaded ? deleteKittyImage(this.backgroundId) + deleteKittyImage(this.viewportId) : "";
    this.uploaded = false; this.forget(); this.failures.clear();
    return output;
  }
}
