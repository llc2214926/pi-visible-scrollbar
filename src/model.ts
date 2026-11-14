import { stripTerminalSequences } from "@earendil-works/pi-tui";

export interface Prompt {
  id: string;
  text: string;
  label: string;
  entryIndex: number;
}
export interface Anchor extends Prompt {
  row: number;
  end: number;
}
export interface Snapshot {
  anchors: Anchor[];
  lines: readonly string[];
  width: number;
  height: number;
  top: number;
  contentHeight: number;
}

export function label(text: string): string {
  return stripTerminalSequences(text).replace(/[\x00-\x1f\x7f-\x9f]/g, " ").trim().replace(/\s+/g, " ") || "[Empty input]";
}

export function buckets(anchors: readonly Anchor[], total: number, height: number): Anchor[][] {
  const result: Anchor[][] = Array.from({ length: Math.max(0, height) }, () => []);
  if (!height) return result;
  for (const anchor of anchors) {
    const row = Math.min(height - 1, Math.max(0, Math.floor(anchor.row * height / Math.max(total, height))));
    result[row].push(anchor);
  }
  return result;
}

export function thumb(top: number, total: number, height: number): { top: number; size: number; travel: number; max: number } {
  const size = Math.min(height, Math.max(1, Math.round(height * height / Math.max(total, height, 1))));
  const max = Math.max(0, total - height);
  const travel = height - size;
  return { top: max ? Math.round(Math.min(max, Math.max(0, top)) * travel / max) : 0, size, travel, max };
}

export function dragTop(pointer: number, grab: number, total: number, height: number): number {
  const geometry = thumb(0, total, height);
  return geometry.travel > 0 ? Math.round(Math.max(0, Math.min(geometry.travel, pointer - grab)) * geometry.max / geometry.travel) : 0;
}

export function nearestAnchor(anchors: readonly Anchor[], row: number): Anchor | undefined {
  let low = 0, high = anchors.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (anchors[middle].row <= row) low = middle + 1;
    else high = middle;
  }
  return anchors[Math.max(0, low - 1)];
}
