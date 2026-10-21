import { z } from "zod";
import { sourceFormatSchema } from "./native-schema";

export const historyChangeSchema = z.object({
  id: z.string(),
  documentId: z.string().uuid(),
  revision: z.number().int().nonnegative(),
  createdAt: z.string(),
  actor: z.string(),
  threadId: z.string().uuid().nullable(),
  beforeFormat: sourceFormatSchema,
  format: sourceFormatSchema,
  from: z.number().int().nonnegative(),
  removed: z.string(),
  inserted: z.string(),
  beforeLength: z.number().int().nonnegative(),
  baseline: z.string().optional(),
});
export type HistoryChange = z.infer<typeof historyChangeSchema>;
export const historyEntrySchema = historyChangeSchema
  .omit({ baseline: true })
  .extend({
    cursor: z.number().int().positive(),
  });
export type HistoryEntry = z.infer<typeof historyEntrySchema>;
export const historyPageSchema = z.object({
  entries: z.array(historyEntrySchema),
  hasMore: z.boolean(),
});
export const historyRevisionSchema = z.object({
  before: z.string(),
  after: z.string(),
  beforeFormat: sourceFormatSchema,
  format: sourceFormatSchema,
});
export type HistoryRevision = z.infer<typeof historyRevisionSchema>;

export function textDifference(before: string, after: string) {
  let from = 0;
  while (
    from < before.length &&
    from < after.length &&
    before[from] === after[from]
  )
    from += 1;
  if (from > 0 && /[\uD800-\uDBFF]/u.test(before[from - 1])) from -= 1;
  let beforeEnd = before.length;
  let afterEnd = after.length;
  while (
    beforeEnd > from &&
    afterEnd > from &&
    before[beforeEnd - 1] === after[afterEnd - 1]
  ) {
    beforeEnd -= 1;
    afterEnd -= 1;
  }
  if (beforeEnd < before.length && /[\uDC00-\uDFFF]/u.test(before[beforeEnd])) {
    beforeEnd += 1;
    afterEnd += 1;
  }
  return {
    from,
    removed: before.slice(from, beforeEnd),
    inserted: after.slice(from, afterEnd),
  };
}
