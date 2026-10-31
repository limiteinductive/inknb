import { DecisionCard } from "./Decisions";
import { useAutoHideScrollbar } from "./use-auto-hide-scrollbar";
import { agentAttribution, messageSummary, defaultAgent, proposalTurnId } from "./domain";
import { focusAside, revealAsideComposer } from "./aside-focus";
import {
  Fragment,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  Button,
  Tooltip,
  TooltipTrigger,
  Popover,
  MenuTrigger,
  Menu,
  MenuItem,
} from "react-aria-components";
import {
  Check,
  CheckCheck,
  Clock3,
  CircleAlert,
  Send,
  Copy,
  CopyCheck,
  ChevronDown,
  Ellipsis,
  RotateCcw,
  CornerDownRight,
  FileText,
  Table2,
  MessageSquare,
  X,
} from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import ComponentHost from "./ComponentHost";
import PreviewCapture from "./PreviewCapture";
import AttachedImage from "./AttachedImage";
import AgentResponse from "./AgentResponse";
import { clipboardImages, importImages } from "./images";
import type { AgentRequest, Message, Proposal, Source } from "./domain";
import { threadActivity } from "./domain";
import {
  asideVisible,
  asideExpanded,
  resolvableAsides,
} from "./aside-state";
import {
  asideDetailsSchema,
  asideLink,
} from "./aside-reference";
import type { AsideConnection } from "./aside-reference";
import { SessionContext, useAsideSession, useAsideState } from "./use-session";
import {
  currentSuggestions,
  visibleSuggestions,
  reviewSuggestion,
} from "./suggestions";
import IconButton from "./IconButton";
import ReferenceEditor from "./ReferenceEditor";
import PassageText from "./PassageText";
import AnnotationContext from "./AnnotationContext";
import CommentRecipients from "./CommentRecipients";

function AsidePassage({ threadId }: { threadId?: string }) {
  const session = useAsideSession();
  const state = useAsideState();
  const documentSession = useContext(SessionContext);
  const thread = threadId
    ? state.metadata.threads.find((thread) => thread.id === threadId)
    : null;
  const anchor = threadId ? thread?.anchor : state.composerAnchor;
  const preview = threadId
    ? thread?.previewAnchor
    : state.composerPreviewAnchor;
  if (!anchor && !preview) return null;
  const quote = anchor?.native?.region
    ? "Selected image region"
    : anchor && anchor.status !== "detached" && documentSession?.view
      ? documentSession.view.passageText(anchor)
      : preview?.quote || anchor?.quote || thread?.originalQuote || "";
  let tableTitle = "";
  if (anchor?.native && anchor.native.from.identity === anchor.native.to.identity) {
    documentSession?.model?.state.doc.descendants(node => {
      if (node.type.name !== "table" || node.attrs.identity !== anchor.native!.from.identity) return;
      tableTitle = node.firstChild?.firstChild?.textContent || "Table";
      return false;
    });
  }
  return (
    <button
      type="button"
      className="aside-passage annotation-context-source"
      aria-label={tableTitle ? `Show table: ${tableTitle}` : `Show passage: ${quote || "This position"}`}
      title={quote || "This position"}
      data-inknb-control={`aside.passage:${threadId ?? "new"}`}
      onClick={() => {
        if (!window.getSelection()?.isCollapsed) return;
        if (preview) session.revealPreview(preview);
        else if (threadId) session.revealSource(threadId);
        else if (anchor && anchor.status !== "detached") documentSession?.surface?.scrollToSource(anchor.from, anchor);
      }}
    >
      {tableTitle && <Table2 size={14} strokeWidth={1.6} aria-hidden="true" />}
      <span className="annotation-context-label">{tableTitle || quote || "This position"}</span>
    </button>
  );
}

function Composer({
  threadId,
  onClose,
}: {
  threadId?: string;
  onClose?: () => void;
}) {
  const session = useAsideSession();
  const state = useAsideState();
  const draftKey = threadId ?? "new";
  const { content, images, annotations = [] } = state.drafts[draftKey] ?? {
    content: "",
    images: [],
  };
  const textarea = useRef<HTMLElement>(null);
  const composerContent = useRef<HTMLDivElement>(null);
  useAutoHideScrollbar(composerContent);
  useLayoutEffect(() => {
    if (threadId) return;
    const element = textarea.current;
    if (!element) return;
    return revealAsideComposer(
      element,
      session.getSnapshot().preferences.reduce_motion,
    );
  }, [threadId, session]);
  const [sending, setSending] = useState(false);
  const [pasting, setPasting] = useState(0);
  async function send() {
    if (sending || pasting || (!content.trim() && !images.length && !annotations.length)) return;
    setSending(true);
    try {
      await session.comment(content, threadId);
    } catch (error) {
      session.fail(error);
    } finally {
      setSending(false);
    }
  }
  return (
    <form
      className="composer"
      data-inknb-control={`composer:${draftKey}`}
      onSubmit={(event) => {
        event.preventDefault();
        void send();
      }}
    >
      {!threadId && <AsidePassage />}
      <CommentRecipients
        metadata={state.metadata}
        preferences={state.preferences}
        draft={state.drafts[draftKey]}
        threadId={threadId}
        controlId={draftKey}
        disabled={sending}
        onChange={recipientAgentIds => session.update({ drafts: { ...state.drafts, [draftKey]: { ...state.drafts[draftKey], content, images, recipientAgentIds, recipientAgentId: undefined } } })}
      />
      <div
        className="composer-content"
        ref={composerContent}
        data-inknb-control={`composer.scroll:${draftKey}`}
        data-inknb-scroll="true"
      >
        {annotations.length > 0 && <AnnotationContext annotations={annotations} onRemove={id => textarea.current?.dispatchEvent(new CustomEvent("inknb-remove-annotation", { detail: id }))} />}
        <ReferenceEditor
          preferences={state.preferences}
          annotations={annotations}
          content={content}
          references={state.drafts[draftKey]?.references}
          elementRef={textarea}
          control={`composer.input:${draftKey}`}
          label={threadId ? "Reply to conversation" : "Request to your agent"}
          placeholder={threadId ? "Reply…" : "Write your aside…"}
          onChange={(content, references, annotations) => {
            const current = session.getSnapshot();
            session.update({ drafts: { ...current.drafts, [draftKey]: { ...current.drafts[draftKey], content, references, annotations, images: current.drafts[draftKey]?.images ?? [] } } });
          }}
          onSend={() => void send()}
          onClose={() => {
            if (onClose) onClose();
            else if (threadId) session.collapseThread(threadId, true);
            else {
              session.update({ composer: false, composerAnchor: null, composerPreviewAnchor: null });
              session.restoreFocus();
            }
          }}
            onPaste={(event) => {
              const files = clipboardImages(event.clipboardData);
              if (!files.length) return;
              event.preventDefault();
              const documentId = state.metadata.documentId;
              setPasting((count) => count + 1);
              void importImages(files)
                .then((imported) => {
                  const current = session.getSnapshot();
                  if (current.metadata.documentId !== documentId)
                    throw Error(
                      "The document changed before the image paste finished.",
                    );
                  const draft = current.drafts[draftKey] ?? {
                    content: "",
                    images: [],
                  };
                  session.update({
                    drafts: {
                      ...current.drafts,
                      [draftKey]: {
                        ...draft,
                        images: [...draft.images, ...imported],
                      },
                    },
                  });
                })
                .catch((error) => session.fail(error))
                .finally(() => setPasting((count) => count - 1));
            }}
        />
        {images.length > 0 && (
          <div className="attached-images">
            {images.map((image, index) => (
              <div className="attached-image" key={`${image.id}:${index}`}>
                <AttachedImage image={image} />
                <IconButton
                  icon={X}
                  label={`Remove ${image.name}`}
                  onPress={() => {
                    const current = session.getSnapshot();
                    const draft = current.drafts[draftKey];
                    if (draft)
                      session.update({
                        drafts: {
                          ...current.drafts,
                          [draftKey]: {
                            ...draft,
                            images: draft.images.filter(
                              (_, position) => position !== index,
                            ),
                          },
                        },
                      });
                  }}
                />
              </div>
            ))}
          </div>
        )}
      </div>
      {pasting > 0 && (
        <p className="quiet-note" role="status">
          Adding image…
        </p>
      )}
    </form>
  );
}

function DeliveryReceipt({ request, named = false }: { request: AgentRequest; named?: boolean }) {
  const state = useAsideState();
  const recipient = request.binding ?? defaultAgent(state.metadata);
  const label = request.state === "failed"
    ? "Not sent"
    : request.state === "sending"
      ? "Sending"
      : request.state === "pending"
        ? recipient ? "Queued" : "Saved"
        : request.state === "delivered" ? "Sent" : "Replied";
  const Icon = request.state === "failed"
    ? CircleAlert
    : request.state === "sending"
      ? Send
      : request.state === "pending"
        ? Clock3
        : request.state === "delivered" ? Check : CheckCheck;
  return (
    <div className={`delivery ${request.state}`}>
      <span className="delivery-receipt" role="status">
        <Icon size={14} strokeWidth={1.6} aria-hidden="true" />
        {named ? `${agentAttribution(recipient)}: ${label}` : label}
      </span>
      {request.state === "failed" && request.error && (
        <details className="inspection">
          <summary>Details</summary>
          <p>{request.error}</p>
        </details>
      )}
    </div>
  );
}

function SourceChip({ source }: { source: Source }) {
  const session = useAsideSession();
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

export function Conversation({
  identity,
  onClose,
}: {
  identity: string;
  onClose?: () => void;
}) {
  const session = useAsideSession();
  const documentSession = useContext(SessionContext);
  const state = useAsideState();
  const card = useRef<HTMLElement>(null);
  const conversationScroll = useRef<HTMLDivElement>(null);
  useAutoHideScrollbar(conversationScroll);
  const previousMessage = useRef<{ threadId: string; messageId: string } | null>(null);
  const followMessages = useRef(true);
  const [copiedReference, setCopiedReference] = useState<string | null>(null);
  const [references, setReferences] = useState<AsideConnection[]>([]);
  const thread = state.metadata.threads.find(
    (thread) => thread.id === identity,
  );
  const activity = thread ? threadActivity(state.metadata, thread) : null;
  const latestMessage = thread?.messages.at(-1);
  useLayoutEffect(() => {
    const viewport = conversationScroll.current;
    if (!viewport || !thread || !latestMessage) return;
    const first = previousMessage.current?.threadId !== identity;
    if (!first && previousMessage.current?.messageId === latestMessage.id) return;
    previousMessage.current = { threadId: identity, messageId: latestMessage.id };
    if (!first && !followMessages.current && latestMessage.author !== "human") return;
    const target = first
      ? thread.messages.filter((message) => message.author === "human").at(-1) ?? latestMessage
      : latestMessage;
    const element = viewport.querySelector<HTMLElement>(`[data-message-id="${target.id}"]`);
    if (element)
      viewport.scrollTop += element.getBoundingClientRect().top - viewport.getBoundingClientRect().top;
  }, [identity, latestMessage?.id]);
  useEffect(() => {
    if (!copiedReference) return;
    const timer = setTimeout(() => setCopiedReference(null), 2000);
    return () => clearTimeout(timer);
  }, [copiedReference]);
  useEffect(() => {
    let current = true;
    void session
      .control("aside_read", {
        documentId: state.metadata.documentId,
        threadId: identity,
      })
      .then((details) => {
        if (current)
          setReferences(asideDetailsSchema.parse(details).references);
      })
      .catch((error) => {
        if (current) session.fail(error);
      });
    return () => {
      current = false;
    };
  }, [session, identity, state.metadata, state.activeThread]);
  useEffect(() => {
    const element = card.current;
    if (!element || activity === null) return;
    const displayedActivity = activity;
    let visible = false;
    function acknowledge() {
      if (
        visible &&
        document.hasFocus() &&
        document.visibilityState === "visible"
      )
        session.markThreadRead(identity, displayedActivity);
    }
    const observer = new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting;
      acknowledge();
    });
    const latestAgent = thread?.messages
      .filter((message) => message.author === "agent")
      .at(-1);
    observer.observe(
      (latestAgent &&
        element.querySelector(`[data-message-id="${latestAgent.id}"]`)) ||
        element,
    );
    window.addEventListener("focus", acknowledge);
    document.addEventListener("visibilitychange", acknowledge);
    return () => {
      observer.disconnect();
      window.removeEventListener("focus", acknowledge);
      document.removeEventListener("visibilitychange", acknowledge);
    };
  }, [session, identity, activity]);
  if (!thread) return null;
  const requests = state.metadata.requests.filter(
    (request) => request.threadId === identity,
  );
  const latest = requests.at(-1);
  const proposals = state.metadata.proposals.filter(
    (proposal) =>
      proposal.threadId === identity && proposal.status !== "superseded",
  );
  const turnProposals = state.metadata.proposals.filter((proposal) => proposal.status !== "superseded" && (
    proposal.threadId === identity ||
    state.metadata.requests.some((request) => request.id === proposal.requestId && request.threadId === identity) ||
    state.metadata.threads.find((owner) => owner.id === proposal.threadId)?.links.some((link) => link.relation === "suggestion_for" && link.documentId === state.metadata.documentId && link.threadId === identity)
  ));
  const turns: { id: string | null; messages: Message[]; proposals: Proposal[] }[] = [];
  for (const message of thread.messages) {
    if (message.author === "human" || !turns.length)
      turns.push({ id: message.id, messages: [], proposals: [] });
    turns.at(-1)!.messages.push(message);
  }
  for (const proposal of turnProposals) {
    const turnId = proposalTurnId(state.metadata, proposal, thread);
    let turn = turns.find((turn) => turn.messages.some((message) => message.id === turnId));
    if (!turn) {
      turn = turns.find((turn) => turn.id === null);
      if (!turn) {
        turn = { id: null, messages: [], proposals: [] };
        turns.unshift(turn);
      }
    }
    turn.proposals.push(proposal);
  }
  const conversationReferences = references.filter((reference) => reference.documentId !== state.metadata.documentId || !turnProposals.some((proposal) => proposal.threadId === reference.threadId));
  const shown = visibleSuggestions(state);
  const pending = proposals.filter((proposal) => proposal.status === "pending");
  const passage =
    pending.find((proposal) =>
      shown.some((candidate) => candidate.id === proposal.id),
    ) ?? pending.at(-1);
  const quote = thread.anchor?.native?.region
    ? ""
    : thread.anchor?.status === "attached" && documentSession?.view
      ? documentSession.view.passageText(thread.anchor)
      : thread.originalQuote;
  const firstMessage = thread.messages[0];
  const collapse = (
    <TooltipTrigger delay={500}>
      <Button
        className="aside-collapse"
        aria-label="Collapse aside"
        aria-expanded={true}
        data-inknb-control={`conversation.collapse:${identity}`}
        onPress={() => (onClose ? onClose() : session.collapseThread(identity))}
      >
        <ChevronDown size={15} strokeWidth={1.6} aria-hidden="true" />
      </Button>
      <Tooltip className="control-tooltip" offset={7}>
        Collapse aside
        {firstMessage && (
          <time dateTime={firstMessage.createdAt}>
            {" "}
            · {new Date(firstMessage.createdAt).toLocaleString()}
          </time>
        )}
      </Tooltip>
    </TooltipTrigger>
  );
  const actions = (
    <div className="aside-actions">
      <IconButton
        icon={copiedReference === identity ? CopyCheck : Copy}
        label={
          copiedReference === identity
            ? "Aside reference copied"
            : "Copy aside reference"
        }
        active={copiedReference === identity}
        agentControl={`aside.copy:${identity}`}
        onPress={() => {
          const excerpt =
            quote || messageSummary(thread.messages.at(-1)) || "Whole document";
          void invoke("clipboard_write", {
            text: `Aside: ${excerpt}\n${asideLink({ documentId: state.metadata.documentId, threadId: identity })}`,
          })
            .then(() => setCopiedReference(identity))
            .catch((error) =>
              session.fail(
                new Error(`Could not copy the aside reference: ${String(error)}`),
              ),
            );
        }}
      />
      <IconButton
        icon={thread.resolved ? RotateCcw : Check}
        label={thread.resolved ? "Reopen aside" : "Resolve aside"}
        agentControl={`conversation.resolve:${identity}`}
        onPress={() => session.resolve(identity, !onClose)}
      />
      <MenuTrigger>
        <Button
          className="icon-button"
          aria-label="Aside actions"
          data-inknb-control={`aside.actions:${identity}`}
        >
          <Ellipsis size={17} strokeWidth={1.6} aria-hidden="true" />
        </Button>
        <Popover
          className="aside-actions-popover"
          placement="bottom end"
          offset={5}
        >
          <Menu className="aside-menu" aria-label="Aside actions">
            <MenuItem
              id="resolve-all"
              data-inknb-control="asides.resolve-all"
              isDisabled={!resolvableAsides(state.metadata).length}
              onAction={() =>
                void session.resolveAll().catch((error) => session.fail(error))
              }
            >
              Resolve all asides in document
            </MenuItem>
            {((thread.anchor && thread.anchor.status !== "detached") ||
              thread.previewAnchor) && (
              <MenuItem
                id="passage"
                data-inknb-control={`thread.passage:${thread.id}`}
                onAction={() => {
                  if (thread.previewAnchor)
                    session.revealPreview(thread.previewAnchor);
                  else if (state.previewHost === "detached")
                    session.selectThread(identity);
                  else session.revealSource(identity);
                }}
              >
                Show passage
              </MenuItem>
            )}
            {thread.anchor && !thread.resolved && (
              <MenuItem
                id="move-passage"
                data-inknb-control={`aside.reanchor:${identity}`}
                isDisabled={state.selection.from === state.selection.to}
                onAction={() => session.reanchor(identity)}
              >
                Move aside to selected text
              </MenuItem>
            )}
          </Menu>
        </Popover>
      </MenuTrigger>
    </div>
  );
  return (
    <section
      ref={card}
      tabIndex={passage ? 0 : undefined}
      data-suggestion-active={
        passage && state.activeThread === identity ? true : undefined
      }
      className={`margin-note ${thread.resolved ? "resolved" : ""}`}
      id={`conversation-${thread.id}`}
      data-inknb-control={`conversation:${thread.id}`}
      onFocusCapture={() => {
        if (state.activeThread !== identity) session.selectThread(identity);
      }}
      onPointerDownCapture={() => {
        if (state.activeThread !== identity) session.selectThread(identity);
      }}
      aria-label={`Aside: ${quote || messageSummary(thread.messages[0]) || "Whole document"}`}
    >
      <div className="aside-card-heading">
        {collapse}
        {actions}
      </div>
      <div
        ref={conversationScroll}
        className="aside-conversation-scroll"
        role="region"
        aria-label="Conversation messages"
        tabIndex={0}
        data-inknb-control={`conversation.scroll:${identity}`}
        data-inknb-scroll="true"
        onScroll={(event) => {
          const viewport = event.currentTarget;
          followMessages.current = viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop <= 48;
        }}
      >
      <AsidePassage threadId={identity} />

      {thread.resolution && (
        <p className="aside-resolution">
          {thread.resolution.actor}: {thread.resolution.reason}
        </p>
      )}

      {thread.previewAnchor?.capture && (
        <details className="aside-context">
          <summary>Selected region</summary>
          <PreviewCapture capture={thread.previewAnchor.capture} />
        </details>
      )}
      {quote && thread.anchor?.status !== "attached" && (
        <details className="aside-context">
          <summary>Original passage</summary>
          <p className="anchor-quote">{quote}</p>
          {!thread.resolved &&
            thread.anchorSuggestions.map((candidate) => (
              <Button
                className="anchor-candidate"
                key={candidate.id}
                onPress={() => {
                  if (
                    session
                      .getSnapshot()
                      .text.slice(
                        candidate.anchor.from,
                        candidate.anchor.to,
                      ) !== candidate.anchor.quote
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
        </details>
      )}
      <div className="messages" id={`messages-${thread.id}`}>
        {turns.map((turn) => (
          <Fragment key={turn.id ?? "earlier-edits"}>
        {turn.messages.map((message) => {
          const messageRequests = message.author === "human"
            ? requests.filter((request) =>
                request.trigger.kind === "human" && request.messageId === message.id,
              )
            : [];
          return (
          <article
            className={`message ${message.author}`}
            data-message-id={message.id}
            aria-label={message.author === "human" ? "Your message" : `Message from ${agentAttribution(message.agent)}`}
            key={message.id}
          >
            {message.author === "agent" && (
              <div className="message-heading">
                  <TooltipTrigger delay={500}>
                    <Button className="message-author">
                      {agentAttribution(message.agent)}
                    </Button>
                    <Tooltip className="control-tooltip" offset={7}>
                      <time dateTime={message.createdAt}>
                        {new Date(message.createdAt).toLocaleString()}
                      </time>
                    </Tooltip>
                  </TooltipTrigger>
              </div>
            )}
            {message.annotations?.length ? <AnnotationContext annotations={message.annotations} /> : null}
            {message.author === "agent" ? (
              <AgentResponse message={message} />
            ) : (
              message.content && <PassageText message={message} />
            )}

            {message.images.length > 0 && (
              <div className="attached-images">
                {message.images.map((image, index) => (
                  <div className="attached-image" key={`${image.id}:${index}`}>
                    <AttachedImage image={image} />
                  </div>
                ))}
              </div>
            )}
            {message.sources.length > 0 && (
              <div className="sources">
                {message.sources.map((source) => (
                  <SourceChip key={source.id} source={source} />
                ))}
              </div>
            )}
            {messageRequests.map(request => <DeliveryReceipt key={request.id} request={request} named={messageRequests.length > 1} />)}
          </article>
          );
        })}
        {turn.proposals.length > 0 && (
          <details className="turn-edits" data-turn-id={turn.id ?? "earlier-edits"}>
            <summary data-inknb-control={`turn.edits:${identity}:${turn.id ?? "earlier"}`}>
              {turn.id === null && thread.messages.length > 0 && "Earlier edits · "}
              {(["applied", "pending", "conflict", "rejected", "undone", "withdrawn"] as const).map((status) => {
                const count = turn.proposals.filter((proposal) => proposal.status === status).length;
                const label = { applied: "applied", pending: "pending", conflict: "out of date", rejected: "dismissed", undone: "undone", withdrawn: "withdrawn" }[status];
                return count ? `${count} ${count === 1 ? "edit" : "edits"} ${label}` : null;
              }).filter(Boolean).join(" · ")}
            </summary>
            <div className="turn-edit-list">
              {turn.proposals.map((proposal) => (
                <div className="turn-edit" key={proposal.id}>
                  <p>{proposal.explanation}</p>
                  {["pending", "conflict"].includes(proposal.status) && (
                    <Button
                      className="text-button"
                      data-inknb-control={`proposal.review:${proposal.id}`}
                      onPress={() => currentSuggestions(state).some((current) => current.id === proposal.id)
                        ? reviewSuggestion(proposal.id, session)
                        : void session.proposal(proposal.id, false).catch((error) => session.fail(error))}
                    >
                      {currentSuggestions(state).some((current) => current.id === proposal.id) ? "Show in document" : "Dismiss earlier suggestion"}
                    </Button>
                  )}
                </div>
              ))}
            </div>
          </details>
        )}
          </Fragment>
        ))}
      </div>
      {conversationReferences.length > 0 && (
        <div className="aside-references">
          {conversationReferences.map((reference, position) => (
            <Button
              key={`${reference.documentId}:${reference.threadId}:${position}`}
              className="aside-reference"
              aria-label={`${reference.relation}: ${reference.label}`}
              onPress={() => {
                try {
                  session.openAside(reference);
                } catch (error) {
                  session.fail(error);
                }
              }}
            >
              <CornerDownRight size={13} aria-hidden="true" />
              <span>{reference.label}</span>
            </Button>
          ))}
        </div>
      )}
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
      {latest && latest.trigger.kind !== "human" && latest.state !== "answered" && (
        <DeliveryReceipt request={latest} />
      )}
      </div>
      {(!thread.resolved ||
        state.drafts[identity]?.content ||
        state.drafts[identity]?.images.length) && (
        <Composer threadId={identity} onClose={onClose} />
      )}
    </section>
  );
}

export default function Asides({ historyOpen }: { historyOpen: boolean }) {
  const session = useAsideSession();
  const state = useAsideState();
  const decisions = state.metadata.decisions.filter(decision => ["open", "answered"].includes(decision.status));
  const threads = state.metadata.threads.filter(thread => asideVisible(state, thread));
  return (
    <aside className="margin" aria-label="Asides" data-reading="true">
      <div
        className="thread-index"
        role="region"
        aria-label="Aside conversations"
        data-inknb-control="asides"
        data-inknb-scroll="true"
      >
        <div className="aside-canvas">
          {state.composer && !historyOpen && (
              <div
                className="new-aside margin-note"
                data-aside-id="new"
                data-expanded="true"
                onPointerEnter={(event) =>
                  focusAside(event.currentTarget, "new")
                }
                onPointerLeave={(event) =>
                  focusAside(event.currentTarget, null)
                }
              >
                {state.composerPreviewAnchor?.capture && (
                  <PreviewCapture
                    capture={state.composerPreviewAnchor.capture}
                  />
                )}
                <Composer />
              </div>
            )}
          {decisions.map((decision) => (
            <div
              className="decision-note"
              data-aside-id={decision.id}
              data-expanded="true"
              data-decision-card="true"
              key={decision.id}
            >
              <DecisionCard decision={decision} />
            </div>
          ))}
          {threads.length
            ? threads.map((thread) => {
                const expanded = !historyOpen && asideExpanded(state, thread);
                const content = expanded ? (
                  <Conversation identity={thread.id} />
                ) : (
                  <Button
                    className="inline-aside-summary"
                    aria-label={`Open aside: ${messageSummary(thread.messages.at(-1)) || thread.originalQuote}`}
                    aria-expanded={false}
                    data-inknb-control={`thread:${thread.id}`}
                    onPress={() => session.selectThread(thread.id)}
                  >
                    <MessageSquare size={14} aria-hidden="true" />
                    <span>{messageSummary(thread.messages.at(-1)) || thread.originalQuote}</span>
                    {session.hasUnreadActivity(thread.id) && <span className="aside-unread" />}
                  </Button>
                );
                return (
                  <div
                    className="passage-aside"
                    onPointerEnter={(event) =>
                      focusAside(event.currentTarget, thread.id)
                    }
                    onPointerLeave={(event) =>
                      focusAside(event.currentTarget, null)
                    }
                    onFocusCapture={(event) =>
                      focusAside(event.currentTarget, thread.id)
                    }
                    onBlurCapture={(event) => {
                      if (!event.currentTarget.contains(event.relatedTarget))
                        focusAside(event.currentTarget, null);
                    }}
                    data-expanded={expanded || undefined}
                    data-aside-id={thread.id}
                    data-active={state.activeThread === thread.id || undefined}
                    key={thread.id}
                  >
                    {content}
                  </div>
                );
              })
            : null}

        </div>
      </div>
    </aside>
  );
}
