import { parentPort } from "node:worker_threads";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Resvg } from "@resvg/resvg-js";

const FONT = "Menlo,Consolas,DejaVu Sans Mono,Liberation Mono,Arial Unicode MS,Microsoft YaHei,Noto Sans CJK SC,WenQuanYi Zen Hei,monospace";
const escapeXml = text => text.replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[char]);
let fontFiles;
const glyphs = new Map();
function minimapFonts() {
  // Do not scan every installed font for each new set of glyphs.
  if (!fontFiles) {
    const windowsFonts = join(process.env.WINDIR ?? "C:\\Windows", "Fonts");
    const candidates = process.platform === "darwin" ? [
      "/System/Library/Fonts/Menlo.ttc", "/System/Library/Fonts/Supplemental/Arial Unicode.ttf",
    ] : process.platform === "win32" ? [
      join(windowsFonts, "consola.ttf"), join(windowsFonts, "msyh.ttc"), join(windowsFonts, "seguisym.ttf"),
    ] : [
      "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf", "/usr/share/fonts/truetype/liberation2/LiberationMono-Regular.ttf",
      "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc", "/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc",
    ];
    fontFiles = candidates.filter(existsSync);
  }
  if (!fontFiles.length) throw new Error("No supported outline font found (Menlo, Consolas or DejaVu Sans Mono)");
  return fontFiles;
}

/** Pure raster stage; the worker deliberately has no imports from Pi's virtual host packages. */
export function rasterize(frame) {
  const { width, height, columns, rows, widths, geometry, sourceRows, dark } = frame;
  const characters = [...widths.keys()].filter(text => text.trim() && widths.get(text));
  const missing = characters.filter(text => !glyphs.has(text));
  if (missing.length) {
    // Bitmap/color emoji have no outline here; keep their terminal columns with one placeholder.
    const atlas = `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100">${missing.map((text, i) => `<text id="g${i}" y="10" font-family="${FONT}" font-size="10">${escapeXml(/[\u200d\uFE0F]|\p{Emoji_Presentation}/u.test(text) ? "□" : text)}</text>`).join("")}</svg>`;
    const outlines = new Resvg(atlas, { font: { loadSystemFonts: false, fontFiles: minimapFonts() } }).toString();
    for (const match of outlines.matchAll(/<g id="g(\d+)">([\s\S]*?)<\/g>/g)) glyphs.set(missing[Number(match[1])], match[2].replaceAll(' fill="#000000"', ""));
    if (missing.some(text => !glyphs.has(text))) throw new Error("Could not rasterize minimap font outlines");
  }
  const ids = new Map(characters.map((text, i) => [text, i]));
  const definitions = characters.map(text => `<g id="g${ids.get(text)}"><title>${escapeXml(text)}</title>${glyphs.get(text)}</g>`).join("");
  const cellWidth = (width - 4) / Math.max(1, columns);
  const text = rows.flatMap((row, y) => row.flatMap(run => {
    let column = run.column;
    return run.glyphs.map(glyph => {
      const cells = widths.get(glyph), x = 2 + column * cellWidth;
      column += cells;
      return glyph.trim() && cells ? `<use href="#g${ids.get(glyph)}" fill="${run.color}" transform="translate(${x} ${Math.min(height - geometry.fontSize, sourceRows[y] * geometry.lineHeight)}) scale(${cellWidth / 6} ${geometry.fontSize / 10})"/>` : "";
    });
  })).join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="${dark ? "#1e1e1e" : "#ffffff"}"/><defs>${definitions}</defs>${text}</svg>`;
  const pixels = new Resvg(svg, { font: { loadSystemFonts: false } }).render().pixels;
  while (glyphs.size > 8192) glyphs.delete(glyphs.keys().next().value);
  return { pixels, svg };
}

parentPort?.on("message", ({ id, frame }) => {
  try {
    const pixels = Uint8Array.from(rasterize(frame).pixels);
    parentPort.postMessage({ id, pixels }, [pixels.buffer]);
  } catch (error) {
    parentPort.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
  }
});
