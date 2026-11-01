import { z } from "zod";

export const documentSearchMatchSchema = z.object({
  documentId: z.string().uuid(),
  title: z.string(),
  from: z.number().int().nonnegative().nullable(),
  to: z.number().int().nonnegative().nullable(),
  detail: z.string().optional(),
});
export type DocumentSearchMatch = z.infer<typeof documentSearchMatchSchema>;

export function searchDocuments(documents: { documentId: string; title: string; text: string }[], query: string): DocumentSearchMatch[] {
  const search = query.trim();
  const expression = search ? new RegExp(search.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "iu") : null;
  return documents.flatMap(document => {
    const match = expression?.exec(document.text);
    if (expression && !expression.test(document.title) && !match) return [];
    return [{ documentId: document.documentId, title: document.title, from: match?.index ?? null, to: match ? match.index + match[0].length : null, detail: match ? document.text.slice(match.index, match.index + Math.max(search.length, 72)).trim() : undefined }];
  });
}
