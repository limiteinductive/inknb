import { collab, receiveTransaction, sendableSteps } from "prosemirror-collab";
import { Selection as NativeSelection, TextSelection } from "prosemirror-state";
import { Step } from "prosemirror-transform";
import { z } from "zod";
import { resolvedAsideView } from "./aside-state";
import { DocumentSession } from "./session";
import type { CommentReceipt, DocumentHost, SessionState } from "./session";
import type { Binding, Metadata, Selection } from "./domain";
import { captureAnchor, mapAnchor } from "./domain";
import { passageSourceSchema, textRange, mapPassageDrafts } from "./passage-reference";
import type { AsideAction } from "./aside-actions";
import type { HostRequest, DocumentExchange } from "./host-protocol";
import { documentViewSchema } from "./spaces";
import type { DocumentViewState } from "./spaces";
import type { NativeUpdate } from "./native-model";
import { NativeDocumentModel } from "./native-model";
import { save } from "@tauri-apps/plugin-dialog";

export class WindowDocument extends DocumentSession {
  epochIdentity: string;
  version: number;
  confirmedPublication: number;
  readonly clientId: string;
  private sending: Promise<void> | null = null;
  private receiving = false;
  private sourceChanged = false;
  private sendingSelection = false;
  private confirmed: SessionState;

  constructor(
    host: DocumentHost,
    exchange: DocumentExchange,
    view: DocumentViewState,
    clientId: string,
    readonly request: (request: HostRequest) => Promise<unknown>,
    readonly refreshHost: () => Promise<void>,
  ) {
    super(host);
    this.clientId = clientId;
    this.epochIdentity = exchange.epoch;
    this.version = exchange.version;
    this.confirmedPublication = exchange.publication;
    this.confirmed = exchange.state;
    const from = Math.min(view.selection.from, exchange.state.text.length);
    this.update({
      ...exchange.state,
      ...view,
      sourceScrollTop: view.scrollTop,
      selection: {
        from,
        to: Math.max(
          from,
          Math.min(view.selection.to, exchange.state.text.length),
        ),
      },
      dirty: false,
    });
    this.prepareModel();
    const pending = this.getSnapshot().pendingSource;
    if (!pending || !this.model) return;
    if (pending.text === this.confirmed.text) {
      this.update({ pendingSource: null });
      return;
    }
    if (pending.baseText !== this.confirmed.text) {
      this.sourceChanged = true;
      this.fail(
        "This window has recovered writing that conflicts with the saved document. Its recovery remains available in the window state.",
      );
      return;
    }
    const transaction = this.model.state.tr;
    for (const step of pending.steps)
      transaction.step(Step.fromJSON(this.model.state.schema, step));
    transaction.setSelection(
      NativeSelection.fromJSON(transaction.doc, pending.selection),
    );
    this.model.commit(transaction);
  }

  override prepareModel(): void {
    this.model = new NativeDocumentModel(this, [
      collab({ version: this.version, clientID: this.clientId }),
    ]);
  }

  override getSnapshot = (): SessionState => this.getWorkingSnapshot();

  receive(exchange: DocumentExchange): void {
    const current = this.getWorkingSnapshot();
    if (exchange.epoch !== this.epochIdentity) {
      if (this.model && sendableSteps(this.model.state)) {
        this.sourceChanged = true;
        this.fail(
          "The source was reloaded while this window had pending input. Keep this window open to recover its text.",
        );
        return;
      }
      this.epochIdentity = exchange.epoch;
      this.version = exchange.version;
      this.confirmedPublication = exchange.publication;
      this.confirmed = exchange.state;
      this.update({
        ...exchange.state,
        ...documentViewSchema.parse(current),
        asideNarrow: current.asideNarrow,
        dirty: false,
        epoch: current.epoch + 1,
      });
      this.prepareModel();

      return;
    }
    if (exchange.version < this.version) return;
    this.receiving = true;
    try {
      if (exchange.steps.length && this.model) {
        const transaction = receiveTransaction(
          this.model.state,
          exchange.steps.map((step) =>
            Step.fromJSON(this.model!.state.schema, step),
          ),
          exchange.clients,
        );
        this.model.commit(transaction);
      }
      this.version = exchange.version;
      this.confirmedPublication = exchange.publication;
      this.confirmed = exchange.state;
      const local = this.getWorkingSnapshot();
      const source = this.model?.source.toString() ?? exchange.state.text;
      let anchors = Object.fromEntries(
        exchange.state.metadata.threads.flatMap((thread) =>
          thread.anchor ? [[thread.id, thread.anchor]] : [],
        ),
      );
      const pending = this.model ? sendableSteps(this.model.state) : null;
      if (pending) {
        const projected = new NativeDocumentModel(
          {
            getWorkingSnapshot: () => exchange.state,
            onEditorUpdate: (update) => {
              anchors = update.anchors;
            },
          },
          [],
        );
        const transaction = projected.state.tr;
        for (const step of pending.steps) transaction.step(step);
        projected.commit(transaction);
        if (projected.source.toString() !== source)
          throw Error(
            "The pending window steps do not match its visible source.",
          );
      }
      this.update({
        ...exchange.state,
        ...documentViewSchema.parse(local),
        asideNarrow: local.asideNarrow,
        ...resolvedAsideView(local, exchange.state.metadata.threads
          .filter((thread) => thread.resolved && local.metadata.threads.some((previous) => previous.id === thread.id && !previous.resolved))
          .map((thread) => thread.id)),
        text: source,
        metadata: {
          ...exchange.state.metadata,
          nativeDocument: local.metadata.nativeDocument,
          decisions: exchange.state.metadata.decisions.map((decision) => ({ ...decision, anchor: anchors[decision.id] ?? decision.anchor })),
          threads: exchange.state.metadata.threads.map((thread) => ({
            ...thread,
            anchor: anchors[thread.id] ?? thread.anchor,
          })),
        },
        dirty: Boolean(this.model && sendableSteps(this.model.state)),
      });
      this.model?.restoreAnchors(
        Object.fromEntries(
          [...this.getSnapshot().metadata.threads, ...this.getSnapshot().metadata.decisions].flatMap((thread) =>
            thread.anchor ? [[thread.id, thread.anchor]] : [],
          ),
        ),
      );
      this.view?.refresh();
    } finally {
      this.receiving = false;
    }
  }

  override onEditorUpdate(update: NativeUpdate): void {
    const state = this.getWorkingSnapshot();
    this.update({
      text: update.source.toString(),
      drafts: mapPassageDrafts(state.drafts, state.metadata.documentId, update.source.toString(), update.changes),
      selection: update.selection,
      metadata: {
        ...state.metadata,
        nativeDocument: update.document,
        decisions: state.metadata.decisions.map((decision) => ({ ...decision, anchor: update.anchors[decision.id] ?? decision.anchor })),
        threads: state.metadata.threads.map((thread) => ({
          ...thread,
          anchor: update.anchors[thread.id] ?? thread.anchor,
        })),
      },
      dirty: update.docChanged || state.dirty,
      composerAnchor: state.composerAnchor
        ? mapAnchor(
            update.source.toString(),
            state.composerAnchor,
            update.changes,
          )
        : null,
    });
  }

  committed(): void {
    if (this.receiving || this.sourceChanged) return;
    const pending = this.model ? sendableSteps(this.model.state) : null;
    this.update({
      pendingSource: pending
        ? {
            baseText: this.confirmed.text,
            text: this.model!.source.toString(),
            steps: pending.steps.map((step) => step.toJSON()),
            selection: this.model!.state.selection.toJSON(),
          }
        : null,
    });
    void this.flush().catch((error) => this.fail(error));
  }

  flush(): Promise<void> {
    if (this.sourceChanged)
      return Promise.reject(
        Error(
          "This window has conflicting writing in recovery. Keep its text until the source is reconciled.",
        ),
      );
    if (this.sending) return this.sending;
    this.sending = (async () => {
      await this.view?.pasteQueue;
      while (this.model) {
        const pending = sendableSteps(this.model.state);
        if (!pending) break;
        await this.request({
          kind: "steps",
          documentId: this.confirmed.metadata.documentId,
          epoch: this.epochIdentity,
          version: pending.version,
          steps: pending.steps.map((step) => step.toJSON()),
          selection: this.model.state.selection.toJSON(),
        });
        await this.refreshHost();
        if (this.sourceChanged)
          throw Error(
            "The source changed while this window had pending writing. Your text stays in this window's recovery.",
          );
      }
      this.update({ pendingSource: null });
    })().finally(() => {
      this.sending = null;
    });
    return this.sending;
  }

  requireEditMode(): void {
    if (this.getWorkingSnapshot().editorMode !== "edit")
      throw Error("Switch to Edit mode to change the manuscript.");
  }

  async undoNative(): Promise<void> {
    this.requireEditMode();
    await this.flush();
    this.requireEditMode();
    await this.request({
      kind: "undo",
      documentId: this.confirmed.metadata.documentId,
    });
    await this.refreshHost();
  }
  async redoNative(): Promise<void> {
    this.requireEditMode();
    await this.flush();
    this.requireEditMode();
    await this.request({
      kind: "redo",
      documentId: this.confirmed.metadata.documentId,
    });
    await this.refreshHost();
  }

  private async action(action: AsideAction): Promise<unknown> {
    await this.flush();
    if (action.kind === "accept-all" || (action.kind === "proposal" && action.accept)) this.requireEditMode();
    const result = await this.request({
      kind: "aside",
      documentId: this.confirmed.metadata.documentId,
      revision: this.confirmed.metadata.revision,
      view: documentViewSchema.parse(this.getWorkingSnapshot()),
      action,
    });
    await this.refreshHost();
    return result;
  }

  override changed(
    metadata: Metadata = this.getWorkingSnapshot().metadata,
  ): void {
    const previous = this.getWorkingSnapshot().metadata;
    if (
      JSON.stringify({ ...metadata, agentAccess: previous.agentAccess }) !==
      JSON.stringify(previous)
    )
      throw Error("Document changes must go through the app host.");
    void this.request({
      kind: "permission",
      documentId: metadata.documentId,
      permission: metadata.agentAccess,
    })
      .then(() => this.refreshHost())
      .catch((error) => this.fail(error));
  }
  override async comment(
    content: string,
    threadId?: string,
  ): Promise<CommentReceipt> {
    const before = this.getWorkingSnapshot();
    const draftKey = threadId ?? "new";
    const receipt = z
      .object({ threadId: z.string().uuid() })
      .parse(await this.action({ kind: "comment", content, threadId }));
    const state = this.getWorkingSnapshot();
    if (!threadId) {
      this.view?.selectSource(state.selection.to);
      this.selectThread(receipt.threadId);
    }
    this.update({
      composer: false,
      composerAnchor: null,
      composerPreviewAnchor: null,
      drafts:
        JSON.stringify(state.drafts[draftKey]) === JSON.stringify(before.drafts[draftKey])
          ? { ...state.drafts, [draftKey]: { content: "", images: [] } }
          : state.drafts,
    });
    return receipt;
  }
  async commitAnnotation(key: string): Promise<void> {
    const before = this.getWorkingSnapshot().drafts[key];
    await this.action({ kind: "annotation-commit", key });
    const state = this.getWorkingSnapshot();
    const drafts = { ...state.drafts };
    if (JSON.stringify(state.drafts[key]) === JSON.stringify(before)) delete drafts[key];
    this.update({ drafts });
  }
  async dismissAnnotation(annotationId: string): Promise<void> {
    await this.action({ kind: "annotation-dismiss", annotationId });
    const drafts = { ...this.getWorkingSnapshot().drafts };
    delete drafts[`annotation:${annotationId}`];
    this.update({ drafts });
  }
  async sendAnnotation(key: string): Promise<CommentReceipt> {
    const before = this.getWorkingSnapshot().drafts[key];
    const receipt = z.object({ threadId: z.string().uuid() }).parse(await this.action({ kind: "annotation-send", key }));
    const state = this.getWorkingSnapshot();
    const drafts = { ...state.drafts };
    if (JSON.stringify(state.drafts[key]) === JSON.stringify(before)) delete drafts[key];
    this.update({ asidesOpen: true, focus: false, drafts });
    this.selectThread(receipt.threadId);
    return receipt;
  }
  override markThreadRead(threadId: string, signature: string): void {
    if (this.getSnapshot().threadReads[threadId] === signature) return;
    this.update({
      threadReads: { ...this.getSnapshot().threadReads, [threadId]: signature },
      threadExpansions: { ...this.getSnapshot().threadExpansions, [threadId]: true },
    });
    void this.action({ kind: "read", threadId, activity: signature }).catch(
      (error) => this.fail(error),
    );
  }

  override resolve(threadId: string, restoreFocus = true): void {
    void this.action({ kind: "resolve", threadId, restoreFocus: false })
      .then(() => {
        if (this.getSnapshot().metadata.threads.find(thread => thread.id === threadId)?.resolved)
          this.collapseThread(threadId, false);
        if (restoreFocus) this.restoreFocus();
      })
      .catch((error) => this.fail(error));
  }
  override async resolveAll(): Promise<string[]> {
    return z.array(z.string().uuid()).parse(await this.action({ kind: "resolve-all" }));
  }
  override async acceptAllProposals(): Promise<string[]> {
    this.requireEditMode();
    return z.array(z.string().uuid()).parse(await this.action({ kind: "accept-all" }));
  }
  override reanchor(
    threadId: string,
    selection: Selection = this.getWorkingSnapshot().selection,
  ): void {
    void this.action({ kind: "reanchor", threadId, selection }).catch((error) =>
      this.fail(error),
    );
  }
  override async proposal(proposalId: string, accept: boolean): Promise<void> {
    if (accept) this.requireEditMode();
    await this.action({ kind: "proposal", proposalId, accept });
  }
  override hideComponent(componentId: string): void {
    void this.action({ kind: "component-hide", componentId }).catch((error) =>
      this.fail(error),
    );
  }
  override componentMessage(
    componentId: string,
    message: Parameters<DocumentSession["componentMessage"]>[1],
  ): Promise<unknown> {
    return this.action({ kind: "component-message", componentId, message });
  }
  override async answerDecision(decisionId: string, option: number | null, text: string): Promise<void> {
    await this.action({ kind: "decision-answer", decisionId, option, text });
  }

  override async bind(
    binding: Binding | null,
    documentId: string,
  ): Promise<void> {
    await this.flush();
    await this.request({ kind: "binding", documentId, binding });
    await this.refreshHost();
  }
  override async control(
    method: string,
    parameters: unknown,
  ): Promise<unknown> {
    if (method === "passage_reveal") {
      const source = passageSourceSchema.parse(parameters);
      const state = this.getWorkingSnapshot();
      if (source.documentId !== state.metadata.documentId) throw Error("Open the source document to follow this reference.");
      this.host?.beforeNavigation();
      if (source.kind === "document") {
        const anchor = source.liveAnchor ?? source.anchor;
        if (anchor.status !== "attached" || state.text.slice(anchor.from, anchor.to) !== anchor.quote) throw Error(`Original passage: ${source.quote}`);
        this.surface?.scrollToSource(anchor.from, anchor);
      } else {
        this.update({ asidesOpen: true, focus: false, threadExpansions: { ...state.threadExpansions, [source.threadId]: true } });
        if (state.metadata.threads.find(thread => thread.id === source.threadId)?.resolved) window.dispatchEvent(new CustomEvent("inknb-history-aside", { detail: { documentId: source.documentId, threadId: source.threadId } }));
        requestAnimationFrame(() => {
          const selector = `[data-message-id="${source.messageId}"] [data-message-content="${source.field}"], [data-source-message-id="${source.messageId}"][data-message-content="${source.field}"]`;
          const reveal = () => {
            const element = Array.from(document.querySelectorAll(selector)).find(element => element.textContent === source.text);
            if (!element) { this.fail(Error(`Original passage: ${source.quote}`)); return; }
            const range = textRange(element, source.from, source.to);
            if (range && window.CSS?.highlights) CSS.highlights.set("inknb-reference", new Highlight(range));
            element.scrollIntoView({ block: "nearest" });
          };
          if (Array.from(document.querySelectorAll(selector)).some(element => element.textContent === source.text)) reveal();
          else {
            document.querySelector<HTMLButtonElement>(`[data-inknb-control="response:${source.messageId}"]`)?.click();
            requestAnimationFrame(reveal);
          }
        });
      }
      this.host?.afterNavigation();
      return null;
    }
    if (
      [
        "ui_state",
        "ui_inspect",
        "ui_action",
        "editor_select",
        "window_resize",
      ].includes(method)
    )
      return super.control(method, parameters);
    await this.flush();
    const result = await this.request({
      kind: "document",
      documentId: this.confirmed.metadata.documentId,
      method,
      parameters: z.record(z.string(), z.unknown()).parse(parameters),
    });
    await this.refreshHost();
    return result;
  }
  override async command(command: string): Promise<void> {
    if (command === "editor-mode") {
      if (this.view?.editor.composing)
        throw Error("Finish composing text before switching modes.");
      await this.view?.pasteQueue;
      const mode = this.getWorkingSnapshot().editorMode;
      this.update({ editorMode: mode === "edit" ? "render" : "edit" });
      this.view?.refresh();
      return;
    }
    if (command === "selection-comment") {
      if (this.sendingSelection) return;
      const model = this.model;
      const selected = model?.state.selection;
      if (!model || !(selected instanceof TextSelection) || selected.empty || !this.surface?.dom.contains(document.activeElement))
        throw Error("Select text in the document to send as an aside.");
      const snapshot = this.getWorkingSnapshot();
      const anchor = model.capture(captureAnchor(snapshot.text, snapshot.selection));
      this.sendingSelection = true;
      try {
        const receipt = z.object({ threadId: z.string().uuid() }).parse(await this.action({ kind: "selection-comment", anchor }));
        this.update({ asidesOpen: true, focus: false });
        this.selectThread(receipt.threadId);
      } finally {
        this.sendingSelection = false;
      }
      return;
    }
    if (command === "undo" || command === "redo") {
      const active = document.activeElement;
      const reply = active?.closest(".reference-editor");
      if (reply) { reply.dispatchEvent(new CustomEvent("inknb-editor-command", { detail: command })); return; }
      if (active?.closest('input, textarea, [contenteditable="true"]') && !this.surface?.dom.contains(active)) {
        document.execCommand(command);
        return;
      }
      return command === "undo" ? this.undoNative() : this.redoNative();
    }
    if (command === "save-as") {
      const path = await save({
        defaultPath: this.getSnapshot().path ?? undefined,
      });
      if (path) await this.control("document_save", { path });
      return;
    }
    if (command === "preview")
      return this.host?.detachPreview(this.confirmed.metadata.documentId);
    return super.command(command);
  }
  override async recover(): Promise<void> {}
  override async persist(): Promise<void> {
    await this.control("document_save", {});
  }
  override async load(path: string): Promise<void> {
    await this.host?.openDocument(path);
  }
  override async checkFiles(): Promise<void> {}
}
