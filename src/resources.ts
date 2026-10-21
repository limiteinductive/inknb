import { z } from "zod";

export const resourceTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("document"), documentId: z.string().uuid() }),
  z.object({ kind: z.literal("file"), path: z.string().startsWith("/") }),
  z.object({ kind: z.literal("url"), url: z.string().url().refine((value) => /^https?:\/\//i.test(value)) }),
]);
export const linkedResourceSchema = z.object({
  id: z.string().uuid(),
  label: z.string().trim().min(1).max(200).nullable().default(null),
  target: resourceTargetSchema,
});
export const resourceActionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("read") }),
  linkedResourceSchema.extend({ kind: z.literal("attach") }),
  z.object({ kind: z.literal("remove"), id: z.string().uuid() }),
]);
export const resourceStateSchema = z.object({
  documentId: z.string().uuid(),
  items: z.array(linkedResourceSchema.extend({ title: z.string() })),
  backlinks: z.array(z.object({ documentId: z.string().uuid(), title: z.string() })),
});
export type ResourceAction = z.infer<typeof resourceActionSchema>;
export type ResourceState = z.infer<typeof resourceStateSchema>;

export function parseDocumentLink(value: string): string | null {
  const match = /^inknb:\/\/document\/([\da-f-]{36})$/i.exec(value);
  return match && z.string().uuid().safeParse(match[1]).success ? match[1] : null;
}
