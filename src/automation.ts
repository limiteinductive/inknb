import { conversationBlocker } from "./conversation-lifecycle";
import { agentAttribution, defaultAgent } from "./domain";
import type { AgentRequest, Metadata } from "./domain";

export type EventKind =
  | "document.opened"
  | "document.changed"
  | "document.access_changed"
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
  | "decision.created"
  | "decision.answered"
  | "decision.acknowledged"
  | "decision.withdrawn"
  | "decision.superseded"
  | "connection.changed"
  | "component.mounted"
  | "component.updated"
  | "component.removed"
  | "component.event"
  | "preview.published"
  | "preview.rendered"
  | "preview.build";

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
  actor = "You",
  draftThreadIds: string[] = [],
): { metadata: Metadata; events: EventInput[] } {
  const events: EventInput[] = [];
  const reviews: AgentRequest[] = [];
  next = {
    ...next,
    threads: next.threads.map((thread) => {
      if (thread.kind !== "suggestion") return thread;
      const proposal = next.proposals
        .filter((proposal) => proposal.threadId === thread.id)
        .at(-1);
      const before = previous.proposals.find(
        (candidate) => candidate.id === proposal?.id,
      );
      if (!proposal || before?.status === proposal.status) return thread;
      if (proposal.status === "undone")
        return { ...thread, resolved: false, resolution: null };
      if (!["applied", "rejected"].includes(proposal.status)) return thread;
      return {
        ...thread,
        resolved: true,
        resolution: {
          reason:
            proposal.status === "applied"
              ? "Suggestion applied."
              : "Suggestion dismissed.",
          outcome: "done" as const,
          actor: "You",
          createdAt: new Date().toISOString(),
          lastMessageId: thread.messages.at(-1)?.id ?? null,
        },
      };
    }),
  };
  next = {
    ...next,
    threads: next.threads.map((thread) => {
      const message = thread.messages.at(-1);
      if (
        thread.resolved ||
        message?.author !== "agent" ||
        message.status !== "complete" ||
        thread.reopenedMessageId === message.id ||
        draftThreadIds.includes(thread.id)
      )
        return thread;
      const outcome = message.continuedIn
        ? ("superseded" as const)
        : ("done" as const);
      if (conversationBlocker(next, thread, outcome)) return thread;
      return {
        ...thread,
        resolved: true,
        resolution: {
          reason: message.continuedIn
            ? "Work continued in another aside."
            : "Request completed.",
          outcome,
          actor: agentAttribution(message.agent),
          createdAt: new Date().toISOString(),
          lastMessageId: message.id,
        },
      };
    }),
  };
  next = {
    ...next,
    requests: next.requests.map((request) =>
      request.trigger.kind === "completion_review" &&
      next.threads.find((thread) => thread.id === request.threadId)?.resolved
        ? { ...request, state: "answered" as const }
        : request,
    ),
  };
  next = {
    ...next,
    threads: next.threads.map((thread) => {
      const before = previous.threads.find(
        (candidate) => candidate.id === thread.id,
      );
      const changed =
        !before ||
        before.resolved !== thread.resolved ||
        before.messages.length !== thread.messages.length ||
        before.anchor?.status !== thread.anchor?.status ||
        JSON.stringify(before.resolution) !==
          JSON.stringify(thread.resolution) ||
        JSON.stringify(before.links) !== JSON.stringify(thread.links) ||
        JSON.stringify(before.anchorSuggestions) !==
          JSON.stringify(thread.anchorSuggestions);
      return changed
        ? { ...thread, updatedAt: new Date().toISOString() }
        : thread;
    }),
  };
  if (previous.preview?.artifactId !== next.preview?.artifactId)
    events.push(
      createEvent(next, "preview.published", { preview: next.preview }),
    );
  if (previous.previewLastGood?.artifactId !== next.previewLastGood?.artifactId)
    events.push(
      createEvent(next, "preview.rendered", { preview: next.previewLastGood }),
    );
  if (
    JSON.stringify(previous.previewBuild) !== JSON.stringify(next.previewBuild)
  )
    events.push(
      createEvent(next, "preview.build", { build: next.previewBuild }),
    );
  for (const decision of next.decisions) {
    const before = previous.decisions.find((candidate) => candidate.id === decision.id);
    if (!before || before.status !== decision.status)
      events.push(createEvent(next, !before ? "decision.created" : `decision.${decision.status === "open" ? "created" : decision.status}`, { decisionId: decision.id, decision }));
  }
  for (const thread of next.threads) {
    const before = previous.threads.find(
      (candidate) => candidate.id === thread.id,
    );
    const suggestions = next.threads.filter((candidate) =>
      candidate.links.some(
        (link) =>
          link.relation === "suggestion_for" &&
          link.documentId === next.documentId &&
          link.threadId === thread.id,
      ),
    );
    const finished = suggestions.some(
      (suggestion) =>
        suggestion.resolved &&
        !previous.threads.find((candidate) => candidate.id === suggestion.id)
          ?.resolved,
    );
    if (
      !thread.resolved &&
      thread.messages.at(-1)?.status !== "complete" &&
      finished &&
      suggestions.every((suggestion) => suggestion.resolved) &&
      !next.requests.some(
        (request) =>
          request.threadId === thread.id && request.state !== "answered",
      )
    )
      reviews.push({
        id: crypto.randomUUID(),
        threadId: thread.id,
        messageId: null,
        revision: next.revision,
        trigger: { kind: "completion_review" },
        permission: "read",
        state: "pending",
        binding: defaultAgent(next),
        createdAt: new Date().toISOString(),
        deliveredAt: null,
        error: null,
      });
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
    if (before?.updatedAt !== thread.updatedAt)
      events.push(
        createEvent(next, "conversation.updated", {
          threadId: thread.id,
          resolved: thread.resolved,
          resolution: thread.resolution,
          links: thread.links,
          completion: thread.messages.at(-1)?.status === "complete",
          message:
            thread.messages.at(-1)?.id !== before?.messages.at(-1)?.id
              ? {
                  id: thread.messages.at(-1)?.id,
                  author: thread.messages.at(-1)?.author,
                  content: thread.messages.at(-1)?.content.slice(0, 240),
                  awaitingHuman: thread.messages.at(-1)?.awaitingHuman ?? false,
                  label: agentAttribution(thread.messages.at(-1)?.agent),
                }
              : null,
        }),
      );
    if (
      before &&
      !thread.resolved &&
      (before.anchor?.status !== "detached" ||
        (before.anchorSuggestions.length > 0 &&
          thread.anchorSuggestions.length === 0)) &&
      thread.anchor?.status === "detached"
    ) {
      reviews.push({
        id: crypto.randomUUID(),
        threadId: thread.id,
        messageId: null,
        revision: next.revision,
        trigger: { kind: "anchor_detached" },
        permission: "read",
        state: "pending",
        binding: defaultAgent(next),
        createdAt: new Date().toISOString(),
        deliveredAt: null,
        error: null,
      });
      events.push(
        createEvent(next, "anchor.detached", { threadId: thread.id }),
      );
    }
    if (
      before?.anchor?.status === "detached" &&
      thread.anchor?.status === "attached"
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
            binding: defaultAgent(next),
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
        proposal.threadId &&
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
          binding: defaultAgent(next),
          createdAt: new Date().toISOString(),
          deliveredAt: null,
          error: null,
        });
    }
  }
  next = {
    ...next,
    annotations: next.annotations.map(annotation => {
      if (annotation.status === "open") {
        const destination = next.threads.find(thread => thread.messages.some(message => message.annotations?.some(context => context.annotationId === annotation.id)));
        if (destination) annotation = { ...annotation, status: "waiting", continuedIn: { documentId: next.documentId, threadId: destination.id } };
      }
      const discussion = annotation.continuedIn?.documentId === next.documentId
        ? next.threads.find(thread => thread.id === annotation.continuedIn?.threadId)
        : null;
      if (annotation.status !== "waiting" || !discussion?.resolved) return annotation;
      return { ...annotation, status: "resolved" as const, reason: discussion.resolution?.reason ?? "Completed." };
    }),
  };
  const metadata = {
    ...next,
    requests: [
      ...next.requests.map((request) => {
        if (request.state === "answered") return request;
        const annotationId = request.trigger.kind === "annotation" ? request.trigger.annotationId : null;
        if (annotationId && next.annotations.find(annotation => annotation.id === annotationId)?.status !== "open") return { ...request, state: "answered" as const };
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
            thread?.anchor?.status === "attached" ||
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
          error: request.error,
        }),
      );
  }
  if (previous.revision !== next.revision)
    events.push(createEvent(metadata, "document.changed", { actor }));
  if (previous.agentAccess !== next.agentAccess)
    events.push(
      createEvent(metadata, "document.access_changed", {
        agentAccess: next.agentAccess,
      }),
    );
  if (JSON.stringify([previous.agents, previous.defaultAgentId]) !== JSON.stringify([next.agents, next.defaultAgentId]))
    events.push(
      createEvent(metadata, "connection.changed", {
        agents: next.agents, defaultAgentId: next.defaultAgentId,
      }),
    );
  return { metadata, events };
}
