import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Container, type Component, type TUI } from "@earendil-works/pi-tui";
import { HistoryClient, historyLayout, isHistoryCancelled } from "./history-client.ts";
import { HISTORY_HEADER_ROWS, HistoryPageView, type HistoryAction } from "./history-page.ts";
import { pickHistory } from "./history-picker.ts";
import type { HistoryLayout, HistoryPage, HistoryQuery, HistoryRequests, HistorySummary } from "./history-protocol.ts";
import { NativeHistory, nativeFrame, requestViewFrame, transcriptOffset } from "./native-history.ts";
import { label, type Anchor, type LineChange } from "./model.ts";

type PageJob = { kind: "page"; target: Omit<HistoryRequests["page"], "layout"> }
  | { kind: "find"; target: Omit<HistoryRequests["find"], "layout"> };
const abort = () => new DOMException("History request cancelled", "AbortError");

/** Native live transcript by default; bounded read-only history pages only on explicit navigation. */
export class History {
  anchors: Anchor[] = [];
  lines: readonly string[] = [];
  lineChange?: LineChange;
  width = 0;
  nativeHeight = 0;
  pageOffset = 0;
  error = "";
  private client: HistoryClient;
  private native: NativeHistory;
  private pageView: HistoryPageView;
  private summary: HistorySummary = { leaf: null, entries: 0, prompts: 0, revision: -1 };
  private syncTask?: Promise<HistorySummary>;
  private syncInput?: HistoryRequests["sync"];
  private syncing = false;
  private disposed = false;
  private warned = "";
  private originalRender: Component["render"];
  private wrappedRender: Component["render"];
  private ownRender?: PropertyDescriptor;
  private frameCache?: Map<number, ReturnType<Component["render"]>>;
  private page?: HistoryPage;
  private pageAnchors = new Map<string, Anchor & { rank: number }>();
  private capturedPage?: HistoryPage;
  private capturedOffset = -1;
  private activePage = false;
  private loading = false;
  private navigationVersion = 0;
  private queryVersion = 0;
  private copyVersion = 0;
  private expanded?: boolean;
  private hidden?: boolean;
  private globalExpanded?: boolean;
  private globalHidden?: boolean;
  private globalOutputPad?: number;
  private appliedLayout?: HistoryLayout;
  private layoutTheme?: Theme;
  private settingsVersion = 0;
  private appliedSettings = -1;
  private requested?: { job: PageJob; width: number; theme: Theme; settings: number; reflow: boolean };
  private reflow?: { job: PageJob; width: number; reflow: boolean };
  private reflowTimer?: ReturnType<typeof setTimeout>;
  private dialog?: AbortController;
  private lastFind = "";

  constructor(private document: Container, private chat: Container, private ctx: ExtensionContext, private tui: TUI,
    private onError: (error: unknown) => void, private getHideThinkingBlock: () => boolean = () => false,
    private viewChanged: (mode: "page" | "live" | "end") => void = () => {}, private getTop: () => number = () => 0,
    private getOutputPad: () => number = () => 1) {
    this.client = new HistoryClient(ctx.sessionManager, error => { this.report(error); this.closePage(); }, ctx.cwd);
    this.native = new NativeHistory(this.client, () => this.ready(), redraw => {
      if (!this.inPage) {
        this.anchors = this.native.anchors; this.lineChange = this.native.lineChange;
        if (redraw) requestViewFrame(this.tui);
      }
    }, error => this.report(error));
    this.pageView = new HistoryPageView(() => ({ page: this.page, loading: this.loading || !!this.reflowTimer,
      expanded: this.appliedLayout?.expanded ?? false, hideThinkingBlock: this.appliedLayout?.hideThinkingBlock ?? false,
      total: this.promptCount }), () => this.ctx.ui.theme, action => this.pageAction(action), width => this.scheduleReflow(width));
    this.originalRender = document.render;
    this.ownRender = Object.getOwnPropertyDescriptor(document, "render");
    this.wrappedRender = width => {
      if (this.disposed) return this.originalRender.call(document, width);
      const cached = this.frameCache?.get(width);
      if (cached && this.width === width) return cached;
      const lines = this.originalRender.call(document, width);
      try {
        this.lines = lines; this.width = width;
        if (this.inPage) this.capturePage(lines, width);
        else {
          this.nativeHeight = lines.length;
          this.native.capture(nativeFrame(document, chat, width, lines));
          this.anchors = this.native.anchors; this.lineChange = this.native.lineChange;
        }
      } catch (error) {
        this.dispose(); this.onError(error);
        return this.originalRender.call(document, width);
      }
      this.frameCache?.set(width, lines);
      return lines;
    };
    document.render = this.wrappedRender;
    this.synchronize();
  }

  get inPage(): boolean { return this.activePage; }
  get currentPage(): HistoryPage | undefined { return this.inPage ? this.page : undefined; }
  get promptCount(): number { return this.summary.prompts; }
  get isFramePending(): boolean { return this.inPage && this.capturedPage !== this.page; }
  get isPending(): boolean { return !this.disposed && (this.syncing || this.loading || !!this.reflowTimer || this.isFramePending || (!this.inPage && this.native.isPending)); }
  get status(): string { return this.error || (this.loading ? "loading a history page in background" : this.syncing ? "indexing history in background" : this.inPage ? "read-only history page" : "native live transcript"); }

  beginFrame(): void {
    if (this.originalRender === Container.prototype.render) this.frameCache = new Map();
    this.synchronize();
  }
  endFrame(): void { this.frameCache = undefined; }

  private synchronize(): void {
    if (this.disposed) return;
    const reader = this.ctx.sessionManager;
    const input = { leaf: reader.getLeafId(), file: reader.getSessionFile(), sessionId: reader.getSessionId() };
    if (this.syncInput?.leaf === input.leaf && this.syncInput.file === input.file && this.syncInput.sessionId === input.sessionId) return;
    // Finish the current append batch; repeatedly cancelling it recopies the same uncommitted ancestors.
    if (this.syncing && this.syncInput?.file === input.file && this.syncInput?.sessionId === input.sessionId) return;
    this.syncInput = input; this.syncing = true;
    const task = this.client.request("sync", input).then(summary => {
      if (this.disposed || this.syncTask !== task) throw abort();
      if (summary.revision !== this.summary.revision) {
        if (this.summary.revision >= 0) { this.cancelQueries(); this.cancelCopy(); this.dialog?.abort(); this.closePage(); }
        this.native.reset();
      } else this.native.refresh();
      this.summary = summary; this.syncing = false; this.error = "";
      this.synchronize();
      if (this.inPage) this.tui.requestRender();
      else requestViewFrame(this.tui);
      return summary;
    }).catch(error => {
      if (!this.disposed && this.syncTask === task) {
        this.syncing = false;
        if (!isHistoryCancelled(error)) this.report(error);
        this.synchronize();
      }
      throw error;
    });
    this.syncTask = task;
    void task.catch(() => {});
  }

  async ready(): Promise<HistorySummary> {
    for (;;) {
      if (this.disposed) throw abort();
      this.synchronize();
      const task = this.syncTask!;
      try {
        const result = await task;
        if (this.disposed) throw abort();
        if (this.syncTask === task && result.leaf === this.ctx.sessionManager.getLeafId()) return result;
      } catch (error) { if (this.syncTask === task) throw error; }
    }
  }

  invalidate(reset = false): void {
    this.frameCache?.clear(); this.settingsVersion++;
    if (reset) {
      this.client.cancel("sync"); this.syncInput = undefined; this.syncing = false;
      this.dialog?.abort(); this.cancelQueries(); this.cancelCopy(); this.closePage(); this.native.reset();
    }
    this.synchronize();
  }

  anchor(id: string): Anchor | undefined { return this.inPage ? this.pageAnchors.get(id) : this.native.anchor(id); }
  promptRank(id: string): number {
    if (this.inPage) return this.pageAnchors.get(id)?.rank ?? (this.page?.current?.id === id ? this.page.current.rank : -1);
    return this.native.anchor(id)?.rank ?? -1;
  }
  async prompt(input: HistoryRequests["prompt"]) { await this.ready(); if (this.disposed) throw abort(); return this.client.request("prompt", input); }

  async query(text: string, offset: number, limit: number): Promise<HistoryQuery> {
    const version = ++this.queryVersion;
    this.client.cancel("query");
    if (text.length > 1024) throw new Error("History search is limited to 1024 characters");
    await this.ready();
    if (this.disposed || version !== this.queryVersion) throw abort();
    return this.client.request("query", { text, offset, limit });
  }
  cancelQueries(): void { this.queryVersion++; this.client.cancel("query"); }

  private layout(width: number): HistoryLayout {
    const expanded = this.ctx.ui.getToolsExpanded(), hidden = this.getHideThinkingBlock();
    if (expanded !== this.globalExpanded) this.expanded = undefined;
    if (hidden !== this.globalHidden) this.hidden = undefined;
    this.globalExpanded = expanded; this.globalHidden = hidden; this.globalOutputPad = this.getOutputPad();
    return { ...historyLayout(this.ctx, width, this.hidden ?? hidden, this.globalOutputPad), expanded: this.expanded ?? expanded };
  }

  open(id: string): Promise<boolean> { return this.load({ kind: "page", target: { id } }); }
  turnPage(direction: number): Promise<boolean> {
    const page = this.page;
    if (!this.inPage || !page || (direction < 0 ? !page.hasPrevious : !page.next)) return Promise.resolve(false);
    return this.load({ kind: "page", target: direction < 0 ? { cursor: page.start, before: true } : { cursor: page.next } });
  }

  private async load(job: PageJob, width = this.width || Math.max(1, this.tui.terminal.columns - 3), reflow = false): Promise<boolean> {
    this.cancelNavigation(true);
    const version = this.navigationVersion;
    this.loading = true; this.requested = { job, width, theme: this.ctx.ui.theme, settings: this.settingsVersion, reflow };
    this.tui.requestRender();
    try {
      await this.ready();
      if (this.disposed || version !== this.navigationVersion) return false;
      for (;;) {
        const layout = this.layout(width), theme = this.ctx.ui.theme, settings = this.settingsVersion;
        if (job.kind === "find") layout.expanded = true;
        const page = job.kind === "page" ? await this.client.request("page", { ...job.target, layout })
          : await this.client.request("find", { ...job.target, layout });
        if (this.disposed || version !== this.navigationVersion) return false;
        if (!page) { this.ctx.ui.notify?.("No matching text in this branch."); return false; }
        if (this.width && page.width !== this.width) { width = this.width; this.requested!.width = width; continue; }
        if (theme !== this.ctx.ui.theme || layout.theme.mode !== theme.getColorMode() || settings !== this.settingsVersion ||
            this.globalExpanded !== this.ctx.ui.getToolsExpanded() || this.globalHidden !== this.getHideThinkingBlock() || layout.outputPad !== this.getOutputPad()) continue;
        if (this.document.children[2] !== this.chat && this.document.children[2] !== this.pageView) throw new Error("Another extension replaced the transcript slot");
        this.page = page; this.appliedLayout = layout; this.layoutTheme = theme; this.appliedSettings = settings;
        if (job.kind === "find") this.expanded = true;
        this.activePage = true; this.document.children[2] = this.pageView;
        this.loading = false; this.requested = undefined; this.frameCache?.clear();
        this.viewChanged("page"); this.tui.requestRender();
        return true;
      }
    } catch (error) { if (!isHistoryCancelled(error) && version === this.navigationVersion) this.report(error); return false; }
    finally {
      if (version === this.navigationVersion) { this.loading = false; this.requested = undefined; if (!this.disposed) this.tui.requestRender(); }
    }
  }

  private scheduleReflow(width: number): void {
    if (!this.inPage || this.disposed) return;
    const theme = this.ctx.ui.theme;
    const settingsMatch = this.globalExpanded === this.ctx.ui.getToolsExpanded() && this.globalHidden === this.getHideThinkingBlock() &&
      this.globalOutputPad === this.getOutputPad();
    if (settingsMatch && this.requested?.width === width && this.requested.theme === theme && this.requested.settings === this.settingsVersion) return;
    if (settingsMatch && this.appliedLayout?.width === width && this.layoutTheme === theme && this.appliedLayout.theme.mode === theme.getColorMode() &&
        this.appliedSettings === this.settingsVersion) return;
    const job = this.requested?.job ?? this.reflow?.job ?? { kind: "page" as const, target: { cursor: this.pageView.cursorAt(this.getTop() - this.pageOffset) } };
    this.reflow = { job, width, reflow: this.requested?.reflow ?? true };
    if (!this.reflowTimer) this.reflowTimer = setTimeout(() => {
      this.reflowTimer = undefined;
      const next = this.reflow; this.reflow = undefined;
      if (next && !this.disposed) void this.load(next.job, next.width, next.reflow);
    }, 0);
  }

  private capturePage(lines: readonly string[], width: number): void {
    const offset = transcriptOffset(this.document, this.pageView, width, lines);
    if (offset === undefined) throw new Error("Unsupported history page layout; returning to the native transcript");
    this.pageOffset = offset;
    const page = this.page;
    if (page?.width !== width) { this.anchors = []; this.pageAnchors.clear(); this.capturedPage = undefined; }
    else if (page !== this.capturedPage || offset !== this.capturedOffset) {
      this.anchors = page.anchors.map(anchor => ({ ...anchor, row: anchor.row + offset + HISTORY_HEADER_ROWS, end: anchor.end + offset + HISTORY_HEADER_ROWS }));
      this.pageAnchors = new Map(this.anchors.map(anchor => [anchor.id, anchor as Anchor & { rank: number }]));
      this.capturedPage = page; this.capturedOffset = offset;
    }
    this.lineChange = undefined;
  }

  cancelNavigation(force = false): void {
    if (!force && (this.requested?.reflow || this.reflow?.reflow)) return;
    const pending = this.loading || !!this.reflowTimer;
    this.navigationVersion++; this.client.cancel("page"); this.client.cancel("find");
    clearTimeout(this.reflowTimer); this.reflowTimer = undefined; this.reflow = this.requested = undefined;
    this.loading = false;
    if (pending && !this.disposed) this.tui.requestRender();
  }

  closePage(): void {
    this.cancelNavigation(true);
    if (!this.activePage) return;
    if (this.document.children[2] === this.pageView) this.document.children[2] = this.chat;
    this.activePage = false; this.page = this.capturedPage = undefined;
    this.pageAnchors.clear(); this.anchors = this.native.anchors; this.lineChange = undefined;
    this.frameCache?.clear(); this.viewChanged("live");
    if (!this.disposed) this.tui.requestRender();
  }

  async choose(): Promise<string | undefined> {
    if (this.dialog || this.disposed) return undefined;
    const dialog = this.dialog = new AbortController();
    try { return await pickHistory(this.ctx, (text, offset, limit) => this.query(text, offset, limit), () => this.cancelQueries(), dialog.signal); }
    finally { if (this.dialog === dialog) this.dialog = undefined; }
  }

  async find(text?: string): Promise<boolean> {
    if (this.dialog || this.disposed) return false;
    if (text === undefined) {
      const dialog = this.dialog = new AbortController();
      try { text = await this.ctx.ui.input("Find text across this branch · read-only", this.lastFind || "Search text", { signal: dialog.signal }); }
      finally { if (this.dialog === dialog) this.dialog = undefined; }
    }
    if (!text?.trim() || this.disposed) return false;
    if (text.length > 1024) { this.report(new Error("History search is limited to 1024 characters")); return false; }
    const after = text === this.lastFind && this.page ? { ...this.page.start, line: this.page.start.line + 1 } : undefined;
    this.lastFind = text;
    return this.load({ kind: "find", target: { text, after } });
  }

  async copy(first: number, last: number): Promise<string> {
    this.cancelCopy(); const version = this.copyVersion;
    await this.ready();
    if (this.disposed || version !== this.copyVersion) throw abort();
    const text = await this.client.request("copy", { first, last, layout: { ...this.layout(this.width), expanded: true } });
    if (this.disposed || version !== this.copyVersion) throw abort();
    return text;
  }
  cancelCopy(): void { this.copyVersion++; this.client.cancel("copy"); }

  private pageAction(action: HistoryAction): void {
    if (action === "live") { this.closePage(); this.viewChanged("end"); return; }
    if (action === "previous" || action === "next") { void this.turnPage(action === "previous" ? -1 : 1); return; }
    if (action === "find") { void this.find().catch(error => this.report(error)); return; }
    if (action === "inputs") {
      void this.choose().then(id => { if (id && !this.disposed) return this.open(id); }).catch(error => this.report(error));
      return;
    }
    if (action === "expand") this.expanded = !this.appliedLayout?.expanded;
    if (action === "thinking") this.hidden = !this.appliedLayout?.hideThinkingBlock;
    this.appliedSettings = -1;
    this.scheduleReflow(this.width); this.tui.requestRender();
  }

  private report(error: unknown): void {
    if (this.disposed || isHistoryCancelled(error)) return;
    this.error = label(error instanceof Error ? error.message : String(error)).slice(0, 240);
    if (this.error !== this.warned) { this.warned = this.error; this.ctx.ui.notify?.(`History unavailable: ${this.error}`, "warning"); }
    this.tui.requestRender();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true; this.dialog?.abort(); this.dialog = undefined;
    this.cancelQueries(); this.cancelCopy(); this.closePage();
    this.native.dispose(); this.client.dispose();
    if (this.document.render === this.wrappedRender) {
      if (this.ownRender) Object.defineProperty(this.document, "render", this.ownRender);
      else delete (this.document as Partial<Container>).render;
    }
    this.anchors = []; this.lines = []; this.lineChange = undefined; this.frameCache = undefined;
  }
}
