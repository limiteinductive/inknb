import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open } from "@tauri-apps/plugin-dialog";
import { getVersion, sendableSteps } from "prosemirror-collab";
import { z } from "zod";
import { activity } from "./activity";
import { LogicalSize } from "@tauri-apps/api/dpi";
import { inspectInterface, actOnInterface } from "./ui-control";
import { readWindowChrome } from "./window-chrome";
import { documentScroll } from "./document-scroll";
import { parseAsideLink } from "./aside-reference";
import { parseDocumentLink } from "./resources";
import type { AsideReference, Preferences } from "./domain";
import {
  captureAnchor,
  relocateAnchor,
  defaultPreferences,
  asideReferenceSchema,
} from "./domain";
import { documentViewSchema, spacesSchema } from "./spaces";
import type { SpaceWindow, SpacesState } from "./spaces";
import type { HostRequest, HostSnapshot } from "./host-protocol";
import type { DocumentHost } from "./session";
import type { Library, LibraryNode } from "./workspace";
import { WindowDocument } from "./window-document";
import { currentSuggestions, pendingSuggestions, reviewSuggestion } from "./suggestions";

export const compactLibraryWidth = 980;

type CommandSurface = "commands" | "project-search" | "agents" | "decisions" | "resources" | "history";

class WindowWorkspace implements DocumentHost {
  private state: Library & {
    ready: boolean;
    error: string | null;
    spaceId: string | null;
    spaceTitle: string;
    spaceRegistry: SpacesState | null;
    preferences: Preferences;
    profile: string | null;
    commandSurface: CommandSurface | null;
  } = {
    version: 2,
    documents: [],
    collections: [],
    collapsedIds: [],
    activeId: null,
    sidebarOpen: true,
    sidebarWidth: 232,
    asideWidth: 400,
    previewWidth: null,
    history: [],
    historyIndex: -1,
    ready: false,
    error: null,
    spaceId: null,
    spaceTitle: "",
    spaceRegistry: null,
    preferences: defaultPreferences,
    profile: null,
    commandSurface: null,
  };
  readonly sessions = new Map<string, WindowDocument>();
  readonly windowId = getCurrentWindow().label.replace(/^writing-/, "");
  private listeners = new Set<() => void>();
  private refreshing: Promise<void> | null = null;
  private refreshAgain = false;
  private receiving = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private navigating = false;
  private navigationFrame: number | null = null;
  private initialized = false;
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  get active(): WindowDocument | undefined {
    return this.state.activeId
      ? this.sessions.get(this.state.activeId)
      : undefined;
  }
  get nodes(): LibraryNode[] {
    return [...this.state.collections, ...this.state.documents];
  }
  request = (request: HostRequest): Promise<unknown> =>
    invoke("host_request", { request });

  async initialize(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    await getCurrentWindow().listen(
      "inknb-host-changed",
      () => void this.refresh().catch((error) => this.fail(error)),
    );
    await getCurrentWindow().listen(
      "inknb-window-close",
      () => void this.close().catch((error) => this.fail(error)),
    );
    await getCurrentWindow().listen<string>("inknb-quit-error", (event) => {
      document.documentElement.inert = false;
      this.fail(event.payload);
    });
    await getCurrentWindow().onFocusChanged((event) => {
      if (event.payload) void invoke("space_window_focused");
    });
    await getCurrentWindow().onResized(() => this.update({}));
    await getCurrentWindow().onMoved(() => this.update({}));
    await this.refresh();
    await invoke("space_window_ready");
  }

  refresh = (): Promise<void> => {
    if (this.refreshing) {
      this.refreshAgain = true;
      return this.refreshing;
    }
    this.refreshing = (async () => {
      do {
        this.refreshAgain = false;
        const versions = Object.fromEntries(
          [...this.sessions].map(([identity, session]) => [
            identity,
            {
              epoch: session.epochIdentity,
              publication: session.confirmedPublication,
              pending: Boolean(
                session.model && sendableSteps(session.model.state),
              ),
              version: session.model
                ? getVersion(session.model.state)
                : session.version,
            },
          ]),
        );
        const snapshot = (await this.request({
          kind: "snapshot",
          versions,
        })) as HostSnapshot;
        const spaces = spacesSchema.parse(snapshot.spaces);
        const window = spaces.windows.find(
          (window) => window.id === this.windowId,
        );
        const space = spaces.spaces.find(
          (space) => space.id === window?.spaceId,
        );
        if (!window || !space) throw Error("This space window is unavailable.");
        this.receiving = true;
        try {
          if (
            this.active?.view &&
            !space.documentIds.includes(this.state.activeId!)
          )
            this.active.update({
              sourceScrollTop: this.scrollTop,
            });
          for (const [identity, exchange] of Object.entries(
            snapshot.documents,
          )) {
            const existing = this.sessions.get(identity);
            if (existing) existing.receive(exchange);
            else {
              const session = new WindowDocument(
                this,
                exchange,
                window.documents[identity] ?? documentViewSchema.parse({}),
                this.windowId,
                this.request,
                this.refresh,
              );
              this.sessions.set(identity, session);
              queueMicrotask(() => session.committed());
              session.subscribe(() => {
                if (!this.receiving) this.update({});
              });
            }
          }
          for (const identity of this.sessions.keys())
            if (
              !space.documentIds.includes(identity) &&
              !this.sessions.get(identity)?.getSnapshot().pendingSource &&
              !sendableSteps(this.sessions.get(identity)!.model!.state)
            )
              this.sessions.delete(identity);
          const documents = snapshot.library.documents.map((entry) => {
            const session = this.sessions.get(entry.id);
            const view = this.state.ready && session
              ? documentViewSchema.parse(session.getSnapshot())
              : window.documents[entry.id];
            const scrollTop = this.state.ready
              ? (this.state.documents.find(
                  (candidate) => candidate.id === entry.id,
                )?.scrollTop ?? session?.getSnapshot().sourceScrollTop ?? entry.scrollTop)
              : (window.documents[entry.id]?.scrollTop ?? 0);
            return { ...entry, ...view, scrollTop, open: true };
          });
          const activeId =
            this.state.ready &&
            space.documentIds.includes(this.state.activeId ?? "")
              ? this.state.activeId
              : window.activeId;
          const layout = this.state.ready ? this.state : window;
          const history = layout.history.filter((location) =>
            space.documentIds.includes(location.documentId),
          );
          const historyIndex =
            layout.history
              .slice(0, layout.historyIndex + 1)
              .filter((location) =>
                space.documentIds.includes(location.documentId),
              ).length - 1;
          this.state = {
            ...this.state,
            documents,
            collections: snapshot.library.collections,
            activeId,
            ready: true,
            error: snapshot.library.error,
            collapsedIds: layout.collapsedIds,
            sidebarOpen: layout.sidebarOpen,
            sidebarWidth: layout.sidebarWidth,
            asideWidth: layout.asideWidth,
            previewWidth: layout.previewWidth,
            history,
            historyIndex,
            spaceId: space.id,
            spaceTitle: space.title,
            spaceRegistry: spaces,
            preferences: snapshot.preferences,
            profile: snapshot.profile,
          };
          activity.setScope(space.documentIds);
          void activity.refresh().then(() => {
            for (const [documentId, session] of this.sessions) {
              const current = session.getSnapshot();
              if (current.error || current.dirty || current.pendingSource) continue;
              activity.clear(documentId, "error", "The document host did not respond. Your window keeps its pending text.");
            }
          });
          if (snapshot.activityKey !== null)
            activity.update({ open: true, targetKey: snapshot.activityKey });
          for (const listener of this.listeners) listener();
        } finally {
          this.receiving = false;
        }
      } while (this.refreshAgain);
    })().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  };

  update(
    patch: Partial<Library> & { ready?: boolean; error?: string | null; commandSurface?: CommandSurface | null },
  ): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
    if (this.receiving || !this.state.ready) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(
      () => void this.persist().catch((error) => this.fail(error)),
      150,
    );
  }
  fail(error: unknown): void {
    this.state = { ...this.state, error: String(error) };
    activity.report(this.state.activeId, "error", error);
    for (const listener of this.listeners) listener();
  }
  async persist(): Promise<void> {
    clearTimeout(this.timer);
    const window = getCurrentWindow();
    const scale = await window.scaleFactor();
    const position = await window.outerPosition();
    const size = await window.innerSize();
    const documents = Object.fromEntries(
      [...this.sessions].map(([identity, session]) => {
        const view = documentViewSchema.parse(session.getSnapshot());
        const reader = identity === this.state.activeId
          ? session.view?.dom.closest(".document-body")?.querySelector<HTMLElement>(".aside-reader-scroll")
          : null;
        return [identity, {
          ...view,
          asideReader: { ...view.asideReader, scrollTop: reader?.scrollTop ?? view.asideReader.scrollTop },
          scrollTop:
            session.view && identity === this.state.activeId
              ? this.scrollTop
              : (this.state.documents.find((entry) => entry.id === identity)
                  ?.scrollTop ?? 0),
        }];
      }),
    );
    const patch: Partial<SpaceWindow> = {
      activeId: this.state.activeId,
      documents,
      collapsedIds: this.state.collapsedIds,
      sidebarOpen: this.state.sidebarOpen,
      sidebarWidth: this.state.sidebarWidth,
      asideWidth: this.state.asideWidth,
      previewWidth: this.state.previewWidth,
      history: this.state.history,
      historyIndex: this.state.historyIndex,
      bounds: {
        left: position.x / scale,
        top: position.y / scale,
        width: size.width / scale,
        height: size.height / scale,
      },
    };
    await this.request({ kind: "window", patch });
  }
  private get scrollTop(): number {
    return Math.max(0, this.active?.view
      ? documentScroll(this.active.surface!.dom).scrollTop
      : (this.active?.getSnapshot().sourceScrollTop ?? 0));
  }
  documentTitle(identity: string): string {
    return (
      this.state.documents.find((entry) => entry.id === identity)?.title ??
      "Untitled"
    );
  }
  readAside(reference: AsideReference) {
    const session = this.sessions.get(reference.documentId);
    const thread = session
      ?.getSnapshot()
      .metadata.threads.find((thread) => thread.id === reference.threadId);
    if (!thread) throw Error("This aside is outside this space.");
    return {
      thread,
      documentId: reference.documentId,
      title: this.documentTitle(reference.documentId),
      pendingSuggestions: pendingSuggestions(session!.getSnapshot().metadata, thread.id).map(proposal => proposal.id),
      references: session!.getSnapshot().asideReferences[thread.id] ?? [],
    };
  }
  openAside(reference: AsideReference): void {
    const member = this.state.documents.some(
      (entry) => entry.id === reference.documentId,
    );
    if (!member) {
      void this.request({ kind: "open-aside", reference }).catch((error) =>
        this.fail(error),
      );
      return;
    }
    this.readAside(reference);
    this.activate(reference.documentId);
    this.active?.revealSource(reference.threadId);
  }
  async newDocument(): Promise<void> {
    const result = z.object({ documentId: z.string().uuid() }).parse(
      await this.request({
        kind: "library",
        method: "document_create",
        parameters: { title: "Untitled" },
      }),
    );
    await this.refresh();
    this.activate(result.documentId);
  }
  async openDocument(path?: string): Promise<void> {
    const documentId = path ? parseDocumentLink(path) : null;
    if (documentId) {
      await this.request({ kind: "open-document", documentId });
      return;
    }
    const reference = path ? parseAsideLink(path) : null;
    if (reference) {
      this.openAside(reference);
      return;
    }
    const selected =
      path ??
      (await open({
        multiple: false,
        directory: false,
        filters: [
          {
            name: "Writing",
            extensions: ["md", "markdown", "html", "htm", "tex", "txt"],
          },
        ],
      }));
    if (typeof selected !== "string") return;
    const result = z
      .object({ documentId: z.string().uuid() })
      .passthrough()
      .parse(
        await this.request({
          kind: "library",
          method: "document_open",
          parameters: { path: selected },
        }),
      );
    await this.refresh();
    this.activate(result.documentId);
  }
  async flush(): Promise<void> {
    for (const session of this.sessions.values()) await session.flush();
    await this.persist();
  }
  async close(): Promise<void> {
    document.documentElement.inert = true;
    try {
      await this.flush();
      await this.request({ kind: "close-window" });
      await getCurrentWindow().destroy();
    } catch (error) {
      document.documentElement.inert = false;
      throw error;
    }
  }
  async command(command: string): Promise<void> {
    if (command === "commands" || command === "project-search" || command === "agents" || command === "decisions" || command === "resources" || command === "history") {
      activity.update({ open: false });
      this.update({ commandSurface: command });
      return;
    }
    const session = this.active;
    const state = session?.getSnapshot();
    if (session && state) {
      if (command === "outline") {
        session.update({ outlineOpen: !(state.outlineOpen ?? state.preferences.document_outline) });
        return;
      }
      if (command === "asides") {
        session.update({ asidesOpen: !state.asidesOpen, focus: false });
        return;
      }
      if (command === "page") {
        session.update({ pageVisible: !state.pageVisible });
        return;
      }
      if (command === "review") {
        const proposals = currentSuggestions(state);
        const proposal = proposals.find(proposal => proposal.id === state.reviewProposalId) ?? proposals[0];
        if (proposal) reviewSuggestion(proposal.id, session);
        return;
      }
    }
    if (["text-larger", "text-smaller", "text-reset"].includes(command)) {
      const change = command === "text-larger" ? "increase" : command === "text-smaller" ? "decrease" : "reset";
      await invoke("configuration_font_size", { change });
      return;
    }
    if (command === "activity") {
      this.update({ commandSurface: null });
      activity.update({ open: true });
      return;
    }
    if (command === "back") {
      this.navigate(-1);
      return;
    }
    if (command === "forward") {
      this.navigate(1);
      return;
    }
    if (command === "sidebar") {
      const open = !this.state.sidebarOpen || Boolean(this.active?.getSnapshot().focus);
      if (open) this.active?.update({ focus: false });
      this.update({ sidebarOpen: open });
      return;
    }
    if (["cut", "copy", "paste", "select-all"].includes(command)) {
      await invoke("editing_action", { action: command });
      return;
    }
    if (command === "window-close") return this.close();
    if (command === "new") return this.newDocument();
    if (command === "open") return this.openDocument();
    if (command === "close") {
      await this.persist();
      for (const session of this.sessions.values()) await session.flush();
      await invoke("request_quit");
      return;
    }
    await this.active?.command(command);
  }
  async control(method: string, parameters: unknown): Promise<unknown> {
    if (method === "window_flush") {
      const request = z
        .object({ closing: z.boolean().default(false) })
        .strict()
        .parse(parameters);
      if (request.closing) document.documentElement.inert = true;
      try {
        await this.flush();
        return { flushed: true };
      } catch (error) {
        document.documentElement.inert = false;
        throw error;
      }
    }
    const values = z.record(z.string(), z.unknown()).parse(parameters);
    if (method === "aside_open") {
      this.openAside(asideReferenceSchema.parse(parameters));
      return { opened: true };
    }
    if (method === "window_resize") {
      const size = z
        .object({
          width: z.number().int().min(700).max(2400),
          height: z.number().int().min(480).max(1800),
        })
        .strict()
        .parse(parameters);
      await getCurrentWindow().setSize(
        new LogicalSize(size.width, size.height),
      );
      return size;
    }
    if (method === "ui_inspect")
      return {
        documentId: this.state.activeId,
        windowId: this.windowId,
        ...(await inspectInterface()),
      };
    if (method === "ui_action") {
      if (values.documentId !== this.state.activeId)
        throw Error("The active document changed. Inspect this window again.");
      return actOnInterface(parameters);
    }
    if (method === "ui_state" && !this.active)
      return {
        build: __INKNB_BUILD__,
        windowId: this.windowId,
        spaceId: this.state.spaceId,
        spaceTitle: this.state.spaceTitle,
        documentId: null,
        revision: null,
        capturedAt: new Date().toISOString(),
        windowChrome: await readWindowChrome(),
        theme: document.documentElement.dataset.theme,
        preferences: this.state.preferences,
        profile: this.state.profile,
        viewport: {
          width: innerWidth,
          height: innerHeight,
          scale: devicePixelRatio,
        },
        dialogs: [...document.querySelectorAll('[role="dialog"]')].map(
          (dialog) => dialog.getAttribute("aria-label"),
        ),
        library: this.state,
        activity: activity.getSnapshot(),
      };

    if (method === "library_list") return this.state;
    if (method === "document_activate") {
      this.activate(z.string().uuid().parse(values.documentId));
      return { documentId: values.documentId };
    }
    if (method === "page_open") {
      const documentId = z.string().uuid().parse(values.documentId);
      this.activate(documentId);
      if (!this.active?.getSnapshot().metadata.page) throw Error("This document has no published page.");
      this.active.update({ pageVisible: true });
      return { documentId, opened: true };
    }
    const identity =
      z.string().uuid().optional().parse(values.documentId) ??
      this.state.activeId;
    const session = identity ? this.sessions.get(identity) : null;
    if (!session) throw Error("This document is outside this space.");
    if (
      ["ui_state", "ui_inspect", "ui_action", "editor_select"].includes(
        method,
      ) &&
      session !== this.active
    )
      throw Error("Activate this document before acting on its interface.");
    if (method === "document_read" || method === "requests_list")
      return session.control(method, {});
    if (method === "editor_select" && this.navigationFrame !== null) {
      cancelAnimationFrame(this.navigationFrame);
      this.navigationFrame = null;
    }
    const result = await session.control(method, parameters);
    if (method === "ui_state")
      return {
        ...z.object({}).passthrough().parse(result),
        windowId: this.windowId,
        spaceId: this.state.spaceId,
        spaceTitle: this.state.spaceTitle,
        library: this.state,
        activity: activity.getSnapshot(),
      };
    return result;
  }
  activate(identity: string): void {
    if (!this.state.documents.some((entry) => entry.id === identity))
      throw Error("This document is outside this space.");
    if (!this.sessions.has(identity))
      throw Error("This document is unavailable.");
    if (this.state.activeId === identity) return;
    this.beforeNavigation();
    const ancestors = new Set<string>();
    let parentId = this.state.documents.find(
      (entry) => entry.id === identity,
    )?.parentId;
    while (parentId) {
      ancestors.add(parentId);
      parentId = this.nodes.find((node) => node.id === parentId)?.parentId;
    }
    this.update({
      collapsedIds: this.state.collapsedIds.filter(
        (nodeId) => !ancestors.has(nodeId),
      ),
      activeId: identity,
      documents: this.state.documents.map((entry) =>
        entry.id === identity ? { ...entry, open: true } : entry,
      ),
    });
    this.afterNavigation();
    const scrollTop =
      this.state.documents.find((entry) => entry.id === identity)?.scrollTop ??
      0;
    if (this.navigationFrame !== null) cancelAnimationFrame(this.navigationFrame);
    this.navigationFrame = requestAnimationFrame(() => {
      this.navigationFrame = null;
      if (this.state.activeId !== identity) return;
      const surface = this.sessions.get(identity)?.surface;
      surface?.requestMeasure();
      surface &&
        documentScroll(surface.dom).scrollTo({
          top: scrollTop,
          behavior: "instant",
        });
    });
  }
  beforeNavigation(): void {
    if (this.navigating || !this.active) return;
    const state = this.active.getSnapshot();
    const history = [...this.state.history];
    const scrollTop = this.scrollTop;
    this.active.update({ sourceScrollTop: scrollTop });
    this.update({
      documents: this.state.documents.map((entry) =>
        entry.id === state.metadata.documentId
          ? { ...entry, scrollTop }
          : entry,
      ),
    });
    if (this.state.historyIndex >= 0)
      history[this.state.historyIndex] = {
        documentId: state.metadata.documentId,
        anchor: captureAnchor(state.text, state.selection),
        threadId: state.activeThread,
        composer: state.composer,
        scrollTop,
      };
    this.update({ history });
  }
  afterNavigation(): void {
    if (this.navigating || !this.active) return;
    const state = this.active.getSnapshot();
    const location = {
      documentId: state.metadata.documentId,
      anchor: captureAnchor(state.text, state.selection),
      threadId: state.activeThread,
      composer: state.composer,
      scrollTop: this.scrollTop,
    };
    const previous = this.state.history[this.state.historyIndex];
    if (
      previous &&
      previous.documentId === location.documentId &&
      previous.threadId === location.threadId &&
      previous.anchor.from === location.anchor.from &&
      previous.anchor.to === location.anchor.to
    )
      return;
    this.update({
      history: [
        ...this.state.history.slice(0, this.state.historyIndex + 1),
        location,
      ],
      historyIndex: this.state.historyIndex + 1,
    });
  }
  navigate(direction: -1 | 1): void {
    const index = this.state.historyIndex + direction;
    const location = this.state.history[index];
    if (!location) return;
    const session = this.sessions.get(location.documentId);
    if (!session) return;
    this.beforeNavigation();
    this.navigating = true;
    this.activate(location.documentId);
    const state = session.getSnapshot();
    const anchor = relocateAnchor(state.text, location.anchor);
    const selection =
      anchor.status === "detached"
        ? {
            from: Math.min(location.anchor.from, state.text.length),
            to: Math.min(location.anchor.to, state.text.length),
          }
        : anchor;
    session.update({ selection, sourceScrollTop: location.scrollTop });
    session.selectThread(location.threadId);
    session.update({
      composer:
        location.composer &&
        Boolean(
          state.composerAnchor ||
          state.drafts.new?.content ||
          state.drafts.new?.images.length,
        ),
    });
    session.view?.selectSource(selection.from, selection.to, false);
    this.update({ historyIndex: index });
    this.navigating = false;
    if (this.navigationFrame !== null) cancelAnimationFrame(this.navigationFrame);
    this.navigationFrame = requestAnimationFrame(() => {
      this.navigationFrame = null;
      if (this.active !== session) return;
      session.surface?.requestMeasure();
      session.view &&
        documentScroll(session.surface!.dom).scrollTo({
          top: location.scrollTop,
          behavior: "instant",
        });
    });
    session.restoreFocus();
  }
  reveal(identity: string, from: number, to: number): void {
    this.beforeNavigation();
    this.navigating = true;
    this.activate(identity);
    if (this.navigationFrame !== null) {
      cancelAnimationFrame(this.navigationFrame);
      this.navigationFrame = null;
    }
    const session = this.sessions.get(identity)!;
    const selection = {
      from,
      to: Math.min(to, session.getSnapshot().text.length),
    };
    session.view?.selectSource(selection.from, selection.to, false);
    session.update({ selection });
    session.surface?.scrollToSource(selection.from);
    this.navigating = false;
    this.afterNavigation();
    requestAnimationFrame(() => session.surface?.focus());
  }
  validateParent(
    identity: string | null,
    parentId: string | null,
    newFolder = false,
  ): void {
    const folders = new Map(
      this.state.collections.map((node) => [node.id, node]),
    );
    const visited = new Set(identity ? [identity] : []);
    let parentDepth = 0;
    let ancestor = parentId;
    while (ancestor) {
      if (visited.has(ancestor))
        throw Error("A writing or group cannot contain itself.");
      visited.add(ancestor);
      const node = folders.get(ancestor);
      if (!node) throw Error("Only folders can contain documents or folders.");
      parentDepth += 1;
      ancestor = node.parentId;
    }
    let subtreeDepth = newFolder || (identity && folders.has(identity)) ? 1 : 0;
    if (identity && folders.has(identity))
      for (const folder of folders.values()) {
        let depth = 1;
        let parent = folder.parentId;
        while (parent) {
          if (parent === identity) {
            subtreeDepth = Math.max(subtreeDepth, depth + 1);
            break;
          }
          depth += 1;
          parent = folders.get(parent)!.parentId;
        }
      }
    const limit = this.active?.getSnapshot().preferences.library_depth ?? 1;
    if (limit >= 0 && parentDepth + subtreeDepth > limit)
      throw Error(`This organization exceeds library_depth = ${limit}.`);
  }
  rename(identity: string, title: string): void {
    if (title.trim())
      void this.request({
        kind: "library",
        method: this.state.collections.some((folder) => folder.id === identity)
          ? "collection_update"
          : "library_update",
        parameters: this.state.collections.some(
          (folder) => folder.id === identity,
        )
          ? { collectionId: identity, title }
          : { documentId: identity, title },
      })
        .then(() => this.refresh())
        .catch((error) => this.fail(error));
  }
  pin(identity: string, pinned: boolean): void {
    void this.request({ kind: "pin", documentId: identity, pinned })
      .then(() => this.refresh())
      .catch((error) => this.fail(error));
  }
  organize(identity: string, parentId: string | null, beforeId?: string): void {
    this.validateParent(identity, parentId);
    void this.request({
      kind: "library",
      method: "library_organize",
      parameters: {
        itemId: identity,
        parentId,
        ...(beforeId ? { beforeId } : {}),
      },
    })
      .then(() => this.refresh())
      .catch((error) => this.fail(error));
  }
  reorder(
    identity: string,
    targetId: string,
    position: "before" | "after",
  ): void {
    void this.request({
      kind: "library",
      method: "library_reorder",
      parameters: { documentId: identity, targetId, position },
    })
      .then(() => this.refresh())
      .catch((error) => this.fail(error));
  }
  publishPreview(): void {}
  async detachPreview(identity: string): Promise<void> {
    await this.request({
      kind: "document",
      documentId: identity,
      method: "preview_open",
      parameters: {},
    });
  }
  async dockPreview(): Promise<void> {
    await this.closePreview();
  }
  async closePreview(): Promise<void> {
    if (this.state.activeId)
      await this.request({
        kind: "document",
        documentId: this.state.activeId,
        method: "preview_close",
        parameters: {},
      });
  }
}
export const workspace = new WindowWorkspace();
