import { Decoration } from "prosemirror-view";
import type { Node as DocumentNode } from "prosemirror-model";
import type { SessionState, DocumentSession } from "./session";
import type { SourceProjection } from "./native-source";
import { documentPosition } from "./native-source";
import {
  currentSuggestions,
  reviewSuggestion,
  visibleSuggestions,
} from "./suggestions";

export function suggestionMarkers(
  state: SessionState,
  projection: SourceProjection,
  document: DocumentNode,
  offset = 0,
  excluded?: ReadonlySet<string>,
): Decoration[] {
  if (state.focus) return [];
  const markers: Decoration[] = [];
  const focused = new Set(visibleSuggestions(state).map(proposal => proposal.id));
  for (const proposal of currentSuggestions(state)) {
    if (excluded?.has(proposal.id)) continue;
    const start = documentPosition(projection, proposal.from) - offset;
    const end = documentPosition(projection, proposal.to, -1) - offset;
    if (start > document.content.size || end < 0) continue;
    const from = Math.max(0, start);
    const to = Math.max(from, Math.min(document.content.size, end));
    const expanded = focused.has(proposal.id);
    const attributes = {
      class: `suggestion-anchor${!proposal.replacement || expanded ? " suggestion-deletion" : ""}${expanded ? " suggestion-anchor-focused" : ""}`,
      "data-review-proposal": proposal.id,
    };
    const resolvedStart = document.resolve(from);
    const resolvedEnd = document.resolve(to);
    if (
      to > from &&
      proposal.replacement &&
      (!resolvedStart.sameParent(resolvedEnd) ||
        !resolvedStart.parent.isTextblock)
    )
      document.nodesBetween(from, to, (node, position) => {
        if (!node.isBlock) return;
        markers.push(
          Decoration.node(position, position + node.nodeSize, {
            ...attributes,
            class: `suggestion-block-anchor${expanded ? " suggestion-block-focused" : ""}`,
          }),
        );
        return false;
      });
    else if (to > from) markers.push(Decoration.inline(from, to, attributes));
    else
      markers.push(
        Decoration.widget(
          from,
          () => {
            const marker = window.document.createElement("button");
            marker.type = "button";
            marker.className = `${attributes.class} suggestion-insertion`;
            marker.dataset.reviewProposal = proposal.id;
            marker.setAttribute("aria-label", "Review suggested insertion");
            marker.textContent = "+";
            return marker;
          },
          { key: `review:${proposal.id}`, side: -1 },
        ),
      );
  }
  return markers;
}

export function openSuggestion(
  event: MouseEvent,
  session: Pick<DocumentSession, "getSnapshot" | "update">,
): boolean {
  if (
    !(event.target instanceof Element) ||
    event.detail !== 1 ||
    event.shiftKey ||
    event.altKey ||
    event.metaKey ||
    event.ctrlKey ||
    !window.getSelection()?.isCollapsed
  )
    return false;
  const identity = event.target.closest<HTMLElement>("[data-review-proposal]")
    ?.dataset.reviewProposal;
  if (!identity) return false;
  return reviewSuggestion(identity, session);
}
