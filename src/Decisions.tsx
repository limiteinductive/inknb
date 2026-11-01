import { useState, useSyncExternalStore } from "react";
import {
  Button,
  TextArea,
  TextField,
} from "react-aria-components";
import { Check, ChevronDown } from "lucide-react";
import type { Decision } from "./domain";
import { agentAttribution } from "./domain";
import { useAsideSession, useAsideSelector, sameFields } from "./use-session";
import { workspace } from "./window-workspace";
import { ResponseBody } from "./AgentResponse";
import type { AsideDraft } from "./images";
import { invoke } from "@tauri-apps/api/core";
import { PanelModal, PanelBody, PanelEmpty } from "./PanelPopover";
import "./decisions.css";

export function DecisionCard({ decision }: { decision: Decision }) {
  const session = useAsideSession();
  const draftKey = `decision:${decision.id}`;
  const state = useAsideSelector(state => ({ draft: state.drafts[draftKey], path: state.path }), sameFields);
  return <DecisionBody decision={decision} path={state.path} draft={state.draft ?? { content: "", images: [] }} onDraft={content => session.update({ drafts: { ...session.getSnapshot().drafts, [draftKey]: { ...state.draft, content, images: state.draft?.images ?? [] } } })} onAnswer={(option, content) => session.answerDecision(decision.id, option, content)} onError={error => session.fail(error)} />;
}

function DecisionBody({ decision, path, draft, onDraft, onAnswer, onError }: { decision: Decision; path: string | null; draft: AsideDraft; onDraft: (content: string) => void; onAnswer: (option: number | null, text: string) => Promise<void>; onError: (error: unknown) => void }) {
  const [expanded, setExpanded] = useState(true);
  const [busy, setBusy] = useState(false);
  const answer = async (option: number | null, text: string) => {
    if (busy) return;
    setBusy(true);
    try {
      await onAnswer(option, text);
      onDraft("");
    } catch (error) {
      onError(error);
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
                    documentPath: path,
                    reference,
                  }).catch(onError)
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
                  onChange={onDraft}
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
  const entries = library.decisions.flatMap(entry => {
    const document = library.documents.find(document => document.id === entry.documentId);
    return document ? [{ document, path: entry.path, decision: entry.decision }] : [];
  }).sort((first, second) => second.decision.createdAt.localeCompare(first.decision.createdAt));
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
          {shown.map(({ document: entry, path, decision }) => (
              <div className="decision-list-entry" key={decision.id}>
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
                <DecisionBody decision={decision} path={path} draft={workspace.documentDraft(entry.id, `decision:${decision.id}`)} onDraft={content => workspace.setDocumentDraft(entry.id, `decision:${decision.id}`, content)} onAnswer={async (option, text) => { await workspace.request({ kind: "decision-answer", documentId: entry.id, decisionId: decision.id, option, text }); }} onError={error => workspace.fail(error)} />
              </div>
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
