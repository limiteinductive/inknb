import { z } from "zod";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { LogicalSize } from "@tauri-apps/api/dpi";
import { readWindowChrome } from "./window-chrome";
import { componentRuntimes } from "./component-bridge";
import { inspectInterface, actOnInterface } from "./ui-control";
import { validateSelection } from "./domain";
import type { NativeDocumentModel } from "./native-model";
import { activity } from "./activity";
import { asideReaderSchema } from "./spaces";
import { documentScroll } from "./document-scroll";
import { revealAsideComposer } from "./aside-focus";
import type { WritingSurface } from "./document-surface";
import type { NativeEditor } from "./native-editor";
import { previewAnchorSchema } from "./preview-model";
import type { PreviewAnchor, PreviewInfo } from "./preview-model";
import type { PreviewState } from "./preview-window";
import { asideExpanded } from "./aside-state";
import { captureAnchor, createMetadata, defaultPreferences, relocateAnchor, threadActivity } from "./domain";
import type { Anchor, AsideReference } from "./domain";
import type { SessionState, DocumentHost } from "./session";

export abstract class DocumentReader {
  constructor(readonly host?: DocumentHost) {}

  writingSurface: WritingSurface | null = null;

  get surface(): WritingSurface | null {
    return this.writingSurface ?? this.view;
  }

  get agentAccess(): "read" | "edit" {
    return (
      this.state.metadata.agentAccess ??
      (this.state.preferences.agent_edits ? "edit" : "read")
    );
  }

  protected state: SessionState = {
    asideReferences: {},
    ready: false,
    epoch: 0,
    text: "",
    metadata: createMetadata(),
    path: null,
    selection: { from: 0, to: 0 },
    preferences: defaultPreferences,
    dirty: false,
    saving: false,
    status: "",
    error: null,
    externalChange: false,
    activeThread: null,
    asidesOpen: true,
    asideNarrow: false,
    asideReader: asideReaderSchema.parse({}),
    threadExpansions: {},
    composer: false,
    drafts: {},
    threadReads: {},
    composerAnchor: null,
    composerPreviewAnchor: null,
    composerTop: null,
    outlineOpen: null,
    reviewOpen: false,
    reviewEarlier: false,
    reviewProposalId: null,
    pageVisible: false,
    pageDrafts: {},
    previewInformation: null,
    previewSelection: null,
    previewRuntime: null,
    previewArtifactId: null,
    previewLocation: null,
    focus: false,
    previewHost: "main",
    sourceScrollTop: 0,
    commandPath: "",
    codexPath: "",
    socketPath: "",
    profile: null,
  };

  private listeners = new Set<() => void>();

  private unreadThreads = new Set<string>();

  publication = 0;

  model: NativeDocumentModel | null = null;

  view: NativeEditor | null = null;

  getWorkingSnapshot = (): SessionState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  update(patch: Partial<SessionState>): void {
    const view = this.view;
    if (view && patch.asideNarrow !== undefined && patch.asideNarrow !== this.state.asideNarrow) {
      const viewport = documentScroll(view.dom);
      const scrollTop = viewport.scrollTop;
      const bounds = view.dom.getBoundingClientRect();
      const position = view.editor.posAtCoords({ left: bounds.left + Math.min(24, bounds.width / 2), top: viewport.getBoundingClientRect().top + 80 });
      const top = position ? view.editor.coordsAtPos(position.pos).top : null;
      requestAnimationFrame(() => {
        if (this.view !== view) return;
        viewport.scrollTop = scrollTop === 0 || !position || top === null
          ? scrollTop
          : viewport.scrollTop + view.editor.coordsAtPos(Math.min(position.pos, view.editor.state.doc.content.size)).top - top;
      });
    }
    this.publication += 1;
    this.state = { ...this.state, ...patch };
    if (patch.metadata || patch.threadReads)
      this.unreadThreads = new Set(
        this.state.metadata.threads
          .filter((thread) => {
            const activity = threadActivity(this.state.metadata, thread);
            return (
              activity !== null &&
              this.state.threadReads[thread.id] !== activity
            );
          })
          .map((thread) => thread.id),
      );
    this.publishedState = this.publishedSnapshot(this.state);
    for (const listener of this.listeners) listener();
    if (this.state.previewHost === "detached") this.publishPreview();
    if (
      this.view &&
      (patch.metadata ||
        patch.threadReads ||
        patch.threadExpansions ||
        patch.asidesOpen !== undefined ||
        patch.asideNarrow !== undefined ||
        patch.activeThread !== undefined ||
        patch.composer !== undefined ||
        patch.composerAnchor !== undefined ||
        patch.reviewOpen !== undefined ||
        patch.reviewEarlier !== undefined ||
        patch.reviewProposalId !== undefined ||
        patch.focus !== undefined)
    )
      queueMicrotask(() => {
        this.view?.refresh();
      });
  }

  getPreviewSnapshot = (): PreviewState => {
    const state = this.getSnapshot();
    return {
      ...state,
      title: this.host?.documentTitle(state.metadata.documentId) ?? "Untitled",
    };
  };

  publishPreview(): void {
    this.host?.publishPreview(this.state.metadata.documentId);
  }

  hasUnreadActivity(identity: string): boolean {
    return this.unreadThreads.has(identity);
  }

  fail(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    const fileIssue = activity
      .getSnapshot()
      .pending.some(
        (item) =>
          item.documentId === this.state.metadata.documentId &&
          (item.kind === "save" || item.kind === "external") &&
          !item.resolved &&
          item.detail === message,
      );
    if (!fileIssue)
      activity.report(this.state.metadata.documentId, "error", error);
    this.update({
      error: error instanceof Error ? error.message : String(error),
      status: "Needs attention",
    });
  }

  selectThread(identity: string | null): void {
    this.update({
      activeThread: identity,
      asidesOpen: identity ? true : this.state.asidesOpen,
      threadExpansions: { ...this.state.threadExpansions, ...(identity ? { [identity]: true } : {}) },

    });
    this.view?.refresh();
  }

  toggleThread(identity: string): void {
    if (
      this.state.asidesOpen &&
      !this.state.focus &&
      this.state.metadata.threads.some(thread => thread.id === identity && asideExpanded(this.state, thread))
    ) {
      this.collapseThread(identity, false);
      return;
    }
    this.update({ focus: false });
    this.selectThread(identity);
  }

  openAside(reference: AsideReference): void {
    if (reference.documentId === this.state.metadata.documentId) {
      if (
        !this.state.metadata.threads.some(
          (thread) => thread.id === reference.threadId,
        )
      )
        throw Error("This aside is unavailable.");
      this.revealSource(reference.threadId);
      return;
    }
    if (!this.host) throw Error("Open this reference in the writing window.");
    this.host.openAside(reference);
  }

  revealSource(identity: string): void {
    this.host?.beforeNavigation();
    this.host?.activate(this.state.metadata.documentId);
    const thread = this.state.metadata.threads.find(thread => thread.id === identity);
    if (thread?.resolved) {
      window.dispatchEvent(new CustomEvent("inknb-history-aside", {
        detail: { documentId: this.state.metadata.documentId, threadId: identity },
      }));
      this.host?.afterNavigation();
      return;
    }
    this.selectThread(identity);
    if (thread?.anchor && thread.anchor.status !== "detached") this.surface?.scrollToSource(thread.anchor.from, thread.anchor);
    this.host?.afterNavigation();
  }

  collapseThread(identity: string, restoreFocus = true): void {
    const thread = this.state.metadata.threads.find(thread => thread.id === identity);
    const activity = thread ? threadActivity(this.state.metadata, thread) : null;
    if (activity !== null) this.markThreadRead(identity, activity);
    this.update({
      threadExpansions: { ...this.state.threadExpansions, [identity]: false },
    });
    if (this.state.activeThread === identity) this.selectThread(null);
    if (!restoreFocus) return;
    requestAnimationFrame(() =>
      this.view?.dom
        .closest(".document-container")
        ?.querySelector<HTMLButtonElement>(
          `[data-inknb-control="thread:${identity}"]`,
        )
        ?.focus({ preventScroll: true }),
    );
  }

  restoreFocus(): void {
    if (this.state.composer) {
      if (
        this.state.previewHost === "detached" &&
        this.state.composerPreviewAnchor
      )
        return;
      this.view?.dom
        .closest(".document-container")
        ?.querySelector<HTMLElement>(".new-aside .reference-editor")
        ?.focus({ preventScroll: true });
      return;
    }
    this.surface?.focus();
  }

  startComment(scope: "selection" | "document" = "selection"): void {
    this.update({ asidesOpen: true, focus: false });
    if (this.state.composer) {
      this.restoreFocus();
      const composer = this.view?.dom
        .closest(".document-container")
        ?.querySelector<HTMLElement>(".new-aside .reference-editor");
      if (composer) revealAsideComposer(composer, this.state.preferences.reduce_motion);
      return;
    }
    this.view?.refresh();
    const viewport = this.surface ? documentScroll(this.surface.dom) : null;
    this.update({
      composer: true,
      composerPreviewAnchor: null,
      composerTop: viewport
        ? Math.max(0, viewport.scrollTop + Math.min(96, viewport.clientHeight / 4))
        : this.state.sourceScrollTop,
      activeThread: null,
      composerAnchor:
        scope === "selection" &&
        this.state.selection.to > this.state.selection.from
          ? (this.model?.capture(
              captureAnchor(this.state.text, this.state.selection),
            ) ?? captureAnchor(this.state.text, this.state.selection))
          : null,

    });
    this.view?.dom
      .closest(".document-container")
      ?.querySelector<HTMLElement>(".new-aside .reference-editor")
      ?.focus({ preventScroll: true });
  }

  startPreviewComment(anchor: PreviewAnchor, info: PreviewInfo): void {
    this.update({
      asidesOpen:
        this.state.previewHost === "detached" ? this.state.asidesOpen : true,
      focus: false,
    });
    if (this.state.composer) {
      this.restoreFocus();
      return;
    }
    previewAnchorSchema.parse(anchor);
    if (
      anchor.artifactId !== info.artifactId ||
      anchor.sourceHash !== info.sourceHash
    )
      throw Error("The preview selection changed. Select the location again.");
    const target = anchor.target;
    const mappings = info.manifest.sourceMap.filter((mapping) => {
      if (target.kind === "html" && mapping.target.kind === "element")
        return Boolean(
          target.elementId &&
          target.endElementId &&
          (mapping.target.elementId === target.elementId ||
            mapping.target.elementId === target.endElementId),
        );
      if (target.kind !== "pdf" || mapping.target.kind !== "page") return false;
      const mapped = mapping.target;
      return target.regions.some(
        (region) =>
          region.page === mapped.page &&
          region.rectangle.left <
            mapped.rectangle.left + mapped.rectangle.width &&
          region.rectangle.left + region.rectangle.width >
            mapped.rectangle.left &&
          region.rectangle.top <
            mapped.rectangle.top + mapped.rectangle.height &&
          region.rectangle.top + region.rectangle.height > mapped.rectangle.top,
      );
    });
    let source: Anchor | null = null;
    if (mappings.length) {
      let from = Math.min(...mappings.map((mapping) => mapping.source.from));
      let to = Math.max(...mappings.map((mapping) => mapping.source.to));
      const passage = info.sourceText.slice(from, to);
      const quote = anchor.quote.trim();
      const position = quote ? passage.indexOf(quote) : -1;
      if (position >= 0 && passage.indexOf(quote, position + 1) < 0) {
        from += position;
        to = from + quote.length;
      }
      source = relocateAnchor(
        this.state.text,
        captureAnchor(info.sourceText, { from, to }),
      );
      if (source.status === "detached") source = null;
    }
    this.update({
      composer: true,
      activeThread: null,
      composerAnchor: source,
      composerPreviewAnchor: anchor,
      previewSelection: null,
    });
    this.view?.refresh();
  }

  revealPreview(anchor: PreviewAnchor): void {
    this.update({
      previewArtifactId: anchor.artifactId,
      previewLocation: anchor,
      previewSelection: null,
      focus: false,
    });
    void this.command("preview");
  }

  restoreSourceScroll(top: number): void {
    if (this.surface)
      documentScroll(this.surface.dom).scrollTo({ top, behavior: "instant" });
  }

  protected publishedState = this.state;
  getSnapshot = (): SessionState => this.publishedState;

  protected publishedSnapshot(state: SessionState): SessionState {
    return state;
  }

  async controlView(method: string, parameters: unknown): Promise<unknown> {
    if (method === "ui_inspect") {
      z.object({}).strict().parse(parameters);
      return {
        documentId: this.state.metadata.documentId,
        ...(await inspectInterface()),
      };
    }
    if (method === "ui_action") {
      const documentId = z
        .object({ documentId: z.string().uuid() })
        .passthrough()
        .parse(parameters).documentId;
      if (documentId !== this.state.metadata.documentId)
        throw new Error(
          "The open document changed. Inspect the interface again.",
        );
      return actOnInterface(parameters);
    }
    if (method === "ui_state") {
      if (!this.view) throw Error("This document has no attached window.");
      z.object({}).strict().parse(parameters);
      const geometry = [
        ".library-sidebar",
        ".writing-pane",
        ".document-surfaces",
        ".document-body",
        ".document-scroll",
        ".document-canvas",
        ".aside-dock",
        ".aside-reader-scroll",
        ".aside-marker-group",
        ".aside-resizer",
        ".titlebar",
        ".workspace",
        ".statusbar",
        ".margin",
        ".thread-index",
        ".margin-note",
        ".decision-card",
        ".native-content",
        ".modal-overlay",
        ".preview-panel",
        ".preview-resizer",
        ".preview-content",
        ".agent-connection-popover",
      ].map((selector) => {
        const element =
          selector === ".library-sidebar"
            ? document.querySelector(selector)
            : this.view?.dom
                .closest(".document-container")
                ?.querySelector(selector);
        const rectangle = element?.getBoundingClientRect();
        return {
          selector,
          rectangle: rectangle?.toJSON(),
          visibility: element ? getComputedStyle(element).visibility : null,
          display: element ? getComputedStyle(element).display : null,
          scrollTop: element?.scrollTop,
          scrollWidth: element?.scrollWidth,
          clientWidth: element?.clientWidth,
          scrollHeight: element?.scrollHeight,
          clientHeight: element?.clientHeight,
          height: element ? getComputedStyle(element).height : null,
          opacity: element ? getComputedStyle(element).opacity : null,
          transform: element ? getComputedStyle(element).transform : null,
          boxShadow: element ? getComputedStyle(element).boxShadow : null,
          docked: element?.closest<HTMLElement>(".document-toolbar")?.dataset.docked ?? null,
          animations: element?.getAnimations().map((animation) => ({
            state: animation.playState,
            currentTime: animation.currentTime,
            duration: animation.effect?.getTiming().duration,
          })) ?? [],
          pointerEvents: element
            ? getComputedStyle(element).pointerEvents
            : null,
          backdropFilter: element
            ? getComputedStyle(element).backdropFilter
            : null,
        };
      });
      return {
        build: __INKNB_BUILD__,
        profile: this.state.profile,
        windowChrome: await readWindowChrome(),
        windowActive: document.hasFocus(),
        visibility: document.visibilityState,
        capturedAt: new Date().toISOString(),
        documentId: this.state.metadata.documentId,
        revision: this.state.metadata.revision,
        selection: this.state.selection,
        viewport: {
          width: innerWidth,
          height: innerHeight,
          scale: devicePixelRatio,
        },
        theme: document.documentElement.dataset.theme,
        placement: this.state.preferences.placement,
        preferences: this.state.preferences,
        focusMode: this.state.focus,
        asidesOpen: this.state.asidesOpen,
        asideReader: this.state.asideReader,
        asideNarrow: this.state.asideNarrow,
        asidesLayout: this.view?.dom
          .closest(".document-container")
          ?.querySelector<HTMLElement>(".document-body")?.dataset.asidesLayout,
        sourceScrollTop: documentScroll(this.view.dom).scrollTop,
        documentView: "document",
        previewHost: this.state.previewHost,
        previewMode:
          this.state.previewHost === "detached" ? "detached" : "closed",
        preview: {
          published: this.state.metadata.preview,
          displayed: this.state.previewInformation?.artifactId ?? null,
          build: this.state.metadata.previewBuild,
          runtime: this.state.previewRuntime,
          selection: this.state.previewSelection,
        },
        dialogs: [...document.querySelectorAll('[role="dialog"]')].map(
          (dialog) => dialog.getAttribute("aria-label"),
        ),
        motion: document.documentElement.dataset.motion,
        scroll: {
          top: documentScroll(this.view.dom).scrollTop,
          left: documentScroll(this.view.dom).scrollLeft,
        },
        focus:
          document.activeElement?.getAttribute("aria-label") ??
          document.activeElement
            ?.getAttribute("aria-labelledby")
            ?.split(" ")
            .map((identity) => document.getElementById(identity)?.textContent)
            .join(" ") ??
          document.activeElement?.tagName,
        activeThread: this.state.activeThread,
        asides: this.state.metadata.threads.map((thread) => ({
          id: thread.id,
          resolved: thread.resolved,
          unread: this.hasUnreadActivity(thread.id),
          expanded: asideExpanded(this.state, thread),
        })),
        dirty: this.state.dirty,
        externalChange: this.state.externalChange,
        geometry,
        components: [...componentRuntimes].map(([id, runtime]) => ({
          id,
          status: runtime.status,
          error: runtime.error,
        })),
      };
    }
    if (method === "window_resize") {
      const parsed = z
        .object({
          width: z.number().int().min(700).max(2400),
          height: z.number().int().min(480).max(1800),
        })
        .strict()
        .parse(parameters);
      await getCurrentWindow().setSize(
        new LogicalSize(parsed.width, parsed.height),
      );
      return { width: parsed.width, height: parsed.height };
    }
    if (method === "editor_select") {
      if (!this.view) throw Error("This document has no attached window.");
      const parsed = z
        .object({
          documentId: z.string().uuid().optional(),
          revision: z.number().int().nonnegative(),
          from: z.number().int().nonnegative(),
          to: z.number().int().nonnegative(),
        })
        .strict()
        .parse(parameters);
      if (parsed.revision !== this.state.metadata.revision)
        throw new Error("The document revision changed.");
      validateSelection(this.state.text, parsed);
      this.view.selectSource(parsed.from, parsed.to, false);
      this.surface?.scrollToSource(parsed.from);
      this.surface?.focus();
      return this.state.selection;
    }
    throw Error("This control does not belong to the document view.");
  }

  protected async readerCommand(command: string): Promise<boolean> {
    if (!["comment-region","find","open","new","comment-document","resolve-asides","accept-asides","comment","preview-fullscreen","preview-close","focus"].includes(command)) return false;
    if (command === "comment-region") this.view?.region.start();
    if (command === "find") this.view?.openFind();
    if (command === "open") await this.host?.openDocument();
    if (command === "new") await this.host?.newDocument();
    if (command === "comment-document") this.startComment("document");
    if (command === "resolve-asides") await this.resolveAll();
    if (command === "accept-asides") await this.acceptAllProposals();
    if (command === "comment") {
        if (this.state.previewSelection && this.state.previewInformation)
          this.startPreviewComment(
            this.state.previewSelection.anchor,
            this.state.previewInformation,
          );
        else this.startComment();
      }
    if (command === "preview-fullscreen") {
        const window = getCurrentWindow();
        await window.setFullscreen(!(await window.isFullscreen()));
      }
    if (command === "preview-close") {
        if (this.state.previewHost === "detached") {
          await this.host?.closePreview();
          return true;
        }
        this.restoreFocus();
      }
    if (command === "focus")
        this.update({ focus: !this.state.focus, composer: false });
    return true;
  }

  abstract markThreadRead(identity: string, signature: string): void;
  abstract command(command: string): Promise<void>;
  abstract control(method: string, parameters: unknown): Promise<unknown>;
  abstract resolveAll(): Promise<string[]>;
  abstract acceptAllProposals(): Promise<string[]>;
}
