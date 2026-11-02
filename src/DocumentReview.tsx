import { observeImageAssets } from "./image-assets";
import { memo, useLayoutEffect, useState } from "react";
import { Button } from "react-aria-components";
import {
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ListChecks,
} from "lucide-react";
import { useAsideSession, useAsideState, useAsideSelector, sameFields, sameItems } from "./use-session";
import { currentSuggestions, reviewSuggestion } from "./suggestions";
import { renderChange } from "./change-display";
import { sourceFormat } from "./native-schema";
import type { Proposal } from "./domain";
import IconButton from "./IconButton";

export function ReviewButton() {
  const session = useAsideSession();
  const state = useAsideState();
  const current = currentSuggestions(state);
  if (!current.length) return null;
  return (
    <Button
      className="icon-button review-button"
      aria-label={`Review changes, ${current.length} remaining`}
      data-inknb-control="review.toggle"
      onPress={() =>
        reviewSuggestion(
          current.find((proposal) => proposal.id === state.reviewProposalId)
            ?.id ?? current[0].id,
          session,
        )
      }
    >
      <ListChecks size={17} strokeWidth={1.6} aria-hidden="true" />
      <span className="count-badge review-count" aria-hidden="true">
        {current.length > 99 ? "99+" : current.length}
      </span>
    </Button>
  );
}

export default function DocumentReview({
  active,
  onReveal,
}: {
  active: boolean;
  onReveal: (proposal: Proposal) => void;
}) {
  const session = useAsideSession();
  const state = useAsideSelector(state => ({ reviewOpen: state.reviewOpen, reviewProposalId: state.reviewProposalId, focus: state.focus }), sameFields);
  useLayoutEffect(() => {
    if (!active || !state.reviewOpen || state.focus) return;
    const selected = currentSuggestions(session.getSnapshot()).find(
      (proposal) => proposal.id === state.reviewProposalId,
    );
    const frame = requestAnimationFrame(() => {
      if (selected) onReveal(selected);
      session.update({ reviewOpen: false });
    });
    return () => cancelAnimationFrame(frame);
  }, [active, state.reviewOpen, state.reviewProposalId, state.focus]);
  return null;
}

export const InlineSuggestion = memo(function InlineSuggestion({ identity }: { identity: string }) {
  const session = useAsideSession();
  const state = useAsideSelector(state => ({ path: state.path, text: state.text, format: state.metadata.nativeDocument?.format }), sameFields);
  const queue = useAsideSelector(currentSuggestions, sameItems);
  const selected = queue.find((proposal) => proposal.id === identity);
  const index = queue.findIndex((proposal) => proposal.id === identity);
  const [preview, setPreview] = useState<HTMLDivElement | null>(null);
  const [original, setOriginal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useLayoutEffect(() => {
    if (!preview || !selected) return;
    const fragment = renderChange(
      selected.expectedText,
      selected.replacement,
      sourceFormat(
        state.path,
        state.text,
        state.format,
      ),
    );
    preview.replaceChildren(fragment);
    const references = [
      ...new Set(
        [
          ...preview.querySelectorAll<HTMLImageElement>(
            "img[data-native-image]",
          ),
        ].map((image) => image.dataset.nativeImage ?? ""),
      ),
    ];
    const unsubscribe = observeImageAssets(
      () => state.path,
      references,
      assets => {
        for (const image of preview.querySelectorAll<HTMLImageElement>("img[data-native-image]")) {
          const source = assets[image.dataset.nativeImage ?? ""];
          if (source) image.src = source;
          else image.removeAttribute("src");
        }
      },
      failure => setError(String(failure)),
    );
    return unsubscribe;
  }, [
    preview,
    selected?.id,
    selected?.expectedText,
    selected?.replacement,
    state.path,
  ]);
  if (!selected) return null;
  const decide = async (accept: boolean) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await session.proposal(identity, accept);
      if (session.getSnapshot().reviewProposalId === identity)
        session.update({ reviewProposalId: null, reviewOpen: false });
    } catch (failure) {
      setError(String(failure));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section
      className="inline-suggestion"
      aria-label="Suggested change"
      aria-busy={busy}
      data-inknb-suggestion={identity}
    >
      <div className="inline-suggestion-heading">
        <IconButton
          icon={ChevronDown}
          label="Collapse suggestion"
          agentControl={`proposal.collapse:${identity}`}
          onPress={() =>
            selected.threadId
              ? session.collapseThread(selected.threadId)
              : session.update({ reviewProposalId: null })
          }
        />
        <span>Suggested change</span>
        <Button
          className="text-button"
          onPress={() => setOriginal(!original)}
          aria-pressed={original}
          data-inknb-control={`proposal.original:${identity}`}
        >
          {original ? "Show suggestion" : "Show original"}
        </Button>
      </div>
      <div
        ref={setPreview}
        className="inline-suggestion-content"
        data-version={original ? "current" : "suggested"}
      />
      {!original && !selected.replacement && (
        <p className="quiet-note">Delete this passage</p>
      )}
      <div className="inline-suggestion-actions">
        <Button
          className="primary-button"
          isDisabled={busy}
          onPress={() => void decide(true)}
          data-inknb-control={`proposal.accept:${identity}`}
        >
          <Check size={15} aria-hidden="true" /> Accept
        </Button>
        <Button
          className="text-button"
          isDisabled={busy}
          onPress={() => void decide(false)}
          data-inknb-control={`proposal.dismiss:${identity}`}
        >
          Dismiss
        </Button>
        <div className="review-navigation">
          <span>
            {index + 1} of {queue.length}
          </span>
          <IconButton
            icon={ChevronLeft}
            label="Previous suggestion"
            disabled={busy || queue.length < 2}
            onPress={() =>
              reviewSuggestion(
                queue[(index - 1 + queue.length) % queue.length].id,
                session,
              )
            }
          />
          <IconButton
            icon={ChevronRight}
            label="Next suggestion"
            disabled={busy || queue.length < 2}
            onPress={() =>
              reviewSuggestion(queue[(index + 1) % queue.length].id, session)
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
});
