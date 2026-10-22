import { z } from "zod";
import { draftSchema } from "./images";
import { anchorSchema, selectionSchema, asideReferenceSchema } from "./domain";
import { previewAnchorSchema } from "./preview-model";

export const asideActionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("decision-answer"), decisionId: z.string().uuid(), option: z.number().int().nonnegative().nullable(), text: z.string() }),
  z.object({
    kind: z.literal("history-read"),
    before: z.number().int().positive().optional(),
  }),
  z.object({
    kind: z.literal("revision-read"),
    fromCursor: z.number().int().positive(),
    toCursor: z.number().int().positive(),
  }),
  z.object({ kind: z.literal("reference"), reference: asideReferenceSchema }),
  z.object({ kind: z.literal("aside-read"), reference: asideReferenceSchema }),
  z.object({ kind: z.literal("source"), threadId: z.string().uuid() }),
  z.object({
    kind: z.literal("focus"),
    threadId: z.string().uuid().nullable(),
  }),
  draftSchema.extend({ kind: z.literal("draft"), key: z.string() }),
  z.object({ kind: z.literal("annotation-send"), key: z.string() }),
  z.object({ kind: z.literal("annotation-commit"), key: z.string() }),
  z.object({ kind: z.literal("annotation-dismiss"), annotationId: z.string().uuid() }),
  z.object({
    kind: z.literal("composer"),
    composer: z.boolean(),
    composerAnchor: anchorSchema.nullable().optional(),
    composerPreviewAnchor: previewAnchorSchema.nullable().optional(),
  }),
  z.object({
    kind: z.literal("comment"),
    content: z.string(),
    threadId: z.string().uuid().optional(),
  }),
  z.object({ kind: z.literal("selection-comment"), anchor: anchorSchema }),
  z.object({
    kind: z.literal("read"),
    threadId: z.string().uuid(),
    activity: z.string(),
  }),
  z.object({
    kind: z.enum(["collapse", "select"]),
    threadId: z.string().uuid().nullable(),
  }),
  z.object({
    kind: z.literal("resolve"),
    threadId: z.string().uuid().nullable(),
    restoreFocus: z.boolean().optional(),
  }),
  z.object({ kind: z.literal("resolve-all") }),
  z.object({
    kind: z.literal("reanchor"),
    threadId: z.string().uuid(),
    selection: selectionSchema.optional(),
  }),
  z.object({ kind: z.literal("reveal"), anchor: previewAnchorSchema }),
  z.object({ kind: z.literal("toggle"), threadId: z.string().uuid() }),
  z.object({
    kind: z.literal("proposal"),
    proposalId: z.string().uuid(),
    accept: z.boolean(),
  }),
  z.object({ kind: z.literal("start") }),
  z.object({
    kind: z.literal("component-show"),
    componentId: z.string().uuid(),
    revision: z.number().int().nonnegative(),
  }),
  z.object({
    kind: z.literal("component-hide"),
    componentId: z.string().uuid(),
  }),
  z.object({
    kind: z.literal("component-message"),
    componentId: z.string().uuid(),
    message: z.discriminatedUnion("type", [
      z.object({
        type: z.literal("event"),
        name: z.string(),
        payload: z.unknown(),
      }),
      z.object({
        type: z.literal("state"),
        revision: z.number().int().nonnegative(),
        state: z.unknown(),
      }),
    ]),
  }),
]);
export type AsideAction = z.infer<typeof asideActionSchema>;
export const asideRequestSchema = z.object({
  kind: z.literal("aside-action"),
  requestId: z.string().uuid(),
  action: asideActionSchema,
});
export interface AsideResult {
  requestId: string;
  result?: unknown;
  error?: string;
}
