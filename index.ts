import { copyToClipboard, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DEFAULT_CONFIG, configPath, loadConfig, saveConfig, type Config } from "./src/config.ts";
import { Sidebar } from "./src/sidebar.ts";
import { Viewport } from "./src/viewport.ts";
import { label } from "./src/model.ts";
import { isHistoryCancelled } from "./src/history-client.ts";

const WIDGET = "pi-visible-scrollbar.bootstrap";
const USAGE = "/scrollbar on | off | status | list | prev | next | page prev | page next | find TEXT | copy FIRST-LAST | end | minimap on | minimap off";

export default function visibleScrollbar(pi: ExtensionAPI): void {
  let config: Config = { ...DEFAULT_CONFIG };
  let active: { viewport: Viewport; sidebar: Sidebar } | undefined;
  let failure = "";
  let stopped = false;

  const dispose = () => {
    active?.sidebar.dispose();
    active?.viewport.dispose();
    active = undefined;
  };
  function mount(ctx: ExtensionContext): void {
    if (ctx.mode !== "tui" || !ctx.hasUI) return;
    ctx.ui.setWidget(WIDGET, tui => {
      const ensure = () => {
        if (stopped || !config.enabled || failure) return;
        if (active?.viewport.failure) {
          failure = active.viewport.failure;
          dispose();
          queueMicrotask(() => { if (!stopped) ctx.ui.notify(`Visible scrollbar disabled: ${failure}`, "warning"); });
          return;
        }
        if (active && !active.viewport.mounted) dispose();
        if (tui.mode !== "fullscreen") return;
        let candidate: Viewport | undefined;
        try {
          if (!active) {
            candidate = new Viewport(tui, ctx, () => pi.getSettings().hideThinkingBlock ?? false, () => pi.getSettings().outputPad ?? 1);
            const sidebar = new Sidebar(candidate, ctx, config.experimentalMinimap);
            active = { viewport: candidate, sidebar };
          }
          active.sidebar.resize();
        } catch (error) {
          dispose();
          candidate?.dispose();
          failure = error instanceof Error ? error.message : String(error);
          queueMicrotask(() => { if (!stopped) ctx.ui.notify(`Visible scrollbar disabled: ${failure}`, "warning"); });
        }
      };
      ensure();
      return {
        render() { ensure(); return []; },
        invalidate() { active?.viewport.refresh(); active?.sidebar.invalidate(); },
        dispose,
      };
    }, { placement: "belowEditor" });
  }

  pi.on("session_start", (_event, ctx) => {
    stopped = false;
    dispose();
    failure = "";
    try { config = loadConfig(); }
    catch (error) {
      failure = error instanceof Error ? error.message : String(error);
      config = { ...DEFAULT_CONFIG, enabled: false };
      if (ctx.mode === "tui") ctx.ui.notify(failure, "warning");
    }
    mount(ctx);
  });
  pi.on("session_shutdown", (_event, ctx) => {
    stopped = true;
    dispose();
    if (ctx.mode === "tui") ctx.ui.setWidget(WIDGET, undefined);
  });
  pi.on("session_tree", () => { active?.sidebar.closePopup(); active?.viewport.refresh(true); });
  pi.on("session_compact", () => { active?.sidebar.closePopup(); active?.viewport.refresh(); });
  pi.on("message_end", () => { active?.viewport.refresh(); });

  pi.registerCommand("scrollbar", {
    description: "Input markers, on-demand read-only history pages, background search/copy and an optional minimap",
    getArgumentCompletions: prefix => ["on", "off", "status", "list", "prev", "next", "page prev", "page next", "find", "copy", "end", "minimap on", "minimap off"]
      .filter(value => value.startsWith(prefix)).map(value => ({ value, label: value })),
    handler: async (args, ctx) => {
      if (ctx.mode !== "tui") { ctx.ui.notify("Visible scrollbar requires interactive fullscreen Pi.", "warning"); return; }
      if (args.length > 2048) { ctx.ui.notify("History search is limited to 1024 characters.", "warning"); return; }
      const action = args.trim();
      if (action === "status") {
        const rendered = active?.viewport.history.anchors.length ?? 0;
        const total = active?.viewport.history.promptCount ?? 0;
        const minimap = active?.sidebar.minimapStatus ?? (config.experimentalMinimap ? "on, not mounted" : "off");
        const error = failure || active?.viewport.history.error || active?.sidebar.minimapFailure;
        const history = active?.viewport.history.status ?? "not mounted";
        ctx.ui.notify(`Visible scrollbar: ${config.enabled ? "on" : "off"}; ${active?.viewport.mounted ? "mounted" : "not mounted"}; visible inputs ${rendered}/${total}; ${history}; experimental minimap ${minimap}.\n${error || configPath()}`, error ? "warning" : "info");
        return;
      }
      if (["on", "off", "minimap on", "minimap off"].includes(action)) {
        const next = { ...config };
        if (action.startsWith("minimap ")) next.experimentalMinimap = action === "minimap on";
        else next.enabled = action === "on";
        try { saveConfig(next); }
        catch (error) { ctx.ui.notify(`Could not save scrollbar configuration: ${error instanceof Error ? error.message : String(error)}`, "error"); return; }
        config = next;
        failure = "";
        if (action.startsWith("minimap ") && active?.viewport.mounted) {
          active.sidebar.setMinimap(config.experimentalMinimap);
        } else {
          dispose();
          ctx.ui.setWidget(WIDGET, undefined);
          mount(ctx);
        }
        ctx.ui.notify(`Scrollbar ${config.enabled ? "on" : "off"}; experimental minimap ${config.experimentalMinimap ? "on" : "off"}.`);
        return;
      }
      const find = action === "find" || action.startsWith("find ");
      const copy = /^copy\s+(\d+)(?:\s*-\s*(\d+))?$/.exec(action);
      if (!["list", "prev", "next", "end", "page prev", "page next"].includes(action) && !find && !copy) { ctx.ui.notify(USAGE); return; }
      const controller = active;
      if (!controller?.viewport.mounted) { ctx.ui.notify(failure || "Use /scrollbar on in fullscreen mode first.", "warning"); return; }
      controller.sidebar.closePopup();
      const viewport = controller.viewport;
      try {
        if (action === "end") { viewport.end(); return; }
        if (find) { await viewport.history.find(action === "find" ? undefined : action.slice(5)); return; }
        if (copy) {
          const first = Number(copy[1]), last = Number(copy[2] ?? copy[1]);
          if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last) || first < 1 || last < first) throw new Error("Use /scrollbar copy FIRST-LAST with positive input numbers");
          const text = await viewport.history.copy(first - 1, last - 1);
          if (active !== controller || !viewport.mounted) return;
          await copyToClipboard(text);
          ctx.ui.notify(`Copied inputs ${first}–${last} and their replies (plain text).`);
          return;
        }
        if (action.startsWith("page ")) {
          if (!viewport.history.inPage) ctx.ui.notify("Open an input with /scrollbar list first.");
          else await viewport.history.turnPage(action === "page prev" ? -1 : 1);
          return;
        }
        if (action === "list") {
          const id = await viewport.history.choose();
          if (id && active === controller && viewport.mounted && !await viewport.jump(id)) ctx.ui.notify("That input is no longer available.", "warning");
        } else await viewport.step(action === "prev" ? -1 : 1);
      } catch (error) {
        if (!isHistoryCancelled(error) && active === controller) ctx.ui.notify(label(error instanceof Error ? error.message : String(error)).slice(0, 240), "warning");
      }
    },
  });
}
