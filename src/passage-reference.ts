import { z } from "zod";
import { anchorSchema, mapAnchor } from "./anchors";
import type { ChangeDesc } from "@codemirror/state";
import type { AsideDraft } from "./images";

export const passageSourceSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("document"),
    documentId: z.string().uuid(),
    revision: z.number().int().nonnegative(),
    quote: z.string().min(1),
    anchor: anchorSchema,
    liveAnchor: anchorSchema.optional(),
  }),
  z.object({
    kind: z.literal("message"),
    documentId: z.string().uuid(),
    threadId: z.string().uuid(),
    messageId: z.string().uuid(),
    field: z
      .string()
      .regex(
        /^(?:content|details|annotation-(?:comment|quote):[\da-f-]{36})$/i,
      ),
    text: z.string(),
    from: z.number().int().nonnegative(),
    to: z.number().int().nonnegative(),
    quote: z.string().min(1),
  }),
]);
export const passageReferenceSchema = z.object({
  id: z.string().uuid(),
  from: z.number().int().nonnegative(),
  to: z.number().int().nonnegative(),
  source: passageSourceSchema,
});
export const passageAnnotationSchema = z.object({
  source: passageSourceSchema,
  completed: z.boolean(),
  expectedComment: z.string().optional(),
});
export const annotationTransferSchema = z.object({
  source: passageSourceSchema,
  comment: z.string(),
  annotationId: z.string().uuid().optional(),
});
export const messageAnnotationSchema = annotationTransferSchema.extend({
  id: z.string().uuid(),
});
export type MessageAnnotation = z.infer<typeof messageAnnotationSchema>;
export type PassageSource = z.infer<typeof passageSourceSchema>;
export type PassageReference = z.infer<typeof passageReferenceSchema>;
export const annotationTransferType = "application/x-inknb-annotation+json";

function passageSnapshot(source: PassageSource) {
  if (source.kind !== "document") return source;
  const { liveAnchor, ...snapshot } = source;
  return snapshot;
}

export function messagePassageSnapshot(message: {
  references?: PassageReference[];
  annotations?: MessageAnnotation[];
}): string {
  return JSON.stringify({
    references: message.references?.map((reference) => ({
      ...reference,
      source: passageSnapshot(reference.source),
    })),
    annotations: message.annotations?.map((annotation) => ({
      ...annotation,
      source: passageSnapshot(annotation.source),
    })),
  });
}

export function mapPassageSource(
  source: PassageSource,
  documentId: string,
  text: string,
  changes: ChangeDesc,
): PassageSource {
  if (
    source.kind !== "document" ||
    source.documentId !== documentId ||
    changes.empty
  )
    return source;
  return {
    ...source,
    liveAnchor: {
      ...mapAnchor(text, source.liveAnchor ?? source.anchor, changes),
      native: undefined,
    },
  };
}

export function mapPassageDrafts(
  drafts: Record<string, AsideDraft>,
  documentId: string,
  text: string,
  changes: ChangeDesc,
): Record<string, AsideDraft> {
  if (changes.empty) return drafts;
  return Object.fromEntries(
    Object.entries(drafts).map(([key, draft]) => [
      key,
      {
        ...draft,
        ...(draft.annotation
          ? {
              annotation: {
                ...draft.annotation,
                source: mapPassageSource(
                  draft.annotation.source,
                  documentId,
                  text,
                  changes,
                ),
              },
            }
          : {}),
        ...(draft.references
          ? {
              references: draft.references.map((reference) => ({
                ...reference,
                source: mapPassageSource(
                  reference.source,
                  documentId,
                  text,
                  changes,
                ),
              })),
            }
          : {}),
        ...(draft.annotations
          ? {
              annotations: draft.annotations.map((annotation) => ({
                ...annotation,
                source: mapPassageSource(
                  annotation.source,
                  documentId,
                  text,
                  changes,
                ),
              })),
            }
          : {}),
      },
    ]),
  );
}

export function validatePassageReferences(
  content: string,
  references: PassageReference[],
): void {
  let end = 0;
  for (const reference of [...references].sort(
    (first, second) => first.from - second.from,
  )) {
    if (
      reference.from < end ||
      reference.to <= reference.from ||
      reference.to > content.length
    )
      throw Error(
        "Passage references must cover separate, nonempty parts of the message.",
      );
    end = reference.to;
  }
}

export function textRange(
  element: Element,
  from: number,
  to: number,
): Range | null {
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  let offset = 0;
  let started = false;
  let node;
  while ((node = walker.nextNode())) {
    const end = offset + node.textContent!.length;
    if (!started && from <= end) {
      range.setStart(node, Math.max(0, from - offset));
      started = true;
    }
    if (started && to <= end) {
      range.setEnd(node, Math.max(0, to - offset));
      return range;
    }
    offset = end;
  }
  return null;
}
