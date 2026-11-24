import type { KeybindingsConfig, TerminalCapabilities, TerminalColorMode } from "@earendil-works/pi-tui";
import type { Anchor, Prompt } from "./model.ts";

export const HISTORY_PAGE_ROWS = 256;
export const HISTORY_PACKET_BYTES = 128 * 1024;
export const HISTORY_SOURCE_CHARS = 16 * 1024;
export const HISTORY_COPY_BYTES = 32 * 1024 * 1024;

export interface HistoryPrompt extends Prompt { rank: number }
export interface HistoryCursor { id: string; line: number }
export interface HistorySummary { leaf: string | null; entries: number; prompts: number; revision: number }
export interface HistoryTheme {
  foreground: Record<string, string | number>;
  background: Record<string, string | number>;
  dim: string[];
  mode: TerminalColorMode;
  appearance: "dark" | "light";
}
export interface HistoryLayout {
  width: number;
  expanded: boolean;
  hideThinkingBlock: boolean;
  outputPad: number;
  theme: HistoryTheme;
  capabilities: TerminalCapabilities;
  keybindings: KeybindingsConfig;
}
export interface HistoryPage {
  lines: string[];
  spans: { id: string; row: number; end: number; line: number }[];
  anchors: (Anchor & { rank: number })[];
  start: HistoryCursor;
  next?: HistoryCursor;
  hasPrevious: boolean;
  current?: HistoryPrompt;
  width: number;
}
export interface HistoryQuery { items: HistoryPrompt[]; total: number; offset: number }
export interface HistoryMatch { entryIndex: number; prompt?: HistoryPrompt }
export interface HistoryRequests {
  sync: { leaf: string | null; file?: string; sessionId: string };
  query: { text: string; offset: number; limit: number };
  prompt: { id?: string; rank?: number; step?: number };
  match: { candidates: { id?: string; signature?: string }[]; cursor?: number };
  page: { cursor?: HistoryCursor; id?: string; before?: boolean; layout: HistoryLayout };
  find: { text: string; after?: HistoryCursor; layout: HistoryLayout };
  copy: { first: number; last: number; layout: HistoryLayout };
}
export interface HistoryReplies {
  sync: HistorySummary;
  query: HistoryQuery;
  prompt: HistoryPrompt | undefined;
  match: { matches: (HistoryMatch | null)[]; cursor: number };
  page: HistoryPage;
  find: HistoryPage | undefined;
  copy: string;
}
export type HistoryRequestKind = keyof HistoryRequests;
