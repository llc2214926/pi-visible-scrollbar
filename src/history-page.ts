import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, type Component, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";
import type { HistoryCursor, HistoryPage } from "./history-protocol.ts";

export type HistoryAction = "previous" | "next" | "inputs" | "find" | "expand" | "thinking" | "live";
export interface HistoryPageState {
  page?: HistoryPage;
  loading: boolean;
  expanded: boolean;
  hideThinkingBlock: boolean;
  total: number;
}
export const HISTORY_HEADER_ROWS = 3;

/** A bounded, ordinary Pi component: native scrolling, selection and search still own the page. */
export class HistoryPageView implements Component {
  private buttons: { action: HistoryAction; from: number; end: number; enabled: boolean }[] = [];
  private footer = -1;
  private cached?: { width: number; state: HistoryPageState; theme: Theme; lines: string[] };

  constructor(private state: () => HistoryPageState, private theme: () => Theme,
    private action: (action: HistoryAction) => void, private reflow: (width: number) => void) {}

  render(width: number): string[] {
    this.reflow(width);
    const state = this.state(), theme = this.theme(), previous = this.cached;
    if (previous?.width === width && previous.theme === theme && previous.state.page === state.page &&
        previous.state.loading === state.loading && previous.state.expanded === state.expanded &&
        previous.state.hideThinkingBlock === state.hideThinkingBlock && previous.state.total === state.total) return previous.lines;
    const page = state.page, ready = page?.width === width;
    const choices: [HistoryAction, string, boolean][] = [
      ["previous", "Previous", !!page?.hasPrevious], ["next", "Next", !!page?.next],
      ["inputs", "Inputs", true], ["find", "Find", true], ["expand", state.expanded ? "Collapse" : "Expand", true],
      ["thinking", state.hideThinkingBlock ? "Show think" : "Hide think", true], ["live", "Live", true],
    ];
    let controls = " ", column = 1;
    this.buttons = choices.map(([action, text, available]) => {
      const value = `[${text}]`, enabled = available && (!state.loading || action === "live");
      const button = { action, from: column, end: column + value.length, enabled };
      controls += theme.fg(enabled ? "accent" : "dim", value) + " "; column += value.length + 1;
      return button;
    });
    controls = truncateToWidth(controls, width, "…");
    const position = page?.current ? ` · input ${page.current.rank + 1}/${state.total}` : "";
    const title = theme.fg("muted", truncateToWidth(` Earlier history · read-only${position}${state.loading ? " · loading…" : ""}`, width, "…"));
    const body = ready ? page.lines : [theme.fg("muted", truncateToWidth(" Loading this page in background…", width, "…"))];
    const lines = [title, controls, "", ...body, controls];
    this.footer = lines.length - 1;
    this.cached = { width, state, theme, lines };
    return lines;
  }

  cursorAt(row: number): HistoryCursor | undefined {
    const page = this.state().page;
    if (!page) return undefined;
    const bodyRow = Math.max(0, Math.min(page.lines.length - 1, row - HISTORY_HEADER_ROWS));
    const span = page.spans.find(span => span.row <= bodyRow && span.end > bodyRow);
    return span ? { id: span.id, line: span.line + bodyRow - span.row } : page.start;
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (event.y !== 1 && event.y !== this.footer) return undefined;
    const button = this.buttons.find(button => event.x >= button.from && event.x < button.end);
    if (!button) return undefined;
    if (event.type === "click" && event.button === "left" && button.enabled) this.action(button.action);
    return { handled: true, render: false };
  }

  invalidate(): void { this.cached = undefined; }
}
