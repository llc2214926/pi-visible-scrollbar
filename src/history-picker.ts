import { getSelectListTheme, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Input, SelectList, truncateToWidth, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { isHistoryCancelled } from "./history-client.ts";
import type { HistoryQuery } from "./history-protocol.ts";
import { label } from "./model.ts";

/** Only one small result page lives in the modal; filtering never walks the session on the UI thread. */
export async function pickHistory(ctx: ExtensionContext, query: (text: string, offset: number, limit: number) => Promise<HistoryQuery>,
  cancel: () => void, signal: AbortSignal): Promise<string | undefined> {
  return ctx.ui.custom<string | undefined>((tui, theme, keys, done) => {
    const limit = Math.max(1, Math.min(12, tui.terminal.rows - 8));
    const input = new Input({ prompt: "Search inputs: ", placeholder: "text or input number" });
    let list = new SelectList([], limit, getSelectListTheme());
    let page: HistoryQuery = { items: [], total: 0, offset: 0 }, wanted = 0, serial = 0, loading = true, error = "", closed = false;
    const close = (id?: string) => { if (!closed) { closed = true; serial++; cancel(); signal.removeEventListener("abort", abort); done(id); } };
    const abort = () => close();
    signal.addEventListener("abort", abort, { once: true });
    const load = (offset: number) => {
      if (closed) return;
      const version = ++serial;
      wanted = Math.max(0, offset); loading = true; error = "";
      void query(input.getValue(), wanted, limit).then(result => {
        if (closed || version !== serial) return;
        page = result; loading = false;
        list = new SelectList(result.items.map(item => ({ value: item.id, label: `${item.rank + 1}. ${item.label}` })), limit, getSelectListTheme());
        list.onSelect = item => close(item.value); list.onCancel = abort;
        tui.requestRender();
      }).catch(reason => {
        if (closed || version !== serial || isHistoryCancelled(reason)) return;
        loading = false; error = label((reason instanceof Error ? reason.message : String(reason)).slice(0, 1024)); tui.requestRender();
      });
      tui.requestRender();
    };
    const turnPage = (direction: number) => {
      const offset = wanted + direction * limit;
      if (offset >= 0 && (direction < 0 || offset < page.total)) load(offset);
    };
    if (signal.aborted) queueMicrotask(abort);
    else load(0);
    return {
      capturesViewportInput: true,
      get focused() { return input.focused; },
      set focused(value: boolean) { input.focused = value; },
      render(width: number) {
        const fit = (text: string) => truncateToWidth(text, width, "…");
        const status = error || (loading ? "Loading history in background…" : `${page.total ? page.offset + 1 : 0}–${page.offset + page.items.length} / ${page.total} inputs`);
        return [theme.fg("accent", fit("Jump to user input · read-only")), ...input.render(width),
          ...(loading || error ? [theme.fg("muted", fit(status))] : list.render(width)),
          theme.fg("muted", fit(loading || error ? "" : status)),
          theme.fg("dim", fit("↑↓ select · Enter jump · PgUp/PgDn page · Esc close"))];
      },
      handleInput(data: string) {
        if (keys.matches(data, "tui.select.cancel")) { close(); return; }
        if (keys.matches(data, "tui.select.pageUp")) { turnPage(-1); return; }
        if (keys.matches(data, "tui.select.pageDown")) { turnPage(1); return; }
        if ((["tui.select.up", "tui.select.down", "tui.select.confirm"] as const).some(key => keys.matches(data, key))) {
          if (!loading && !error) list.handleInput(data);
          return;
        }
        const before = input.getValue(); input.handleInput(data);
        if (before !== input.getValue()) load(0);
      },
      handleMouse(event: TuiMouseEvent) {
        if (event.type === "wheel") { turnPage((event.wheelDelta ?? 0) < 0 ? -1 : 1); return { handled: true }; }
        if (event.y === 1) return input.handleMouse({ ...event, y: 0 });
        if (!loading && !error && event.y >= 2 && event.y < 2 + page.items.length) return list.handleMouse({ ...event, y: event.y - 2 });
        return { handled: true, render: false };
      },
      invalidate() { input.invalidate(); list.invalidate(); },
      dispose() { close(); },
    };
  }, { overlay: true, overlayOptions: { width: "85%", maxHeight: "85%" } });
}
