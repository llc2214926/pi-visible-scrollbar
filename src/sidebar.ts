import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getCellDimensions, matchesKey, truncateToWidth, visibleWidth, type Component, type OverlayHandle, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";
import { buckets, dragTop, thumb, type Anchor, type Snapshot } from "./model.ts";
import { Minimap, minimapGeometry, minimapDragTop } from "./minimap.ts";
import { GraphicMinimap, minimapProtocol } from "./graphics.ts";
import { Viewport } from "./viewport.ts";

export class Sidebar implements Component {
  private map: Minimap;
  private rendered?: Snapshot;
  private tracks: Anchor[][] = [];
  private minimapLayout = false;
  private terminalSize = "";
  private drag?: { kind: "map" | "thumb"; grab: number };
  private suppressClick = false;
  private graphics?: GraphicMinimap;
  minimapFailure = "";
  private warned = "";
  private disposed = false;
  private popup?: OverlayHandle;
  private popupKey = "";
  private removeInput: () => void;

  constructor(private viewport: Viewport, private ctx: ExtensionContext, private experimentalMinimap: boolean) {
    this.map = new Minimap(() => { if (!this.disposed) viewport.tui.requestRender(); }, error => this.failMinimap(error));
    this.removeInput = viewport.tui.addInputListener(data => {
      if (!this.popup) return undefined;
      if (matchesKey(data, "escape")) { this.closePopup(); return { consume: true }; }
      return undefined;
    });
  }

  resize(): void {
    const terminal = this.viewport.tui.terminal;
    const size = `${terminal.columns}:${terminal.rows}`;
    if (size !== this.terminalSize) { this.terminalSize = size; this.drag = undefined; this.suppressClick = false; this.closePopup(); }
    const protocol = minimapProtocol(this.viewport.tui);
    const enabled = this.experimentalMinimap && !this.minimapFailure && protocol !== null && terminal.columns >= 60;
    if (this.experimentalMinimap && !protocol) this.warn("Pixel minimap needs iTerm2 or Kitty graphics in a direct terminal. Input markers remain available; no dot-map fallback is used.");
    if (enabled && !this.graphics) {
      try {
        this.graphics = new GraphicMinimap(this.viewport.tui, this, (width, height, protocol) => {
          const snapshot = this.viewport.snapshot(), dark = this.ctx.ui.theme.appearance === "dark", dragging = this.drag?.kind === "map";
          if (protocol === "kitty") {
            const layers = this.map.renderLayers(snapshot, width, height, dark, dragging);
            return layers ? { protocol, layers } : undefined;
          }
          const png = this.map.render(snapshot, width, height, dark, dragging);
          return png ? { protocol, png } : undefined;
        }, error => this.failMinimap(error));
      } catch (error) { this.failMinimap(error); }
    } else if (!enabled && this.graphics) { this.graphics.dispose(); this.graphics = undefined; this.map.dispose(); }
    const proportional = enabled && !this.minimapFailure;
    if (proportional !== this.minimapLayout || !this.viewport.mounted) {
      this.drag = undefined;
      this.suppressClick = false;
      this.minimapLayout = proportional;
      this.closePopup();
      this.viewport.setGutter(this, 3, proportional);
    }
  }

  private failMinimap(error: unknown): void {
    if (this.disposed) return;
    this.minimapFailure = error instanceof Error ? error.message : String(error);
    this.warn(`Pixel minimap unavailable: ${this.minimapFailure}. Check runtime dependencies and fonts, then /reload.`);
    this.graphics?.dispose();
    this.graphics = undefined;
    this.map.dispose();
    queueMicrotask(() => { if (!this.disposed) this.resize(); });
  }

  private warn(message: string): void {
    if (this.warned === message) return;
    this.warned = message;
    queueMicrotask(() => { if (!this.disposed) this.ctx.ui.notify?.(message, "warning"); });
  }

  get minimapStatus(): string {
    if (!this.experimentalMinimap) return "off";
    if (this.minimapFailure) return `unavailable: ${this.minimapFailure}`;
    if (!minimapProtocol(this.viewport.tui)) return "unavailable: needs direct iTerm2/Kitty graphics";
    if (this.viewport.tui.terminal.columns < 60) return "paused: terminal narrower than 60 columns";
    return this.graphics ? `PNG (${minimapProtocol(this.viewport.tui)})` : "not mounted";
  }

  setMinimap(enabled: boolean): void {
    this.experimentalMinimap = enabled; this.minimapFailure = ""; this.warned = "";
    this.map.dispose(); this.resize(); this.viewport.tui.requestRender(true);
  }
  invalidate(): void { this.map.clear(); }

  render(width: number): string[] {
    const snapshot = this.viewport.snapshot();
    if (snapshot.anchors !== this.rendered?.anchors || snapshot.contentHeight !== this.rendered.contentHeight || snapshot.height !== this.rendered.height) {
      this.tracks = buckets(snapshot.anchors, snapshot.contentHeight, snapshot.height);
    }
    this.rendered = snapshot;
    const miniWidth = Math.max(0, width - 3);
    const cells = getCellDimensions();
    const mapGeometry = miniWidth ? minimapGeometry(snapshot, miniWidth * cells.widthPx, snapshot.height * cells.heightPx) : undefined;
    const geometry = thumb(snapshot.top, snapshot.contentHeight, snapshot.height);
    const theme = this.ctx.ui.theme;
    return Array.from({ length: snapshot.height }, (_, row) => {
      const entries = this.tracks[row];
      const mark = entries.length > 1 ? "≡ " : entries.length ? "━ " : "  ";
      const inView = row >= geometry.top && row < geometry.top + geometry.size;
      const inMapView = mapGeometry && row + 1 > mapGeometry.top && row < mapGeometry.top + mapGeometry.size;
      return (miniWidth ? inMapView ? theme.bg("selectedBg", " ".repeat(miniWidth)) : " ".repeat(miniWidth) : "") +
        theme.fg("accent", mark) + theme.fg(inView ? "scrollbarThumb" : "scrollbarTrack", inView ? "┃" : "│");
    });
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    const snapshot = this.rendered;
    if (!snapshot || !this.viewport.mounted) return undefined;
    if (event.type === "wheel") { this.closePopup(); this.viewport.scrollBy(event.wheelDelta ?? 0); return { handled: true }; }
    const group = this.tracks[event.y] ?? [];
    const marker = event.x >= event.width - 3 && event.x < event.width - 1;
    const onThumbLane = event.x === event.width - 1;
    const miniWidth = Math.max(0, event.width - 3);
    const onMap = event.x < miniWidth;
    const cells = getCellDimensions();
    const mapGeometry = onMap || this.drag?.kind === "map"
      ? this.map.geometry ?? minimapGeometry(snapshot, miniWidth * cells.widthPx, snapshot.height * cells.heightPx) : undefined;
    if (event.type === "move") {
      if (marker && group.length > 1) this.openPopup(group, event);
      // Keep the popup reachable while crossing the experimental minimap to its left.
      else if (marker || onThumbLane) this.closePopup();
      return { handled: true, render: false };
    }
    if (event.type === "press" && event.button === "left") {
      this.closePopup();
      this.suppressClick = false;
      if (onMap && mapGeometry && event.y + 1 > mapGeometry.top && event.y < mapGeometry.top + mapGeometry.size) {
        this.drag = { kind: "map", grab: event.y - mapGeometry.top };
        this.suppressClick = true;
        return { capture: true };
      }
      if (onThumbLane) {
        const geometry = thumb(snapshot.top, snapshot.contentHeight, snapshot.height);
        const grab = event.y >= geometry.top && event.y < geometry.top + geometry.size ? event.y - geometry.top : Math.floor(geometry.size / 2);
        this.drag = { kind: "thumb", grab };
        this.suppressClick = true;
        this.viewport.scrollTo(dragTop(event.y, grab, snapshot.contentHeight, snapshot.height), true);
        return { capture: true, render: false };
      }
      return { handled: true };
    }
    if (event.type === "drag" && this.drag) {
      const latest = this.viewport.snapshot();
      const row = this.drag.kind === "map" && mapGeometry
        ? minimapDragTop(event.y, this.drag.grab, { ...mapGeometry, max: Math.max(0, latest.contentHeight - latest.height) })
        : dragTop(event.y, this.drag.grab, latest.contentHeight, latest.height);
      this.viewport.scrollTo(row, true);
      return { capture: true, render: false };
    }
    if (event.type === "release") { this.drag = undefined; return { handled: true }; }
    if (event.type === "click" && event.button === "left") {
      if (this.suppressClick) { this.suppressClick = false; return { handled: true }; }
      if (onMap && mapGeometry) this.viewport.scrollTo(Math.round(mapGeometry.start + (event.y + 0.5) * mapGeometry.count / (mapGeometry.size + mapGeometry.travel || 1) - snapshot.height / 2));
      else if (marker && group.length === 1) this.viewport.jump(group[0].id);
      else if (marker && group.length > 1) this.openPopup(group, event);
      else if (!onThumbLane) this.viewport.scrollTo(Math.floor(event.y * snapshot.contentHeight / Math.max(1, snapshot.height)));
      return { handled: true };
    }
    return { handled: true, render: false };
  }

  private openPopup(group: Anchor[], event: TuiMouseEvent): void {
    const key = group.map(a => a.id).join(":");
    if (this.popup && key === this.popupKey) return;
    this.closePopup();
    const terminal = this.viewport.tui.terminal;
    if (terminal.rows < 4 || terminal.columns < 12) return;
    this.popupKey = key;
    const width = Math.min(64, terminal.columns);
    const height = Math.min(12, terminal.rows, group.length + 2);
    const page = height - 2;
    const left = Math.max(0, event.screenX - event.x - width);
    const top = Math.max(0, Math.min(terminal.rows - height, event.screenY - 1));
    let offset = 0;
    const popup: Component = {
      render: available => {
        const theme = this.ctx.ui.theme;
        const fit = (text: string) => {
          const line = truncateToWidth(text, available, "…");
          return line + " ".repeat(Math.max(0, available - visibleWidth(line)));
        };
        return [
          theme.bg("selectedBg", theme.fg("accent", fit(` × Close · ${group.length} inputs · click to jump`))),
          ...group.slice(offset, offset + page).map(anchor => theme.bg("selectedBg", theme.fg("text", fit(` ${this.viewport.history.prompts.findIndex(p => p.id === anchor.id) + 1}. ${anchor.label}`)))),
          theme.bg("selectedBg", theme.fg("muted", fit(` ${offset + 1}–${Math.min(group.length, offset + page)}/${group.length} · wheel scroll · Esc close`))),
        ];
      },
      invalidate() {},
      handleMouse: mouse => {
        if (mouse.type === "wheel") {
          offset = Math.max(0, Math.min(Math.max(0, group.length - page), offset + (mouse.wheelDelta ?? 0)));
          return { handled: true };
        }
        if (mouse.type === "click" && mouse.button === "left") {
          const anchor = mouse.y > 0 && mouse.y <= page ? group[offset + mouse.y - 1] : undefined;
          if (anchor) this.viewport.jump(anchor.id);
          this.closePopup();
        }
        return { handled: true, render: mouse.type !== "move" };
      },
    };
    this.popup = this.viewport.tui.showOverlay(popup, { row: top, col: left, width, maxHeight: height, nonCapturing: true });
    this.viewport.tui.requestRender();
  }

  closePopup(): void {
    if (!this.popup) return;
    this.popup.hide();
    this.popup = undefined;
    this.popupKey = "";
    this.viewport.tui.requestRender();
  }

  dispose(): void {
    this.disposed = true; this.closePopup(); this.removeInput();
    this.graphics?.dispose(); this.graphics = undefined; this.map.dispose();
  }
}
