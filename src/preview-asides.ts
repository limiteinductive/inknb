import { activity } from "./activity";
import { invoke } from "@tauri-apps/api/core";
import { z } from "zod";
import type { AsideDraft } from "./images";
import type { AsideReference, Selection } from "./domain";
import { asideReferenceSchema } from "./domain";
import { threadActivity } from "./domain";
import type { PreviewAnchor } from "./preview-model";
import type { PreviewState } from "./preview-window";
import type { CommentReceipt, SessionState } from "./session";
import type { AsideSession } from "./use-session";
import type { AsideAction, AsideResult } from "./aside-actions";

export class PreviewAsides implements AsideSession {
  private state: SessionState;
  private confirmed: PreviewState;
  private listeners = new Set<() => void>();
  private open = true;
  private reader: SessionState["asideReader"];
  private narrow = false;
  private review = {
    reviewOpen: false,
    reviewEarlier: false,
    reviewProposalId: null as string | null,
  };
  private reviewLocation: PreviewAnchor | null = null;
  private drafts = new Map<string, AsideDraft & { requestId: string }>();
  private pending = new Map<
    string,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timeout: ReturnType<typeof setTimeout>;
    }
  >();

  constructor(state: PreviewState) {
    this.confirmed = state;
    this.reader = {
      scrollTop: 0,
    };
    this.state = {
      ...state,
      ...this.review,
      asideReader: this.reader,
      asideNarrow: false,
      asidesOpen: true,
      focus: false,
    };
  }
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  receive(state: PreviewState): void {
    if (state.composer && !this.confirmed.composer) {
      this.open = true;
    }
    this.confirmed = state;
    this.refresh();
  }
  private refresh(): void {
    this.state = {
      ...this.confirmed,
      ...this.review,
      ...(this.reviewLocation ? { previewLocation: this.reviewLocation } : {}),
      asidesOpen: this.open,
      asideReader: this.reader,
      asideNarrow: this.narrow,
      focus: false,
      drafts: {
        ...this.confirmed.drafts,
        ...Object.fromEntries(
          [...this.drafts].map(([key, draft]) => [
            key,
            { content: draft.content, images: draft.images, references: draft.references, annotations: draft.annotations, annotation: draft.annotation, recipientAgentId: draft.recipientAgentId },
          ]),
        ),
      },
    };
    for (const listener of this.listeners) listener();
  }
  private request(
    action: AsideAction,
    requestId = crypto.randomUUID(),
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(requestId);
        reject(
          new Error("The writing window did not answer this aside action."),
        );
      }, 10000);
      this.pending.set(requestId, { resolve, reject, timeout });
      void invoke("preview_window_action", {
        documentId: this.state.metadata.documentId,
        action: { kind: "aside-action", requestId, action },
      }).catch((error) => this.result({ requestId, error: String(error) }));
    });
  }
  private send(action: AsideAction): void {
    void this.request(action).catch((error) => this.fail(error));
  }
  result(response: AsideResult): void {
    const pending = this.pending.get(response.requestId);
    if (!pending) return;
    this.pending.delete(response.requestId);
    clearTimeout(pending.timeout);
    for (const [key, draft] of this.drafts) {
      if (draft.requestId === response.requestId) this.drafts.delete(key);
    }
    this.refresh();
    if (response.error) pending.reject(new Error(response.error));
    else pending.resolve(response.result);
  }
  destroy(): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error("The preview document changed."));
    }
    this.pending.clear();
  }
  update(patch: Partial<SessionState>): void {
    if (patch.asideReader) this.reader = patch.asideReader;
    if (patch.asideNarrow !== undefined) this.narrow = patch.asideNarrow;
    if (patch.reviewOpen !== undefined)
      this.review.reviewOpen = patch.reviewOpen;
    if (patch.reviewEarlier !== undefined)
      this.review.reviewEarlier = patch.reviewEarlier;
    if (patch.reviewProposalId !== undefined)
      this.review.reviewProposalId = patch.reviewProposalId;
    if (patch.previewLocation !== undefined)
      this.reviewLocation = patch.previewLocation;
    if (patch.activeThread !== undefined)
      this.send({ kind: "focus", threadId: patch.activeThread });
    if (patch.asidesOpen !== undefined) this.open = patch.asidesOpen;
    if (patch.drafts) {
      for (const [key, draft] of Object.entries(patch.drafts)) {
        if (draft === this.state.drafts[key]) continue;
        const requestId = crypto.randomUUID();
        this.drafts.set(key, { requestId, ...draft });
        void this.request({ kind: "draft", key, ...draft }, requestId).catch(
          (error) => this.fail(error),
        );
      }
    }
    if (patch.composer !== undefined)
      this.send({
        kind: "composer",
        composer: patch.composer,
        composerAnchor: patch.composerAnchor,
        composerPreviewAnchor: patch.composerPreviewAnchor,
      });
    this.refresh();
  }
  fail(error: unknown): void {
    activity.report(this.state.metadata.documentId, "error", error);
    this.confirmed = { ...this.confirmed, error: String(error) };
    this.refresh();
  }
  async comment(content: string, threadId?: string): Promise<CommentReceipt> {
    const receipt = z
      .object({ threadId: z.string().uuid() })
      .parse(await this.request({ kind: "comment", content, threadId }));
    return receipt;
  }
  async answerDecision(
    decisionId: string,
    option: number | null,
    text: string,
  ): Promise<void> {
    await this.request({ kind: "decision-answer", decisionId, option, text });
  }
  markThreadRead(threadId: string, activity: string): void {
    this.send({ kind: "read", threadId, activity });
  }
  collapseThread(threadId: string): void {
    this.send({ kind: "collapse", threadId });
  }
  resolve(threadId: string, restoreFocus = true): void {
    this.send({ kind: "resolve", threadId, restoreFocus });
  }
  async resolveAll(): Promise<string[]> {
    return z
      .array(z.string().uuid())
      .parse(await this.request({ kind: "resolve-all" }));
  }
  reanchor(threadId: string, selection?: Selection): void {
    this.send({ kind: "reanchor", threadId, selection });
  }
  revealSource(threadId: string): void {
    this.send({ kind: "source", threadId });
  }
  revealPreview(anchor: PreviewAnchor): void {
    this.send({ kind: "reveal", anchor });
  }
  selectThread(threadId: string | null): void {
    this.send({ kind: "select", threadId });
    this.refresh();
  }
  toggleThread(threadId: string): void {
    this.send({ kind: "toggle", threadId });
  }
  openAside(reference: AsideReference): void {
    this.open = true;
    this.send({ kind: "reference", reference });
    this.refresh();
  }
  async control(method: string, parameters: unknown): Promise<unknown> {
    if (method === "history_read") {
      const value = z
        .object({ before: z.number().int().positive().optional() })
        .strict()
        .parse(parameters);
      return this.request({ kind: "history-read", ...value });
    }
    if (method === "revision_read") {
      const value = z
        .object({
          fromCursor: z.number().int().positive(),
          toCursor: z.number().int().positive(),
        })
        .strict()
        .parse(parameters);
      return this.request({ kind: "revision-read", ...value });
    }
    if (method === "aside_read")
      return this.request({
        kind: "aside-read",
        reference: asideReferenceSchema.parse(parameters),
      });
    if (method !== "component_update")
      throw new Error("This action is unavailable in the preview margin.");
    const value = z
      .object({
        componentId: z.string().uuid(),
        revision: z.number().int().nonnegative(),
        hidden: z.literal(false),
      })
      .parse(parameters);
    return this.request({
      kind: "component-show",
      componentId: value.componentId,
      revision: value.revision,
    });
  }
  async proposal(proposalId: string, accept: boolean): Promise<void> {
    await this.request({ kind: "proposal", proposalId, accept });
  }
  restoreFocus(): void {
    document.querySelector<HTMLTextAreaElement>(".new-aside textarea")?.focus();
  }
  startComment(): void {
    this.open = true;
    this.send({ kind: "start" });
    this.refresh();
  }
  hasUnreadActivity(threadId: string): boolean {
    const thread = this.state.metadata.threads.find(
      (thread) => thread.id === threadId,
    );
    const activity = thread
      ? threadActivity(this.state.metadata, thread)
      : null;
    return activity !== null && this.state.threadReads[threadId] !== activity;
  }
  componentMessage(
    componentId: string,
    message: Parameters<AsideSession["componentMessage"]>[1],
  ): Promise<unknown> {
    return this.request({ kind: "component-message", componentId, message });
  }
  hideComponent(componentId: string): void {
    this.send({ kind: "component-hide", componentId });
  }
}
