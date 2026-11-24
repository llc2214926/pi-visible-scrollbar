import { parentPort, workerData } from "node:worker_threads";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { Resvg } from "@resvg/resvg-js";

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const prepared = new Map();
const ANSI = ["#000000", "#cd3131", "#0dbc79", "#e5e510", "#2472c8", "#bc3fbc", "#11a8cd", "#e5e5e5", "#666666", "#f14c4c", "#23d18b", "#f5f543", "#3b8eea", "#d670d6", "#29b8db", "#ffffff"];
function indexedColor(index) {
  if (index < 16) return ANSI[Math.max(0, index)];
  if (index >= 232) { const gray = Math.min(255, 8 + (index - 232) * 10); return `rgb(${gray},${gray},${gray})`; }
  const n = index - 16, levels = [0, 95, 135, 175, 215, 255];
  return `rgb(${levels[Math.floor(n / 36) % 6]},${levels[Math.floor(n / 6) % 6]},${levels[n % 6]})`;
}

/** Preserve terminal text, graphemes and SGR foregrounds using the actual host's width rules. */
export function coloredRuns(line, foreground, tui) {
  const runs = [];
  let column = 0, color = foreground, last = 0;
  const add = text => {
    text = tui.stripTerminalSequences(text).replace(/[\x00-\x1f\x7f-\x9f]/g, "");
    const cells = tui.visibleWidth(text);
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
    last = match.index + match[0].length;
  }
  add(line.slice(last));
  return runs;
}

function prepare(lines, frame, tui) {
  const foreground = frame.dark ? "#d4d4d4" : "#333333", widths = new Map(), rows = [];
  for (const line of lines) {
    const key = `${frame.columns}:${foreground}:${line}`;
    let runs = prepared.get(key);
    if (!runs) {
      runs = coloredRuns(tui.sliceByColumn(line, 0, frame.columns, true), foreground, tui).map(run => ({
        column: run.column, color: run.color, glyphs: Array.from(segmenter.segment(run.text), part => part.segment),
      }));
      prepared.set(key, runs);
    }
    for (const run of runs) for (const glyph of run.glyphs) if (!widths.has(glyph)) {
      if (glyph.length > 256 || widths.size >= 8192) throw new Error("Minimap text is too complex to rasterize safely");
      widths.set(glyph, tui.visibleWidth(glyph));
    }
    rows.push(runs);
    while (prepared.size > 512) prepared.delete(prepared.keys().next().value);
  }
  return { ...frame, rows, widths };
}

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

/** Pure raster stage, shared by prepared worker jobs and raster consumers. */
export function rasterize(frame) {
  const { width, height, columns, rows, widths, geometry, sourceRows, dark } = frame;
  const characters = [...widths.keys()].filter(text => text.trim() && widths.get(text));
  if (characters.length > 8192 || characters.some(text => text.length > 256)) throw new Error("Minimap glyph set exceeds its safe limit");
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
  let drawn = 0;
  const text = rows.flatMap((row, y) => row.flatMap(run => {
    let column = run.column;
    return run.glyphs.map(glyph => {
      const cells = widths.get(glyph), x = 2 + column * cellWidth;
      column += cells;
      if (!glyph.trim() || !cells) return "";
      if (++drawn > 500000) throw new Error("Minimap preview contains too many glyphs");
      return `<use href="#g${ids.get(glyph)}" fill="${run.color}" transform="translate(${x} ${(sourceRows[y] - geometry.start) * geometry.lineHeight}) scale(${cellWidth / 6} ${geometry.fontSize / 10})"/>`;
    });
  })).join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="${dark ? "#1e1e1e" : "#ffffff"}"/><defs>${definitions}</defs>${text}</svg>`;
  const pixels = new Resvg(svg, { font: { loadSystemFonts: false } }).render().pixels;
  while (glyphs.size > 8192) glyphs.delete(glyphs.keys().next().value);
  return { pixels, svg };
}

// A package extension may not have physical Pi peers beside it. Resolve from the running host.
const toolkit = parentPort ? import(pathToFileURL(createRequire(join(workerData.agentDir, "package.json")).resolve("@earendil-works/pi-tui")).href)
  .then(tui => { tui.setCapabilities(workerData.capabilities); return tui; }) : undefined;
let incoming;
parentPort?.on("message", async message => {
  const { id } = message;
  try {
    if (message.type === "cancel") { if (incoming?.id === id) incoming = undefined; return; }
    if (message.type === "start") {
      const { frame } = message;
      if (!Array.isArray(frame.sourceRows) || frame.sourceRows.length > workerData.maxRows ||
          !Number.isInteger(frame.width) || frame.width < 8 || frame.width > 1024 ||
          !Number.isInteger(frame.height) || frame.height < 1 || frame.height > 4096) throw new Error("Invalid minimap frame");
      const request = incoming = { id, frame, lines: [], parts: [], chars: 0, lineChars: 0 };
      await toolkit;
      if (incoming === request) parentPort.postMessage({ type: "credit", id });
      return;
    }
    const request = incoming;
    if (message.type !== "rows" || request?.id !== id) return;
    if (typeof message.text !== "string" || message.text.length > 16 * 1024 || !Array.isArray(message.ends) || message.ends.length > 128) throw new Error("Invalid minimap text packet");
    request.chars += message.text.length;
    if (request.chars > workerData.maxChars) throw new Error("Minimap text exceeds its safe size limit");
    let from = 0;
    for (const end of message.ends) {
      if (!Number.isInteger(end) || end < from || end > message.text.length) throw new Error("Invalid minimap line boundary");
      request.parts.push(message.text.slice(from, end)); request.lineChars += end - from;
      if (request.lineChars > workerData.maxLine) throw new Error("Minimap line exceeds its safe size limit");
      request.lines.push(request.parts.join("")); request.parts = []; request.lineChars = 0; from = end;
    }
    if (from < message.text.length) { request.parts.push(message.text.slice(from)); request.lineChars += message.text.length - from; }
    if (request.lines.length > workerData.maxRows || request.lineChars > workerData.maxLine) throw new Error("Minimap text exceeds its safe size limit");
    if (!message.done) { parentPort.postMessage({ type: "credit", id }); return; }
    if (request.parts.length || request.lines.length !== request.frame.sourceRows.length) throw new Error("Incomplete minimap text");
    const tui = await toolkit;
    if (incoming !== request) return;
    incoming = undefined;
    const pixels = Uint8Array.from(rasterize(prepare(request.lines, request.frame, tui)).pixels);
    parentPort.postMessage({ id, pixels }, [pixels.buffer]);
  } catch (error) {
    if (incoming?.id === id) incoming = undefined;
    parentPort.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
  }
});
