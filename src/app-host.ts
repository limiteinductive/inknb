import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Selection } from "prosemirror-state";
import { closeHistory } from "prosemirror-history";
import { Step } from "prosemirror-transform";
import { z } from "zod";
import { DocumentLibrary } from "./workspace";
import { parseAsideLink } from "./aside-reference";
import type { AsideReference } from "./domain";
import { Spaces, documentViewSchema, spacesSchema } from "./spaces";
import type { SpaceWindow } from "./spaces";
import { hostRequestSchema } from "./host-protocol";
import type {
  HostSnapshot,
  HostRequest,
  DocumentExchange,
} from "./host-protocol";
import type { Bootstrap } from "./session";
import { linkedResourceSchema, parseDocumentLink, resourceActionSchema } from "./resources";
import type { ResourceAction, ResourceState } from "./resources";
import { nativeSchema } from "./native-schema";

class AppHost {
  private spaces!: Spaces;
  private documents = new DocumentLibrary((reference) =>
    this.openAside(reference),
  );
  private operations = Promise.resolve<unknown>(null);
  private ready = false;
  private activityTargets = new Map<string, string>();

  async start(): Promise<void> {
    const hostWindow = getCurrentWindow();
    await invoke("host_lifecycle", {
      status: { phase: "starting", message: null },
    });
    const bootstrap = await invoke<Bootstrap>("bootstrap");
    await this.documents.initialize(bootstrap);
    const library = this.documents.getSnapshot();
    if (!library.ready)
      throw Error(library.error ?? "The document library could not start.");
    await invoke("host_lifecycle", {
      status: { phase: "documentsReady", message: null },
    });
    const stored = z
      .object({ spaces: spacesSchema.optional() })
      .passthrough()
      .parse(bootstrap.library ?? {});
    const spaceId = crypto.randomUUID();
    const windowId = crypto.randomUUID();
    this.spaces = new Spaces(
      stored.spaces ?? {
        version: 1,
        defaultSpaceId: spaceId,
        spaces: [
          {
            id: spaceId,
            title: "Writing",
            documentIds: library.documents.filter(entry => !entry.trash).map((entry) => entry.id),
            pinnedIds: library.documents
              .filter((entry) => entry.pinned && !entry.trash)
              .map((entry) => entry.id),
            homeId: library.activeId,
          },
        ],
        windows: [
          {
            id: windowId,
            spaceId,
            activeId: library.activeId,
            documents: Object.fromEntries(
              library.documents.map((entry) => [
                entry.id,
                documentViewSchema.parse(entry),
              ]),
            ),
            collapsedIds: library.collapsedIds,
            sidebarOpen: library.sidebarOpen,
            sidebarWidth: library.sidebarWidth,
            asideWidth: library.asideWidth,
            previewWidth: library.previewWidth,
            history: library.history,
            historyIndex: library.historyIndex,
            bounds: { left: null, top: null, width: 1180, height: 820 },
            open: true,
          },
        ],
        lastWindowId: windowId,
      },
      () => {
        if (this.ready)
          void this.persist().catch((error) => this.documents.fail(error));
      },
    );
    for (const space of this.spaces.getSnapshot().spaces)
      for (const identity of space.documentIds)
        if (!library.documents.some((entry) => entry.id === identity))
          throw Error("A space references an unavailable document.");
    const assigned = new Set(
      this.spaces.getSnapshot().spaces.flatMap((space) => space.documentIds),
    );
    const storedIdentities = new Set(
      z
        .object({
          documents: z
            .array(z.object({ id: z.string().uuid() }).passthrough())
            .default([]),
        })
        .passthrough()
        .parse(bootstrap.library ?? {})
        .documents.map((entry) => entry.id),
    );
    const recovered = library.documents.filter(
      (entry) => !entry.trash && !assigned.has(entry.id) && !storedIdentities.has(entry.id),
    );
    if (recovered.length) {
      const space = this.spaces.space(this.spaces.getSnapshot().defaultSpaceId);
      this.spaces.update(space.id, {
        ...space,
        documentIds: [
          ...space.documentIds,
          ...recovered.map((entry) => entry.id),
        ],
      });
    }
    await hostWindow.listen<{ id: string; windowId: string; request: unknown }>(
      "inknb-host-request",
      (event) => {
        const request = hostRequestSchema.safeParse(event.payload.request);
        const execute = () => {
          if (!request.success) throw request.error;
          return this.request(event.payload.windowId, request.data);
        };
        const interactive =
          request.success && ["open-aside", "open-document"].includes(request.data.kind);
        const operation = interactive
          ? Promise.resolve().then(execute)
          : this.operations.catch(() => undefined).then(execute);
        if (!interactive) this.operations = operation;
        void operation.then(
          (result) =>
            invoke("complete_control", {
              requestId: event.payload.id,
              result: result ?? null,
              error: null,
            }),
          (error) =>
            invoke("complete_control", {
              requestId: event.payload.id,
              result: null,
              error: String(error),
            }),
        );
      },
    );
    await hostWindow.listen<{ id: string; method: string; params: unknown; agentId?: string }>(
      "inknb-control",
      (event) => {
        const interactive = [
          "library_list",
          "ui_state",
          "ui_inspect",
          "ui_action",
          "editor_select",
          "document_activate",
          "page_open",
          "window_resize",
          "window_flush",
          "document_delete",
          "aside_open",
        ].includes(event.payload.method);
        const operation = interactive
          ? this.control(event.payload.method, event.payload.params, event.payload.agentId)
          : this.operations
              .catch(() => undefined)
              .then(() =>
                this.control(event.payload.method, event.payload.params, event.payload.agentId),
              );
        if (!interactive) this.operations = operation;
        void operation.then(
          (result) =>
            invoke("complete_control", {
              requestId: event.payload.id,
              result: result ?? null,
              error: null,
            }),
          (error) =>
            invoke("complete_control", {
              requestId: event.payload.id,
              result: null,
              error: String(error),
            }),
        );
      },
    );
    await hostWindow.listen("inknb-configuration", (event) =>
      this.documents.configure(event.payload),
    );
    await hostWindow.listen<string>("inknb-open", (event) => {
      void this.openPath(event.payload).catch((error) =>
        this.documents.fail(error),
      );
    });
    await hostWindow.listen<string | null>("inknb-activity-target", (event) => {
      const documentId = event.payload?.split(":")[0];
      const spaces = this.spaces.getSnapshot();
      const previous = spaces.windows.find(
        (window) => window.id === spaces.lastWindowId,
      );
      const current = spaces.spaces.find(
        (space) =>
          space.id === previous?.spaceId &&
          (!documentId || space.documentIds.includes(documentId)),
      );
      const space =
        current ??
        spaces.spaces.find(
          (space) => documentId && space.documentIds.includes(documentId),
        ) ??
        this.spaces.space(spaces.defaultSpaceId);
      const window = this.spaces.open(space.id, false);
      this.activityTargets.set(window.id, event.payload ?? "");
      void this.open(window)
        .then(() => invoke("host_changed"))
        .catch((error) => this.documents.fail(error));
    });
    await hostWindow.listen<string>("inknb-space-focused", (event) => {
      this.spaces.focus(event.payload);
    });
    await hostWindow.listen("inknb-open-default", () => {
      const window = this.spaces.open(
        this.spaces.getSnapshot().defaultSpaceId,
        false,
      );
      void this.open(window);
    });
    await hostWindow.listen<{ documentId: string | null; action: unknown }>(
      "inknb-preview-action",
      (event) => this.documents.previewAction(event.payload),
    );
    await hostWindow.listen("inknb-quit", () => {
      const operation = this.operations
        .catch(() => undefined)
        .then(() => this.request("host", { kind: "quit" }));
      this.operations = operation;
      void operation.catch((error) => this.documents.fail(error));
    });
    this.documents.subscribe(() => {
      if (this.ready) void invoke("host_changed");
    });
    for (const session of this.documents.sessions.values())
      session.subscribe(() => {
        if (this.ready) void invoke("host_changed");
      });
    this.ready = true;
    await this.persist();
    await invoke("host_lifecycle", {
      status: { phase: "ready", message: null },
    });
    const windows = this.spaces
      .getSnapshot()
      .windows.filter((window) => window.open);
    if (!windows.length)
      windows.push(
        this.spaces.open(this.spaces.getSnapshot().defaultSpaceId, false),
      );
    for (const window of windows) await this.open(window);
    if (bootstrap.requestedPath) await this.openPath(bootstrap.requestedPath);
    setInterval(() => {
      for (const session of this.documents.sessions.values())
        if (!this.documents.getSnapshot().documents.find(entry => entry.id === session.getSnapshot().metadata.documentId)?.trash) void session.checkFiles();
    }, 1800);
  }

  private async persist(): Promise<void> {
    this.documents.update({ spaces: this.spaces.getSnapshot() });
    await this.documents.persist();
  }

  private async open(window: SpaceWindow): Promise<void> {
    await invoke("space_window_open", {
      identity: window.id,
      title: this.spaces.space(window.spaceId).title,
      bounds: window.bounds,
    });
  }

  private async openPath(path: string): Promise<void> {
    const documentId = parseDocumentLink(path);
    if (documentId) {
      await this.control("document_activate", { documentId });
      return;
    }
    const reference = parseAsideLink(path);
    if (reference) return this.openAside(reference);
    const result = z
      .object({ documentId: z.string().uuid() })
      .passthrough()
      .parse(
        await this.library(
          this.spaces.getSnapshot().defaultSpaceId,
          "document_open",
          { path },
        ),
      );
    await this.control("document_activate", { documentId: result.documentId });
  }

  private async openAside(reference: AsideReference): Promise<void> {
    this.documents.readAside(reference);
    await this.control("aside_open", reference);
  }

  private async snapshot(
    windowId: string,
    versions: Extract<HostRequest, { kind: "snapshot" }>["versions"],
  ): Promise<HostSnapshot> {
    const window = this.spaces.window(windowId);
    const space = this.spaces.space(window.spaceId);
    const documents: Record<string, DocumentExchange> = {};
    const identities = [
      ...new Set([
        ...space.documentIds,
        ...Object.entries(versions)
          .filter(
            ([identity, version]) =>
              version.pending && window.documents[identity],
          )
          .map(([identity]) => identity),
      ]),
    ];
    for (const identity of identities) {
      const session = this.documents.sessions.get(identity);
      if (!session?.model) continue;
      await session.recover();
      const model = session.model;
      const previous = versions[identity];
      const reset = !previous || previous.epoch !== model.epoch;
      if (
        !reset &&
        previous.publication === session.publication &&
        previous.version === model.steps.length
      )
        continue;
      if (!reset && previous.version > model.steps.length)
        throw Error("The window document version is ahead of the host.");
      const changes = reset ? [] : model.steps.slice(previous.version);
      documents[identity] = {
        state: session.getSnapshot(),
        publication: session.publication,
        epoch: model.epoch,
        version: model.steps.length,
        steps: changes.map((change) => change.step),
        clients: changes.map((change) => change.clientId),
        reset,
      };
    }
    const library = this.documents.getSnapshot();
    const folders = new Set<string>();
    for (const entry of library.documents.filter((entry) =>
      space.documentIds.includes(entry.id),
    )) {
      let parent = entry.parentId;
      while (parent && !folders.has(parent)) {
        folders.add(parent);
        parent =
          library.collections.find((collection) => collection.id === parent)
            ?.parentId ?? null;
      }
    }
    const activityKey = this.activityTargets.get(windowId) ?? null;
    this.activityTargets.delete(windowId);
    return {
      spaces: {
        ...this.spaces.getSnapshot(),
        windows: this.spaces
          .getSnapshot()
          .windows.map((candidate) =>
            candidate.id === windowId
              ? candidate
              : { ...candidate, documents: {} },
          ),
      },
      windowId,
      activityKey,
      preferences: this.documents.sessions.values().next().value!.getSnapshot()
        .preferences,
      profile: this.documents.sessions.values().next().value!.getSnapshot()
        .profile,
      documents,
      library: {
        documents: library.documents
          .filter((entry) => space.documentIds.includes(entry.id))
          .map((entry) => ({
            ...entry,
            pinned: space.pinnedIds.includes(entry.id),
          })),
        collections: library.collections.filter((entry) =>
          folders.has(entry.id),
        ),
        error: library.error,
      },
    };
  }

  private async request(
    windowId: string,
    request: HostRequest,
  ): Promise<unknown> {
    if (request.kind === "quit") {
      for (const session of this.documents.sessions.values())
        await session.recover();
      await this.persist();
      await invoke("host_quit");
      return null;
    }
    const window = this.spaces.window(windowId);
    if (request.kind === "open-aside") {
      await this.openAside(request.reference);
      return null;
    }
    if (request.kind === "open-document") {
      return this.control("document_activate", { documentId: request.documentId });
    }
    if (request.kind === "snapshot")
      return this.snapshot(windowId, request.versions);
    if (request.kind === "window") {
      this.spaces.updateWindow(windowId, {
        ...request.patch,
        ...(request.patch.documents
          ? { documents: { ...window.documents, ...request.patch.documents } }
          : {}),
      });
      await this.persist();
      return null;
    }
    if (request.kind === "spaces")
      return {
        spaces: this.spaces.getSnapshot(),
        documents: this.documents.getSnapshot().documents.filter(entry => !entry.trash),
      };
    if (request.kind === "create-space" || request.kind === "update-space") {
      for (const identity of request.documentIds)
        if (!this.documents.getSnapshot().documents.some(entry => entry.id === identity && !entry.trash))
          throw Error("This document is unavailable.");
      const space =
        request.kind === "create-space"
          ? this.spaces.create(
              request.title,
              request.documentIds,
              request.homeId,
            )
          : this.spaces.update(request.spaceId, request);
      await this.persist();
      await invoke("host_changed");
      return space;
    }
    if (request.kind === "open-space") {
      const opened = this.spaces.open(request.spaceId, request.newWindow);
      await this.persist();
      await this.open(opened);
      return opened;
    }
    if (request.kind === "close-window") {
      this.spaces.updateWindow(windowId, { open: false });
      await this.persist();
      return null;
    }
    if (request.kind === "pin") {
      this.spaces.pin(window.spaceId, request.documentId, request.pinned);
      await this.persist();
      await invoke("host_changed");
      return null;
    }
    if (request.kind === "library") {
      const result = await this.library(
        window.spaceId,
        request.method,
        request.parameters,
      );
      if (
        request.method === "document_create" ||
        request.method === "document_open"
      ) {
        const identity = z
          .object({ documentId: z.string().uuid() })
          .passthrough()
          .parse(result).documentId;
        this.spaces.updateWindow(windowId, { activeId: identity });
        await this.persist();
      }
      await invoke("host_changed");
      return result;
    }

    const space = this.spaces.space(window.spaceId);
    if (
      !space.documentIds.includes(request.documentId) &&
      !(request.kind === "steps" && window.documents[request.documentId])
    )
      throw Error("This document is outside the window's space.");
    const session = this.documents.sessions.get(request.documentId);
    if (!session?.model) throw Error("The document model is unavailable.");
    if (request.kind !== "steps" && this.documents.getSnapshot().documents.find(entry => entry.id === request.documentId)?.trash) throw Error("This document is in Trash. Use document_restore first.");
    if (request.kind === "resource") return this.resources(request.documentId, request.action);
    let result: unknown = null;
    if (request.kind === "document") {
      if (request.method === "preview_open") {
        await this.documents.detachPreview(request.documentId);
        return null;
      }
      if (request.method === "preview_close") {
        await this.documents.closePreview();
        return null;
      }
      result = await session.control(request.method, request.parameters);
    }
    if (request.kind === "binding")
      result = await session.transact(async () => {
        await session.bind(request.binding, request.documentId);
        return null;
      });
    if (request.kind === "aside")
      result = await session.asideAction(request.action, {
        ...request.view,
        revision: request.revision,
      });
    if (request.kind === "permission")
      result = await session.transact(async () => {
        session.changed({
          ...session.getWorkingSnapshot().metadata,
          agentAccess: request.permission,
        });
        return null;
      });
    if (request.kind === "steps")
      result = await session.transact(async () => {
        const model = session.model!;
        if (
          model.epoch !== request.epoch ||
          model.steps.length !== request.version
        )
          return { accepted: false };
        const transaction = model.state.tr.setMeta("clientId", windowId);
        for (const step of request.steps)
          transaction.step(Step.fromJSON(model.state.schema, step));
        transaction.setSelection(
          Selection.fromJSON(transaction.doc, request.selection),
        );
        if (model.steps.at(-1)?.clientId !== windowId)
          closeHistory(transaction);
        model.commit(transaction);
        return { accepted: true };
      });
    if (request.kind === "move-node")
      result = await session.transact(async () => {
        if (session.getWorkingSnapshot().metadata.revision !== request.revision)
          throw Error("The document changed before the move. Move the card again.");
        session.model!.applyAtomic(session.model!.moveTransaction(request.identity, request.parentIdentity, request.beforeIdentity));
        return { moved: true };
      });
    if (request.kind === "insert-note")
      result = await session.transact(async () => {
        if (session.getWorkingSnapshot().metadata.revision !== request.revision)
          throw Error("The document changed before adding the note. Add it again.");
        const model = session.model!;
        const parent = model.node(request.parentIdentity);
        const textIdentity = crypto.randomUUID();
        const paragraph = nativeSchema.nodes.paragraph.create({ identity: textIdentity });
        const note = parent.node.canReplaceWith(parent.node.childCount, parent.node.childCount, paragraph.type)
          ? paragraph
          : nativeSchema.nodes.list_item.createChecked({ identity: crypto.randomUUID() }, paragraph);
        if (!parent.node.canReplaceWith(parent.node.childCount, parent.node.childCount, note.type))
          throw Error("This container cannot contain notes.");
        model.applyAtomic(model.state.tr.insert(parent.position + 1 + parent.node.content.size, note));
        return { identity: note.attrs.identity, textIdentity };
      });
    if (request.kind === "undo" || request.kind === "redo")
      result = await session.transact(async () => {
        session.model![request.kind]();
        return null;
      });
    await invoke("host_changed");
    return result;
  }

  private async resources(documentId: string, action: ResourceAction): Promise<ResourceState> {
    const session = this.documents.sessions.get(documentId);
    if (!session) throw Error("This document is outside the library.");
    if (this.documents.getSnapshot().documents.find(entry => entry.id === documentId)?.trash) throw Error("This document is in Trash. Use document_restore first.");
    if (action.kind !== "read") {
      await session.transact(async () => {
        const metadata = session.getWorkingSnapshot().metadata;
        let resources = metadata.resources.filter((resource) => resource.id !== action.id);
        if (action.kind === "attach") {
          if (action.target.kind === "document" && !this.documents.getSnapshot().documents.some(entry => action.target.kind === "document" && entry.id === action.target.documentId && !entry.trash))
            throw Error("The linked document is outside the library.");
          const resource = linkedResourceSchema.parse(action);
          const previous = metadata.resources.find((candidate) => candidate.id === action.id);
          if (previous && JSON.stringify(previous) !== JSON.stringify(resource))
            throw Error("This resource identity already has another target or label.");
          if (previous) return null;
          resources = [...resources, resource];
        }
        session.changed({ ...metadata, version: 14, resources });
        return null;
      });
      await invoke("host_changed");
    }
    const items = session.getSnapshot().metadata.resources.map((resource) => {
      const target = resource.target;
      const title = resource.label ?? (target.kind === "document"
        ? this.documents.documentTitle(target.documentId)
        : target.kind === "file" ? target.path.split("/").at(-1)! : new URL(target.url).hostname);
      return { ...resource, title };
    });
    const backlinks = [...this.documents.sessions].filter(([identity]) => !this.documents.getSnapshot().documents.find(entry => entry.id === identity)?.trash).flatMap(([identity, source]) =>
      source.getSnapshot().metadata.resources.some((resource) => resource.target.kind === "document" && resource.target.documentId === documentId)
        ? [{ documentId: identity, title: this.documents.documentTitle(identity) }] : [],
    );
    return { documentId, items, backlinks };
  }

  private async library(
    spaceId: string,
    method: string,
    parameters: Record<string, unknown>,
  ): Promise<unknown> {
    const space = this.spaces.space(spaceId);
    const result = await this.documents.control(method, parameters);
    if (method === "document_create" || method === "document_open") {
      const identity = z
        .object({ documentId: z.string().uuid() })
        .passthrough()
        .parse(result).documentId;
      this.spaces.update(space.id, {
        ...space,
        documentIds: [...new Set([...space.documentIds, identity])],
      });
    }
    await this.persist();
    await invoke("host_changed");
    return result;
  }

  private async control(method: string, parameters: unknown, agentId?: string): Promise<unknown> {
    if (method === "application_quit")
      return this.request("host", { kind: "quit" });
    const values = z.record(z.string(), z.unknown()).parse(parameters);
    const {
      windowId: requestedWindow,
      spaceId: requestedSpace,
      ...source
    } = values;
    let windowId =
      z.string().uuid().optional().parse(requestedWindow) ??
      this.spaces
        .getSnapshot()
        .windows.find(
          (window) =>
            window.id === this.spaces.getSnapshot().lastWindowId && window.open,
        )?.id ??
      this.spaces.getSnapshot().windows.find((window) => window.open)?.id ??
      this.spaces.getSnapshot().lastWindowId ??
      this.spaces.getSnapshot().windows[0]?.id;
    if (!windowId) throw Error("Open a space window first.");
    if (method === "document_trash_list") {
      z.object({}).strict().parse(source);
      return { documents: this.documents.getSnapshot().documents.filter(entry => entry.trash).map(entry => ({ documentId: entry.id, title: entry.title, path: entry.path, deletionId: entry.trash!.deletionId, deletedAt: entry.trash!.deletedAt })) };
    }
    if (method === "document_delete") {
      const parsed = z.object({ documentId: z.string().uuid(), revision: z.number().int().nonnegative(), textHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict().parse(source);
      const entry = this.documents.getSnapshot().documents.find(entry => entry.id === parsed.documentId);
      const session = this.documents.sessions.get(parsed.documentId);
      if (!entry || !session) throw Error("This document is outside the library.");
      if (entry.trash) {
        if (entry.trash.revision !== parsed.revision || entry.trash.textHash !== parsed.textHash) throw Error("This document is already in Trash. Read document_trash_list.");
        return { documentId: entry.id, deletionId: entry.trash.deletionId, deletedAt: entry.trash.deletedAt };
      }
      await session.control("document_delete", parsed, agentId);
      for (const window of this.spaces.getSnapshot().windows.filter(window => window.open && window.documents[parsed.documentId]))
        await invoke("space_window_control", { identity: window.id, method: "window_flush", parameters: {} });
      const operation = this.operations.catch(() => undefined).then(async () => {
        await session.control("document_delete", parsed, agentId);
        const current = this.documents.getSnapshot();
        const existing = current.documents.find(entry => entry.id === parsed.documentId)!;
        if (existing.trash) return { documentId: existing.id, deletionId: existing.trash.deletionId, deletedAt: existing.trash.deletedAt };
        const trash = {
          deletionId: crypto.randomUUID(), deletedAt: new Date().toISOString(), revision: parsed.revision, textHash: parsed.textHash,
          memberships: this.spaces.getSnapshot().spaces.filter(space => space.documentIds.includes(entry.id)).map(space => ({ spaceId: space.id, pinned: space.pinnedIds.includes(entry.id) })),
        };
        if (session.getSnapshot().previewHost === "detached") await this.documents.closePreview();
        for (const space of this.spaces.getSnapshot().spaces.filter(space => space.documentIds.includes(entry.id))) {
          const documentIds = space.documentIds.filter(identity => identity !== entry.id);
          this.spaces.update(space.id, { ...space, documentIds, homeId: space.homeId === entry.id ? documentIds[0] ?? null : space.homeId });
        }
        this.documents.update({ documents: current.documents.map(candidate => candidate.id === entry.id ? { ...candidate, trash } : candidate), activeId: current.activeId === entry.id ? current.documents.find(candidate => candidate.id !== entry.id && !candidate.trash)?.id ?? null : current.activeId });
        await this.persist();
        await invoke("host_changed");
        return { documentId: entry.id, deletionId: trash.deletionId, deletedAt: trash.deletedAt };
      });
      this.operations = operation;
      return operation;
    }
    if (method === "document_restore") {
      const parsed = z.object({ documentId: z.string().uuid(), deletionId: z.string().uuid() }).strict().parse(source);
      const current = this.documents.getSnapshot();
      const entry = current.documents.find(entry => entry.id === parsed.documentId);
      if (!entry?.trash || entry.trash.deletionId !== parsed.deletionId) throw Error("The Trash entry changed. Read document_trash_list before restoring it.");
      if (!this.documents.sessions.get(entry.id)?.getSnapshot().ready) throw Error("The document source is unavailable. Keep it in Trash until its source is recovered.");
      const memberships = entry.trash.memberships.filter(membership => this.spaces.getSnapshot().spaces.some(space => space.id === membership.spaceId));
      if (!memberships.length) memberships.push({ spaceId: this.spaces.getSnapshot().defaultSpaceId, pinned: false });
      for (const membership of memberships) {
        const space = this.spaces.space(membership.spaceId);
        this.spaces.update(space.id, { ...space, documentIds: [...space.documentIds, entry.id], homeId: space.homeId ?? entry.id });
        if (membership.pinned) this.spaces.pin(space.id, entry.id, true);
      }
      this.documents.update({ documents: current.documents.map(candidate => candidate.id === entry.id ? { ...candidate, trash: undefined } : candidate) });
      await this.persist();
      await invoke("host_changed");
      return { documentId: entry.id, restored: true };
    }
    if (method === "decisions_list" && !source.documentId) {
      z.object({}).strict().parse(source);
      const space = this.spaces.getSnapshot().spaces.find((space) => space.id === (requestedSpace ?? this.spaces.window(windowId).spaceId));
      if (!space) throw Error("This space is unavailable.");
      return space.documentIds.flatMap((documentId) => {
        const document = this.documents.getSnapshot().documents.find((document) => document.id === documentId);
        return (this.documents.sessions.get(documentId)?.getSnapshot().metadata.decisions ?? []).map((decision) => ({ documentId, title: document?.title, decision }));
      }).sort((first, second) => second.decision.createdAt.localeCompare(first.decision.createdAt));
    }
    if (method === "requests_list" && source.allConnected === true) {
      z.object({ allConnected: z.literal(true) }).strict().parse(source);
      if (!agentId) throw Error("Identify the connected caller first.");
      return [...this.documents.sessions.values()].filter(session => !this.documents.getSnapshot().documents.find(entry => entry.id === session.getSnapshot().metadata.documentId)?.trash).flatMap((session) => {
        const metadata = session.getSnapshot().metadata;
        return metadata.requests.filter((request) => request.state !== "answered" && request.binding && `${request.binding.provider}:${request.binding.sessionId}` === agentId).map((request) => ({ ...request, documentId: metadata.documentId, thread: metadata.threads.find((thread) => thread.id === request.threadId), annotation: metadata.annotations.find(annotation => request.trigger.kind === "annotation" && annotation.id === request.trigger.annotationId), permission: session.agentAccess }));
      });
    }
    if (method === "spaces_read")
      return {
        spaces: this.spaces.getSnapshot(),
        documents: this.documents.getSnapshot().documents.filter(entry => !entry.trash),
      };
    if (["resources_read", "resource_attach", "resource_remove"].includes(method)) {
      const parsed = z.object({ documentId: z.string().uuid() }).passthrough().parse(source);
      const { documentId, ...parameters } = parsed;
      return this.resources(documentId, resourceActionSchema.parse({ ...parameters, kind: method === "resources_read" ? "read" : method === "resource_attach" ? "attach" : "remove" }));
    }
    if (method === "space_create")
      return this.request(
        windowId,
        hostRequestSchema.parse({ kind: "create-space", ...source }),
      );
    if (method === "space_update")
      return this.request(
        windowId,
        hostRequestSchema.parse({
          kind: "update-space",
          spaceId: requestedSpace,
          ...source,
        }),
      );
    if (method === "space_open")
      return this.request(
        windowId,
        hostRequestSchema.parse({
          kind: "open-space",
          spaceId: requestedSpace,
          newWindow: false,
          ...source,
        }),
      );
    if (
      [
        "ui_state",
        "ui_inspect",
        "ui_action",
        "editor_select",
        "document_activate",
        "page_open",
        "window_resize",
        "window_flush",
        "aside_open",
      ].includes(method) ||
      (method === "library_list" && requestedWindow)
    ) {
      const documentId = z.string().uuid().nullish().parse(source.documentId);
      if (documentId && this.documents.getSnapshot().documents.find(entry => entry.id === documentId)?.trash) throw Error("This document is in Trash. Use document_restore first.");
      if (
        documentId &&
        !this.spaces
          .space(this.spaces.window(windowId).spaceId)
          .documentIds.includes(documentId)
      ) {
        if (requestedWindow)
          throw Error("This document is outside the requested space.");
        const space = this.spaces
          .getSnapshot()
          .spaces.find((space) => space.documentIds.includes(documentId));
        if (!space)
          throw Error("Add this document to a space before opening it.");
        const window = this.spaces.open(space.id, false);
        windowId = window.id;
        await this.open(window);
      }
      const target = this.spaces.window(windowId);
      if (!target.open) {
        if (requestedWindow) throw Error("This writing window is closed.");
        const opened = this.spaces.open(target.spaceId, false);
        windowId = opened.id;
        await this.open(opened);
      }
      return invoke("space_window_control", {
        identity: windowId,
        method,
        parameters: source,
      });
    }
    if (method === "document_create" || method === "document_open") {
      const spaceId =
        z.string().uuid().optional().parse(requestedSpace) ??
        this.spaces.getSnapshot().defaultSpaceId;
      return this.library(spaceId, method, source);
    }
    if (method === "library_update" && source.pinned !== undefined) {
      const documentId = z.string().uuid().parse(source.documentId);
      this.spaces.pin(
        this.spaces.window(windowId).spaceId,
        documentId,
        z.boolean().parse(source.pinned),
      );
      delete source.pinned;
    }
    const routing = [
      "documentId",
      "requestId",
      "decisionId",
      "threadId",
      "componentId",
      "messageId",
    ].some((key) => source[key] !== undefined);
    if (
      !routing &&
      ![
        "library_list",
        "collection_create",
        "collection_update",
        "library_organize",
        "library_reorder",
      ].includes(method)
    ) {
      const activeId = this.spaces.window(windowId).activeId;
      if (activeId) source.documentId = activeId;
    }
    const result = await this.documents.control(method, source, agentId);
    await this.persist();
    await invoke("host_changed");
    return result;
  }
}
export const appHost = new AppHost();
