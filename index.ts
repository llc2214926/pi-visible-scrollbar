import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { DEFAULT_CONFIG, configPath, loadConfig, saveConfig, type Config } from "./src/config.ts";
import { Sidebar } from "./src/sidebar.ts";
import { Viewport } from "./src/viewport.ts";

const WIDGET = "pi-visible-scrollbar.bootstrap";
const USAGE = "/scrollbar on | off | status | list | prev | next | end | minimap on | minimap off";

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
            candidate = new Viewport(tui, ctx);
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
  pi.on("session_tree", () => { active?.sidebar.closePopup(); active?.viewport.refresh(); });
  pi.on("session_compact", () => { active?.sidebar.closePopup(); active?.viewport.refresh(); });
  pi.on("message_end", () => { active?.viewport.refresh(); });

  pi.registerCommand("scrollbar", {
    description: "User-input markers and scroll-only history navigation; optional experimental minimap",
    getArgumentCompletions: prefix => ["on", "off", "status", "list", "prev", "next", "end", "minimap on", "minimap off"]
      .filter(value => value.startsWith(prefix)).map(value => ({ value, label: value })),
    handler: async (args, ctx) => {
      if (ctx.mode !== "tui") { ctx.ui.notify("Visible scrollbar requires interactive fullscreen Pi.", "warning"); return; }
      const action = args.trim();
      if (action === "status") {
        const rendered = active?.viewport.history.anchors.length ?? 0;
        const total = active?.viewport.history.prompts.length ?? 0;
        const minimap = active?.sidebar.minimapStatus ?? (config.experimentalMinimap ? "on, not mounted" : "off");
        const error = failure || active?.sidebar.minimapFailure;
        ctx.ui.notify(`Visible scrollbar: ${config.enabled ? "on" : "off"}; ${active?.viewport.mounted ? "mounted" : "not mounted"}; inputs ${rendered}/${total}; experimental minimap ${minimap}.\n${error || configPath()}`, error ? "warning" : "info");
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
      if (!["list", "prev", "next", "end"].includes(action)) { ctx.ui.notify(USAGE); return; }
      const controller = active;
      if (!controller?.viewport.mounted) { ctx.ui.notify(failure || "Use /scrollbar on in fullscreen mode first.", "warning"); return; }
      controller.sidebar.closePopup();
      const viewport = controller.viewport;
      if (action === "end") { viewport.end(); return; }
      viewport.tui.renderNow();
      const snapshot = viewport.snapshot();
      if (action === "list") {
        const prompts = viewport.history.prompts.slice();
        if (!prompts.length) { ctx.ui.notify("No user inputs in this branch."); return; }
        const options = prompts.map((p, i) => `${i + 1}. ${truncateToWidth(p.label, 100)}`);
        const selected = await ctx.ui.select("Jump to user input · display only", options);
        if (selected && active === controller && viewport.mounted) {
          const index = options.indexOf(selected);
          if (index >= 0 && !viewport.jump(prompts[index].id)) ctx.ui.notify("That input is no longer in the current branch.", "warning");
        }
      } else {
        const target = action === "next" ? snapshot.anchors.find(a => a.row > snapshot.top) : snapshot.anchors.slice().reverse().find(a => a.row < snapshot.top);
        if (target) viewport.jump(target.id);
      }
    },
  });
}
