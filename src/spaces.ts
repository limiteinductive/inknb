import { z } from "zod";
import { anchorSchema, selectionSchema } from "./domain";
import { draftSchema } from "./images";
import { previewAnchorSchema } from "./preview-model";
import { pageDraftSchema } from "./document-page";

export const asideReaderSchema = z.object({
  scrollTop: z.number().nonnegative().default(0),
});

export const documentViewSchema = z.object({
  selection: selectionSchema.default({ from: 0, to: 0 }),
  scrollTop: z.number().nonnegative().default(0),
  activeThread: z.string().uuid().nullable().default(null),
  asidesOpen: z.boolean().default(true),
  asideReader: asideReaderSchema.prefault({}),
  threadExpansions: z.record(z.string().uuid(), z.boolean()).default({}),
  composer: z.boolean().default(false),
  drafts: z.record(z.string(), draftSchema).default({}),
  composerAnchor: anchorSchema.nullable().default(null),
  composerPreviewAnchor: previewAnchorSchema.nullable().default(null),
  composerTop: z.number().nonnegative().nullable().default(null),
  outlineOpen: z.boolean().nullable().default(null),
  reviewOpen: z.boolean().default(false),
  reviewEarlier: z.boolean().default(false),
  reviewProposalId: z.string().uuid().nullable().default(null),
  pageVisible: z.boolean().default(false),
  pageDrafts: z.record(z.string().uuid(), pageDraftSchema).default({}),
  focus: z.boolean().default(false),
  pendingSource: z
    .object({
      baseText: z.string(),
      text: z.string(),
      steps: z.array(z.unknown()),
      selection: z.unknown(),
    })
    .nullable()
    .default(null),
});
export const navigationLocationSchema = z.object({
  documentId: z.string().uuid(),
  anchor: anchorSchema,
  threadId: z.string().nullable(),
  composer: z.boolean().default(false),
  scrollTop: z.number().nonnegative(),
});
export const spaceSchema = z.object({
  id: z.string().uuid(),
  title: z.string().trim().min(1),
  documentIds: z.array(z.string().uuid()),
  pinnedIds: z.array(z.string().uuid()),
  homeId: z.string().uuid().nullable(),
});
export const spaceWindowSchema = z.object({
  id: z.string().uuid(),
  spaceId: z.string().uuid(),
  activeId: z.string().uuid().nullable(),
  documents: z.record(z.string().uuid(), documentViewSchema),
  collapsedIds: z.array(z.string().uuid()),
  sidebarOpen: z.boolean(),
  sidebarWidth: z.number().finite().min(200).max(480),
  asideWidth: z.number().finite().min(280),
  previewWidth: z.number().finite().min(280).nullable(),
  history: z.array(navigationLocationSchema),
  historyIndex: z.number().int().min(-1),
  bounds: z.object({
    left: z.number().finite().nullable(),
    top: z.number().finite().nullable(),
    width: z.number().finite().min(700),
    height: z.number().finite().min(480),
  }),
  open: z.boolean(),
});
export const spacesSchema = z.object({
  version: z.literal(1),
  spaces: z.array(spaceSchema),
  defaultSpaceId: z.string().uuid(),
  windows: z.array(spaceWindowSchema),
  lastWindowId: z.string().uuid().nullable(),
});
export type DocumentViewState = z.infer<typeof documentViewSchema>;
export type Space = z.infer<typeof spaceSchema>;
export type SpaceWindow = z.infer<typeof spaceWindowSchema>;
export type SpacesState = z.infer<typeof spacesSchema>;

export class Spaces {
  private state: SpacesState;

  constructor(
    state: unknown,
    readonly changed: (state: SpacesState) => void,
  ) {
    this.state = spacesSchema.parse(state);
    const identities = new Set<string>();
    for (const space of this.state.spaces) {
      if (identities.has(space.id))
        throw Error("A space identity is repeated.");
      identities.add(space.id);
      if (space.documentIds.length !== new Set(space.documentIds).size)
        throw Error("A document is repeated in this space.");
      if (
        space.pinnedIds.some(
          (identity) => !space.documentIds.includes(identity),
        )
      )
        throw Error("A pinned document must belong to its space.");
      if (space.homeId && !space.documentIds.includes(space.homeId))
        throw Error("The home document must belong to its space.");
    }
    this.space(this.state.defaultSpaceId);
    const windows = new Set<string>();
    for (const window of this.state.windows) {
      if (windows.has(window.id)) throw Error("A window identity is repeated.");
      windows.add(window.id);
      const space = this.space(window.spaceId);
      window.documents = {
        ...Object.fromEntries(
          space.documentIds.map((identity) => [
            identity,
            documentViewSchema.parse({}),
          ]),
        ),
        ...window.documents,
      };
      if (window.activeId && !space.documentIds.includes(window.activeId))
        throw Error("The active document must belong to its window's space.");
      if (
        window.history.some(
          (location) => !space.documentIds.includes(location.documentId),
        )
      )
        throw Error("Navigation cannot leave its window's space.");
      if (window.historyIndex >= window.history.length)
        throw Error("The navigation position is outside its window history.");
    }
    if (this.state.lastWindowId && !windows.has(this.state.lastWindowId))
      throw Error("The last window is unavailable.");
  }

  getSnapshot = (): SpacesState => this.state;

  space(identity: string): Space {
    const space = this.state.spaces.find((space) => space.id === identity);
    if (!space) throw Error("This space is unavailable.");
    return space;
  }

  window(identity: string): SpaceWindow {
    const window = this.state.windows.find((window) => window.id === identity);
    if (!window) throw Error("This space window is unavailable.");
    return window;
  }

  create(title: string, documentIds: string[], homeId: string | null): Space {
    const space = spaceSchema.parse({
      id: crypto.randomUUID(),
      title,
      documentIds: [...new Set(documentIds)],
      pinnedIds: [],
      homeId,
    });
    if (space.homeId && !space.documentIds.includes(space.homeId))
      throw Error("The home document must belong to its space.");
    this.state = { ...this.state, spaces: [...this.state.spaces, space] };
    this.changed(this.state);
    return space;
  }

  update(
    identity: string,
    patch: Pick<Space, "title" | "documentIds" | "homeId">,
  ): Space {
    const previous = this.space(identity);
    const documentIds = [...new Set(patch.documentIds)];
    const space = spaceSchema.parse({
      ...previous,
      ...patch,
      documentIds,
      pinnedIds: previous.pinnedIds.filter((identity) =>
        documentIds.includes(identity),
      ),
    });
    if (space.homeId && !space.documentIds.includes(space.homeId))
      throw Error("The home document must belong to its space.");
    this.state = {
      ...this.state,
      spaces: this.state.spaces.map((candidate) =>
        candidate.id === identity ? space : candidate,
      ),
      windows: this.state.windows.map((window) => {
        if (window.spaceId !== identity) return window;
        return {
          ...window,
          documents: {
            ...Object.fromEntries(
              documentIds.map((identity) => [
                identity,
                documentViewSchema.parse({}),
              ]),
            ),
            ...window.documents,
          },
          activeId:
            window.activeId && documentIds.includes(window.activeId)
              ? window.activeId
              : (space.homeId ?? documentIds[0] ?? null),
          history: window.history.filter((location) =>
            documentIds.includes(location.documentId),
          ),
          historyIndex:
            window.history
              .slice(0, window.historyIndex + 1)
              .filter((location) => documentIds.includes(location.documentId))
              .length - 1,
        };
      }),
    };
    this.changed(this.state);
    return space;
  }

  pin(spaceId: string, documentId: string, pinned: boolean): void {
    const space = this.space(spaceId);
    if (!space.documentIds.includes(documentId))
      throw Error("This document is outside the space.");
    this.state = {
      ...this.state,
      spaces: this.state.spaces.map((candidate) =>
        candidate.id !== spaceId
          ? candidate
          : {
              ...candidate,
              pinnedIds: pinned
                ? [...new Set([...candidate.pinnedIds, documentId])]
                : candidate.pinnedIds.filter(
                    (identity) => identity !== documentId,
                  ),
            },
      ),
    };
    this.changed(this.state);
  }

  open(spaceId: string, newWindow: boolean): SpaceWindow {
    const space = this.space(spaceId);
    const previous = newWindow
      ? undefined
      : (this.state.windows.find(
          (window) => window.spaceId === spaceId && window.open,
        ) ?? this.state.windows.find((window) => window.spaceId === spaceId));
    const window: SpaceWindow = previous
      ? { ...previous, open: true }
      : {
          id: crypto.randomUUID(),
          spaceId,
          activeId: space.homeId ?? space.documentIds[0] ?? null,
          documents: Object.fromEntries(
            space.documentIds.map((identity) => [
              identity,
              documentViewSchema.parse({}),
            ]),
          ),
          collapsedIds: [],
          sidebarOpen: true,
          sidebarWidth: 232,
          asideWidth: 400,
          previewWidth: null,
          history: [],
          historyIndex: -1,
          bounds: { left: null, top: null, width: 1180, height: 820 },
          open: true,
        };
    this.state = {
      ...this.state,
      windows: [
        ...this.state.windows.filter((candidate) => candidate.id !== window.id),
        window,
      ],
      lastWindowId: window.id,
    };
    this.focus(window.id);
    return window;
  }

  focus(identity: string): void {
    this.window(identity);
    this.state = { ...this.state, lastWindowId: identity };
    this.changed(this.state);
  }

  updateWindow(
    identity: string,
    patch: Partial<Omit<SpaceWindow, "id" | "spaceId">>,
  ): void {
    const previous = this.window(identity);
    const window = spaceWindowSchema.parse({ ...previous, ...patch });
    const space = this.space(window.spaceId);
    if (window.activeId && !space.documentIds.includes(window.activeId))
      throw Error("The active document must belong to its window's space.");
    if (
      window.history.some(
        (location) => !space.documentIds.includes(location.documentId),
      )
    )
      throw Error("Navigation cannot leave its window's space.");
    if (window.historyIndex >= window.history.length)
      throw Error("The navigation position is outside its window history.");
    this.state = {
      ...this.state,
      windows: this.state.windows.map((candidate) =>
        candidate.id === identity ? window : candidate,
      ),
    };
    this.changed(this.state);
  }
}
