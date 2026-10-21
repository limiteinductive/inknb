import { captureAnchor, relocateAnchor } from "./domain";
import type { Anchor } from "./domain";
import type { PreviewAnchor, PreviewInfo } from "./preview-model";
import type { SessionState } from "./session";
import { asideVisible, asideExpanded } from "./aside-state";
import { currentSuggestions } from "./suggestions";

export interface AsidePassage {
  id: string;
  anchor: Anchor | null;
  preview: PreviewAnchor | null;
  suggestionId: string | null;
  expanded: boolean;
}

export interface AsideGeometry {
  positions: { id: string; top: number; bottom: number }[];
}

export function asidePassages(state: SessionState): AsidePassage[] {
  const suggestions = state.focus ? [] : currentSuggestions(state);
  const identities = new Set(suggestions.map((proposal) => proposal.threadId));
  const passages = state.metadata.threads
    .filter(
      (thread) =>
        !identities.has(thread.id) && asideVisible(state, thread),
    )
    .map((thread) => {
      const proposal = [...state.metadata.proposals]
        .reverse()
        .find(
          (proposal) =>
            proposal.threadId === thread.id &&
            proposal.status === "pending" &&
            proposal.revision === state.metadata.revision,
        );
      return {
        id: thread.id,
        expanded:
          state.asidesOpen && !state.focus && asideExpanded(state, thread),
        anchor: thread.anchor,
        preview: thread.previewAnchor,
        suggestionId: proposal?.id ?? null,
      };
    });
  passages.unshift(...suggestions.map((proposal) => ({
    id: proposal.id,
    anchor: captureAnchor(state.text, proposal),
    preview: null,
    suggestionId: proposal.id,
    expanded: state.reviewOpen && state.reviewProposalId === proposal.id,
  })));
  if (!state.focus) passages.push(...state.metadata.decisions.filter((decision) => ["open", "answered"].includes(decision.status)).map((decision) => ({ id: decision.id, anchor: decision.anchor, preview: null, expanded: state.asidesOpen, suggestionId: null })));
  if (state.composer)
    passages.push({
      id: "new",
      expanded: state.asidesOpen && !state.focus,
      anchor: state.composerAnchor,
      preview: state.composerPreviewAnchor,
      suggestionId: null,
    });
  return passages;
}

export function previewAsideLocations(
  information: PreviewInfo,
  passages: AsidePassage[],
) {
  return passages.flatMap((passage) => {
    if (passage.preview?.artifactId === information.artifactId)
      return [
        {
          id: passage.id,
          expanded: passage.expanded,
          target: passage.preview.target,
          quote: passage.preview.quote,
          suggestionId: passage.suggestionId,
        },
      ];
    if (!passage.anchor || passage.anchor.status === "detached") return [];
    const anchor = relocateAnchor(information.sourceText, passage.anchor);
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
    if (!mapping) return [];
    const endMapping = information.manifest.sourceMap
      .filter(
        (candidate) =>
          candidate.source.from < anchor.to &&
          candidate.source.to > anchor.from &&
          candidate.target.kind === "element",
      )
      .at(-1);
    const target =
      mapping.target.kind === "element"
        ? {
            kind: "html" as const,
            elementId: mapping.target.elementId,
            endElementId:
              endMapping?.target.kind === "element"
                ? endMapping.target.elementId
                : null,
            rectangle: { left: 0, top: 0, width: 1, height: 1 },
          }
        : {
            kind: "pdf" as const,
            regions: information.manifest.sourceMap.flatMap((candidate) =>
              candidate.target.kind === "page" &&
              candidate.source.from < Math.max(anchor.to, anchor.from + 1) &&
              candidate.source.to > anchor.from
                ? [
                    {
                      page: candidate.target.page,
                      rectangle: candidate.target.rectangle,
                    },
                  ]
                : [],
            ),
          };
    return [
      {
        id: passage.id,
        expanded: passage.expanded,
        target,
        quote: anchor.quote,
        suggestionId: passage.suggestionId,
      },
    ];
  });
}
