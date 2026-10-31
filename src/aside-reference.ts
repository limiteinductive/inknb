import { asideReferenceSchema, messageSummary } from "./domain";
import type { AsideReference, Metadata, Thread } from "./domain";

export interface AsideConnection extends AsideReference {
  label: string;
  relation: string;
}

export function indexAsideConnections(documents: Metadata[]): Map<string, AsideConnection[]> {
  const labels = new Map<string, string>();
  const threads = new Map<string, { documentId: string; thread: Thread }>();
  const connections = new Map<string, Map<string, AsideConnection>>();
  for (const document of documents) {
    for (const proposal of document.proposals) {
      const identity = `${document.documentId}:${proposal.threadId}`;
      if (!labels.has(identity)) labels.set(identity, proposal.explanation);
    }
    for (const thread of document.threads) {
      const identity = `${document.documentId}:${thread.id}`;
      threads.set(identity, { documentId: document.documentId, thread });
      connections.set(identity, new Map());
    }
  }
  for (const [identity, { thread }] of threads)
    labels.set(identity, labels.get(identity) || messageSummary(thread.messages[0]) || thread.originalQuote || "Whole document");
  for (const [identity, { thread }] of threads)
    for (const link of thread.links) {
      const target = `${link.documentId}:${link.threadId}`;
      const outgoing = connections.get(identity)!;
      if (outgoing.has(target) && link.relation === "related") continue;
      outgoing.set(target, { ...link, label: labels.get(target) || "Whole document" });
    }
  for (const [identity, { documentId, thread }] of threads)
    for (const link of thread.links) {
      const incoming = connections.get(`${link.documentId}:${link.threadId}`);
      if (!incoming) continue;
      const relation = link.relation === "suggestion_for"
        ? "suggestion"
        : link.relation === "superseded_by"
          ? "supersedes"
          : link.relation === "supersedes"
            ? "superseded_by"
            : "related";
      if (incoming.has(identity) && relation === "related") continue;
      incoming.set(identity, { documentId, threadId: thread.id, relation, label: labels.get(identity)! });
    }
  return new Map([...connections].map(([identity, targets]) => [identity, [...targets.values()]]));
}

export function asideConnections(documents: Metadata[], reference: AsideReference): AsideConnection[] {
  return indexAsideConnections(documents).get(`${reference.documentId}:${reference.threadId}`) ?? [];
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
