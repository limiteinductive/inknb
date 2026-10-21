import type { SessionState } from "./session";
import type { Anchor, Proposal } from "./domain";
import { relocateAnchor } from "./domain";
import type { PreviewInfo } from "./preview-model";
import type { DocumentSession } from "./session";
import { asideExpanded } from "./aside-state";

export function currentSuggestions(state: SessionState): Proposal[] {
  return state.metadata.proposals
    .filter(
      (proposal) =>
        proposal.status === "pending" &&
        proposal.revision === state.metadata.revision &&
        state.text.slice(proposal.from, proposal.to) === proposal.expectedText,
    )
    .sort(
      (first, second) =>
        first.from - second.from ||
        first.createdAt.localeCompare(second.createdAt),
    );
}

export function earlierSuggestions(state: SessionState): Proposal[] {
  const current = new Set(
    currentSuggestions(state).map((proposal) => proposal.id),
  );
  return state.metadata.proposals.filter(
    (proposal) =>
      proposal.status === "conflict" ||
      (proposal.status === "pending" && !current.has(proposal.id)),
  );
}

export function reviewSuggestion(
  identity: string,
  session: Pick<DocumentSession, "getSnapshot" | "update">,
): boolean {
  const state = session.getSnapshot();
  const proposal = currentSuggestions(state).find(
    (proposal) => proposal.id === identity,
  );
  if (!proposal) return false;
  session.update({
    reviewOpen: true,
    reviewEarlier: false,
    reviewProposalId: identity,
    asidesOpen: true,
    activeThread: proposal.threadId,
    threadExpansions: {
      ...state.threadExpansions,
      ...(proposal.threadId ? { [proposal.threadId]: true } : {}),
    },
  });
  return true;
}

export function visibleSuggestions(state: SessionState): Proposal[] {
  if (state.focus || !state.asidesOpen) return [];
  return currentSuggestions(state).filter((proposal) => {
    const thread = state.metadata.threads.find(
      (thread) => thread.id === proposal.threadId,
    );
    if (thread?.resolved)
      return state.threadExpansions[thread.id] ?? state.reviewProposalId === proposal.id;
    return thread
      ? asideExpanded(state, thread)
      : state.reviewProposalId === proposal.id;
  });
}

export interface ProjectedSuggestion {
  proposal: Proposal;
  from: number;
  to: number;
}

export function sourcePosition(
  position: number,
  association: -1 | 1,
  suggestions: ProjectedSuggestion[],
): number {
  let adjustment = 0;
  for (const suggestion of suggestions) {
    if (
      position < suggestion.from ||
      (position === suggestion.from && association < 0)
    )
      break;
    if (position === suggestion.from && suggestion.from !== suggestion.to)
      return suggestion.proposal.from;
    if (position === suggestion.to) return suggestion.proposal.to;
    if (position < suggestion.to)
      return association < 0
        ? suggestion.proposal.from
        : suggestion.proposal.to;
    adjustment +=
      suggestion.to -
      suggestion.from -
      (suggestion.proposal.to - suggestion.proposal.from);
  }
  return position - adjustment;
}

export interface PreviewSuggestion {
  id: string;
  anchor: Anchor;
  html: string;
}

export function locateSuggestions(
  information: PreviewInfo,
  suggestions: PreviewSuggestion[],
) {
  return suggestions.flatMap((suggestion) => {
    const anchor = relocateAnchor(information.sourceText, suggestion.anchor);
    if (anchor.status !== "attached") return [];
    const mapping = information.manifest.sourceMap
      .filter(
        (mapping) =>
          mapping.source.from <= anchor.from && mapping.source.to > anchor.from,
      )
      .sort(
        (first, second) =>
          first.source.to -
          first.source.from -
          (second.source.to - second.source.from),
      )[0];
    return mapping
      ? [{ id: suggestion.id, html: suggestion.html, target: mapping.target }]
      : [];
  });
}
