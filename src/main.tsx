import {
  type CSSProperties,
  lazy,
  Suspense,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { createRoot } from "react-dom/client";
import {
  Button,
  Dialog,
  Heading,
  Label,
  Menu,
  MenuItem,
  MenuTrigger,
  Modal,
  ModalOverlay,
  Popover,
  Radio,
  RadioGroup,
  Separator,
  Switch,
  TextArea,
  TextField,
} from "react-aria-components";
import {
  ArrowLeft,
  ArrowUp,
  Check,
  ChevronDown,
  ChevronRight,
  FileText,
  Focus,
  MessageSquarePlus,
  Plus,
  Settings2,
  X,
} from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { ask } from "@tauri-apps/plugin-dialog";
import { getCurrentWindow } from "@tauri-apps/api/window";
import ComponentHost from "./ComponentHost";
import { createEditor } from "./editor";
import type { Source } from "./domain";
import { threadHasStaleSources } from "./domain";
import { SessionContext, useDocumentSession, useSession } from "./use-session";
import { workspace } from "./workspace";
import Library from "./Library";
import DocumentNavigation from "./DocumentNavigation";
import IconButton from "./IconButton";
import "./style.css";

const Preview = lazy(() => import("./Preview"));

function Composer({ threadId }: { threadId?: string }) {
  const session = useDocumentSession();
  const state = useSession();
  const draftKey = threadId ?? "new";
  const { content, permission } = state.drafts[draftKey] ?? {
    content: "",
    permission: false,
  };
  const [sending, setSending] = useState(false);
  async function send() {
    if (sending || !content.trim()) return;
    setSending(true);
    try {
      await session.comment(content, permission ? "edit" : "read", threadId);
    } catch (error) {
      session.fail(error);
    } finally {
      setSending(false);
    }
  }
  return (
    <form
      className="composer"
      onSubmit={(event) => {
        event.preventDefault();
        void send();
      }}
    >
      <TextField
        value={content}
        onChange={(content) =>
          session.update({
            drafts: { ...state.drafts, [draftKey]: { content, permission } },
          })
        }
        aria-label={
          threadId ? "Reply to conversation" : "Request to your agent"
        }
      >
        <TextArea
          autoFocus={!threadId}
          placeholder={
            threadId ? "Continue this thought…" : "Ask about this passage…"
          }
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              void send();
            }
          }}
        />
      </TextField>
      <div className="composer-bottom">
        <Switch
          className="permission"
          isSelected={permission}
          onChange={(permission) =>
            session.update({
              drafts: { ...state.drafts, [draftKey]: { content, permission } },
            })
          }
        >
          <span className="switch-track">
            <span />
          </span>
          Allow this edit
        </Switch>
        <Button
          type="submit"
          className="send-button"
          isDisabled={!content.trim() || sending}
          aria-label="Send request"
        >
          <ArrowUp size={17} />
        </Button>
      </div>
      {permission && (
        <p className="permission-note">
          Your agent may edit the manuscript for this request. Every change
          stays undoable.
        </p>
      )}
      {!state.metadata.binding && (
        <p className="quiet-note">Saved locally until your agent joins.</p>
      )}
    </form>
  );
}

function SourceChip({ source }: { source: Source }) {
  const session = useDocumentSession();
  const [expanded, setExpanded] = useState(false);
  return (
    <div className={`source ${source.status}`}>
      <Button
        data-inknb-control={`source:${source.id}`}
        onPress={() => setExpanded(!expanded)}
      >
        <FileText size={13} />
        <span>{source.label}</span>
        {source.status !== "current" && (
          <span className="source-status">{source.status}</span>
        )}
        <ChevronDown size={12} />
      </Button>
      {expanded && (
        <div className="source-detail">
          <p>
            {source.status === "current"
              ? "Matches the local file attached to this reply."
              : (source.review ?? "Your agent is checking this source update.")}
          </p>
          <details className="inspection">
            <summary>Inspect source</summary>
            <code>{source.path}</code>
            <small>Original SHA-256 {source.hash}</small>
            <small>
              Observed SHA-256 {source.observedHash ?? "File unavailable"}
            </small>
          </details>
          <Button
            className="text-button"
            onPress={() =>
              void invoke("open_reference", {
                documentPath: session.getSnapshot().path,
                reference: source.path,
              }).catch((error) => session.fail(error))
            }
          >
            Open file
          </Button>
        </div>
      )}
    </div>
  );
}

function Conversation({ identity }: { identity: string }) {
  const session = useDocumentSession();
  const state = useSession();
  const thread = state.metadata.threads.find(
    (thread) => thread.id === identity,
  );
  if (!thread) return null;
  const requests = state.metadata.requests.filter(
    (request) => request.threadId === identity,
  );
  const latest = requests.at(-1);
  const proposals = state.metadata.proposals.filter(
    (proposal) =>
      proposal.threadId === identity && proposal.status !== "superseded",
  );
  return (
    <section
      className={`thread-card ${thread.resolved ? "resolved" : ""}`}
      data-inknb-control={`conversation:${thread.id}`}
      data-inknb-scroll="true"
      aria-label="Conversation"
    >
      <div className="thread-heading conversation-heading">
        <Button
          className="text-button"
          aria-label="Back to asides"
          data-inknb-control="conversation.close"
          onPress={() => session.selectThread(null)}
        >
          <ArrowLeft size={14} strokeWidth={1.6} aria-hidden="true" />
          Asides
        </Button>
        <Button
          className="text-button"
          onPress={() => session.resolve(identity)}
        >
          {thread.resolved ? "Reopen" : "Mark done"}
        </Button>
      </div>
      {thread.anchor.status !== "attached" && (
        <div className="anchor-alert">
          <span>
            {thread.anchor.status === "changed"
              ? "This passage changed."
              : "This passage is no longer attached."}
          </span>
          <Button
            className="text-button"
            onPress={() => session.reanchor(identity)}
          >
            Attach to selection
          </Button>
          {thread.anchorSuggestions.map((candidate) => (
            <Button
              className="anchor-candidate"
              key={candidate.id}
              onPress={() => {
                if (
                  session
                    .getSnapshot()
                    .text.slice(candidate.anchor.from, candidate.anchor.to) !==
                  candidate.anchor.quote
                ) {
                  session.fail(
                    "This passage changed. Your agent can locate it again.",
                  );
                  return;
                }
                session.reanchor(thread.id, candidate.anchor);
              }}
            >
              <span>{candidate.label}</span>
              <q>{candidate.anchor.quote}</q>
            </Button>
          ))}
        </div>
      )}
      {thread.originalQuote && (
        <blockquote className="anchor-quote">{thread.originalQuote}</blockquote>
      )}
      <div className="messages">
        {thread.messages.map((message) => (
          <article className={`message ${message.author}`} key={message.id}>
            <div className="message-author">
              {message.author === "human"
                ? "You"
                : (message.agent?.label ?? "Your agent")}
              <time dateTime={message.createdAt}>
                {new Date(message.createdAt).toLocaleTimeString([], {
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </time>
            </div>
            <p>{message.content}</p>
            {message.sources.length > 0 && (
              <div className="sources">
                {message.sources.map((source) => (
                  <SourceChip key={source.id} source={source} />
                ))}
              </div>
            )}
          </article>
        ))}
      </div>
      {thread.components
        .filter((component) => !component.hidden)
        .map((component) => (
          <ComponentHost key={component.id} instance={component} />
        ))}
      {thread.components
        .filter((component) => component.hidden)
        .map((component) => (
          <Button
            key={component.id}
            className="text-button"
            data-inknb-control={`component-show:${component.id}`}
            onPress={() =>
              void session
                .control("component_update", {
                  documentId: state.metadata.documentId,
                  componentId: component.id,
                  revision: component.revision,
                  hidden: false,
                })
                .catch((error) => session.fail(error))
            }
          >
            Show {component.title}
          </Button>
        ))}
      {proposals.map((proposal) => (
        <div className="proposal" key={proposal.id}>
          <div className="eyebrow">
            {proposal.status === "pending"
              ? "Proposed edit"
              : proposal.status === "conflict"
                ? "Suggestion out of date"
                : `Edit ${proposal.status}`}
          </div>
          <p>{proposal.explanation}</p>
          {proposal.expectedText && <del>{proposal.expectedText}</del>}
          <ins>{proposal.replacement || "Remove this passage"}</ins>
          {proposal.status === "pending" && (
            <div className="proposal-actions">
              <Button
                className="primary-button"
                onPress={() => {
                  try {
                    session.proposal(proposal.id, true);
                    session.view?.focus();
                  } catch (error) {
                    session.fail(error);
                  }
                }}
              >
                Accept
              </Button>
              <Button
                className="text-button"
                onPress={() => session.proposal(proposal.id, false)}
              >
                Dismiss
              </Button>
            </div>
          )}
        </div>
      ))}
      {latest && latest.state !== "answered" && (
        <div className={`delivery ${latest.state}`}>
          <span className="status-dot" />
          {latest.state === "failed"
            ? "Your agent needs to check this request"
            : latest.state === "delivered"
              ? latest.trigger.kind === "source_changed"
                ? "Checking the updated source…"
                : latest.trigger.kind === "proposal_stale"
                  ? "Refreshing the suggestion…"
                  : latest.trigger.kind === "anchor_detached"
                    ? thread.anchorSuggestions.length > 0
                      ? "Choose a passage above"
                      : "Locating this passage…"
                    : "Sent to your agent"
              : latest.state === "sending"
                ? "Sending request…"
                : state.metadata.binding
                  ? "Waiting to send"
                  : "Waiting for your agent"}
          {latest.error && (
            <details className="inspection">
              <summary>Details</summary>
              <p>{latest.error}</p>
            </details>
          )}
          {latest.state === "pending" && state.metadata.binding && (
            <Button
              className="text-button"
              onPress={() =>
                void session
                  .deliver(latest.id)
                  .catch((error) => session.fail(error))
              }
            >
              Send
            </Button>
          )}
        </div>
      )}
      {!thread.resolved && <Composer threadId={identity} />}
    </section>
  );
}

function Settings() {
  const session = useDocumentSession();
  const state = useSession();
  const preferences = state.preferences;
  return (
    <ModalOverlay
      isOpen={state.settings}
      onOpenChange={(settings) => session.update({ settings })}
      isDismissable
      className="modal-overlay"
    >
      <Modal className="settings-modal">
        <Dialog aria-label="Settings">
          <div className="modal-heading">
            <Heading slot="title">Make room for your writing.</Heading>
            <IconButton
              icon={X}
              label="Close settings"
              agentControl="settings.close"
              onPress={() => session.update({ settings: false })}
            />
          </div>
          <div className="settings-content">
            <section>
              <h3>Writing surface</h3>
              <RadioGroup
                className="setting-row"
                value={preferences.placement}
                onChange={(value) =>
                  void session
                    .preference({ placement: value as "margin" | "inline" })
                    .catch((error) => session.fail(error))
                }
              >
                <Label>Conversations</Label>
                <div className="segmented">
                  <Radio value="margin">Margin</Radio>
                  <Radio value="inline">Inline</Radio>
                </div>
              </RadioGroup>
              <RadioGroup
                className="setting-row"
                value={preferences.appearance}
                onChange={(value) =>
                  void session
                    .preference({
                      appearance: value as "system" | "light" | "dark",
                    })
                    .catch((error) => session.fail(error))
                }
              >
                <Label>Appearance</Label>
                <div className="segmented">
                  <Radio value="system">System</Radio>
                  <Radio value="light">Light</Radio>
                  <Radio value="dark">Dark</Radio>
                </div>
              </RadioGroup>
              <RadioGroup
                className="setting-row"
                value={preferences.typeface}
                onChange={(value) =>
                  void session
                    .preference({
                      typeface: value as "editorial" | "system" | "monospace",
                    })
                    .catch((error) => session.fail(error))
                }
              >
                <Label>Typeface</Label>
                <div className="segmented">
                  <Radio value="editorial">Editorial</Radio>
                  <Radio value="system">System</Radio>
                  <Radio value="monospace">Mono</Radio>
                </div>
              </RadioGroup>
              <label className="setting-row">
                Text size{" "}
                <span className="range-setting">
                  <input
                    type="range"
                    min="14"
                    max="28"
                    value={preferences.fontSize}
                    aria-label="Text size"
                    onChange={(event) =>
                      void session
                        .preference({ fontSize: Number(event.target.value) })
                        .catch((error) => session.fail(error))
                    }
                  />
                  <span>{preferences.fontSize}</span>
                </span>
              </label>
              <Switch
                className="setting-switch"
                isSelected={preferences.reduceMotion}
                onChange={(reduceMotion) =>
                  void session
                    .preference({ reduceMotion })
                    .catch((error) => session.fail(error))
                }
              >
                Reduce motion
                <span className="switch-track">
                  <span />
                </span>
              </Switch>
              <Switch
                className="setting-switch"
                isSelected={preferences.autosave}
                onChange={(autosave) =>
                  void session
                    .preference({ autosave })
                    .catch((error) => session.fail(error))
                }
              >
                Save changes automatically
                <span className="switch-track">
                  <span />
                </span>
              </Switch>
            </section>
            <footer className="settings-footer">
              <span>ink and butter {__INKNB_BUILD__.split("+")[0]}</span>
              <span>Local files. Your words.</span>
            </footer>
          </div>
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}

function DocumentApp({ active }: { active: boolean }) {
  const library = useSyncExternalStore(
    workspace.subscribe,
    workspace.getSnapshot,
  );
  const session = useDocumentSession();
  const state = useSession();
  const editorHost = useRef<HTMLDivElement>(null);
  const [documentMenuOpen, setDocumentMenuOpen] = useState(false);
  const [railTop, setRailTop] = useState(90);
  const [showResolved, setShowResolved] = useState(false);
  useEffect(() => {
    const activity = () => {
      document.documentElement.dataset.active = String(
        document.hasFocus() && document.visibilityState === "visible",
      );
    };
    activity();
    window.addEventListener("focus", activity);
    window.addEventListener("blur", activity);
    document.addEventListener("visibilitychange", activity);
    return () => {
      window.removeEventListener("focus", activity);
      window.removeEventListener("blur", activity);
      document.removeEventListener("visibilitychange", activity);
    };
  }, []);
  useLayoutEffect(() => {
    if (!state.ready || !editorHost.current) return;
    const view = createEditor(editorHost.current, session, (host, identity) => {
      const root = createRoot(host);
      root.render(
        <SessionContext value={session}>
          <Conversation identity={identity} />
        </SessionContext>,
      );
      return () => root.unmount();
    });
    return () => {
      session.view = null;
      view.destroy();
    };
  }, [state.ready, state.epoch]);
  useLayoutEffect(() => {
    if (!active || !state.ready || !session.view) return;
    const entry = workspace
      .getSnapshot()
      .documents.find(
        (candidate) => candidate.id === state.metadata.documentId,
      );
    const frame = requestAnimationFrame(() => {
      session.view?.requestMeasure();
      session.view?.scrollDOM.scrollTo({
        top: entry?.scrollTop ?? 0,
        behavior: "instant",
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [state.ready, state.epoch]);
  useLayoutEffect(() => {
    if (active && state.ready) session.restoreFocus();
  }, [active, state.ready, state.epoch, state.composer]);
  useEffect(() => {
    const media = matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      document.documentElement.dataset.theme =
        state.preferences.appearance === "system"
          ? media.matches
            ? "dark"
            : "light"
          : state.preferences.appearance;
    };
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [state.preferences.appearance]);
  useEffect(() => {
    document.documentElement.dataset.motion = state.preferences.reduceMotion
      ? "reduced"
      : "system";
    document.documentElement.dataset.typeface = state.preferences.typeface;
    document.documentElement.style.setProperty(
      "--writing-size",
      `${state.preferences.fontSize}px`,
    );
    document.documentElement.style.setProperty(
      "--writing-width",
      `${state.preferences.lineWidth}px`,
    );
  }, [state.preferences]);
  useEffect(() => {
    if (!active) return;
    const name =
      library.documents.find((entry) => entry.id === state.metadata.documentId)
        ?.title ?? "Untitled";
    void getCurrentWindow().setTitle(
      `${name}${state.dirty ? " •" : ""} · ink and butter`,
    );
  }, [
    state.path,
    state.dirty,
    active,
    library.documents,
    state.metadata.documentId,
  ]);
  useEffect(() => {
    function positionRail() {
      const current = session.getSnapshot();
      const thread = current.metadata.threads.find(
        (thread) => thread.id === current.activeThread,
      );
      if (!thread || thread.anchor.status === "detached" || !session.view) {
        setRailTop(90);
        return;
      }
      const coordinates = session.view.coordsAtPos(thread.anchor.from);
      if (coordinates)
        setRailTop(
          Math.max(64, Math.min(coordinates.top - 64, innerHeight * 0.35)),
        );
    }
    positionRail();
    const scroller = session.view?.scrollDOM;
    scroller?.addEventListener("scroll", positionRail);
    window.addEventListener("resize", positionRail);
    return () => {
      scroller?.removeEventListener("scroll", positionRail);
      window.removeEventListener("resize", positionRail);
    };
  }, [
    state.activeThread,
    state.previewMode,
    state.metadata.revision,
    state.preferences,
    state.ready,
    state.epoch,
  ]);
  const threads = state.metadata.threads.filter(
    (thread) => showResolved || !thread.resolved,
  );
  const activeThread = state.metadata.threads.find(
    (thread) => thread.id === state.activeThread,
  );
  const title =
    library.documents.find((entry) => entry.id === state.metadata.documentId)
      ?.title ?? "Untitled";
  const wordCount = state.text.trim()
    ? state.text.trim().split(/\s+/u).length
    : 0;
  return (
    <div
      className={`app ${state.focus ? "focus-mode" : ""} ${state.previewMode === "panel" && !state.focus ? "preview-open" : ""} ${state.previewMode === "fullscreen" ? "preview-fullscreen" : ""} placement-${state.preferences.placement}`}
    >
      <section className="writing-pane" aria-label="Writing workspace">
        <header className="titlebar" data-tauri-drag-region>
          <div className="window-inset" />
          {!library.sidebarOpen && <DocumentNavigation />}
          <MenuTrigger
            isOpen={documentMenuOpen && active}
            onOpenChange={setDocumentMenuOpen}
          >
            <Button className="document-name">
              <span className="document-title">{title}</span>
              <ChevronDown size={12} />
              {state.dirty && (
                <span className="unsaved-dot" aria-label="Unsaved changes" />
              )}
            </Button>
            <Popover
              className="document-menu"
              placement="bottom start"
              offset={5}
            >
              <Menu
                aria-label="Document actions"
                onAction={(action) => {
                  setDocumentMenuOpen(false);
                  void session.command(String(action));
                }}
              >
                <MenuItem id="new">
                  <Plus size={15} />
                  New document<kbd>⌘N</kbd>
                </MenuItem>
                <MenuItem id="open">
                  <FileText size={15} />
                  Open…<kbd>⌘O</kbd>
                </MenuItem>
                <MenuItem id="save">
                  <Check size={15} />
                  Save<kbd>⌘S</kbd>
                </MenuItem>
                <MenuItem id="save-as">
                  Save as…<kbd>⇧⌘S</kbd>
                </MenuItem>
                <Separator />
                <MenuItem id="preview">
                  <FileText size={15} />
                  Reading preview
                </MenuItem>
              </Menu>
            </Popover>
          </MenuTrigger>
          <div className="header-spacer" data-tauri-drag-region />
          <div className="toolbar">
            <IconButton
              icon={Focus}
              label="Toggle focus mode"
              agentControl="focus.toggle"
              active={state.focus}
              onPress={() => void session.command("focus")}
            />
            <span className="toolbar-divider" />
            <IconButton
              icon={MessageSquarePlus}
              label="Add aside"
              agentControl="aside.add"
              active={state.composer}
              onPress={() => session.startComment()}
            />
            <IconButton
              icon={Settings2}
              label="Open settings"
              agentControl="settings.open"
              onPress={() => session.update({ settings: true })}
            />
          </div>
        </header>
        {state.error && (
          <div className="notice error" role="alert">
            <span>{state.error}</span>
            <IconButton
              icon={X}
              label="Dismiss error"
              onPress={() => session.update({ error: null })}
            />
          </div>
        )}
        {state.externalChange && (
          <div className="notice conflict">
            <span>This file changed outside ink and butter.</span>
            <Button
              onPress={() => {
                if (state.path)
                  void (async () => {
                    const confirmed =
                      !state.dirty ||
                      (await ask(
                        "Reload the external file? This replaces your current unsaved buffer.",
                        {
                          title: "Reload document",
                          kind: "warning",
                          okLabel: "Reload",
                          cancelLabel: "Keep editing",
                        },
                      ));
                    if (confirmed) await session.load(state.path!);
                  })().catch((error) => session.fail(error));
              }}
            >
              Reload
            </Button>
            <Button
              onPress={() =>
                void session.saveAs().catch((error) => session.fail(error))
              }
            >
              Save a copy
            </Button>
          </div>
        )}
        <main className="workspace">
          <div className="writing-region">
            <div className="editor-host" ref={editorHost} />
            {!state.text && state.ready && (
              <div className="empty-hint">
                <span>Your words go here.</span>
                <span>
                  Select a passage, then press <kbd>⇧⌘A</kbd> to leave an aside.
                </span>
              </div>
            )}
          </div>
          {!state.focus && (
            <aside className="margin" aria-label="Asides">
              <div className="margin-label">
                <span>ASIDES {threads.length || ""}</span>
                <Button
                  className="text-button"
                  aria-label="Open reading preview"
                  data-inknb-control="preview.open"
                  onPress={() => void session.command("preview")}
                >
                  Preview
                </Button>
              </div>
              {state.composer ? (
                <div
                  className="new-aside thread-card"
                  style={
                    {
                      "--draft-top": `${Math.max(32, railTop - 40)}px`,
                    } as CSSProperties
                  }
                >
                  <div className="thread-heading">
                    <span className="eyebrow">A thought for your agent</span>
                    <IconButton
                      icon={X}
                      label="Cancel aside"
                      agentControl="aside.cancel"
                      onPress={() =>
                        session.update({
                          composer: false,
                          composerAnchor: null,
                        })
                      }
                    />
                  </div>
                  <p className="composer-context">
                    {(state.composerAnchor ?? state.selection).to >
                    (state.composerAnchor ?? state.selection).from
                      ? state.text.slice(
                          (state.composerAnchor ?? state.selection).from,
                          (state.composerAnchor ?? state.selection).to,
                        )
                      : "At your cursor"}
                  </p>
                  <Composer />
                </div>
              ) : activeThread &&
                (state.preferences.placement === "margin" ||
                  activeThread.anchor.status === "detached") ? (
                <div
                  className="active-thread"
                  style={{ "--aside-top": `${railTop}px` } as CSSProperties}
                >
                  <Conversation identity={activeThread.id} />
                </div>
              ) : (
                <div className="thread-index">
                  {threads.length ? (
                    threads.map((thread) => (
                      <Button
                        key={thread.id}
                        className="thread-preview"
                        data-inknb-control={`thread:${thread.id}`}
                        onPress={() => session.selectThread(thread.id)}
                      >
                        <span
                          className={`preview-marker ${threadHasStaleSources(thread) || thread.anchor.status === "detached" ? "stale" : thread.resolved ? "resolved" : ""}`}
                        />{" "}
                        <span>
                          <span className="preview-quote">
                            {thread.anchor.status === "detached" &&
                              "Unattached: "}
                            {thread.originalQuote || "At the cursor"}
                          </span>
                          <span className="preview-message">
                            {thread.messages.at(-1)?.content}
                          </span>
                        </span>
                        <ChevronRight size={13} />
                      </Button>
                    ))
                  ) : (
                    <div className="margin-empty">
                      <MessageSquarePlus size={22} strokeWidth={1.2} />
                      <p>
                        A place for the
                        <br />
                        thought beside the text.
                      </p>
                      <Button
                        className="text-button"
                        onPress={() => session.startComment()}
                      >
                        Leave an aside <Plus size={12} />
                      </Button>
                    </div>
                  )}
                  {state.metadata.threads.some((thread) => thread.resolved) && (
                    <Button
                      className="text-button resolved-toggle"
                      onPress={() => setShowResolved(!showResolved)}
                    >
                      {showResolved ? "Hide resolved" : "Show resolved"}
                    </Button>
                  )}
                </div>
              )}
            </aside>
          )}
        </main>
        <footer className="statusbar">
          <span className="brand">ink and butter</span>
          <span className="save-status" aria-live="polite">
            {state.saving
              ? "Saving…"
              : state.status || (state.dirty ? "Unsaved" : "")}
          </span>
          <span className="status-spacer" />
          {state.metadata.binding ? (
            <MenuTrigger>
              <Button
                className="connection-status connected"
                aria-label="Agent connection"
              >
                <span className="status-dot" />
                {state.metadata.binding.label}
              </Button>
              <Popover className="document-menu" placement="top end" offset={8}>
                <Menu
                  aria-label="Agent connection"
                  onAction={() => {
                    void session
                      .bind(null, state.metadata.documentId)
                      .catch((error) => session.fail(error));
                  }}
                >
                  <MenuItem id="disconnect">Disconnect agent</MenuItem>
                </Menu>
              </Popover>
            </MenuTrigger>
          ) : (
            <span className="connection-status">No agent yet</span>
          )}
          <span className="word-count">
            {wordCount.toLocaleString()} {wordCount === 1 ? "word" : "words"}
          </span>
          <Button
            className="focus-exit"
            data-inknb-control="focus.leave"
            onPress={() => void session.command("focus")}
          >
            Leave focus <Focus size={13} />
          </Button>
        </footer>
      </section>
      {!state.focus && state.previewMode !== "closed" && (
        <Suspense
          fallback={
            <aside className="preview-panel" aria-label="Reading preview">
              <p className="quiet-note">Loading preview…</p>
            </aside>
          }
        >
          <Preview />
        </Suspense>
      )}
      {active && state.settings && <Settings />}
    </div>
  );
}

function App() {
  const restoreWritingFocus = useRef(false);
  const [compact, setCompact] = useState(
    () => window.matchMedia("(max-width: 980px)").matches,
  );
  const library = useSyncExternalStore(
    workspace.subscribe,
    workspace.getSnapshot,
  );
  useEffect(() => {
    if (library.sidebarOpen || !restoreWritingFocus.current) return;
    restoreWritingFocus.current = false;
    workspace.active?.restoreFocus();
  }, [library.sidebarOpen]);
  useEffect(() => {
    void workspace.initialize();
  }, []);
  useEffect(() => {
    const query = window.matchMedia("(max-width: 980px)");
    const resize = () => setCompact(query.matches);
    query.addEventListener("change", resize);
    return () => query.removeEventListener("change", resize);
  }, []);
  useEffect(() => {
    const subscriptions = [
      getCurrentWindow().onResized(() => {
        const session = workspace.active;
        if (session?.getSnapshot().previewMode !== "fullscreen") return;
        void getCurrentWindow()
          .isFullscreen()
          .then((fullscreen) => {
            if (!fullscreen) void session.command("preview-fullscreen-ended");
          });
      }),
      listen<string>(
        "inknb-menu",
        (event) =>
          void workspace
            .command(event.payload)
            .catch((error) => workspace.fail(error)),
      ),
      listen<string>(
        "inknb-open",
        (event) =>
          void workspace
            .openDocument(event.payload)
            .catch((error) => workspace.fail(error)),
      ),
      listen<{ id: string; method: string; params: unknown }>(
        "inknb-control",
        (event) => {
          void workspace
            .control(event.payload.method, event.payload.params)
            .then(
              (result) =>
                invoke("complete_control", {
                  requestId: event.payload.id,
                  result,
                  error: null,
                }),
              (error) =>
                invoke("complete_control", {
                  requestId: event.payload.id,
                  result: null,
                  error: error instanceof Error ? error.message : String(error),
                }),
            );
        },
      ),
    ];
    const polling = setInterval(() => {
      for (const session of workspace.sessions.values())
        void session.checkFiles();
    }, 1800);
    const shortcut = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        !(event.metaKey || event.ctrlKey) ||
        event.altKey
      )
        return;
      const key = event.key.toLowerCase();
      const command =
        key === "["
          ? "back"
          : key === "]"
            ? "forward"
            : key === "s"
              ? event.shiftKey
                ? "save-as"
                : "save"
              : key === "o"
                ? "open"
                : key === "n"
                  ? "new"
                  : key === ","
                    ? "settings"
                    : key === "a" && event.shiftKey
                      ? "comment"
                      : key === "f" && event.shiftKey
                        ? "focus"
                        : null;
      if (!command) return;
      event.preventDefault();
      void workspace.command(command).catch((error) => workspace.fail(error));
    };
    window.addEventListener("keydown", shortcut, true);
    return () => {
      clearInterval(polling);
      window.removeEventListener("keydown", shortcut, true);
      for (const subscription of subscriptions)
        void subscription.then((unlisten) => unlisten());
    };
  }, []);
  if (!library.ready)
    return (
      <div className="startup-state">
        {library.error ?? "Opening your writing…"}
      </div>
    );
  const active = workspace.active?.getSnapshot();
  const sidebar =
    library.sidebarOpen &&
    !active?.focus &&
    active?.previewMode !== "fullscreen";
  return (
    <div
      className={`library-shell ${sidebar && !compact ? "library-visible" : ""}`}
    >
      {sidebar && !compact && <Library />}
      <ModalOverlay
        isOpen={sidebar && compact}
        onOpenChange={(open) => workspace.update({ sidebarOpen: open })}
        isDismissable
        className="modal-overlay library-overlay"
      >
        <Modal className="library-modal">
          <Dialog aria-label="Document library">
            <Library
              onNavigate={() => {
                restoreWritingFocus.current = true;
                workspace.update({ sidebarOpen: false });
              }}
            />
          </Dialog>
        </Modal>
      </ModalOverlay>
      <div className="document-stack">
        {library.error && (
          <div className="notice" role="alert">
            {library.error}
            <Button
              className="text-button"
              onPress={() => workspace.update({ error: null })}
            >
              Dismiss
            </Button>
          </div>
        )}
        {[...workspace.sessions].map(([identity, session]) => (
          <div
            className="document-container"
            key={identity}
            hidden={identity !== library.activeId}
          >
            <SessionContext value={session}>
              <DocumentApp active={identity === library.activeId} />
            </SessionContext>
          </div>
        ))}
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
