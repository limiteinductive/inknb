import { spacesSchema } from "./spaces";
import { activity } from "./activity";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { z } from "zod";
import { asideRequestSchema } from "./aside-actions";
import { previewActionSchema, previewAnchorSchema } from "./preview-model";
import {
  anchorSchema,
  configurationSchema,
  defaultPreferences,
  relocateAnchor,
  selectionSchema,
  threadActivity,
} from "./domain";
import type { AsideReference, ConfigurationSnapshot } from "./domain";
import { asideConnections, parseAsideLink } from "./aside-reference";
import { DocumentSession } from "./session";
import type { Bootstrap, DocumentHost, LoadedDocument } from "./session";

import { draftSchema } from "./images";
const nodeSchema = z.object({
  id: z.string().uuid(),
  title: z.string().min(1),
  parentId: z.string().uuid().nullable().default(null),
  modifiedAt: z.number().nonnegative().default(0),
  order: z.number().int().nonnegative().default(0),
  priority: z.number().finite().default(0),
});
const entrySchema = nodeSchema.extend({
  pinned: z.boolean().default(false),
  path: z.string().nullable(),
  open: z.boolean(),
  selection: selectionSchema.default({ from: 0, to: 0 }),
  scrollTop: z.number().nonnegative().default(0),
  activeThread: z.string().nullable().default(null),
  asidesOpen: z.boolean().default(true),
  threadExpansions: z.record(z.string().uuid(), z.boolean()).default({}),
  composer: z.boolean().default(false),
  drafts: z.record(z.string(), draftSchema).default({}),
  threadReads: z.record(z.string().uuid(), z.string()).nullable().default(null),
  composerAnchor: anchorSchema.nullable().default(null),
  composerPreviewAnchor: previewAnchorSchema.nullable().default(null),
});
const locationSchema = z.object({
  documentId: z.string().uuid(),
  anchor: anchorSchema,
  threadId: z.string().nullable(),
  composer: z.boolean().default(false),
  scrollTop: z.number().nonnegative(),
});
const librarySchema = z.object({
  version: z.literal(2),
  spaces: spacesSchema.optional(),
  documents: z.array(entrySchema),
  collections: z.array(nodeSchema),
  collapsedIds: z.array(z.string().uuid()).default([]),
  activeId: z.string().uuid().nullable(),
  sidebarOpen: z.boolean(),
  sidebarWidth: z.number().finite().min(200).max(480).default(232),
  previewWidth: z.number().finite().min(280).nullable().default(null),
  asideWidth: z.number().finite().min(280).default(400),
  history: z.array(locationSchema).default([]),
  historyIndex: z.number().int().default(-1),
});
const storedDocumentSchema = nodeSchema.extend({
  path: z.string().nullable(),
  threadReads: z.record(z.string().uuid(), z.string()).nullable(),
});
const storedLibrarySchema = z.object({
  version: z.literal(3),
  documents: z.array(storedDocumentSchema),
  collections: z.array(nodeSchema),
  spaces: spacesSchema,
});
export type LibraryNode = z.infer<typeof nodeSchema>;
export type LibraryEntry = z.infer<typeof entrySchema>;
export type Library = z.infer<typeof librarySchema>;

export class DocumentLibrary implements DocumentHost {
  constructor(
    readonly navigateAside: (reference: AsideReference) => Promise<void>,
  ) {}
  private state: Library & { ready: boolean; error: string | null } = {
    version: 2,
    documents: [],
    collections: [],
    collapsedIds: [],
    activeId: null,
    sidebarOpen: true,
    sidebarWidth: 232,
    previewWidth: null,
    asideWidth: 400,
    history: [],
    historyIndex: -1,
    ready: false,
    error: null,
  };
  readonly sessions = new Map<string, DocumentSession>();

  readAside(reference: AsideReference) {
    const session = this.sessions.get(reference.documentId);
    const thread = session
      ?.getSnapshot()
      .metadata.threads.find((thread) => thread.id === reference.threadId);
    if (!thread) throw Error("This aside is not in the writing library.");
    const references = asideConnections(
      [...this.sessions.values()].map(
        (session) => session.getSnapshot().metadata,
      ),
      reference,
    );
    return {
      thread,
      documentId: reference.documentId,
      title: this.documentTitle(reference.documentId),
      references,
    };
  }

  openAside(reference: AsideReference): void {
    this.readAside(reference);
    void this.navigateAside(reference).catch((error) => this.fail(error));
  }
  private listeners = new Set<() => void>();
  private bootstrap: Bootstrap | null = null;
  private configuration: ConfigurationSnapshot | null = null;
  private persistence = Promise.resolve();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private opening: Promise<void> = Promise.resolve();
  private previewDocumentId: string | null = null;
  private previewSequence = 0;
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
  documentTitle(identity: string): string {
    return (
      this.state.documents.find((entry) => entry.id === identity)?.title ??
      "Untitled"
    );
  }
  publishPreview(identity: string): void {
    if (this.previewDocumentId !== identity) return;
    const session = this.sessions.get(identity);
    if (!session) return;
    void invoke("preview_window_state", {
      snapshot: {
        sequence: ++this.previewSequence,
        asideWidth: this.state.asideWidth,
        state: session.getPreviewSnapshot(),
      },
    }).catch((error) => this.fail(error));
  }

  targetPreview(identity: string): void {
    if (this.previewDocumentId === identity) return;
    const session = this.sessions.get(identity);
    if (!session) return;
    const previous = this.previewDocumentId
      ? this.sessions.get(this.previewDocumentId)
      : null;
    this.previewDocumentId = identity;
    previous?.update({ previewHost: "main", previewSelection: null });
    session.update({
      previewHost: "detached",
      previewSelection: null,
    });
  }

  async detachPreview(identity: string): Promise<void> {
    this.targetPreview(identity);
    try {
      await invoke("preview_window_open", {
        title: this.documentTitle(identity),
      });
    } catch (error) {
      this.previewDocumentId = null;
      this.sessions.get(identity)?.update({ previewHost: "main" });
      throw error;
    }
  }

  async dockPreview(): Promise<void> {
    const identity = this.previewDocumentId;
    if (!identity) return;
    this.previewDocumentId = null;
    this.activate(identity);
    this.sessions.get(identity)?.update({
      previewHost: "main",
      previewSelection: null,
      focus: false,
    });
    await invoke("preview_window_close");
  }

  async closePreview(): Promise<void> {
    const identity = this.previewDocumentId;
    this.previewDocumentId = null;
    if (identity)
      this.sessions
        .get(identity)
        ?.update({ previewHost: "main", previewSelection: null });
    await invoke("preview_window_close");
  }

  previewAction(payload: { documentId: string | null; action: unknown }): void {
    const request = asideRequestSchema.safeParse(payload.action);
    if (request.success) {
      if (!payload.documentId || payload.documentId !== this.previewDocumentId)
        return;
      const session = this.sessions.get(payload.documentId);
      if (!session) return;
      void session
        .asideAction(request.data.action)
        .then(
          (result) =>
            invoke("preview_window_result", {
              response: { requestId: request.data.requestId, result },
            }),
          (error) =>
            invoke("preview_window_result", {
              response: {
                requestId: request.data.requestId,
                error: String(error),
              },
            }),
        )
        .catch((error) => this.fail(error));
      return;
    }
    const result = previewActionSchema.safeParse(payload.action);
    if (!result.success) return;
    if (result.data.kind === "closed") {
      const identity = this.previewDocumentId;
      this.previewDocumentId = null;
      if (identity)
        this.sessions
          .get(identity)
          ?.update({ previewHost: "main", previewSelection: null });
      return;
    }
    if (!this.previewDocumentId) return;
    if (result.data.kind === "connected") {
      this.publishPreview(this.previewDocumentId);
      return;
    }
    if (payload.documentId !== this.previewDocumentId) return;
    if (result.data.kind === "aside-width") {
      this.update({ asideWidth: result.data.width });
      return;
    }
    void this.sessions.get(this.previewDocumentId)?.previewAction(result.data);
  }
  update(
    patch: Partial<Library> & { ready?: boolean; error?: string | null },
  ): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
    if (patch.asideWidth !== undefined && this.previewDocumentId)
      this.publishPreview(this.previewDocumentId);
    if (!this.state.ready) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(
      () => void this.persist().catch((error) => this.fail(error)),
      150,
    );
  }
  fail(error: unknown): void {
    activity.report(null, "error", error);
    this.state = { ...this.state, error: String(error) };
    for (const listener of this.listeners) listener();
  }
  async initialize(bootstrap: Bootstrap): Promise<void> {
    try {
      this.bootstrap = bootstrap;
      this.configure(this.bootstrap.configuration);
      if (this.bootstrap.library) {
        let stored = this.bootstrap.library;
        if (
          z.object({ version: z.number() }).passthrough().parse(stored)
            .version === 3
        ) {
          const library = storedLibrarySchema.parse(stored);
          const window =
            library.spaces.windows.find(
              (window) => window.id === library.spaces.lastWindowId,
            ) ?? library.spaces.windows[0];
          stored = {
            ...library,
            version: 2,
            documents: library.documents.map((entry) =>
              entrySchema.parse({ ...entry, open: true }),
            ),
            activeId: window?.activeId ?? null,
            sidebarOpen: window?.sidebarOpen ?? true,
            sidebarWidth: window?.sidebarWidth ?? 232,
            asideWidth: window?.asideWidth ?? 400,
            previewWidth: window?.previewWidth ?? null,
          };
        }
        this.state = {
          ...librarySchema.parse(
            z
              .object({
                version: z.union([z.literal(1), z.literal(2)]),
                documents: z.array(
                  z
                    .object({
                      collectionId: z.string().uuid().nullable().optional(),
                    })
                    .passthrough(),
                ),
              })
              .passthrough()
              .transform((library) => ({
                ...library,
                version: 2,
                documents: library.documents.map((entry, index) => ({
                  ...entry,
                  parentId:
                    entry.parentId !== undefined
                      ? entry.parentId
                      : (entry.collectionId ?? null),
                  order: entry.order ?? index,
                })),
              }))
              .parse(stored),
          ),
          ready: false,
          error: null,
        };
      }
      this.normalizeHierarchy();
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
        await invoke("host_lifecycle", {
          status: {
            phase: "loadingDocuments",
            message: `Opening ${entry.title}`,
          },
        });
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
            asidesOpen: entry.asidesOpen,
            sourceScrollTop: entry.scrollTop,
            threadExpansions: entry.threadExpansions,
            composer: entry.composer,
            composerPreviewAnchor: entry.composerPreviewAnchor,
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
      this.configure(await invoke("configuration_read"));
      if (!this.state.history.length) this.afterNavigation();
      await this.persist();
    } catch (error) {
      this.fail(error);
    }
  }
  register(session: DocumentSession, stored?: LibraryEntry): void {
    if (!session.model) session.prepareModel();
    const state = session.getSnapshot();
    const entry =
      stored ??
      entrySchema.parse({
        id: state.metadata.documentId,
        title:
          state.path
            ?.split("/")
            .at(-1)
            ?.replace(/\.(md|markdown|txt|html|htm|tex|latex)$/iu, "") ??
          "Untitled",
        path: state.path,
        parentId: null,
        modifiedAt: Date.now(),
        order: this.nodes.length,
        open: true,
      });
    const threadReads =
      (entry.threadReads ? { ...entry.threadReads } : null) ??
      Object.fromEntries(
        state.metadata.threads.flatMap((thread) => {
          const activity = threadActivity(state.metadata, thread);
          return activity === null ? [] : [[thread.id, activity]];
        }),
      );
    if (entry.threadReads) {
      for (const thread of state.metadata.threads) {
        if (thread.kind !== "discussion") continue;
        const suggestions = state.metadata.threads.filter(
          (candidate) =>
            candidate.kind === "suggestion" &&
            !candidate.messages.length &&
            candidate.links.some(
              (link) =>
                link.relation === "suggestion_for" &&
                link.documentId === state.metadata.documentId &&
                link.threadId === thread.id,
            ),
        );
        if (!suggestions.length) continue;
        const identities = new Set(
          suggestions.map((suggestion) => suggestion.id),
        );
        const legacy = {
          ...state.metadata,
          proposals: state.metadata.proposals.map((proposal) =>
            proposal.threadId && identities.has(proposal.threadId)
              ? { ...proposal, threadId: thread.id }
              : proposal,
          ),
        };
        if (entry.threadReads[thread.id] !== threadActivity(legacy, thread))
          continue;
        const activity = threadActivity(state.metadata, thread);
        if (activity) threadReads[thread.id] = activity;
        else delete threadReads[thread.id];
        for (const suggestion of suggestions) {
          const read = threadActivity(state.metadata, suggestion);
          if (read) threadReads[suggestion.id] = read;
        }
      }
    }
    session.update({ threadReads });
    this.sessions.set(entry.id, session);
    void invoke("activity_seed", {
      documentId: entry.id,
      metadata: state.metadata,
      unreadThreads: state.metadata.threads
        .filter((thread) => session.hasUnreadActivity(thread.id))
        .map((thread) => thread.id),
    })
      .then(() => activity.refresh())
      .catch((error) => activity.update({ error: String(error) }));
    if (this.configuration) session.configure(this.configuration.effective);
    const documents = this.state.documents.map((candidate) =>
      candidate.id === entry.id ? { ...candidate, threadReads } : candidate,
    );
    if (!documents.some((candidate) => candidate.id === entry.id))
      documents.push({ ...entry, threadReads });
    this.update({ documents });
    let previousRevision = state.metadata.revision;
    session.subscribe(() => {
      const current = session.getSnapshot();
      const edited = current.metadata.revision !== previousRevision;
      previousRevision = current.metadata.revision;
      this.update({
        documents: this.state.documents.map((candidate) =>
          candidate.id === entry.id
            ? {
                ...candidate,
                modifiedAt: edited ? Date.now() : candidate.modifiedAt,
                path: current.path,
                selection: current.selection,
                activeThread: current.activeThread,
                asidesOpen: current.asidesOpen,
                threadExpansions: current.threadExpansions,
                composer: current.composer,
                drafts: current.drafts,
                threadReads: current.threadReads,
                composerAnchor: current.composerAnchor,
                composerPreviewAnchor: current.composerPreviewAnchor,
              }
            : candidate,
        ),
      });
    });
  }
  async persist(): Promise<void> {
    clearTimeout(this.timer);
    const library = this.state.spaces
      ? storedLibrarySchema.parse({ ...this.state, version: 3 })
      : librarySchema.parse(this.state);
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
      profile: configuration?.profile ?? null,
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
        parentId: null,
        modifiedAt: Date.now(),
        order: this.nodes.length,
        open: true,
      }),
    );
    this.activate(session.getSnapshot().metadata.documentId);
  }
  async openDocument(path?: string): Promise<void> {
    const reference = path ? parseAsideLink(path) : null;
    if (reference) {
      this.openAside(reference);
      return;
    }
    if (path?.startsWith("inknb:"))
      throw Error("This aside reference is invalid.");
    const selected =
      path ??
      (await open({
        multiple: false,
        directory: false,
        filters: [
          {
            name: "Documents",
            extensions: [
              "txt",
              "md",
              "markdown",
              "html",
              "htm",
              "tex",
              "latex",
            ],
          },
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
          profile: this.bootstrap?.profile ?? null,
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
    this.update({ activeId: identity });
  }
  beforeNavigation(): void {}
  afterNavigation(): void {}
  rename(identity: string, title: string): void {
    if (!title.trim()) return;
    this.update({
      documents: this.state.documents.map((entry) =>
        entry.id === identity
          ? {
              ...entry,
              title: title.trim(),
              modifiedAt:
                entry.title === title.trim() ? entry.modifiedAt : Date.now(),
            }
          : entry,
      ),
    });
    const session = this.sessions.get(identity);
    if (session?.getSnapshot().previewHost === "detached")
      session.publishPreview();
  }
  get nodes(): LibraryNode[] {
    return [...this.state.collections, ...this.state.documents];
  }
  collection(title: string, parentId: string | null = null): void {
    this.validateParent(null, parentId, true);
    this.update({
      collections: [
        ...this.state.collections,
        nodeSchema.parse({
          id: crypto.randomUUID(),
          title: title.trim(),
          parentId,
          modifiedAt: Date.now(),
          order: this.nodes.length,
        }),
      ],
    });
  }
  pin(identity: string, pinned: boolean): void {
    if (!this.state.documents.some((entry) => entry.id === identity))
      throw Error("This writing is unavailable.");
    this.update({
      documents: this.state.documents.map((entry) =>
        entry.id === identity ? { ...entry, pinned } : entry,
      ),
    });
  }
  setPriority(identity: string, priority: number): void {
    if (!this.nodes.some((node) => node.id === identity))
      throw Error("This writing or group is unavailable.");
    this.update({
      documents: this.state.documents.map((entry) =>
        entry.id === identity ? { ...entry, priority } : entry,
      ),
      collections: this.state.collections.map((node) =>
        node.id === identity ? { ...node, priority } : node,
      ),
    });
  }
  private normalizeHierarchy(): void {
    const nodes = new Map(this.nodes.map((node) => [node.id, node]));
    if (nodes.size !== this.nodes.length)
      throw Error("Library identities must be unique.");
    for (const node of nodes.values()) {
      const visited = new Set([node.id]);
      let ancestor = node.parentId;
      while (ancestor) {
        if (visited.has(ancestor))
          throw Error("A writing or group cannot contain itself.");
        visited.add(ancestor);
        const parent = nodes.get(ancestor);
        if (!parent) throw Error("This parent is unavailable.");
        ancestor = parent.parentId;
      }
    }
    const folders = new Set(this.state.collections.map((node) => node.id));
    const parents = new Map<string, string | null>();
    for (const node of nodes.values()) {
      let parent = node.parentId;
      while (parent && !folders.has(parent))
        parent = nodes.get(parent)!.parentId;
      parents.set(node.id, parent);
    }
    const limit = this.configuration?.effective.library_depth ?? 1;
    const depths = new Map<string, number>();
    function placeFolder(identity: string): number {
      const cached = depths.get(identity);
      if (cached !== undefined) return cached;
      let parent = parents.get(identity) ?? null;
      let depth = parent ? placeFolder(parent) : 0;
      if (limit >= 0 && depth >= limit) {
        parent = null;
        depth = 0;
      }
      parents.set(identity, parent);
      depths.set(identity, depth + 1);
      return depth + 1;
    }
    for (const folder of this.state.collections) placeFolder(folder.id);
    const documents = this.state.documents.map((entry) => ({
      ...entry,
      parentId: limit === 0 ? null : (parents.get(entry.id) ?? null),
    }));
    const collections = this.state.collections.map((folder) => ({
      ...folder,
      parentId: parents.get(folder.id) ?? null,
    }));
    const collapsedIds = this.state.collapsedIds.filter((identity) =>
      folders.has(identity),
    );
    if (
      [...documents, ...collections].some(
        (node) => nodes.get(node.id)!.parentId !== node.parentId,
      ) ||
      collapsedIds.length !== this.state.collapsedIds.length
    )
      this.update({ documents, collections, collapsedIds });
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
    const limit = this.configuration?.effective.library_depth ?? 1;
    if (limit >= 0 && parentDepth + subtreeDepth > limit)
      throw Error(`This organization exceeds library_depth = ${limit}.`);
  }
  organize(identity: string, parentId: string | null, beforeId?: string): void {
    const nodes = this.nodes;
    if (!nodes.some((node) => node.id === identity))
      throw Error("This writing or group is unavailable.");
    this.validateParent(identity, parentId);
    if (beforeId === identity) return;
    if (
      beforeId &&
      !nodes.some((node) => node.id === beforeId && node.parentId === parentId)
    )
      throw Error("The target must have the same parent.");
    const ordered = nodes
      .filter((node) => node.id !== identity)
      .sort((left, right) => left.order - right.order);
    const targetIndex = beforeId
      ? ordered.findIndex((node) => node.id === beforeId)
      : ordered.length;
    ordered.splice(
      targetIndex,
      0,
      nodes.find((node) => node.id === identity)!,
    );
    const positions = new Map(ordered.map((node, index) => [node.id, index]));
    this.update({
      documents: this.state.documents.map((node) => ({
        ...node,
        parentId: node.id === identity ? parentId : node.parentId,
        order: positions.get(node.id)!,
      })),
      collections: this.state.collections.map((node) => ({
        ...node,
        parentId: node.id === identity ? parentId : node.parentId,
        order: positions.get(node.id)!,
      })),
      collapsedIds: this.state.collapsedIds.filter(
        (nodeId) => nodeId !== parentId,
      ),
    });
  }
  reorder(
    identity: string,
    targetId: string,
    position: "before" | "after",
  ): void {
    if (identity === targetId) return;
    const target = this.nodes.find((node) => node.id === targetId);
    if (!target) throw Error("This writing or group is unavailable.");
    const item = this.nodes.find((node) => node.id === identity);
    if (!item) throw Error("This writing or group is unavailable.");
    if (item.priority !== target.priority)
      throw Error("Items with different priorities keep their priority order.");
    const siblings = this.nodes
      .filter(
        (node) => node.id !== identity && node.parentId === target.parentId,
      )
      .sort((left, right) => left.order - right.order);
    const beforeId =
      position === "before"
        ? targetId
        : siblings[siblings.findIndex((node) => node.id === targetId) + 1]?.id;
    this.organize(identity, target.parentId, beforeId);
  }
  configure(value: unknown): void {
    const configuration = configurationSchema.parse(value);
    if (
      this.configuration &&
      configuration.revision <= this.configuration.revision
    )
      return;
    this.configuration = configuration;
    if (this.bootstrap) this.bootstrap.configuration = value;
    this.normalizeHierarchy();
    for (const session of this.sessions.values())
      session.configure(configuration.effective);
    this.update({});
    if (
      this.previewDocumentId &&
      this.state.activeId &&
      configuration.effective.detached_preview === "active_document"
    )
      this.targetPreview(this.state.activeId);
  }
  async close(): Promise<void> {
    for (const session of this.sessions.values()) await session.recover();
    await this.persist();
    await invoke("request_quit");
  }
  async control(method: string, parameters: unknown, agentId?: string): Promise<unknown> {
    if (method === "library_list") {
      z.object({}).strict().parse(parameters);
      return librarySchema.parse(this.state);
    }
    if (method === "library_reorder") {
      const parsed = z
        .object({
          documentId: z.string().uuid(),
          targetId: z.string().uuid(),
          position: z.enum(["before", "after"]),
        })
        .strict()
        .parse(parameters);
      this.reorder(parsed.documentId, parsed.targetId, parsed.position);
      await this.persist();
      return librarySchema.parse(this.state);
    }
    if (method === "library_organize") {
      const parsed = z
        .object({
          itemId: z.string().uuid(),
          parentId: z.string().uuid().nullable(),
          beforeId: z.string().uuid().optional(),
        })
        .strict()
        .parse(parameters);
      this.organize(parsed.itemId, parsed.parentId, parsed.beforeId);
      await this.persist();
      return librarySchema.parse(this.state);
    }
    if (method === "collection_update") {
      const parsed = z
        .object({
          collectionId: z.string().uuid(),
          title: z.string().trim().min(1).optional(),
          parentId: z.string().uuid().nullable().optional(),
          priority: z.number().finite().optional(),
        })
        .strict()
        .parse(parameters);
      if (
        !this.state.collections.some((node) => node.id === parsed.collectionId)
      )
        throw Error("This group is unavailable.");
      if (parsed.parentId !== undefined)
        this.organize(parsed.collectionId, parsed.parentId);
      if (parsed.priority !== undefined)
        this.setPriority(parsed.collectionId, parsed.priority);
      if (parsed.title)
        this.update({
          collections: this.state.collections.map((node) =>
            node.id === parsed.collectionId
              ? { ...node, title: parsed.title!, modifiedAt: Date.now() }
              : node,
          ),
        });
      await this.persist();
      return this.state.collections.find(
        (node) => node.id === parsed.collectionId,
      );
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
          parentId: z.string().uuid().nullable().optional(),
        })
        .strict()
        .refine(
          (parameters) =>
            parameters.parentId === undefined ||
            parameters.collectionId === undefined,
          "Supply parentId or collectionId, not both.",
        )
        .parse(parameters);
      if (
        parsed.collectionId &&
        !this.state.collections.some(
          (collection) => collection.id === parsed.collectionId,
        )
      )
        throw Error("This collection is unavailable.");
      this.validateParent(
        null,
        parsed.parentId !== undefined
          ? parsed.parentId
          : (parsed.collectionId ?? null),
      );
      await this.newDocument();
      const identity = this.state.activeId!;
      this.rename(identity, parsed.title);
      if (parsed.parentId !== undefined || parsed.collectionId !== undefined)
        this.organize(
          identity,
          parsed.parentId !== undefined
            ? parsed.parentId
            : (parsed.collectionId ?? null),
        );
      await this.persist();
      return { documentId: identity };
    }
    if (method === "library_update") {
      const parsed = z
        .object({
          documentId: z.string().uuid(),
          title: z.string().trim().min(1).optional(),
          collectionId: z.string().uuid().nullable().optional(),
          parentId: z.string().uuid().nullable().optional(),
          pinned: z.boolean().optional(),
          priority: z.number().finite().optional(),
        })
        .strict()
        .refine(
          (parameters) =>
            parameters.parentId === undefined ||
            parameters.collectionId === undefined,
          "Supply parentId or collectionId, not both.",
        )
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
      if (parsed.parentId !== undefined || parsed.collectionId !== undefined)
        this.organize(
          parsed.documentId,
          parsed.parentId !== undefined
            ? parsed.parentId
            : (parsed.collectionId ?? null),
        );
      if (parsed.title) this.rename(parsed.documentId, parsed.title);
      if (parsed.pinned !== undefined)
        this.pin(parsed.documentId, parsed.pinned);
      if (parsed.priority !== undefined)
        this.setPriority(parsed.documentId, parsed.priority);
      await this.persist();
      return this.state.documents.find(
        (entry) => entry.id === parsed.documentId,
      );
    }
    if (method === "collection_create") {
      const parsed = z
        .object({
          title: z.string().trim().min(1),
          parentId: z.string().uuid().nullable().optional(),
        })
        .strict()
        .parse(parameters);
      this.collection(parsed.title, parsed.parentId);
      await this.persist();
      return this.state.collections.at(-1);
    }
    if (method === "document_activate") {
      const parsed = z
        .object({ documentId: z.string().uuid() })
        .strict()
        .parse(parameters);
      this.activate(parsed.documentId);
      return { documentId: parsed.documentId };
    }
    const routing = z
      .object({
        documentId: z.string().uuid().optional(),
        decisionId: z.string().uuid().optional(),
        requestId: z.string().uuid().optional(),
        threadId: z.string().uuid().optional(),
        componentId: z.string().uuid().optional(),
        messageId: z.string().uuid().optional(),
      })
      .passthrough()
      .parse(parameters);
    let session = this.active;
    if (routing.documentId) session = this.sessions.get(routing.documentId);
    else if (routing.decisionId)
      session = [...this.sessions.values()].find((candidate) => candidate.getSnapshot().metadata.decisions.some((decision) => decision.id === routing.decisionId));
    else if (routing.requestId)
      session = [...this.sessions.values()].find((candidate) =>
        candidate
          .getSnapshot()
          .metadata.requests.some(
            (request) => request.id === routing.requestId,
          ),
      );
    else if (routing.threadId)
      session = [...this.sessions.values()].find((candidate) =>
        candidate
          .getSnapshot()
          .metadata.threads.some((thread) => thread.id === routing.threadId),
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
      return session.control(method, {}, agentId);
    }
    if (method === "editor_select") this.beforeNavigation();
    const result = await session.control(method, parameters, agentId);
    if (method === "ui_state") {
      const preview = this.previewDocumentId
        ? this.sessions.get(this.previewDocumentId)?.getSnapshot()
        : null;
      return {
        ...z.object({}).passthrough().parse(result),
        activity: activity.getSnapshot(),
        detachedPreview: preview
          ? {
              documentId: this.previewDocumentId,
              behavior: preview.preferences.detached_preview,
              sequence: this.previewSequence,
              runtime: preview.previewRuntime,
              artifactId:
                preview.previewArtifactId ??
                preview.metadata.preview?.artifactId ??
                null,
            }
          : null,
      };
    }
    if (method === "editor_select") this.afterNavigation();
    return result;
  }
}
