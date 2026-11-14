import { crc32, deflateSync } from "node:zlib";

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

/** Paint only the viewport over an immutable raster; no font shaping or worker round-trip on drag. */
export function viewportPng(pixels: Uint8Array, width: number, height: number, top: number, bottom: number, dark: boolean, dragging: boolean): Buffer {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 1024 || height > 4096 || pixels.byteLength !== width * height * 4) {
    throw new Error("Invalid minimap raster dimensions");
  }
  const stride = width * 4;
  const scan = Buffer.allocUnsafe((stride + 1) * height);
  const source = Buffer.from(pixels.buffer, pixels.byteOffset, pixels.byteLength);
  for (let y = 0; y < height; y++) {
    scan[y * (stride + 1)] = 0; // PNG's None filter keeps this pass a straight row copy.
    source.copy(scan, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  top = Math.max(0, Math.min(height - 1, Math.round(top)));
  bottom = Math.max(top + 1, Math.min(height, Math.round(bottom)));
  const left = width > 2 ? 1 : 0, right = width > 2 ? width - 2 : width - 1;
  const fill = dark ? 121 : 153, border = dark ? 160 : 119, alpha = dragging ? 140 : 77;
  for (let y = top; y < bottom; y++) for (let x = left; x <= right; x++) {
    const offset = y * (stride + 1) + 1 + x * 4;
    const edge = x === left || x === right || y === top || y === bottom - 1;
    for (let c = 0; c < 3; c++) scan[offset + c] = edge ? border : Math.round((scan[offset + c] * (255 - alpha) + fill * alpha) / 255);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4);
  header[8] = 8; header[9] = 6; // 8-bit RGBA, no interlacing.
  return Buffer.concat([SIGNATURE, chunk("IHDR", header), chunk("IDAT", deflateSync(scan, { level: 3 })), END]);
}
