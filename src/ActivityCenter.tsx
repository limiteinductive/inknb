import { documentScrollToDecision } from "./Decisions";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Button, Switch, Tooltip, TooltipTrigger } from "react-aria-components";
import { ArrowLeft, Bell, ChevronRight, CircleAlert } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { ask } from "@tauri-apps/plugin-dialog";
import { activity, activityTrigger } from "./activity";
import type { ActivityItem } from "./activity";
import { workspace } from "./window-workspace";
import { SessionContext } from "./use-session";
import { Conversation } from "./Asides";
import { importDocument } from "./native-document";
import { sourceFormat } from "./native-schema";
import { renderChange } from "./change-display";
import PanelPopover, { PanelBody, PanelEmpty } from "./PanelPopover";
import "./activity.css";

export function ActivityButton({ remote = false }: { remote?: boolean }) {
  const state = useSyncExternalStore(activity.subscribe, activity.getSnapshot);
  useEffect(() => {
    if (!remote) return;
    void activity.refresh();
    const subscription = listen(
      "inknb-activity",
      () => void activity.refresh(),
    );
    return () => {
      void subscription.then((unlisten) => unlisten());
    };
  }, [remote]);
  const critical = state.pending.find((item) => item.attention);
  const label = `Notifications${state.unread ? `, ${state.unread} unread` : ""}${critical ? ", needs attention" : ""}`;
  return (
    <TooltipTrigger delay={500}>
      <Button
        ref={remote ? undefined : activityTrigger}
        className="icon-button activity-button"
        aria-label={label}
        data-attention={Boolean(critical)}
        aria-haspopup="dialog"
        aria-expanded={state.open}
        data-inknb-control="activity.open"
        onPress={() =>
          remote
            ? void invoke("activity_show").catch((error) =>
                activity.report(null, "error", error),
              )
            : activity.update({
                open: !state.open,
                targetKey: critical?.key ?? null,
              })
        }
      >
        {critical ? (
          <CircleAlert size={17} strokeWidth={1.6} aria-hidden="true" />
        ) : (
          <Bell size={17} strokeWidth={1.6} aria-hidden="true" />
        )}
        {state.unread > 0 && (
          <span className="activity-count count-badge" aria-hidden="true">
            {state.unread > 99 ? "99+" : state.unread}
          </span>
        )}
      </Button>
      <Tooltip className="control-tooltip" offset={7}>
        {label}
      </Tooltip>
    </TooltipTrigger>
  );
}

export default function ActivityCenter() {
  const state = useSyncExternalStore(activity.subscribe, activity.getSnapshot);
  const library = useSyncExternalStore(
    workspace.subscribe,
    workspace.getSnapshot,
  );
  const [selected, setSelected] = useState<ActivityItem | null>(null);
  const [discussionOpen, setDiscussionOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => {
    void activity.refresh();
    const subscription = listen(
      "inknb-activity",
      () => void activity.refresh(),
    );
    const notification = getCurrentWindow().listen<string | null>(
      "inknb-activity-open",
      (event) => {
        void activity.refresh().then(() => {
          const item = activity
            .getSnapshot()
            .pending.concat(activity.getSnapshot().items)
            .find((item) => item.key === event.payload);
          setSelected(item ?? null);
          activity.update({ open: true });
        });
      },
    );
    return () => {
      void subscription.then((unlisten) => unlisten());
      void notification.then((unlisten) => unlisten());
    };
  }, []);
  useEffect(() => {
    if (state.targetKey === null) return;
    const item = state.pending
      .concat(state.items)
      .find((item) => item.key === state.targetKey);
    if (item || !state.targetKey) {
      setSelected(item ?? null);
      activity.update({ targetKey: null });
    }
  }, [state.targetKey, state.pending, state.items]);
  useEffect(() => {
    if (!state.open) setSelected(null);
  }, [state.open]);
  useEffect(() => setDiscussionOpen(false), [selected?.key]);
  const items = state.pending;
  const session = selected?.documentId
    ? workspace.sessions.get(selected.documentId)
    : undefined;
  const documentState = session?.getSnapshot();
  const thread = documentState?.metadata.threads.find(
    (thread) => thread.id === (selected?.contextThreadId ?? selected?.threadId),
  );
  const proposal =
    documentState?.metadata.proposals.find(
      (proposal) =>
        selected?.key === `${selected?.documentId}:suggestion:${proposal.id}`,
    ) ??
    (thread?.kind === "suggestion"
      ? documentState?.metadata.proposals
          .filter((proposal) => proposal.threadId === thread.id)
          .at(-1)
      : undefined);
  const completed = selected?.contextThreadId
    ? thread?.resolved
    : proposal
      ? proposal.status !== "pending"
      : thread?.resolved && selected?.kind !== "reply";
  const resultLabel = proposal
    ? {
        pending: "Suggestion ready",
        applied: "Applied",
        rejected: "Dismissed",
        undone: "Undone",
        conflict: "Out of date",
        superseded: "Superseded",
      }[proposal.status]
    : thread?.resolution?.outcome === "superseded"
      ? "Superseded"
      : "Resolved";
  const format = documentState
    ? sourceFormat(
        documentState.path,
        documentState.text,
        documentState.metadata.nativeDocument?.format,
      )
    : "text";
  const change = useMemo(() => {
    if (!proposal || proposal.status === "pending") return null;
    try {
      const [before, after] = [proposal.expectedText, proposal.replacement].map(
        (source) => {
          const document = importDocument(source, format);
          return document.textBetween(0, document.content.size, "\n", (node) =>
            node.type.name === "image"
              ? "[Image]"
              : ["math", "math_block"].includes(node.type.name)
                ? String(node.attrs.value)
                : "[Object]",
          );
        },
      );
      const template = document.createElement("template");
      template.content.append(
        renderChange(before, after, "text", ["Before", "After"]),
      );
      return { before, after, html: template.innerHTML };
    } catch {
      return null;
    }
  }, [proposal, format]);
  useEffect(() => {
    if (!state.open || !selected?.decisionId || !selected.documentId) return;
    const decisionId = selected.decisionId;
    void workspace
      .request({ kind: "open-document", documentId: selected.documentId })
      .then(() => {
        workspace.sessions
          .get(selected.documentId!)
          ?.update({ asidesOpen: true });
        activity.update({ open: false });
        requestAnimationFrame(() => documentScrollToDecision(decisionId));
      });
  }, [state.open, selected?.decisionId, selected?.documentId]);
  const latest =
    state.pending.find((item) => item.key === selected?.key) ??
    state.items.find((item) => item.key === selected?.key) ??
    selected;
  useEffect(() => {
    if (state.open && session && thread && !completed) {
      workspace.activate(session.getSnapshot().metadata.documentId);
      session.selectThread(thread.id);
    }
  }, [state.open, session, thread?.id, completed]);
  return (
    <>
      <span className="sr-only" role="status" aria-live="polite">
        {state.unread ? `${state.unread} unread updates` : ""}
      </span>
      <PanelPopover
        presentation="modal"
        triggerRef={activityTrigger}
        isOpen={state.open}
        onOpenChange={(open) => activity.update({ open })}
        className="activity-drawer"
        agentControl="activity.panel"
        title="Notifications"
        size="wide"
        leading={
          selected ? (
            <Button
              className="icon-button"
              aria-label="Back to notifications"
              data-inknb-control="activity.back"
              onPress={() => setSelected(null)}
            >
              <ArrowLeft size={17} aria-hidden="true" />
            </Button>
          ) : null
        }
        actions={
          !selected && state.pending.length > 0 ? (
            <Button
              className="activity-dismiss-all"
              data-inknb-control="activity.dismiss-all"
              isDisabled={
                busy !== null ||
                (state.pending.length === 0 && state.unread === 0)
              }
              onPress={() => {
                setBusy("dismiss-all");
                void activity
                  .dismissAll()
                  .catch((error) => activity.update({ error: String(error) }))
                  .finally(() => setBusy(null));
              }}
            >
              {busy === "dismiss-all" ? "Dismissing…" : "Dismiss all"}
            </Button>
          ) : undefined
        }
        closeControl="activity.close"
      >
        {state.error && (
          <p className="activity-error" role="alert">
            {state.error}
            <Button
              className="text-button"
              onPress={() => void activity.refresh()}
            >
              Retry
            </Button>
          </p>
        )}
        {selected ? (
          <PanelBody className="activity-detail">
            <p className="activity-document">
              {selected.documentId
                ? workspace.documentTitle(selected.documentId)
                : "ink and butter"}
            </p>
            {completed ? (
              <section className="activity-result" aria-label={resultLabel}>
                <h2>{resultLabel}</h2>
                {proposal?.explanation && (
                  <p className="activity-message">{proposal.explanation}</p>
                )}
                {change && change.before !== change.after ? (
                  <div
                    className="activity-diff"
                    dangerouslySetInnerHTML={{ __html: change.html }}
                  />
                ) : proposal ? (
                  <p className="activity-message">
                    {change
                      ? "Formatting change."
                      : "A text preview is unavailable."}
                  </p>
                ) : thread?.resolution?.reason ? (
                  <p className="activity-message">{thread.resolution.reason}</p>
                ) : null}
                {thread && session && (
                  <details
                    className="activity-discussion"
                    key={selected.key}
                    open={discussionOpen}
                    onToggle={(event) =>
                      setDiscussionOpen(event.currentTarget.open)
                    }
                  >
                    <summary>Discussion history</summary>
                    {discussionOpen && (
                      <SessionContext value={session}>
                        <Conversation identity={thread.id} />
                      </SessionContext>
                    )}
                  </details>
                )}
              </section>
            ) : thread && session ? (
              <SessionContext value={session}>
                <Conversation identity={thread.id} />
              </SessionContext>
            ) : (
              <>
                <h2>{latest?.title}</h2>
                {latest?.detail && (
                  <p className="activity-message">{latest.detail}</p>
                )}
              </>
            )}
            <div className="activity-actions">
              {!latest?.resolved && selected.kind === "save" && session && (
                <Button
                  className="activity-action"
                  isDisabled={busy !== null}
                  data-inknb-control="activity.retry"
                  onPress={() => {
                    setBusy(selected.key);
                    void session
                      .persist()
                      .catch((error) => session.fail(error))
                      .finally(() => {
                        setBusy(null);
                        void activity.refresh();
                      });
                  }}
                >
                  {busy ? "Saving…" : "Retry save"}
                </Button>
              )}
              {selected.kind === "external" && session && (
                <>
                  <Button
                    className="activity-action"
                    data-inknb-control="activity.reload"
                    onPress={() => {
                      const current = session.getSnapshot();
                      if (!current.path) return;
                      void (async () => {
                        if (
                          !current.dirty ||
                          (await ask(
                            "Reload the external file? This replaces your current unsaved buffer.",
                            {
                              title: "Reload document",
                              kind: "warning",
                              okLabel: "Reload",
                              cancelLabel: "Keep editing",
                            },
                          ))
                        )
                          await session.load(current.path!);
                      })().catch((error) => session.fail(error));
                    }}
                  >
                    Reload
                  </Button>
                  <Button
                    className="text-button"
                    onPress={() =>
                      void session
                        .saveAs()
                        .catch((error) => session.fail(error))
                    }
                  >
                    Save a copy
                  </Button>
                </>
              )}
              {!latest?.resolved &&
                selected.kind === "delivery" &&
                selected.requestId &&
                session
                  ?.getSnapshot()
                  .metadata.requests.find(
                    (request) => request.id === selected.requestId,
                  )?.state === "failed" && (
                  <Button
                    className="activity-action"
                    isDisabled={busy !== null}
                    data-inknb-control="activity.retry-delivery"
                    onPress={() => {
                      void (async () => {
                        const confirmed = await ask(
                          "Retry only if the agent did not receive this request. Retrying an uncertain delivery can queue it twice.",
                          {
                            title: "Retry agent delivery",
                            kind: "warning",
                            okLabel: "Not received, retry",
                            cancelLabel: "Keep waiting",
                          },
                        );
                        if (!confirmed) return;
                        setBusy(selected.key);
                        try {
                          await session.control("request_retry", {
                            requestId: selected.requestId,
                            confirmedNotQueued: true,
                          });
                        } finally {
                          setBusy(null);
                        }
                      })().catch((error) => session.fail(error));
                    }}
                  >
                    Retry delivery
                  </Button>
                )}
              {selected.documentId &&
                library.documents.some(
                  (entry) => entry.id === selected.documentId,
                ) && (
                  <Button
                    className="text-button"
                    data-inknb-control="activity.open-document"
                    onPress={() => {
                      workspace.activate(selected.documentId!);
                      if (thread && !thread.resolved)
                        session?.selectThread(thread.id);
                      activity.update({ open: false });
                    }}
                  >
                    Open document
                  </Button>
                )}
              {selected.kind === "error" && !latest?.resolved && (
                <Button
                  className="text-button"
                  onPress={() => {
                    activity.clear(selected.documentId, "error");
                    session?.update({ error: null });
                    if (!session) workspace.update({ error: null });
                  }}
                >
                  Dismiss
                </Button>
              )}
            </div>
          </PanelBody>
        ) : (
          <>
            <PanelBody className="activity-list" layout="list">
              {items.length === 0 && (
                <PanelEmpty>You’re up to date.</PanelEmpty>
              )}
              {items.map((item) => (
                <Button
                  key={item.key}
                  className="activity-item"
                  data-unread={(!item.read && !item.resolved) || undefined}
                  data-inknb-control={`activity.item:${item.key}`}
                  onPress={() => {
                    setSelected(item);
                    void activity
                      .acknowledge(item)
                      .catch((error) =>
                        activity.update({ error: String(error) }),
                      );
                  }}
                >
                  <span className="activity-item-state">
                    {!item.read ? <span className="activity-unread" /> : null}
                  </span>
                  <span className="activity-item-text">
                    <strong>{item.title}</strong>
                    <span>
                      {item.documentId
                        ? workspace.documentTitle(item.documentId)
                        : "ink and butter"}
                    </span>
                    {item.detail && (
                      <span className="activity-item-preview">
                        {item.detail}
                      </span>
                    )}
                    <time dateTime={item.occurredAt}>
                      {new Date(item.occurredAt).toLocaleString(undefined, {
                        month: "short",
                        day: "numeric",
                        hour: "numeric",
                        minute: "2-digit",
                      })}
                    </time>
                  </span>
                  <ChevronRight size={14} aria-hidden="true" />
                </Button>
              ))}
            </PanelBody>
            <footer className="activity-footer">
              <Switch
                className="activity-alert-setting"
                isSelected={state.backgroundNotifications}
                isDisabled={busy === "notifications"}
                onChange={(enabled) => {
                  setBusy("notifications");
                  void invoke("activity_background", { enabled })
                    .then(() => activity.refresh())
                    .catch((error) => activity.update({ error: String(error) }))
                    .finally(() => setBusy(null));
                }}
              >
                <span className="switch-track">
                  <span />
                </span>
                macOS notifications
              </Switch>
              <span className="activity-alert-hint">
                Only when the app is in the background.
              </span>
            </footer>
          </>
        )}
      </PanelPopover>
    </>
  );
}
