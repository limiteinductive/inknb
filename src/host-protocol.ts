import { z } from "zod";
import type { Preferences } from "./domain";
import type { SessionState } from "./session";
import type { LibraryEntry, LibraryNode } from "./workspace";
import { spaceWindowSchema } from "./spaces";
import type { SpacesState } from "./spaces";
import { bindingSchema, asideReferenceSchema } from "./domain";
import { asideActionSchema } from "./aside-actions";
import { documentViewSchema } from "./spaces";
import { resourceActionSchema } from "./resources";

export const hostRequestSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("acknowledge"),
    versions: z.record(z.string().uuid(), z.object({
      epoch: z.string().uuid(),
      version: z.number().int().nonnegative(),
    })),
  }),
  z.object({
    kind: z.literal("snapshot"),
    versions: z.record(
      z.string().uuid(),
      z.object({
        epoch: z.string().uuid(),
        version: z.number().int().nonnegative(),
        publication: z.number().int().nonnegative(),
        pending: z.boolean(),
      }),
    ),
  }),
  z.object({
    kind: z.literal("window"),
    patch: spaceWindowSchema.omit({ id: true, spaceId: true }).partial(),
  }),
  z.object({ kind: z.literal("spaces") }),
  z.object({ kind: z.literal("open-aside"), reference: asideReferenceSchema }),
  z.object({ kind: z.literal("open-document"), documentId: z.string().uuid() }),
  z.object({ kind: z.literal("resource"), documentId: z.string().uuid(), action: resourceActionSchema }),
  z.object({ kind: z.literal("move-node"), documentId: z.string().uuid(), revision: z.number().int().nonnegative(), identity: z.string().uuid(), parentIdentity: z.string().uuid(), beforeIdentity: z.string().uuid().nullable() }),
  z.object({ kind: z.literal("insert-note"), documentId: z.string().uuid(), revision: z.number().int().nonnegative(), parentIdentity: z.string().uuid() }),
  z.object({
    kind: z.literal("create-space"),
    title: z.string().trim().min(1),
    documentIds: z.array(z.string().uuid()),
    homeId: z.string().uuid().nullable(),
  }),
  z.object({
    kind: z.literal("update-space"),
    spaceId: z.string().uuid(),
    title: z.string().trim().min(1),
    documentIds: z.array(z.string().uuid()),
    homeId: z.string().uuid().nullable(),
  }),
  z.object({
    kind: z.literal("open-space"),
    spaceId: z.string().uuid(),
    newWindow: z.boolean(),
  }),
  z.object({
    kind: z.literal("pin"),
    documentId: z.string().uuid(),
    pinned: z.boolean(),
  }),
  z.object({
    kind: z.literal("library"),
    method: z.string(),
    parameters: z.record(z.string(), z.unknown()),
  }),
  z.object({
    kind: z.literal("document"),
    documentId: z.string().uuid(),
    method: z.string(),
    parameters: z.record(z.string(), z.unknown()),
  }),
  z.object({
    kind: z.literal("aside"),
    documentId: z.string().uuid(),
    revision: z.number().int().nonnegative(),
    view: documentViewSchema,
    action: asideActionSchema,
  }),
  z.object({
    kind: z.literal("binding"),
    documentId: z.string().uuid(),
    binding: bindingSchema.nullable(),
  }),
  z.object({
    kind: z.literal("permission"),
    documentId: z.string().uuid(),
    permission: z.enum(["read", "edit"]).nullable(),
  }),
  z.object({
    kind: z.literal("steps"),
    documentId: z.string().uuid(),
    epoch: z.string().uuid(),
    version: z.number().int().nonnegative(),
    steps: z.array(z.unknown()).min(1),
    selection: z.unknown(),
  }),
  z.object({ kind: z.enum(["undo", "redo"]), documentId: z.string().uuid() }),
  z.object({ kind: z.literal("close-window") }),
  z.object({ kind: z.literal("quit") }),
]);
export type HostRequest = z.infer<typeof hostRequestSchema>;
export interface DocumentExchange {
  state: SessionState;
  publication: number;
  epoch: string;
  version: number;
  steps: unknown[];
  clients: string[];
  reset: boolean;
}
export interface HostSnapshot {
  spaces: SpacesState;
  windowId: string;
  activityKey: string | null;
  preferences: Preferences;
  profile: string | null;
  documents: Record<string, DocumentExchange>;
  library: {
    documents: LibraryEntry[];
    collections: LibraryNode[];
    error: string | null;
  };
}
