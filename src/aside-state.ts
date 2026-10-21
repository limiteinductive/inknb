import { threadActivity } from "./domain";
import type { Anchor, Metadata, Thread } from "./domain";
import type { SessionState } from "./session";

export function resolvableAsides(metadata: Metadata): Thread[] {
  const pending = new Set(
    metadata.proposals
      .filter((proposal) => ["pending", "conflict"].includes(proposal.status))
      .map((proposal) => proposal.threadId),
  );
  return metadata.threads.filter(
    (thread) => !thread.resolved && !pending.has(thread.id),
  );
}

export function resolvedAsideView(
  state: SessionState,
  threadIds: string[],
): Pick<SessionState, "activeThread" | "threadReads" | "threadExpansions"> {
  const resolved = new Set(threadIds);
  const threadReads = { ...state.threadReads };
  const threadExpansions = { ...state.threadExpansions };
  for (const thread of state.metadata.threads) {
    if (!resolved.has(thread.id)) continue;
    const signature = threadActivity(state.metadata, thread);
    if (signature !== null) threadReads[thread.id] = signature;
    threadExpansions[thread.id] = false;
  }
  return {
    activeThread:
      state.activeThread && resolved.has(state.activeThread)
        ? null
        : state.activeThread,
    threadReads,
    threadExpansions,
  };
}

export function asideOutdated(metadata: Metadata, thread: Thread): boolean {
  if (thread.resolution?.outcome === "superseded") return true;
  if (thread.resolved) return false;
  const proposals = metadata.proposals.filter(
    (proposal) => proposal.threadId === thread.id,
  );
  return (
    proposals.length > 0 &&
    proposals.every((proposal) =>
      ["conflict", "superseded"].includes(proposal.status),
    )
  );
}

export function asideExpanded(state: SessionState, thread: Thread): boolean {
  if (thread.resolved) return false;
  const activity = threadActivity(state.metadata, thread);
  if (
    activity !== null &&
    state.threadReads[thread.id] !== activity &&
    thread.resolution?.outcome !== "superseded" &&
    (thread.kind === "discussion" || !asideOutdated(state.metadata, thread))
  )
    return true;
  return (
    state.threadExpansions[thread.id] ??
    (thread.kind === "discussion" || !asideOutdated(state.metadata, thread))
  );
}

export function asideVisible(state: SessionState, thread: Thread): boolean {
  return (
    asideExpanded(state, thread) ||
    (!thread.resolved &&
      (thread.kind === "discussion" || !asideOutdated(state.metadata, thread)))
  );
}

export function asideInline(
  state: SessionState,
  anchor: Anchor | null,
  identity?: string,
): boolean {
  return (
    (state.preferences.placement === "inline" || state.asideNarrow) &&
    !(
      state.asideReader.open &&
      (identity === "new" ||
        Boolean(identity && state.asideReader.threadIds.includes(identity)))
    ) &&
    anchor !== null &&
    anchor.status !== "detached" &&
    anchor.from <= state.text.length &&
    anchor.to <= state.text.length
  );
}
