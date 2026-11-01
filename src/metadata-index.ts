import type { AgentRequest, Metadata, Proposal, Thread } from "./domain";

interface MetadataIndex {
  threads: ReadonlyMap<string, Thread>;
  requests: ReadonlyMap<string, readonly AgentRequest[]>;
  threadRequests: ReadonlyMap<string, readonly AgentRequest[]>;
  threadProposals: ReadonlyMap<string | null, readonly Proposal[]>;
  turnProposals: ReadonlyMap<string, readonly Proposal[]>;
}

const indexes = new WeakMap<Metadata, MetadataIndex>();

function append<Key, Value>(index: Map<Key, Value[]>, key: Key, value: Value): void {
  let values = index.get(key);
  if (!values) {
    values = [];
    index.set(key, values);
  }
  values.push(value);
}

export function metadataIndex(metadata: Metadata): MetadataIndex {
  const saved = indexes.get(metadata);
  if (saved) return saved;
  const threads = new Map<string, Thread>();
  const requests = new Map<string, AgentRequest[]>();
  const threadRequests = new Map<string, AgentRequest[]>();
  const threadProposals = new Map<string | null, Proposal[]>();
  const turnProposals = new Map<string, Proposal[]>();
  for (const thread of metadata.threads)
    if (!threads.has(thread.id)) threads.set(thread.id, thread);
  for (const request of metadata.requests) {
    append(requests, request.id, request);
    if (request.threadId) append(threadRequests, request.threadId, request);
  }
  for (const proposal of metadata.proposals) {
    append(threadProposals, proposal.threadId, proposal);
    if (proposal.status === "superseded") continue;
    const destinations = new Set<string>();
    if (proposal.threadId) destinations.add(proposal.threadId);
    const linkedRequests = proposal.requestId ? requests.get(proposal.requestId) : undefined;
    for (const request of linkedRequests ?? [])
      if (request.threadId) destinations.add(request.threadId);
    const owner = proposal.threadId ? threads.get(proposal.threadId) : undefined;
    for (const link of owner?.links ?? [])
      if (link.relation === "suggestion_for" && link.documentId === metadata.documentId)
        destinations.add(link.threadId);
    for (const identity of destinations) append(turnProposals, identity, proposal);
  }
  const result = { threads, requests, threadRequests, threadProposals, turnProposals };
  indexes.set(metadata, result);
  return result;
}
