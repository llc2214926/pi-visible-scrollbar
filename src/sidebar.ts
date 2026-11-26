import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getCellDimensions, matchesKey, truncateToWidth, visibleWidth, type Component, type OverlayHandle, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";
import { bucketRanges, type Anchor, type AnchorRange, type Snapshot } from "./model.ts";
import { Minimap, minimapGeometry } from "./minimap.ts";
import { GraphicMinimap, minimapProtocol } from "./graphics.ts";
import { Viewport } from "./viewport.ts";
import { requestViewFrame } from "./native-history.ts";

const DRAG_SCROLL_MS = 32;

export class Sidebar implements Component {
  private map: Minimap;
  private rendered?: Snapshot;
  private tracks: AnchorRange[] = [];
  private minimapLayout = false;
  private terminalSize = "";
  private drag?: { kind: "map"; grab: number; row: number; position: number; moved: boolean };
  private dragTimer?: ReturnType<typeof setTimeout>;
  private suppressClick = false;
  private graphics?: GraphicMinimap;
  minimapFailure = "";
  private warned = "";
  private disposed = false;
  private popup?: OverlayHandle;
  private popupRange?: { anchors: readonly Anchor[]; start: number; end: number };
  private removeInput: () => void;

  constructor(private viewport: Viewport, private ctx: ExtensionContext, private experimentalMinimap: boolean) {
    this.map = new Minimap(() => {
      if (this.disposed || viewport.tui.hasOverlay()) return;
      if (!this.graphics?.redraw(false)) requestViewFrame(viewport.tui);
    }, error => this.failMinimap(error));
    viewport.setGutter(this, 3);
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
            // iTerm2 replaces overlapping Kitty images instead of alpha-compositing them.
            if (process.env.TERM_PROGRAM === "iTerm.app") {
              const png = this.map.render(snapshot, width, height, dark, !!drag, position);
              return png ? { protocol, png } : undefined;
            }
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
    this.viewport.scrollTo(Math.round(this.drag.position * Math.max(0, snapshot.contentHeight - snapshot.height)));
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
    if (enabled === this.experimentalMinimap && !this.minimapFailure) {
      this.resize(); this.viewport.tui.requestRender(); return;
    }
    this.experimentalMinimap = enabled; this.minimapFailure = ""; this.warned = "";
    if (this.drag?.kind === "map") this.cancelDrag();
    this.map.dispose(); this.resize(); this.viewport.tui.requestRender(true);
  }
  invalidate(): void { this.map.clear(this.drag?.kind === "map"); }

  render(width: number): string[] {
    const snapshot = this.viewport.snapshot();
    if (snapshot.anchors !== this.rendered?.anchors || snapshot.contentHeight !== this.rendered.contentHeight || snapshot.height !== this.rendered.height) {
      this.tracks = bucketRanges(snapshot.anchors, snapshot.contentHeight, snapshot.height);
    }
    this.rendered = snapshot;
    const miniWidth = Math.max(0, width - 3);
    const cells = getCellDimensions();
    const mapGeometry = miniWidth ? minimapGeometry(snapshot, miniWidth * cells.widthPx, snapshot.height * cells.heightPx) : undefined;
    const mapTop = this.drag?.kind === "map" && mapGeometry ? this.drag.position * mapGeometry.travel : mapGeometry?.top;
    const theme = this.ctx.ui.theme;
    return Array.from({ length: snapshot.height }, (_, row) => {
      const entries = this.tracks[row].end - this.tracks[row].start;
      let mark = "  ";
      if (entries > 1) mark = "≡ ";
      else if (entries) mark = "━ ";
      const inMapView = mapGeometry && mapTop !== undefined && row + 0.5 >= mapTop && row + 0.5 < mapTop + mapGeometry.size;
      const mapRow = " ".repeat(miniWidth);
      return (inMapView ? theme.bg("selectedBg", mapRow) : mapRow) + theme.fg("accent", mark) + " ";
    });
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    const snapshot = this.rendered;
    if (!snapshot || !this.viewport.mounted) return undefined;
    // Pi can cancel capture on focus loss without delivering a release to this component.
    if (event.type === "press") {
      const wasDragging = !!this.drag;
      this.cancelDrag(); this.suppressClick = false;
      if (wasDragging) requestViewFrame(this.viewport.tui);
    }
    if (event.type === "wheel") {
      if (this.drag?.kind === "map") { this.cancelDrag(); this.suppressClick = false; }
      this.closePopup(); this.viewport.scrollBy(event.wheelDelta ?? 0, { x: event.screenX, y: event.screenY });
      return { handled: true, render: false };
    }
    const group = this.tracks[event.y] ?? { start: 0, end: 0 };
    const count = group.end - group.start;
    const marker = event.x >= event.width - 3 && event.x < event.width - 1;
    const onThumbLane = event.x === event.width - 1;
    const miniWidth = Math.max(0, event.width - 3);
    const onMap = event.x >= 0 && event.x < miniWidth;
    const cells = getCellDimensions();
    const mapGeometry = onMap || this.drag?.kind === "map"
      ? minimapGeometry(snapshot, miniWidth * cells.widthPx, snapshot.height * cells.heightPx) : undefined;
    if (event.type === "move") {
      const wasDragging = !!this.drag;
      this.cancelDrag();
      this.suppressClick = false;
      if (marker && count > 1) this.openPopup(group, snapshot.anchors, event);
      // Keep the popup reachable while crossing the experimental minimap to its left.
      else if (marker || onThumbLane) this.closePopup();
      return { handled: true, render: wasDragging };
    }
    if (event.type === "press" && event.button === "left") {
      this.closePopup();
      // Hit the rounded pixels that are actually displayed, not the ideal fractional rectangle.
      const bounds = onMap && this.graphics?.isPainted
        ? this.map.viewportBounds(miniWidth * cells.widthPx, snapshot.height * cells.heightPx, minimapProtocol(this.viewport.tui)) : undefined;
      const pointer = (event.y + 0.5) / Math.max(1, snapshot.height);
      if (mapGeometry && bounds && pointer >= bounds.top && pointer < bounds.bottom) {
        // Keep continuous scroll coordinates so a same-cell move does not quantize the reading position.
        this.drag = { kind: "map", grab: event.y - mapGeometry.top, row: event.y, position: mapGeometry.max ? snapshot.top / mapGeometry.max : 0, moved: false };
        this.suppressClick = true;
        if (!this.graphics?.redraw()) requestViewFrame(this.viewport.tui);
        return { capture: true, render: false };
      }
      // Pi owns the last column's thumb, capture and click semantics.
      if (onThumbLane) return undefined;
      return { handled: true, render: false };
    }
    if (event.type === "drag" && this.drag) {
      // Focus loss can end Pi's capture without a release; never revive that gesture from motion.
      const capture = (this.viewport.tui.valueOf() as { mouseCapture?: { component: Component } }).mouseCapture;
      if (capture?.component !== this || event.button !== "left" || this.viewport.tui.hasOverlay()) {
        this.cancelDrag(); this.suppressClick = false;
        requestViewFrame(this.viewport.tui);
        return undefined;
      }
      const latest = this.viewport.snapshot();
      // Repeated cell reports are not movement, even in the top/bottom endpoint cells.
      if (event.y === this.drag.row) return { capture: true, render: false };
      this.drag.row = event.y;
      const geometry = minimapGeometry(latest, miniWidth * cells.widthPx, latest.height * cells.heightPx);
      this.drag.position = geometry.travel ? Math.max(0, Math.min(geometry.travel, event.y - this.drag.grab)) / geometry.travel : 0;
      // Cell-level mouse hits can grab outside the actual fractional-row rectangle.
      if (event.y <= 0) this.drag.position = 0;
      else if (event.y >= latest.height - 1) this.drag.position = 1;
      this.drag.moved = true;
      if (!this.graphics?.redraw()) requestViewFrame(this.viewport.tui);
      if (this.drag && !this.dragTimer) this.dragTimer = setTimeout(() => this.flushMapDrag(), DRAG_SCROLL_MS);
      return { capture: true, render: false };
    }
    if (event.type === "release") {
      const wasDragging = !!this.drag;
      this.flushMapDrag(); this.cancelDrag();
      if (wasDragging) requestViewFrame(this.viewport.tui);
      return { handled: true, render: false };
    }
    if (event.type === "click" && event.button === "left") {
      if (this.suppressClick) { this.suppressClick = false; return { handled: true, render: false }; }
      if (onMap && mapGeometry) this.viewport.scrollTo(Math.round(mapGeometry.start + (event.y + 0.5) * mapGeometry.count / Math.max(1, snapshot.height) - snapshot.height / 2));
      else if (marker && count === 1) this.viewport.jump(snapshot.anchors[group.start].id);
      else if (marker && count > 1) this.openPopup(group, snapshot.anchors, event);
      else if (!onThumbLane) this.viewport.scrollTo(Math.floor(event.y * snapshot.contentHeight / Math.max(1, snapshot.height)));
      return { handled: true, render: false };
    }
    return { handled: true, render: false };
  }

  private openPopup(group: AnchorRange, anchors: readonly Anchor[], event: TuiMouseEvent): void {
    if (this.popup && this.popupRange?.anchors === anchors && this.popupRange.start === group.start && this.popupRange.end === group.end) return;
    this.closePopup();
    const terminal = this.viewport.tui.terminal;
    if (terminal.rows < 4 || terminal.columns < 12) return;
    this.popupRange = { anchors, ...group };
    const count = group.end - group.start;
    const width = Math.min(64, terminal.columns);
    const height = Math.min(12, terminal.rows, count + 2);
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
          theme.bg("selectedBg", theme.fg("accent", fit(` × Close · ${count} inputs · click to jump`))),
          ...anchors.slice(group.start + offset, Math.min(group.end, group.start + offset + page)).map(anchor => theme.bg("selectedBg", theme.fg("text", fit(` ${this.viewport.history.promptRank(anchor.id) + 1}. ${anchor.label}`)))),
          theme.bg("selectedBg", theme.fg("muted", fit(` ${offset + 1}–${Math.min(count, offset + page)}/${count} · wheel scroll · Esc close`))),
        ];
      },
      invalidate() {},
      handleMouse: mouse => {
        if (mouse.type === "wheel") {
          offset = Math.max(0, Math.min(Math.max(0, count - page), offset + (mouse.wheelDelta ?? 0)));
          return { handled: true };
        }
        if (mouse.type === "click" && mouse.button === "left") {
          const index = group.start + offset + mouse.y - 1;
          const anchor = mouse.y > 0 && mouse.y <= page && index < group.end ? anchors[index] : undefined;
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
    this.popupRange = undefined;
    this.viewport.tui.requestRender();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true; this.cancelDrag(); this.closePopup(); this.removeInput();
    this.graphics?.dispose(); this.graphics = undefined; this.map.dispose();
    this.rendered = undefined; this.tracks = []; this.popupRange = undefined;
  }
}
