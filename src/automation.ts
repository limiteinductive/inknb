import type { AgentRequest, Metadata } from "./domain";

export type EventKind =
  | "document.opened"
  | "document.changed"
  | "document.saved"
  | "document.moved"
  | "request.created"
  | "request.updated"
  | "proposal.created"
  | "proposal.updated"
  | "source.changed"
  | "source.attached"
  | "source.reviewed"
  | "conversation.updated"
  | "anchor.detached"
  | "anchor.reattached"
  | "connection.changed"
  | "component.mounted"
  | "component.updated"
  | "component.removed"
  | "component.event";

export interface EventInput {
  id: string;
  documentId: string;
  revision: number;
  kind: EventKind;
  occurredAt: string;
  payload: Record<string, unknown>;
}

export function createEvent(
  metadata: Metadata,
  kind: EventKind,
  payload: Record<string, unknown>,
): EventInput {
  return {
    id: crypto.randomUUID(),
    documentId: metadata.documentId,
    revision: metadata.revision,
    kind,
    occurredAt: new Date().toISOString(),
    payload,
  };
}

export function planAutomation(
  previous: Metadata,
  next: Metadata,
): { metadata: Metadata; events: EventInput[] } {
  const events: EventInput[] = [];
  const reviews: AgentRequest[] = [];
  for (const thread of next.threads) {
    const before = previous.threads.find(
      (candidate) => candidate.id === thread.id,
    );
    for (const component of thread.components) {
      const earlier = before?.components.find(
        (candidate) => candidate.id === component.id,
      );
      if (!earlier || earlier.revision !== component.revision)
        events.push(
          createEvent(
            next,
            earlier ? "component.updated" : "component.mounted",
            {
              threadId: thread.id,
              componentId: component.id,
              bundleId: component.bundleId,
              componentRevision: component.revision,
            },
          ),
        );
    }
    for (const component of before?.components ?? []) {
      if (!thread.components.some((candidate) => candidate.id === component.id))
        events.push(
          createEvent(next, "component.removed", {
            threadId: thread.id,
            componentId: component.id,
          }),
        );
    }
    if (
      !before ||
      before.resolved !== thread.resolved ||
      before.messages.length !== thread.messages.length ||
      JSON.stringify(before.anchorSuggestions) !==
        JSON.stringify(thread.anchorSuggestions)
    )
      events.push(
        createEvent(next, "conversation.updated", {
          threadId: thread.id,
          resolved: thread.resolved,
        }),
      );
    if (
      before &&
      !thread.resolved &&
      (before.anchor.status !== "detached" ||
        (before.anchorSuggestions.length > 0 &&
          thread.anchorSuggestions.length === 0)) &&
      thread.anchor.status === "detached"
    ) {
      reviews.push({
        id: crypto.randomUUID(),
        threadId: thread.id,
        messageId: null,
        revision: next.revision,
        trigger: { kind: "anchor_detached" },
        permission: "read",
        state: "pending",
        binding: next.binding,
        createdAt: new Date().toISOString(),
        deliveredAt: null,
        error: null,
      });
      events.push(
        createEvent(next, "anchor.detached", { threadId: thread.id }),
      );
    }
    if (
      before?.anchor.status === "detached" &&
      thread.anchor.status === "attached"
    )
      events.push(
        createEvent(next, "anchor.reattached", { threadId: thread.id }),
      );
    for (const message of thread.messages) {
      for (const source of message.sources) {
        const earlier = before?.messages
          .flatMap((candidate) => candidate.sources)
          .find((candidate) => candidate.id === source.id);
        if (!earlier) {
          events.push(
            createEvent(next, "source.attached", {
              threadId: thread.id,
              sourceId: source.id,
              path: source.path,
            }),
          );
          continue;
        }
        if (earlier.review !== source.review && source.review)
          events.push(
            createEvent(next, "source.reviewed", {
              threadId: thread.id,
              sourceId: source.id,
              hash: source.observedHash,
            }),
          );
        if (
          !earlier ||
          earlier.observedHash === source.observedHash ||
          source.status === "current"
        )
          continue;
        if (!thread.resolved)
          reviews.push({
            id: crypto.randomUUID(),
            threadId: thread.id,
            messageId: null,
            revision: next.revision,
            trigger: {
              kind: "source_changed",
              sourceId: source.id,
              hash: source.observedHash,
            },
            permission: "read",
            state: "pending",
            binding: next.binding,
            createdAt: new Date().toISOString(),
            deliveredAt: null,
            error: null,
          });
        events.push(
          createEvent(next, "source.changed", {
            threadId: thread.id,
            sourceId: source.id,
            path: source.path,
            previousHash: earlier.observedHash ?? earlier.hash,
            hash: source.observedHash,
          }),
        );
      }
    }
  }
  for (const proposal of next.proposals) {
    const before = previous.proposals.find(
      (candidate) => candidate.id === proposal.id,
    );
    if (!before)
      events.push(
        createEvent(next, "proposal.created", {
          proposalId: proposal.id,
          threadId: proposal.threadId,
        }),
      );
    else if (before.status !== proposal.status) {
      events.push(
        createEvent(next, "proposal.updated", {
          proposalId: proposal.id,
          threadId: proposal.threadId,
          status: proposal.status,
        }),
      );
      if (
        proposal.status === "conflict" &&
        !next.threads.find((thread) => thread.id === proposal.threadId)
          ?.resolved
      )
        reviews.push({
          id: crypto.randomUUID(),
          threadId: proposal.threadId,
          messageId: null,
          revision: next.revision,
          trigger: { kind: "proposal_stale", proposalId: proposal.id },
          permission: "read",
          state: "pending",
          binding: next.binding,
          createdAt: new Date().toISOString(),
          deliveredAt: null,
          error: null,
        });
    }
  }
  const metadata = {
    ...next,
    requests: [
      ...next.requests.map((request) => {
        if (request.state === "answered") return request;
        const thread = next.threads.find(
          (thread) => thread.id === request.threadId,
        );
        if (thread?.resolved) return { ...request, state: "answered" as const };
        const trigger = request.trigger;
        let superseded = false;
        if (trigger.kind === "source_changed") {
          const source = next.threads
            .flatMap((thread) => thread.messages)
            .flatMap((message) => message.sources)
            .find((source) => source.id === trigger.sourceId);
          superseded = !source || source.observedHash !== trigger.hash;
        }
        if (trigger.kind === "anchor_detached")
          superseded =
            thread?.anchor.status === "attached" ||
            reviews.some(
              (review) =>
                review.trigger.kind === "anchor_detached" &&
                review.threadId === request.threadId,
            );
        return superseded
          ? { ...request, state: "answered" as const }
          : request;
      }),
      ...reviews,
    ],
  };
  for (const request of metadata.requests) {
    const before = previous.requests.find(
      (candidate) => candidate.id === request.id,
    );
    if (!before || before.state !== request.state)
      events.push(
        createEvent(metadata, before ? "request.updated" : "request.created", {
          requestId: request.id,
          threadId: request.threadId,
          trigger: request.trigger,
          state: request.state,
        }),
      );
  }
  if (previous.revision !== next.revision)
    events.push(createEvent(metadata, "document.changed", {}));
  if (JSON.stringify(previous.binding) !== JSON.stringify(next.binding))
    events.push(
      createEvent(metadata, "connection.changed", {
        provider: next.binding?.provider ?? null,
      }),
    );
  return { metadata, events };
}
