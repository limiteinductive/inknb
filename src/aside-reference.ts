import { asideReferenceSchema, messageSummary } from "./domain";
import type { AsideReference, Metadata, Thread } from "./domain";
import { z } from "zod";

export const asideDetailsSchema = z.object({
  references: z.array(
    asideReferenceSchema.extend({ label: z.string(), relation: z.string() }),
  ),
});

export type AsideConnection = z.infer<
  typeof asideDetailsSchema
>["references"][number];

export function asideConnections(
  documents: Metadata[],
  reference: AsideReference,
): AsideConnection[] {
  const thread = documents
    .find((document) => document.documentId === reference.documentId)
    ?.threads.find((thread) => thread.id === reference.threadId);
  if (!thread) return [];
  const references: AsideConnection[] = thread.links.map((link) => {
    const target = documents
      .find((document) => document.documentId === link.documentId)
      ?.threads.find((thread) => thread.id === link.threadId);
    return {
      ...link,
      label:
        documents
          .find((document) => document.documentId === link.documentId)
          ?.proposals.find((proposal) => proposal.threadId === link.threadId)
          ?.explanation ||
        messageSummary(target?.messages[0]) ||
        target?.originalQuote ||
        "Whole document",
    };
  });
  for (const document of documents)
    for (const source of document.threads)
      for (const link of source.links)
        if (
          link.documentId === reference.documentId &&
          link.threadId === reference.threadId
        )
          references.push({
            documentId: document.documentId,
            threadId: source.id,
            relation:
              link.relation === "suggestion_for"
                ? "suggestion"
                : link.relation === "superseded_by"
                  ? "supersedes"
                  : link.relation === "supersedes"
                    ? "superseded_by"
                    : "related",
            label:
              document.proposals.find(
                (proposal) => proposal.threadId === source.id,
              )?.explanation ||
              messageSummary(source.messages[0]) ||
              source.originalQuote ||
              "Whole document",
          });
  const connections = new Map<string, AsideConnection>();
  for (const reference of references) {
    const identity = `${reference.documentId}:${reference.threadId}`;
    if (connections.has(identity) && reference.relation === "related") continue;
    connections.set(identity, reference);
  }
  return [...connections.values()];
}

export function asideLink(reference: AsideReference): string {
  return `inknb://aside/${reference.documentId}/${reference.threadId}`;
}

export function parseAsideLink(value: string): AsideReference | null {
  const match = value.match(
    /^inknb:\/\/aside\/([\da-f-]{36})\/([\da-f-]{36})$/i,
  );
  if (!match) return null;
  const parsed = asideReferenceSchema.safeParse({
    documentId: match[1],
    threadId: match[2],
  });
  return parsed.success ? parsed.data : null;
}

export function asideLinks(content: string): AsideReference[] {
  return [
    ...content.matchAll(/inknb:\/\/aside\/[\da-f-]{36}\/[\da-f-]{36}/gi),
  ].flatMap((match) => {
    const reference = parseAsideLink(match[0]);
    return reference ? [reference] : [];
  });
}

export function linkedAsides(
  thread: Thread,
  documentId: string,
  content: string,
): Thread["links"] {
  const links = [...thread.links];
  for (const reference of asideLinks(content)) {
    if (reference.documentId === documentId && reference.threadId === thread.id)
      continue;
    if (
      !links.some(
        (link) =>
          link.documentId === reference.documentId &&
          link.threadId === reference.threadId,
      )
    )
      links.push({ ...reference, relation: "related" });
  }
  return links;
}
