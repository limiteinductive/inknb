import { useLayoutEffect, useMemo, useState } from "react";
import { Fragment } from "prosemirror-model";
import { ChangeSet } from "@codemirror/state";
import { invoke } from "@tauri-apps/api/core";
import {
  Check,
  X,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Undo2,
} from "lucide-react";
import { useDocumentSession, useSession } from "./use-session";
import { currentSuggestions, reviewSuggestion } from "./suggestions";
import { tableSuggestionGroups } from "./table-suggestions";
import { renderFragmentsChange } from "./change-display";
import { projectDocument } from "./native-document";
import { documentPosition } from "./native-source";
import IconButton from "./IconButton";
import { LinkGesture } from "./link-gesture";

export default function TableSuggestion({ identity }: { identity: string }) {
  const session = useDocumentSession();
  const state = useSession();
  const group =
    session.model &&
    tableSuggestionGroups(session.model, currentSuggestions(state)).find(
      (group) => group.identity === identity,
    );
  const selected =
    group?.proposals.find(
      (proposal) => proposal.id === state.reviewProposalId,
    ) ?? group?.proposals[0];
  const [preview, setPreview] = useState<HTMLDivElement | null>(null);
  const [original, setOriginal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const links = useMemo(
    () =>
      new LinkGesture(
        () => session.getSnapshot().path,
        (reference) => session.openAside(reference),
        (failure) => session.fail(failure),
      ),
    [session],
  );
  useLayoutEffect(() => {
    if (!preview || !group || !session.model) return;
    let cancelled = false;
    try {
      const proposals = [
        selected!,
        ...group.proposals.filter((proposal) => proposal.id !== selected!.id),
      ]
        .filter(
          (proposal, index, candidates) =>
            !candidates
              .slice(0, index)
              .some(
                (previous) =>
                  (proposal.from < previous.to &&
                    proposal.to > previous.from) ||
                  (proposal.from === previous.from &&
                    proposal.to === previous.to),
              ),
        )
        .sort((first, second) => first.from - second.from);
      const edits = proposals.map((proposal) => ({
        from: proposal.from,
        to: proposal.to,
        insert: proposal.replacement,
      }));
      const changes = ChangeSet.of(edits, state.text.length);
      const projected = session.model.sourceTransaction(edits).doc;
      const projection = projectDocument(projected);
      let suggested = group.node;
      let suggestedPosition = group.position;
      projected.descendants((node, position) => {
        if (node.attrs.identity === identity) {
          suggested = node;
          suggestedPosition = position;
          return false;
        }
      });
      const fragment = renderFragmentsChange(
        Fragment.from(group.node),
        Fragment.from(suggested),
      );
      const originalCells: { from: number; to: number }[] = [];
      group.node.descendants((node, position) => {
        if (["cell", "header_cell"].includes(node.type.spec.tableRole ?? ""))
          originalCells.push({
            from: group.position + position + 2,
            to: group.position + position + node.nodeSize,
          });
      });
      const sameShape =
        group.node.childCount === suggested.childCount &&
        group.node.content.content.every(
          (row, index) => row.childCount === suggested.child(index).childCount,
        );
      for (const [index, table] of [
        ...fragment.querySelectorAll("table"),
      ].entries()) {
        const cells: { from: number; to: number }[] = [];
        (index === 0 ? group.node : suggested).descendants((node, position) => {
          if (["cell", "header_cell"].includes(node.type.spec.tableRole ?? ""))
            cells.push({
              from:
                (index === 0 ? group.position : suggestedPosition) +
                position +
                2,
              to:
                (index === 0 ? group.position : suggestedPosition) +
                position +
                node.nodeSize,
            });
        });
        [...table.querySelectorAll("td, th")].forEach((cell, position) => {
          const owners = proposals.filter((proposal) => {
            if (index === 0 && !proposal.expectedText) return false;
            if (index === 1 && !proposal.replacement) {
              const start = documentPosition(
                session.model!.projection,
                proposal.from,
              );
              const end = documentPosition(
                session.model!.projection,
                proposal.to,
                -1,
              );
              return (
                sameShape &&
                start < originalCells[position].to &&
                end > originalCells[position].from
              );
            }
            const from =
              index === 0 ? proposal.from : changes.mapPos(proposal.from, -1);
            const to =
              index === 0 ? proposal.to : from + proposal.replacement.length;
            const source = index === 0 ? session.model!.projection : projection;
            const start = documentPosition(source, from);
            const end = documentPosition(source, to, -1);
            return start < cells[position].to && end > cells[position].from;
          });
          const proposalId =
            owners.find((proposal) => proposal.id === selected?.id)?.id ??
            owners[0]?.id;
          if (!proposalId) return;
          cell.setAttribute("data-review-proposal", proposalId);
          cell.setAttribute("data-inknb-control", `table.change:${proposalId}`);
          cell.setAttribute(
            "data-selected",
            String(proposalId === selected?.id),
          );
          cell.setAttribute("tabindex", "0");
          const proposal = proposals.find(
            (proposal) => proposal.id === proposalId,
          )!;
          if (index === 1 && !proposal.replacement && !cell.textContent?.trim())
            cell.append(document.createTextNode("−"));
          cell.setAttribute(
            "aria-label",
            proposal.replacement
              ? `Suggested change: ${cell.textContent}`
              : `Delete: ${proposal.expectedText}`,
          );
        });
      }
      const scroll = [
        ...preview.querySelectorAll<HTMLElement>(".tableWrapper"),
      ].map((element) => element.scrollLeft);
      const focused = preview.contains(document.activeElement)
        ? (document.activeElement as HTMLElement).dataset.reviewProposal
        : null;
      preview.replaceChildren(fragment);
      [...preview.querySelectorAll<HTMLElement>(".tableWrapper")].forEach(
        (element, index) => {
          element.scrollLeft = scroll[index] ?? 0;
        },
      );
      if (focused)
        preview
          .querySelector<HTMLElement>(
            `.change-version:${original ? "first" : "last"}-child [data-review-proposal="${focused}"]`,
          )
          ?.focus({ preventScroll: true });
      const references = [
        ...new Set(
          [
            ...preview.querySelectorAll<HTMLImageElement>(
              "img[data-native-image]",
            ),
          ].map((image) => image.dataset.nativeImage!),
        ),
      ];
      if (references.length)
        void invoke<Record<string, string>>("preview_assets", {
          documentPath: state.path,
          references,
        })
          .then((assets) => {
            if (cancelled) return;
            for (const image of preview.querySelectorAll<HTMLImageElement>(
              "img[data-native-image]",
            ))
              image.src = assets[image.dataset.nativeImage!] ?? "";
          })
          .catch((failure) => {
            if (!cancelled) setError(String(failure));
          });
      setError(null);
    } catch (failure) {
      setError(String(failure));
    }
    return () => {
      cancelled = true;
    };
  }, [preview, group, selected?.id, session]);
  if (!group || !selected) return null;
  const index = group.proposals.findIndex(
    (proposal) => proposal.id === selected.id,
  );
  const decide = async (accept: boolean) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await session.proposal(selected.id, accept);
      const remaining = currentSuggestions(session.getSnapshot());
      const next =
        group.proposals
          .slice(index + 1)
          .concat(group.proposals.slice(0, index))
          .find((proposal) =>
            remaining.some((candidate) => candidate.id === proposal.id),
          ) ?? remaining[0];
      if (next) reviewSuggestion(next.id, session);
      else session.update({ reviewProposalId: null });
    } catch (failure) {
      setError(String(failure));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section
      className="table-suggestion"
      data-table-proposals={group.proposals
        .map((proposal) => proposal.id)
        .join(" ")}
      aria-label="Suggested table changes"
      aria-busy={busy}
    >
      <div
        ref={setPreview}
        className="inline-suggestion-content table-suggestion-content"
        data-version={original ? "current" : "suggested"}
        onPointerDown={(event) => links.pointerDown(event.nativeEvent)}
        onPointerMove={(event) => links.pointerMove(event.nativeEvent)}
        onClick={(event) => {
          if (links.click(event.nativeEvent)) return;
          const target = event.target as Element;
          if (target.closest("a[href]")) return;
          const proposalId = target.closest<HTMLElement>(
            "[data-review-proposal]",
          )?.dataset.reviewProposal;
          if (proposalId && window.getSelection()?.isCollapsed)
            reviewSuggestion(proposalId, session);
        }}
        onKeyDown={(event) => {
          if (event.key !== "Enter" && event.key !== " ") return;
          const target = event.target as Element;
          const proposalId = target.closest<HTMLElement>(
            "[data-review-proposal]",
          )?.dataset.reviewProposal;
          if (!proposalId) return;
          event.preventDefault();
          reviewSuggestion(proposalId, session);
        }}
      />
      <div
        className="table-suggestion-actions"
        role="toolbar"
        aria-label="Review table changes"
      >
        <IconButton
          icon={Check}
          label="Accept selected change"
          agentControl={`proposal.accept:${selected.id}`}
          disabled={busy}
          onPress={() => void decide(true)}
        />
        <IconButton
          icon={X}
          label="Dismiss selected change"
          agentControl={`proposal.dismiss:${selected.id}`}
          disabled={busy}
          onPress={() => void decide(false)}
        />
        <IconButton
          icon={Undo2}
          label={original ? "Show suggested table" : "Show original table"}
          agentControl={`proposal.original:${selected.id}`}
          active={original}
          onPress={() => setOriginal(!original)}
        />
        <div className="review-navigation">
          <span aria-live="polite">
            {index + 1} / {group.proposals.length}
          </span>
          <IconButton
            icon={ChevronLeft}
            label="Previous table change"
            disabled={busy || group.proposals.length < 2}
            onPress={() =>
              reviewSuggestion(
                group.proposals[
                  (index - 1 + group.proposals.length) % group.proposals.length
                ].id,
                session,
              )
            }
          />
          <IconButton
            icon={ChevronRight}
            label="Next table change"
            disabled={busy || group.proposals.length < 2}
            onPress={() =>
              reviewSuggestion(
                group.proposals[(index + 1) % group.proposals.length].id,
                session,
              )
            }
          />
          <IconButton
            icon={ChevronDown}
            label="Collapse table suggestions"
            agentControl={`table.review.collapse:${identity}`}
            onPress={() =>
              session.update({
                reviewProposalId: null,
                threadExpansions: {
                  ...state.threadExpansions,
                  ...Object.fromEntries(
                    group.proposals.flatMap((proposal) =>
                      proposal.threadId ? [[proposal.threadId, false]] : [],
                    ),
                  ),
                },
              })
            }
          />
        </div>
      </div>
      {error && (
        <p className="review-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
