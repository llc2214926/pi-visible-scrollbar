import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getCellDimensions, matchesKey, truncateToWidth, visibleWidth, type Component, type OverlayHandle, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";
import { buckets, dragTop, thumb, type Anchor, type Snapshot } from "./model.ts";
import { Minimap, minimapGeometry } from "./minimap.ts";
import { GraphicMinimap, minimapProtocol } from "./graphics.ts";
import { Viewport } from "./viewport.ts";

const DRAG_SCROLL_MS = 32;

export class Sidebar implements Component {
  private map: Minimap;
  private rendered?: Snapshot;
  private tracks: Anchor[][] = [];
  private minimapLayout = false;
  private terminalSize = "";
  private drag?: { kind: "thumb"; grab: number } | { kind: "map"; grab: number; position: number; moved: boolean; width: number; height: number };
  private dragTimer?: ReturnType<typeof setTimeout>;
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
    if (size !== this.terminalSize) { this.terminalSize = size; this.cancelDrag(); this.suppressClick = false; this.closePopup(); }
    const protocol = minimapProtocol(this.viewport.tui);
    const enabled = this.experimentalMinimap && !this.minimapFailure && protocol !== null && terminal.columns >= 60;
    if (this.experimentalMinimap && !protocol) this.warn("Pixel minimap needs iTerm2 or Kitty graphics in a direct terminal. Input markers remain available; no dot-map fallback is used.");
    if (enabled && !this.graphics) {
      try {
        this.graphics = new GraphicMinimap(this.viewport.tui, this, (width, height, protocol, preview) => {
          const snapshot = this.viewport.snapshot(), dark = this.ctx.ui.theme.appearance === "dark";
          const drag = this.drag?.kind === "map" ? this.drag : undefined;
          const position = drag ? { top: drag.position * minimapGeometry(snapshot, width, height).travel / Math.max(1, snapshot.height), preview } : undefined;
          if (protocol === "kitty") {
            const layers = this.map.renderLayers(snapshot, width, height, dark, !!drag, position);
            return layers ? { protocol, layers } : undefined;
          }
          const png = this.map.render(snapshot, width, height, dark, !!drag, position);
          return png ? { protocol, png } : undefined;
        }, error => this.failMinimap(error));
      } catch (error) { this.failMinimap(error); }
    } else if (!enabled && this.graphics) { this.graphics.dispose(); this.graphics = undefined; this.map.dispose(); }
    const proportional = enabled && !this.minimapFailure;
    if (proportional !== this.minimapLayout || !this.viewport.mounted) {
      this.cancelDrag();
      this.suppressClick = false;
      this.minimapLayout = proportional;
      this.closePopup();
      this.viewport.setGutter(this, 3, proportional);
    }
  }

  private cancelDrag(): void {
    clearTimeout(this.dragTimer);
    this.dragTimer = undefined;
    this.drag = undefined;
  }

  private flushMapDrag(): void {
    clearTimeout(this.dragTimer);
    this.dragTimer = undefined;
    if (this.drag?.kind !== "map" || !this.drag.moved) return;
    // Pi consumes focus-out before extension listeners; expired native capture cancels the timer.
    const capture = (this.viewport.tui.valueOf() as { mouseCapture?: { component: Component } }).mouseCapture;
    if (this.disposed || !this.viewport.mounted || this.viewport.tui.hasOverlay() || capture?.component !== this) {
      this.cancelDrag();
      if (!this.disposed) this.viewport.tui.requestRender();
      return;
    }
    const snapshot = this.viewport.snapshot();
    this.viewport.scrollTo(Math.round(this.drag.position * Math.max(0, snapshot.contentHeight - snapshot.height)), true);
  }

  private failMinimap(error: unknown): void {
    if (this.disposed) return;
    if (this.drag?.kind === "map") this.cancelDrag();
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
    if (this.drag?.kind === "map") this.cancelDrag();
    this.map.dispose(); this.resize(); this.viewport.tui.requestRender(true);
  }
  invalidate(): void { if (this.drag?.kind === "map") this.cancelDrag(); this.map.clear(); }

  render(width: number): string[] {
    const snapshot = this.viewport.snapshot();
    if (this.drag?.kind === "map" && (snapshot.width !== this.drag.width || snapshot.height !== this.drag.height)) this.cancelDrag();
    if (snapshot.anchors !== this.rendered?.anchors || snapshot.contentHeight !== this.rendered.contentHeight || snapshot.height !== this.rendered.height) {
      this.tracks = buckets(snapshot.anchors, snapshot.contentHeight, snapshot.height);
    }
    this.rendered = snapshot;
    const miniWidth = Math.max(0, width - 3);
    const cells = getCellDimensions();
    const mapGeometry = miniWidth ? minimapGeometry(snapshot, miniWidth * cells.widthPx, snapshot.height * cells.heightPx) : undefined;
    const mapTop = this.drag?.kind === "map" && mapGeometry ? this.drag.position * mapGeometry.travel : mapGeometry?.top;
    const geometry = thumb(snapshot.top, snapshot.contentHeight, snapshot.height);
    const theme = this.ctx.ui.theme;
    return Array.from({ length: snapshot.height }, (_, row) => {
      const entries = this.tracks[row];
      let mark = "  ";
      if (entries.length > 1) mark = "≡ ";
      else if (entries.length) mark = "━ ";
      const inView = row >= geometry.top && row < geometry.top + geometry.size;
      const inMapView = mapGeometry && mapTop !== undefined && row + 1 > mapTop && row < mapTop + mapGeometry.size;
      const mapRow = " ".repeat(miniWidth);
      return (inMapView ? theme.bg("selectedBg", mapRow) : mapRow) +
        theme.fg("accent", mark) + theme.fg(inView ? "scrollbarThumb" : "scrollbarTrack", inView ? "┃" : "│");
    });
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    const snapshot = this.rendered;
    if (!snapshot || !this.viewport.mounted) return undefined;
    // Pi can cancel capture on focus loss without delivering a release to this component.
    if (event.type === "press") { this.cancelDrag(); this.suppressClick = false; }
    if (event.type === "wheel") {
      if (this.drag?.kind === "map") { this.cancelDrag(); this.suppressClick = false; }
      this.closePopup(); this.viewport.scrollBy(event.wheelDelta ?? 0); return { handled: true };
    }
    const group = this.tracks[event.y] ?? [];
    const marker = event.x >= event.width - 3 && event.x < event.width - 1;
    const onThumbLane = event.x === event.width - 1;
    const miniWidth = Math.max(0, event.width - 3);
    const onMap = event.x < miniWidth;
    const cells = getCellDimensions();
    const mapGeometry = onMap || this.drag?.kind === "map"
      ? minimapGeometry(snapshot, miniWidth * cells.widthPx, snapshot.height * cells.heightPx) : undefined;
    if (event.type === "move") {
      const wasDragging = !!this.drag;
      this.cancelDrag();
      this.suppressClick = false;
      if (marker && group.length > 1) this.openPopup(group, event);
      // Keep the popup reachable while crossing the experimental minimap to its left.
      else if (marker || onThumbLane) this.closePopup();
      return { handled: true, render: wasDragging };
    }
    if (event.type === "press" && event.button === "left") {
      this.closePopup();
      if (onMap && mapGeometry && event.y + 1 > mapGeometry.top && event.y < mapGeometry.top + mapGeometry.size) {
        this.drag = { kind: "map", grab: event.y - mapGeometry.top, position: mapGeometry.max ? snapshot.top / mapGeometry.max : 0, moved: false, width: snapshot.width, height: snapshot.height };
        this.suppressClick = true;
        if (!this.graphics?.redraw()) this.viewport.tui.requestRender();
        return { capture: true, render: false };
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
      if (this.drag.kind === "map") {
        const geometry = minimapGeometry(latest, miniWidth * cells.widthPx, latest.height * cells.heightPx);
        this.drag.position = geometry.travel ? Math.max(0, Math.min(geometry.travel, event.y - this.drag.grab)) / geometry.travel : 0;
        // Cell-level mouse hits can grab outside the actual fractional-row rectangle.
        if (event.y <= 0) this.drag.position = 0;
        else if (event.y >= latest.height - 1) this.drag.position = 1;
        this.drag.moved = true;
        if (!this.graphics?.redraw()) this.viewport.tui.requestRender();
        if (this.drag?.kind === "map" && !this.dragTimer) this.dragTimer = setTimeout(() => this.flushMapDrag(), DRAG_SCROLL_MS);
      } else this.viewport.scrollTo(dragTop(event.y, this.drag.grab, latest.contentHeight, latest.height), true);
      return { capture: true, render: false };
    }
    if (event.type === "release") { this.flushMapDrag(); this.cancelDrag(); return { handled: true }; }
    if (event.type === "click" && event.button === "left") {
      if (this.suppressClick) { this.suppressClick = false; return { handled: true }; }
      if (onMap && mapGeometry) this.viewport.scrollTo(Math.round(mapGeometry.start + (event.y + 0.5) * mapGeometry.count / Math.max(1, snapshot.height) - snapshot.height / 2));
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
    this.disposed = true; this.cancelDrag(); this.closePopup(); this.removeInput();
    this.graphics?.dispose(); this.graphics = undefined; this.map.dispose();
  }
}
