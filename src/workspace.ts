import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { EditorSelection } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { z } from "zod";
import {
  anchorSchema,
  captureAnchor,
  defaultPreferences,
  relocateAnchor,
  selectionSchema,
} from "./domain";
import type { Preferences } from "./domain";
import { DocumentSession } from "./session";
import type { Bootstrap, DocumentHost, LoadedDocument } from "./session";

const draftSchema = z.object({ content: z.string(), permission: z.boolean() });
const entrySchema = z.object({
  id: z.string().uuid(),
  title: z.string().min(1),
  path: z.string().nullable(),
  collectionId: z.string().uuid().nullable(),
  open: z.boolean(),
  selection: selectionSchema.default({ from: 0, to: 0 }),
  scrollTop: z.number().nonnegative().default(0),
  activeThread: z.string().nullable().default(null),
  composer: z.boolean().default(false),
  drafts: z.record(z.string(), draftSchema).default({}),
  composerAnchor: anchorSchema.nullable().default(null),
});
const locationSchema = z.object({
  documentId: z.string().uuid(),
  anchor: anchorSchema,
  threadId: z.string().nullable(),
  composer: z.boolean().default(false),
  scrollTop: z.number().nonnegative(),
});
const librarySchema = z.object({
  version: z.literal(1),
  documents: z.array(entrySchema),
  collections: z.array(
    z.object({ id: z.string().uuid(), title: z.string().min(1) }),
  ),
  activeId: z.string().uuid().nullable(),
  sidebarOpen: z.boolean(),
  history: z.array(locationSchema).default([]),
  historyIndex: z.number().int().default(-1),
});
export type LibraryEntry = z.infer<typeof entrySchema>;
type Library = z.infer<typeof librarySchema>;

class Workspace implements DocumentHost {
  private state: Library & { ready: boolean; error: string | null } = {
    version: 1,
    documents: [],
    collections: [],
    activeId: null,
    sidebarOpen: true,
    history: [],
    historyIndex: -1,
    ready: false,
    error: null,
  };
  readonly sessions = new Map<string, DocumentSession>();
  private listeners = new Set<() => void>();
  private bootstrap: Bootstrap | null = null;
  private persistence = Promise.resolve();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private navigating = false;
  private opening: Promise<void> = Promise.resolve();
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  get active(): DocumentSession | undefined {
    return this.state.activeId
      ? this.sessions.get(this.state.activeId)
      : undefined;
  }
  update(
    patch: Partial<Library> & { ready?: boolean; error?: string | null },
  ): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
    if (!this.state.ready) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(
      () => void this.persist().catch((error) => this.fail(error)),
      150,
    );
  }
  fail(error: unknown): void {
    this.state = { ...this.state, error: String(error) };
    for (const listener of this.listeners) listener();
  }
  async initialize(): Promise<void> {
    try {
      this.bootstrap = await invoke<Bootstrap>("bootstrap");
      if (this.bootstrap.library)
        this.state = {
          ...librarySchema.parse(this.bootstrap.library),
          ready: false,
          error: null,
        };
      const recoveries = [...(this.bootstrap.recoveries ?? [])];
      if (
        this.bootstrap.recovery &&
        !recoveries.some(
          (snapshot) =>
            snapshot.metadata.documentId ===
            this.bootstrap!.recovery!.metadata.documentId,
        )
      )
        recoveries.push(this.bootstrap.recovery);
      for (const entry of this.state.documents) {
        const recovery = recoveries.find(
          (snapshot) => snapshot.metadata.documentId === entry.id,
        );
        const session = new DocumentSession(this);
        try {
          await session.initialize({
            ...this.bootstrap,
            recovery: recovery ?? null,
            lastPath: recovery ? null : entry.path,
          });
          if (session.getSnapshot().error)
            throw Error(session.getSnapshot().error!);
          if (session.getSnapshot().metadata.documentId !== entry.id)
            throw Error(
              `The identity of ${entry.title} changed outside the library.`,
            );
          session.update({
            selection: {
              from: Math.min(
                entry.selection.from,
                session.getSnapshot().text.length,
              ),
              to: Math.min(
                entry.selection.to,
                session.getSnapshot().text.length,
              ),
            },
            activeThread: entry.activeThread,
            composer: entry.composer,
            drafts: entry.drafts,
            composerAnchor: entry.composerAnchor
              ? relocateAnchor(session.getSnapshot().text, entry.composerAnchor)
              : null,
          });
          this.register(session, entry);
        } catch (error) {
          this.fail(error);
        }
      }
      for (const recovery of recoveries) {
        if (this.sessions.has(recovery.metadata.documentId)) continue;
        const session = new DocumentSession(this);
        await session.initialize({
          ...this.bootstrap,
          recovery,
          lastPath: null,
        });
        this.register(session);
      }
      if (!this.sessions.size && this.bootstrap.lastPath) {
        const session = new DocumentSession(this);
        await session.initialize({ ...this.bootstrap, recovery: null });
        if (!session.getSnapshot().error) this.register(session);
      }
      if (!this.sessions.size) await this.newDocument();
      if (this.bootstrap.requestedPath)
        await this.openDocument(this.bootstrap.requestedPath);
      const activeId =
        this.state.activeId && this.sessions.has(this.state.activeId)
          ? this.state.activeId
          : this.sessions.keys().next().value!;
      this.update({
        activeId,
        documents: this.state.documents.map((entry) =>
          entry.id === activeId ? { ...entry, open: true } : entry,
        ),
        ready: true,
      });
      if (!this.state.history.length) this.afterNavigation();
      await this.persist();
    } catch (error) {
      this.fail(error);
    }
  }
  register(session: DocumentSession, stored?: LibraryEntry): void {
    const state = session.getSnapshot();
    const entry =
      stored ??
      entrySchema.parse({
        id: state.metadata.documentId,
        title:
          state.path
            ?.split("/")
            .at(-1)
            ?.replace(/\.(md|markdown|txt)$/u, "") ?? "Untitled",
        path: state.path,
        collectionId: null,
        open: true,
      });
    this.sessions.set(entry.id, session);
    if (!this.state.documents.some((candidate) => candidate.id === entry.id))
      this.update({ documents: [...this.state.documents, entry] });
    session.subscribe(() => {
      const current = session.getSnapshot();
      this.update({
        documents: this.state.documents.map((candidate) =>
          candidate.id === entry.id
            ? {
                ...candidate,
                path: current.path,
                selection: current.selection,
                activeThread: current.activeThread,
                composer: current.composer,
                drafts: current.drafts,
                composerAnchor: current.composerAnchor,
              }
            : candidate,
        ),
      });
    });
  }
  async persist(): Promise<void> {
    clearTimeout(this.timer);
    const library = librarySchema.parse({
      ...this.state,
      documents: this.state.documents.map((entry) => ({
        ...entry,
        scrollTop:
          entry.id === this.state.activeId
            ? (this.sessions.get(entry.id)?.view?.scrollDOM.scrollTop ??
              entry.scrollTop)
            : entry.scrollTop,
      })),
    });
    this.persistence = this.persistence
      .catch(() => undefined)
      .then(() => invoke<void>("store_library", { library }));
    await this.persistence;
  }
  async newDocument(): Promise<void> {
    const session = new DocumentSession(this);
    const configuration = this.bootstrap;
    session.update({
      ready: true,
      preferences: this.active?.getSnapshot().preferences ?? defaultPreferences,
      commandPath: configuration?.commandPath ?? "",
      codexPath: configuration?.codexPath ?? "",
      socketPath: configuration?.socketPath ?? "",
    });
    session.changed();
    const path = await invoke<string>("allocate_document", {
      documentId: session.getSnapshot().metadata.documentId,
    });
    await session.saveTo(path, false);
    this.register(
      session,
      entrySchema.parse({
        id: session.getSnapshot().metadata.documentId,
        title: "Untitled",
        path,
        collectionId: null,
        open: true,
      }),
    );
    this.activate(session.getSnapshot().metadata.documentId);
  }
  async openDocument(path?: string): Promise<void> {
    const selected =
      path ??
      (await open({
        multiple: false,
        directory: false,
        filters: [
          { name: "Text documents", extensions: ["txt", "md", "markdown"] },
        ],
      }));
    if (typeof selected !== "string") return;
    this.opening = this.opening
      .catch(() => undefined)
      .then(async () => {
        const loaded = await invoke<LoadedDocument>("read_document", {
          path: selected,
        });
        const existing = this.state.documents.find(
          (entry) => entry.path === loaded.path,
        );
        if (existing) {
          this.activate(existing.id);
          return;
        }
        if (loaded.metadata) {
          const identity = z
            .object({ documentId: z.string().uuid() })
            .passthrough()
            .parse(loaded.metadata).documentId;
          if (this.sessions.has(identity))
            throw Error(
              "This copy shares another document's identity. Ask your agent to create a separate document for it.",
            );
        }
        const session = new DocumentSession(this);
        session.update({
          preferences:
            this.active?.getSnapshot().preferences ?? defaultPreferences,
          commandPath: this.bootstrap?.commandPath ?? "",
          codexPath: this.bootstrap?.codexPath ?? "",
          socketPath: this.bootstrap?.socketPath ?? "",
        });
        await session.load(loaded.path, loaded);
        if (session.getSnapshot().dirty) await session.persist();
        const identity = session.getSnapshot().metadata.documentId;
        session.update({ ready: true });
        this.register(session);
        this.activate(identity);
        await this.persist();
      });
    await this.opening;
  }
  activate(identity: string): void {
    if (!this.sessions.has(identity))
      throw Error("This document is unavailable.");
    if (this.state.activeId === identity) return;
    this.beforeNavigation();
    this.update({
      activeId: identity,
      documents: this.state.documents.map((entry) =>
        entry.id === identity ? { ...entry, open: true } : entry,
      ),
    });
    this.afterNavigation();
    const scrollTop =
      this.state.documents.find((entry) => entry.id === identity)?.scrollTop ??
      0;
    requestAnimationFrame(() => {
      this.active?.view?.requestMeasure();
      this.active?.view?.scrollDOM.scrollTo({
        top: scrollTop,
        behavior: "instant",
      });
    });
  }
  beforeNavigation(): void {
    if (this.navigating || !this.active) return;
    const state = this.active.getSnapshot();
    const history = [...this.state.history];
    const scrollTop = this.active.view?.scrollDOM.scrollTop ?? 0;
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
        scrollTop: this.active.view?.scrollDOM.scrollTop ?? 0,
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
      scrollTop: this.active.view?.scrollDOM.scrollTop ?? 0,
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
    session.update({ selection });
    session.selectThread(location.threadId);
    session.update({
      composer:
        location.composer &&
        Boolean(state.composerAnchor || state.drafts.new?.content),
    });
    session.view?.dispatch({
      selection: EditorSelection.range(selection.from, selection.to),
    });
    this.update({ historyIndex: index });
    this.navigating = false;
    requestAnimationFrame(() => {
      session.view?.requestMeasure();
      session.view?.scrollDOM.scrollTo({
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
    const session = this.sessions.get(identity)!;
    const selection = {
      from,
      to: Math.min(to, session.getSnapshot().text.length),
    };
    session.view?.dispatch({
      selection: EditorSelection.range(selection.from, selection.to),
      effects: EditorView.scrollIntoView(selection.from, { y: "center" }),
    });
    session.update({ selection });
    this.navigating = false;
    this.afterNavigation();
    requestAnimationFrame(() => session.view?.focus());
  }
  closeDocument(identity: string): void {
    const opened = this.state.documents.filter(
      (entry) =>
        entry.open && entry.id !== identity && this.sessions.has(entry.id),
    );
    if (!opened.length) {
      void this.newDocument()
        .then(() => this.closeDocument(identity))
        .catch((error) => this.fail(error));
      return;
    }
    if (this.state.activeId === identity) this.activate(opened.at(-1)!.id);
    this.update({
      documents: this.state.documents.map((entry) =>
        entry.id === identity ? { ...entry, open: false } : entry,
      ),
    });
  }
  rename(identity: string, title: string): void {
    if (!title.trim()) return;
    this.update({
      documents: this.state.documents.map((entry) =>
        entry.id === identity ? { ...entry, title: title.trim() } : entry,
      ),
    });
  }
  collection(title: string): void {
    if (!title.trim()) return;
    this.update({
      collections: [
        ...this.state.collections,
        { id: crypto.randomUUID(), title: title.trim() },
      ],
    });
  }
  move(identity: string, collectionId: string | null): void {
    this.update({
      documents: this.state.documents.map((entry) =>
        entry.id === identity ? { ...entry, collectionId } : entry,
      ),
    });
  }
  preference(preferences: Preferences): void {
    for (const session of this.sessions.values())
      if (session.getSnapshot().preferences !== preferences)
        session.update({ preferences });
  }
  async close(): Promise<void> {
    for (const session of this.sessions.values()) await session.recover();
    await this.persist();
    await getCurrentWindow().destroy();
  }
  async command(command: string): Promise<void> {
    if (
      (command === "back" || command === "forward") &&
      this.active?.getSnapshot().previewMode === "fullscreen"
    )
      await this.active.command("preview-fullscreen");
    if (command === "back") {
      this.navigate(-1);
      return;
    }
    if (command === "forward") {
      this.navigate(1);
      return;
    }
    if (command === "sidebar") {
      this.update({ sidebarOpen: !this.state.sidebarOpen });
      return;
    }
    if (command === "new") {
      await this.newDocument();
      return;
    }
    if (command === "open") {
      await this.openDocument();
      return;
    }
    await this.active?.command(command);
  }
  async control(method: string, parameters: unknown): Promise<unknown> {
    if (method === "library_list") {
      z.object({}).strict().parse(parameters);
      return librarySchema.parse(this.state);
    }
    if (method === "document_open") {
      const parsed = z
        .object({ path: z.string().min(1) })
        .strict()
        .parse(parameters);
      await this.openDocument(parsed.path);
      return this.active!.control("document_read", {});
    }
    if (method === "document_create") {
      const parsed = z
        .object({
          title: z.string().trim().min(1),
          collectionId: z.string().uuid().nullable().optional(),
        })
        .strict()
        .parse(parameters);
      if (
        parsed.collectionId &&
        !this.state.collections.some(
          (collection) => collection.id === parsed.collectionId,
        )
      )
        throw Error("This collection is unavailable.");
      await this.newDocument();
      const identity = this.state.activeId!;
      this.rename(identity, parsed.title);
      if (parsed.collectionId) this.move(identity, parsed.collectionId);
      await this.persist();
      return { documentId: identity };
    }
    if (method === "library_update") {
      const parsed = z
        .object({
          documentId: z.string().uuid(),
          title: z.string().trim().min(1).optional(),
          collectionId: z.string().uuid().nullable().optional(),
        })
        .strict()
        .parse(parameters);
      if (!this.sessions.has(parsed.documentId))
        throw Error("This document is unavailable.");
      if (
        parsed.collectionId &&
        !this.state.collections.some(
          (collection) => collection.id === parsed.collectionId,
        )
      )
        throw Error("This collection is unavailable.");
      if (parsed.title) this.rename(parsed.documentId, parsed.title);
      if (parsed.collectionId !== undefined)
        this.move(parsed.documentId, parsed.collectionId);
      await this.persist();
      return this.state.documents.find(
        (entry) => entry.id === parsed.documentId,
      );
    }
    if (method === "collection_create") {
      const parsed = z
        .object({ title: z.string().trim().min(1) })
        .strict()
        .parse(parameters);
      this.collection(parsed.title);
      await this.persist();
      return this.state.collections.at(-1);
    }
    if (method === "document_activate") {
      const parsed = z
        .object({ documentId: z.string().uuid() })
        .strict()
        .parse(parameters);
      if (this.active?.getSnapshot().previewMode === "fullscreen")
        await this.active.command("preview-fullscreen");
      this.activate(parsed.documentId);
      return { documentId: parsed.documentId };
    }
    const routing = z
      .object({
        documentId: z.string().uuid().optional(),
        requestId: z.string().uuid().optional(),
        componentId: z.string().uuid().optional(),
        messageId: z.string().uuid().optional(),
      })
      .passthrough()
      .parse(parameters);
    let session = this.active;
    if (routing.documentId) session = this.sessions.get(routing.documentId);
    else if (routing.requestId)
      session = [...this.sessions.values()].find((candidate) =>
        candidate
          .getSnapshot()
          .metadata.requests.some(
            (request) => request.id === routing.requestId,
          ),
      );
    else if (routing.componentId)
      session = [...this.sessions.values()].find((candidate) =>
        candidate
          .getSnapshot()
          .metadata.threads.some((thread) =>
            thread.components.some(
              (component) => component.id === routing.componentId,
            ),
          ),
      );
    else if (routing.messageId)
      session = [...this.sessions.values()].find((candidate) =>
        candidate
          .getSnapshot()
          .metadata.threads.some((thread) =>
            thread.messages.some((message) => message.id === routing.messageId),
          ),
      );
    if (!session) throw Error("This document is unavailable.");
    if (
      (method === "editor_select" ||
        method === "ui_action" ||
        method === "ui_inspect" ||
        method === "ui_state") &&
      session !== this.active
    )
      throw Error("Activate this document before acting on its interface.");
    if (method === "document_read" || method === "requests_list") {
      z.object({ documentId: z.string().uuid().optional() })
        .strict()
        .parse(parameters);
      return session.control(method, {});
    }
    if (method === "editor_select") this.beforeNavigation();
    const result = await session.control(method, parameters);
    if (method === "editor_select") this.afterNavigation();
    return result;
  }
}
export const workspace = new Workspace();
