import { crc32, deflate, deflateSync } from "node:zlib";
import { promisify } from "node:util";

export type ViewportFormat = "png" | "rgba";

const deflateAsync = promisify(deflate);

const SIGNATURE = Buffer.from("89504e470d0a1a0a", "hex");
const END = Buffer.from("0000000049454e44ae426082", "hex");
function chunk(type: string, data: Buffer): Buffer {
  const result = Buffer.allocUnsafe(data.length + 12);
  result.writeUInt32BE(data.length, 0);
  result.write(type, 4, 4, "ascii");
  data.copy(result, 8);
  result.writeUInt32BE(crc32(result.subarray(4, -4)), result.length - 4);
  return result;
}

function dimensions(width: number, height: number): void {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 1024 || height > 4096) {
    throw new Error("Invalid minimap raster dimensions");
  }
}

function scanlines(pixels: Uint8Array, width: number, height: number, format: ViewportFormat = "png"): Buffer {
  dimensions(width, height);
  if (pixels.byteLength !== width * height * 4) throw new Error("Invalid minimap raster dimensions");
  if (format === "rgba") return Buffer.from(pixels); // Packed pixels, no PNG filter byte per row.
  const stride = width * 4;
  const scan = Buffer.allocUnsafe((stride + 1) * height);
  const source = Buffer.from(pixels.buffer, pixels.byteOffset, pixels.byteLength);
  for (let y = 0; y < height; y++) {
    scan[y * (stride + 1)] = 0; // PNG's None filter keeps this pass a straight row copy.
    source.copy(scan, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return scan;
}

function pack(compressed: Buffer, width: number, height: number, format: ViewportFormat = "png"): Buffer {
  if (format === "rgba") return compressed;
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4);
  header[8] = 8; header[9] = 6; // 8-bit RGBA, no interlacing.
  return Buffer.concat([SIGNATURE, chunk("IHDR", header), chunk("IDAT", compressed), END]);
}

function encode(scan: Buffer, width: number, height: number, format: ViewportFormat = "png"): Buffer {
  return pack(deflateSync(scan, { level: 3 }), width, height, format);
}

async function encodeAsync(scan: Buffer, width: number, height: number, format: ViewportFormat = "png"): Promise<Buffer> {
  return pack(await deflateAsync(scan, { level: 3 }), width, height, format);
}

export function rasterPng(pixels: Uint8Array, width: number, height: number): Buffer {
  return encode(scanlines(pixels, width, height), width, height);
}

export async function rasterPngAsync(pixels: Uint8Array, width: number, height: number): Promise<Buffer> {
  return encodeAsync(scanlines(pixels, width, height), width, height);
}

/** A reusable transparent layer: terminal alpha blending matches the iTerm2 composite below. */
export function rectanglePng(width: number, height: number, dark: boolean, dragging: boolean): Buffer {
  dimensions(width, height);
  const pixels = Buffer.alloc(width * height * 4);
  const left = width > 2 ? 1 : 0, right = width > 2 ? width - 2 : width - 1;
  const fill = dark ? 121 : 153, border = dark ? 160 : 119, alpha = dragging ? 140 : 77;
  for (let y = 0; y < height; y++) for (let x = left; x <= right; x++) {
    const offset = (y * width + x) * 4;
    const edge = x === left || x === right || y === 0 || y === height - 1;
    pixels.fill(edge ? border : fill, offset, offset + 3);
    pixels[offset + 3] = edge ? 255 : alpha;
  }
  return rasterPng(pixels, width, height);
}

function viewportScan(pixels: Uint8Array, width: number, height: number, top: number, bottom: number, dark: boolean, dragging: boolean, format: ViewportFormat): Buffer {
  const filter = format === "png" ? 1 : 0, stride = width * 4 + filter;
  const scan = scanlines(pixels, width, height, format);
  top = Math.max(0, Math.min(height - 1, Math.round(top)));
  bottom = Math.max(top + 1, Math.min(height, Math.round(bottom)));
  const left = width > 2 ? 1 : 0, right = width > 2 ? width - 2 : width - 1;
  const fill = dark ? 121 : 153, border = dark ? 160 : 119, alpha = dragging ? 140 : 77;
  for (let y = top; y < bottom; y++) for (let x = left; x <= right; x++) {
    const offset = y * stride + filter + x * 4;
    const edge = x === left || x === right || y === top || y === bottom - 1;
    for (let c = 0; c < 3; c++) scan[offset + c] = edge ? border : Math.round((scan[offset + c] * (255 - alpha) + fill * alpha) / 255);
  }
  return scan;
}

/** Pointer feedback stays synchronous over the cached raster; it never waits for font shaping or a worker. */
export function encodeViewport(pixels: Uint8Array, width: number, height: number, top: number, bottom: number, dark: boolean, dragging: boolean, format: ViewportFormat = "png"): Buffer {
  return encode(viewportScan(pixels, width, height, top, bottom, dark, dragging, format), width, height, format);
}

export async function encodeViewportAsync(pixels: Uint8Array, width: number, height: number, top: number, bottom: number, dark: boolean, dragging: boolean, format: ViewportFormat = "png"): Promise<Buffer> {
  return encodeAsync(viewportScan(pixels, width, height, top, bottom, dark, dragging, format), width, height, format);
}

export { encodeViewport as viewportPng, encodeViewportAsync as viewportPngAsync };
