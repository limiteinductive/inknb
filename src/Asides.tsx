import { DecisionCard } from "./Decisions";
import { useAutoHideScrollbar } from "./use-auto-hide-scrollbar";
import { agentAttribution, messageSummary, defaultAgent, requestAgentId, proposalTurnId } from "./domain";
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
  MessageSquare,
  PencilLine,
  History,
  Pin,
  PinOff,
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
  asideOutdated,
  asideInline,
  resolvableAsides,
} from "./aside-state";
import {
  asideDetailsSchema,
  asideLink,
} from "./aside-reference";
import type { AsideConnection } from "./aside-reference";
import { SessionContext, useAsideSession, useAsideState } from "./use-session";
import { documentScroll } from "./document-scroll";
import { asidePassages } from "./aside-locations";
import type { AsideGeometry } from "./aside-locations";
import {
  currentSuggestions,
  visibleSuggestions,
  reviewSuggestion,
} from "./suggestions";
import IconButton from "./IconButton";
import ReferenceEditor from "./ReferenceEditor";
import PassageText from "./PassageText";
import AnnotationContext from "./AnnotationContext";

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
  if (!anchor && !preview) return <p className="aside-scope">Whole document</p>;
  const quote = anchor?.native?.region
    ? "Selected image region"
    : anchor && anchor.status !== "detached" && documentSession?.view
      ? documentSession.view.passageText(anchor)
      : preview?.quote || anchor?.quote || thread?.originalQuote || "";
  return (
    <div className="aside-passage">
      <details>
        <summary aria-label={`Aside about: ${quote || "This position"}`}>
          <CornerDownRight size={13} aria-hidden="true" />
          <span>{quote || "This position"}</span>
        </summary>
        <p>{quote || "This aside is attached to an insertion point."}</p>
      </details>
      {(preview || anchor?.status !== "detached") && (
        <Button
          className="text-button"
          data-inknb-control={`aside.passage:${threadId ?? "new"}`}
          onPress={() => {
            if (preview) session.revealPreview(preview);
            else if (threadId) session.revealSource(threadId);
            else if (anchor && anchor.status !== "detached") {
              documentSession?.surface?.scrollToSource(anchor.from, anchor);
            }
          }}
        >
          Show passage
        </Button>
      )}
    </div>
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
  const recipientId = requestAgentId(
    state.metadata,
    threadId,
    state.drafts[draftKey]?.recipientAgentId,
  );
  const disconnectedRecipient = Boolean(
    recipientId &&
    !state.metadata.agents.some((agent) => agent.id === recipientId),
  );
  const recipientLabel = disconnectedRecipient
    ? "Disconnected recipient"
    : agentAttribution(state.metadata.agents.find((agent) => agent.id === recipientId));
  const textarea = useRef<HTMLElement>(null);
  const composerContent = useRef<HTMLDivElement>(null);
  useAutoHideScrollbar(composerContent);
  const recipientTrigger = useRef<HTMLButtonElement>(null);
  const [recipientOpen, setRecipientOpen] = useState(false);
  const recipientWasOpen = useRef(false);
  useLayoutEffect(() => {
    if (recipientWasOpen.current && !recipientOpen)
      queueMicrotask(() => recipientTrigger.current?.focus({ preventScroll: true }));
    recipientWasOpen.current = recipientOpen;
  }, [recipientOpen]);
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
      {(state.metadata.agents.length > 1 || disconnectedRecipient) && (
        <MenuTrigger isOpen={recipientOpen} onOpenChange={setRecipientOpen}>
          <Button
            ref={recipientTrigger}
            className="text-button recipient-trigger"
            aria-label={`Send to agent: ${recipientLabel}`}
            data-inknb-control={`recipient.open:${draftKey}`}
          >
            <span>{recipientLabel}</span>
            <ChevronDown size={12} aria-hidden="true" />
          </Button>
          <Popover className="menu-popover" placement="bottom start" offset={5}>
            <Menu
              className="menu"
              aria-label="Send to agent"
              selectionMode="single"
              disallowEmptySelection
              selectedKeys={recipientId ? [recipientId] : []}
              onSelectionChange={(selection) => {
                if (selection === "all") return;
                const [recipientAgentId] = selection;
                if (typeof recipientAgentId !== "string") return;
                session.update({
                  drafts: {
                    ...state.drafts,
                    [draftKey]: { ...state.drafts[draftKey], content, images, recipientAgentId },
                  },
                });
              }}
            >
              {disconnectedRecipient && (
                <MenuItem id={recipientId!} className="menu-item" isDisabled>
                  Disconnected recipient
                </MenuItem>
              )}
              {state.metadata.agents.map((agent) => (
                <MenuItem
                  key={agent.id}
                  id={agent.id}
                  textValue={agentAttribution(agent)}
                  className="menu-item"
                  data-inknb-control={`recipient.select:${agent.id}`}
                >
                  {({ isSelected }) => (
                    <>
                      <span>{agentAttribution(agent)}</span>
                      {isSelected && <Check size={15} aria-hidden="true" />}
                    </>
                  )}
                </MenuItem>
              ))}
            </Menu>
          </Popover>
        </MenuTrigger>
      )}
      <div
        className="composer-content"
        ref={composerContent}
        data-inknb-control={`composer.scroll:${draftKey}`}
        data-inknb-scroll="true"
      >
        {annotations.length > 0 && <AnnotationContext annotations={annotations} onRemove={id => textarea.current?.dispatchEvent(new CustomEvent("inknb-remove-annotation", { detail: id }))} />}
        <ReferenceEditor
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
      {!defaultAgent(state.metadata) && (
        <p className="quiet-note">Saved locally until your agent joins.</p>
      )}
    </form>
  );
}

function DeliveryReceipt({ request }: { request: AgentRequest }) {
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
        {label}
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
      {!thread.resolved && (thread.anchor || thread.previewAnchor) && (
        <IconButton
          icon={
            state.asideReader.open &&
            state.asideReader.threadIds.includes(identity)
              ? PinOff
              : Pin
          }
          label={
            state.asideReader.open &&
            state.asideReader.threadIds.includes(identity)
              ? "Return aside to margin"
              : "Keep aside visible"
          }
          agentControl={`aside.keep:${identity}`}
          onPress={() => {
            const reader = session.getSnapshot().asideReader;
            const kept = reader.open && reader.threadIds.includes(identity);
            const threadIds = kept
              ? reader.threadIds.filter((threadId) => threadId !== identity)
              : [...new Set([...reader.threadIds, identity])];
            session.selectThread(identity);
            session.update({
              asideReader: {
                ...reader,
                open: !kept || reader.documentNotes || threadIds.length > 0,
                threadIds,
              },
            });
          }}
        />
      )}
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
              id="placement"
              data-inknb-control="asides.placement"
              onAction={() => {
                void session
                  .setPlacement(
                    state.preferences.placement === "inline"
                      ? "margin"
                      : "inline",
                  )
                  .catch((error) => session.fail(error));
              }}
            >
              {state.preferences.placement === "inline"
                ? "Show asides in margin"
                : "Show asides inline"}
            </MenuItem>
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
      {(state.preferences.placement === "inline" ||
        state.asideNarrow ||
        state.asideReader.open ||
        (!thread.anchor && !thread.previewAnchor)) && (
        <AsidePassage threadId={identity} />
      )}
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
          const request = message.author === "human"
            ? requests.filter((request) =>
                request.trigger.kind === "human" && request.messageId === message.id,
              ).at(-1)
            : null;
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
            {request && <DeliveryReceipt request={request} />}
          </article>
          );
        })}
        {turn.proposals.length > 0 && (
          <details className="turn-edits" data-turn-id={turn.id ?? "earlier-edits"}>
            <summary data-inknb-control={`turn.edits:${identity}:${turn.id ?? "earlier"}`}>
              {turn.id === null && thread.messages.length > 0 && "Earlier edits · "}
              {(["applied", "pending", "conflict", "rejected", "undone"] as const).map((status) => {
                const count = turn.proposals.filter((proposal) => proposal.status === status).length;
                const label = { applied: "applied", pending: "pending", conflict: "out of date", rejected: "dismissed", undone: "undone" }[status];
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

export function InlineAside({ identity }: { identity: string }) {
  const session = useAsideSession();
  const state = useAsideState();
  if (identity === "new")
    return state.composer ? (
      <div className="new-aside margin-note">
        <Composer />
      </div>
    ) : null;
  const decision = state.metadata.decisions.find(
    (decision) => decision.id === identity,
  );
  if (decision) return <DecisionCard decision={decision} />;
  const thread = state.metadata.threads.find(
    (thread) => thread.id === identity,
  );
  if (!thread || !asideVisible(state, thread)) return null;
  const expanded = asideExpanded(state, thread);
  const summary =
    messageSummary(thread.messages.at(-1)) || thread.originalQuote || "Aside";
  return (
    <div data-aside-id={identity} data-expanded={expanded || undefined}>
      {expanded ? (
        <Conversation identity={identity} />
      ) : (
        <Button
          className="inline-aside-summary"
          aria-label={`Open aside: ${summary}`}
          aria-expanded={false}
          data-inknb-control={`thread:${identity}`}
          onPress={() => session.selectThread(identity)}
        >
          <MessageSquare size={14} aria-hidden="true" />
          <span>{summary}</span>
          {session.hasUnreadActivity(identity) && (
            <span className="aside-unread" />
          )}
        </Button>
      )}
    </div>
  );
}

export default function Asides({
  historyOpen,
  reading = false,
  allNotes = false,
}: {
  historyOpen: boolean;
  reading?: boolean;
  allNotes?: boolean;
}) {
  const session = useAsideSession();
  const state = useAsideState();
  const documentSession = useContext(SessionContext);
  const index = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLDivElement>(null);
  const previewGeometry = useRef<AsideGeometry | null>(null);
  const nativeInline = Boolean(documentSession?.view);
  const passages = asidePassages(state)
    .filter(
      (passage) =>
        reading ||
        !nativeInline ||
        !asideInline(state, passage.anchor, passage.id),
    )
    .filter((passage) => {
      const contextual = Boolean(
        passage.preview ||
        (passage.anchor && passage.anchor.status !== "detached"),
      );
      if (reading)
        return (
          allNotes ||
          passage.id === "new" ||
          state.asideReader.threadIds.includes(passage.id) ||
          (state.asideReader.documentNotes && !contextual)
        );
      return (
        contextual &&
        !(
          state.asideReader.open &&
          state.asideReader.threadIds.includes(passage.id)
        )
      );
    })
    .filter(
      (passage) =>
        passage.id === "new" ||
        state.metadata.threads.some(
          (thread) => thread.id === passage.id && asideVisible(state, thread),
        ),
    )
    .map((passage) => ({
      ...passage,
      expanded: !historyOpen && passage.expanded,
    }));
  const decisions = state.metadata.decisions.filter(
    (decision) =>
      ["open", "answered"].includes(decision.status) &&
      (reading
        ? allNotes || state.asideReader.documentNotes && !decision.anchor
        : decision.anchor &&
          (!nativeInline || !asideInline(state, decision.anchor, decision.id))),
  );
  passages.push(
    ...decisions.map((decision) => ({
      id: decision.id,
      anchor: decision.anchor,
      expanded: true,
      preview: null,
      suggestionId: null,
    })),
  );
  const passageSignature = JSON.stringify(passages);
  useLayoutEffect(() => {
    if (reading) return;
    const rail = index.current;
    const content = canvas.current;
    const host = rail?.closest<HTMLElement>(".document-body");
    if (!rail || !content || !host) return;
    const viewport = documentScroll(
      host.querySelector<HTMLElement>(".document-scroll")!,
    );
    let frame = 0;
    const measure = () => {
      frame = 0;
      const view = documentSession?.surface;
      const useSource = view;
      const origin = viewport.getBoundingClientRect().top - viewport.scrollTop;
      const geometry = useSource
        ? {
            positions: passages.flatMap((passage) => {
              const anchor = passage.anchor;
              if (
                !anchor ||
                anchor.status === "detached" ||
                Math.max(anchor.from, anchor.to) > state.text.length
              )
                return [];
              const bounds = view.anchorBounds(anchor);

              return [
                {
                  id: passage.id,
                  top: bounds.top - origin,
                  bottom: bounds.bottom - origin,
                },
              ];
            }),
          }
        : previewGeometry.current;
      const locations = new Map(
        (geometry?.positions ?? []).map((position) => [position.id, position]),
      );
      const cards = [
        ...content.querySelectorAll<HTMLElement>("[data-aside-id]"),
      ];
      const canvasTop = content.getBoundingClientRect().top - origin;
      const openingTop = Math.max(
        0,
        (view?.dom.getBoundingClientRect().top ?? origin + 64) -
          origin -
          canvasTop,
      );
      const expandedPositions = new Map<
        string,
        { top: number; bottom: number }
      >();
      const expandedCards = cards
        .filter((card) => card.dataset.expanded || card.dataset.decisionCard)
        .map((card) => {
          const location = locations.get(card.dataset.asideId!);
          const height = card.getBoundingClientRect().height;
          const top =
            card.dataset.asideId === "new" &&
            !state.composerAnchor &&
            !state.composerPreviewAnchor &&
            state.composerTop !== null
              ? state.composerTop - canvasTop
              : location
                ? (location.top + location.bottom) / 2 - canvasTop - height / 2
                : 0;
          return { card, top: Math.max(openingTop, top), height };
        })
        .sort((first, second) => first.top - second.top);
      let occupiedBottom = 0;
      for (const { card, top, height } of expandedCards) {
        const placed = Math.max(occupiedBottom, top);
        expandedPositions.set(card.dataset.asideId!, {
          top: placed,
          bottom: placed + height,
        });
        occupiedBottom = placed + height + 16;
      }
      const markers = passages
        .filter((passage) => !passage.expanded)
        .map((passage) => {
          const location = locations.get(passage.id);
          let center = location
            ? (location.top + location.bottom) / 2 - canvasTop
            : 15;
          for (const position of expandedPositions.values()) {
            if (center >= position.top - 36 && center <= position.bottom + 36)
              center = position.bottom + 24;
          }
          return { id: passage.id, center: Math.max(15, center) };
        })
        .sort((first, second) => first.center - second.center);
      let previousMarkerBottom = 0;
      for (const marker of markers) {
        marker.center = Math.max(marker.center, previousMarkerBottom + 15);
        for (const position of expandedPositions.values())
          if (
            marker.center >= position.top - 36 &&
            marker.center <= position.bottom + 36
          )
            marker.center = position.bottom + 24;
        previousMarkerBottom = marker.center + 21;
      }
      let bottom = 0;
      for (const card of cards) {
        const expanded = expandedPositions.get(card.dataset.asideId!);
        const marker = markers.find(
          (marker) => marker.id === card.dataset.asideId,
        );
        const top = expanded
          ? expanded.top
          : Math.max(0, (marker?.center ?? 15) - 15);
        card.style.top = `${top}px`;
        bottom = Math.max(
          bottom,
          top + card.getBoundingClientRect().height + 16,
        );
      }
      content.dataset.aligned = "true";
      const bottomPadding =
        Number.parseFloat(getComputedStyle(rail).paddingBottom) +
        Number.parseFloat(getComputedStyle(rail.parentElement!).paddingBottom);
      content.style.height = `${Math.max(bottom, viewport.scrollTop + viewport.clientHeight - canvasTop - bottomPadding)}px`;
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    const receive = (event: Event) => {
      previewGeometry.current = (event as CustomEvent<AsideGeometry>).detail;
      schedule();
    };
    const observer = new ResizeObserver(schedule);
    observer.observe(host);
    observer.observe(rail);
    for (const card of content.querySelectorAll<HTMLElement>("[data-aside-id]"))
      observer.observe(card);
    host.addEventListener("inknb-aside-geometry", receive);
    host.addEventListener("inknb-source-layout", schedule);
    measure();
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      host.removeEventListener("inknb-aside-geometry", receive);
      host.removeEventListener("inknb-source-layout", schedule);
    };
  }, [
    documentSession,
    passageSignature,
    state.threadExpansions,
    state.activeThread,
    state.previewHost,
    state.composer,
    state.composerTop,
    state.epoch,
    reading,
  ]);
  const positions = new Map<string, number>();
  for (const thread of state.metadata.threads) {
    let position = !thread.anchor && !thread.previewAnchor ? -1 : Infinity;
    if (thread.anchor && thread.anchor.status !== "detached")
      position = thread.anchor.from;
    positions.set(thread.id, position);
  }
  const threads = state.metadata.threads
    .filter(
      (thread) =>
        asideVisible(state, thread) &&
        (reading
          ? allNotes || state.asideReader.threadIds.includes(thread.id) ||
            (state.asideReader.documentNotes &&
              !thread.previewAnchor &&
              (!thread.anchor || thread.anchor.status === "detached"))
          : (thread.previewAnchor ||
              (thread.anchor && thread.anchor.status !== "detached")) &&
            (!nativeInline || !asideInline(state, thread.anchor, thread.id)) &&
            !(
              state.asideReader.open &&
              state.asideReader.threadIds.includes(thread.id)
            )),
    )
    .sort(
      (first, second) => positions.get(first.id)! - positions.get(second.id)!,
    );
  return (
    <aside className="margin" aria-label="Asides" data-reading={reading}>
      <div
        ref={index}
        className="thread-index"
        role="region"
        aria-label="Aside conversations"
        data-inknb-control="asides"
        data-inknb-scroll="true"
      >
        <div className="aside-canvas" ref={canvas}>
          {state.composer &&
            !historyOpen &&
            (reading ||
              (!state.asideReader.open &&
                (state.composerPreviewAnchor || state.composerAnchor) &&
                (!nativeInline ||
                  !asideInline(state, state.composerAnchor, "new")))) && (
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
                const unread = session.hasUnreadActivity(thread.id);
                const summary =
                  thread.originalQuote ||
                  messageSummary(thread.messages.at(-1)) ||
                  thread.messages.at(-1)?.images[0]?.name ||
                  "Aside";
                const content = expanded ? (
                  <Conversation identity={thread.id} />
                ) : reading ? (
                  <InlineAside identity={thread.id} />
                ) : (
                  <TooltipTrigger delay={300}>
                    <Button
                      className={`aside-marker ${thread.resolved ? "resolved" : ""} ${asideOutdated(state.metadata, thread) ? "outdated" : ""}`}
                      aria-label={`${thread.resolution?.outcome === "superseded" ? "Superseded" : thread.resolved ? "Done" : asideOutdated(state.metadata, thread) ? "Outdated" : thread.kind === "suggestion" ? "Suggestion" : "Aside"}: ${unread ? "New activity. " : ""}${summary}`}
                      data-inknb-control={`thread:${thread.id}`}
                      aria-expanded={expanded}
                      onPress={() =>
                        expanded
                          ? session.collapseThread(thread.id)
                          : session.selectThread(thread.id)
                      }
                    >
                      {asideOutdated(state.metadata, thread) ? (
                        <History size={16} aria-hidden="true" />
                      ) : thread.resolved ? (
                        <Check size={16} aria-hidden="true" />
                      ) : thread.kind === "suggestion" ? (
                        <PencilLine size={16} aria-hidden="true" />
                      ) : (
                        <MessageSquare size={16} aria-hidden="true" />
                      )}
                      {unread && <span className="aside-unread" />}
                    </Button>
                    <Tooltip className="control-tooltip" offset={8}>
                      <span className="aside-tooltip-excerpt">{summary}</span>
                    </Tooltip>
                  </TooltipTrigger>
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
          {reading &&
            !threads.length &&
            !decisions.length &&
            !state.composer && (
              <div className="aside-reader-empty">
                <p>No open document notes.</p>
                <Button
                  className="text-button"
                  data-inknb-control="asides.document-create"
                  onPress={() => session.startComment("document")}
                >
                  Add a document note
                </Button>
              </div>
            )}
        </div>
      </div>
    </aside>
  );
}
