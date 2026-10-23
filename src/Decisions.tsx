import { useState, useSyncExternalStore } from "react";
import {
  Button,
  TextArea,
  TextField,
} from "react-aria-components";
import { Check, ChevronDown } from "lucide-react";
import type { Decision } from "./domain";
import { agentAttribution } from "./domain";
import { useAsideSession, useAsideState } from "./use-session";
import { workspace } from "./window-workspace";
import { ResponseBody } from "./AgentResponse";
import { SessionContext } from "./use-session";
import { invoke } from "@tauri-apps/api/core";
import { PanelModal, PanelBody, PanelEmpty } from "./PanelPopover";
import "./decisions.css";

export function DecisionCard({ decision }: { decision: Decision }) {
  const session = useAsideSession();
  const state = useAsideState();
  const [expanded, setExpanded] = useState(true);
  const [busy, setBusy] = useState(false);
  const draftKey = `decision:${decision.id}`;
  const draft = state.drafts[draftKey] ?? { content: "", images: [] };
  const answer = async (option: number | null, text: string) => {
    if (busy) return;
    setBusy(true);
    try {
      await session.answerDecision(decision.id, option, text);
      session.update({
        drafts: {
          ...session.getSnapshot().drafts,
          [draftKey]: { content: "", images: [] },
        },
      });
    } catch (error) {
      session.fail(error);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section
      className="decision-card"
      aria-label={`Decision: ${decision.question}`}
      data-decision-id={decision.id}
    >
      <Button
        className="decision-heading"
        aria-expanded={expanded}
        onPress={() => setExpanded(!expanded)}
      >
        <ChevronDown size={16} data-expanded={expanded} />
        <strong>{decision.question}</strong>
      </Button>
      {expanded && (
        <>
          <p className="decision-author">
            {agentAttribution(decision.creator)}
          </p>
          {decision.anchor?.status === "detached" && (
            <p className="quiet-note">The original passage was removed.</p>
          )}
          {decision.context && (
            <details>
              <summary>Context</summary>
              <ResponseBody
                content={decision.context}
                assets={{}}
                onReference={(reference) =>
                  void invoke("open_reference", {
                    documentPath: state.path,
                    reference,
                  }).catch((error) => session.fail(error))
                }
              />
            </details>
          )}
          {decision.status === "open" ? (
            <>
              <div className="decision-options">
                {decision.options.map((option, index) => (
                  <Button
                    key={index}
                    isDisabled={busy}
                    onPress={() => void answer(index, option.label)}
                  >
                    <span>
                      <strong>{option.label}</strong>
                      {index === decision.recommended && (
                        <small>Recommended</small>
                      )}
                    </span>
                    {option.detail && <span>{option.detail}</span>}
                  </Button>
                ))}
              </div>
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  void answer(null, draft.content);
                }}
              >
                <TextField
                  isDisabled={busy}
                  value={draft.content}
                  aria-label="Your own answer"
                  onChange={(content) =>
                    session.update({
                      drafts: {
                        ...state.drafts,
                        [draftKey]: { ...draft, content },
                      },
                    })
                  }
                >
                  <TextArea rows={2} placeholder="Or write your answer…" />
                </TextField>
                <Button
                  type="submit"
                  className="text-button"
                  isDisabled={busy || !draft.content.trim()}
                >
                  Send answer
                </Button>
              </form>
            </>
          ) : (
            <div className="decision-answer">
              {decision.answer && (
                <>
                  <p>
                    <Check size={14} /> Your answer
                  </p>
                  <p className="decision-exact-answer">
                    {decision.answer.text}
                  </p>
                  <time dateTime={decision.answer.createdAt}>
                    {new Date(decision.answer.createdAt).toLocaleString()}
                  </time>
                </>
              )}
              <p className="quiet-note">
                {decision.status === "answered"
                  ? "Waiting for agent acknowledgement"
                  : decision.status === "acknowledged"
                    ? `Acknowledged by ${agentAttribution(decision.acknowledgement?.agent)}`
                    : decision.reason}
              </p>
            </div>
          )}
        </>
      )}
    </section>
  );
}

export function DecisionsPanel({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const library = useSyncExternalStore(
    workspace.subscribe,
    workspace.getSnapshot,
  );
  const [history, setHistory] = useState(false);
  const entries = library.documents
    .flatMap((document) =>
      (
        workspace.sessions.get(document.id)?.getSnapshot().metadata.decisions ??
        []
      ).map((decision) => ({ document, decision })),
    )
    .sort((first, second) =>
      second.decision.createdAt.localeCompare(first.decision.createdAt),
    );
  const pending = entries.filter(({ decision }) => decision.status === "open");
  const shown = history ? entries : pending;
  return (
    <PanelModal open={open} onOpenChange={onOpenChange}
        className="decisions-popover"
        title="Decisions"
        label="Space decisions"
        actions={
          <Button className="text-button" onPress={() => setHistory(!history)}>
            {history ? "Show open" : "Show history"}
          </Button>
        }
      >
        <PanelBody className="decisions-list">
          {!shown.length && (
            <PanelEmpty>
              {history ? "No decisions yet." : "No open decisions."}
            </PanelEmpty>
          )}
          {shown.map(({ document: entry, decision }) => (
            <SessionContext.Provider
              key={decision.id}
              value={workspace.sessions.get(entry.id) ?? null}
            >
              <div className="decision-list-entry">
                <Button
                  className="decision-document-link text-button"
                  onPress={() => {
                    onOpenChange(false);
                    void workspace
                      .request({
                        kind: "open-document",
                        documentId: entry.id,
                      })
                      .then(() => {
                        workspace.sessions
                          .get(entry.id)
                          ?.update({ asidesOpen: true });
                        requestAnimationFrame(() =>
                          documentScrollToDecision(decision.id),
                        );
                      })
                      .catch((error) => workspace.fail(error));
                  }}
                >
                  {entry.title}
                </Button>
                <DecisionCard decision={decision} />
              </div>
            </SessionContext.Provider>
          ))}
        </PanelBody>
    </PanelModal>
  );
}

export function documentScrollToDecision(decisionId: string): void {
  document
    .querySelector<HTMLElement>(`[data-decision-id="${decisionId}"]`)
    ?.scrollIntoView({ block: "center", behavior: "smooth" });
}
