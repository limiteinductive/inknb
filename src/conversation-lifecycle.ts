import type { Metadata, Thread } from "./domain";

export function conversationBlocker(
  metadata: Metadata,
  thread: Thread,
  outcome: "done" | "superseded",
): string | null {
  if (thread.messages.at(-1)?.awaitingHuman)
    return "This aside is waiting for a human decision.";
  if (
    metadata.requests.some(
      (request) =>
        request.threadId === thread.id &&
        request.trigger.kind === "human" &&
        request.state !== "answered",
    )
  )
    return "Answer the outstanding human requests before resolving this aside.";
  const related = new Set([thread.id]);
  for (let depth = 0; depth < metadata.threads.length; depth++) {
    const before = related.size;
    for (const candidate of metadata.threads)
      if (
        candidate.links.some(
          (link) =>
            link.relation === "suggestion_for" &&
            link.documentId === metadata.documentId &&
            related.has(link.threadId),
        )
      )
        related.add(candidate.id);
    if (before === related.size) break;
  }
  if (
    metadata.proposals.some(
      (proposal) =>
        proposal.threadId &&
        related.has(proposal.threadId) &&
        ["pending", "conflict"].includes(proposal.status) &&
        metadata.threads.find((owner) => owner.id === proposal.threadId)
          ?.resolution?.outcome !== "superseded" &&
        !(
          outcome === "superseded" &&
          proposal.threadId === thread.id &&
          proposal.status === "conflict"
        ),
    )
  )
    return "This aside has suggestions awaiting a human decision.";
  return null;
}
