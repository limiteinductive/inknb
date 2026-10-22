import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { RefObject } from "react";
import { createPortal } from "react-dom";
import { captureAnchor } from "./domain";
import type { PassageSource } from "./passage-reference";
import { annotationTransferType, textRange } from "./passage-reference";
import { useDocumentSession, useSession } from "./use-session";
import "./passage-annotations.css";
import { useAutoHideScrollbar } from "./use-auto-hide-scrollbar";
import { annotationSpace } from "./annotation-layout";

export default function PassageAnnotations({ active }: { active: boolean }) {
  const session = useDocumentSession();
  const state = useSession();
  const [selected, setSelected] = useState<string | null>(null);
  const selectedKey = useRef<string | null>(null);
  selectedKey.current = selected;
  const ranges = useRef(new Map<string, Range>());
  const reply = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const focus = (event: FocusEvent) => {
      if (!(event.target instanceof Element)) return;
      const editor = event.target.closest<HTMLElement>(".reference-editor");
      if (editor) reply.current = editor;
      else if (!event.target.closest(".passage-annotation")) reply.current = null;
    };
    document.addEventListener("focusin", focus);
    return () => document.removeEventListener("focusin", focus);
  }, []);
  useEffect(() => {
    if (!active || !window.CSS?.highlights) return;
    const passages = [...Object.keys(state.drafts), ...state.metadata.annotations.filter(annotation => annotation.status === "open").map(annotation => `annotation:${annotation.id}`)].flatMap(key => {
      const range = ranges.current.get(key);
      return range?.startContainer.isConnected ? [range] : [];
    });
    CSS.highlights.set("inknb-annotation", new Highlight(...passages));
    return () => { CSS.highlights.delete("inknb-annotation"); };
  }, [active, state.drafts, state.metadata.annotations]);
  useEffect(() => {
    if (!active) return;
    const select = (event: Event) => {
      const target = event.target;
      if (
        !(target instanceof Element) ||
        target.closest(".passage-annotation, [role='menu']")
      )
        return;
      const selection = window.getSelection();
      const current = session.getSnapshot();
      const pending = selectedKey.current ? current.drafts[selectedKey.current] : null;
      if (!selection?.rangeCount || selection.isCollapsed) {
        if (selectedKey.current && !pending?.content.trim() && !pending?.annotation?.completed) {
          const drafts = { ...current.drafts };
          delete drafts[selectedKey.current];
          session.update({ drafts });
          setSelected(null);
        }
        return;
      }
      if (target.closest(".reference-editor, input, textarea")) return;
      const selectedRange = selection.getRangeAt(0);
      const container = selectedRange.commonAncestorContainer;
      const element =
        container.nodeType === Node.TEXT_NODE
          ? container.parentElement
          : (container as Element);
      let source: PassageSource | null = null;
      const messageBody = element?.closest<HTMLElement>(
        "[data-message-content]",
      );
      const message = messageBody?.closest<HTMLElement>(
        "[data-message-id], [data-source-message-id]",
      );
      const thread = current.metadata.threads.find((thread) =>
        thread.messages.some(
          (candidate) =>
            candidate.id ===
            (message?.dataset.messageId ?? message?.dataset.sourceMessageId),
        ),
      );
      if (
        messageBody &&
        message &&
        thread &&
        !target.closest(".document-history")
      ) {
        const prefix = selectedRange.cloneRange();
        prefix.selectNodeContents(messageBody);
        prefix.setEnd(selectedRange.startContainer, selectedRange.startOffset);
        const from = prefix.toString().length;
        const quote = selectedRange.toString();
        source = {
          kind: "message",
          documentId: current.metadata.documentId,
          threadId: thread.id,
          messageId: (message.dataset.messageId ??
            message.dataset.sourceMessageId)!,
          field: messageBody.dataset.messageContent ?? "content",
          text: messageBody.textContent ?? "",
          from,
          to: from + quote.length,
          quote,
        };
      } else if (
        session.view?.dom.contains(container) &&
        !element?.closest(".margin-note")
      ) {
        const selection = session.view.selection;
        if (selection.to > selection.from) {
          const anchor = session.model!.capture(
            captureAnchor(current.text, selection),
          );
          source = {
            kind: "document",
            documentId: current.metadata.documentId,
            revision: current.metadata.revision,
            anchor,
            quote: session.view.passageText(anchor),
          };
        }
      }
      if (!source?.quote.trim()) return;
      const existing = Object.entries(current.drafts).find(
        ([, draft]) =>
          draft.annotation &&
          JSON.stringify(draft.annotation.source) === JSON.stringify(source),
      );
      const key = existing?.[0] ?? `annotation:${crypto.randomUUID()}`;
      ranges.current.set(key, selectedRange.cloneRange());
      setSelected(key);
      const drafts = { ...current.drafts };
      if (selectedKey.current && selectedKey.current !== key && !pending?.content.trim() && !pending?.annotation?.completed) delete drafts[selectedKey.current];
      if (!existing) drafts[key] = { content: "", images: [], annotation: { source, completed: false } };
      session.update({ drafts });

    };
    const pointer = (event: PointerEvent) => {
      if (event.button === 0) queueMicrotask(() => select(event));
    };
    const keyboard = (event: KeyboardEvent) => {
      if (event.key.startsWith("Arrow") || event.key === "Shift") select(event);
    };
    document.addEventListener("pointerup", pointer);
    document.addEventListener("keyup", keyboard);
    return () => {
      document.removeEventListener("pointerup", pointer);
      document.removeEventListener("keyup", keyboard);
    };
  }, [active, session]);
  if (!active) return null;
  const identities = new Set([
    ...Object.entries(state.drafts).filter(([key, draft]) => draft.annotation && (key === selected || draft.content.trim() || draft.annotation.completed)).map(([key]) => key),
    ...state.metadata.annotations.filter(annotation => annotation.status === "open").map(annotation => `annotation:${annotation.id}`),
  ]);
  return <>{[...identities].map(identity => <PassageAnnotation key={identity} identity={identity} sourceRange={ranges.current.get(identity)} reply={reply} />)}</>;
}

function PassageAnnotation({ identity, sourceRange, reply }: { identity: string; sourceRange?: Range; reply: RefObject<HTMLElement | null> }) {
  const session = useDocumentSession();
  const state = useSession();
  const [position, setPosition] = useState({ left: 0, top: 0, clipPath: "none", visibility: "hidden" as "hidden" | "visible" });
  const [destinations, setDestinations] = useState(false);
  const [sending, setSending] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const popup = useRef<HTMLDivElement>(null);
  const comment = useRef<HTMLTextAreaElement>(null);
  const grip = useRef<HTMLButtonElement>(null);
  const reserved = useRef<HTMLElement | null>(null);
  const work = state.metadata.annotations.find(annotation => identity === `annotation:${annotation.id}`);
  const draft = useMemo(() => state.drafts[identity] ?? (work ? { content: work.comment, images: [], annotation: { source: work.source, completed: true } } : null), [state.drafts[identity], work]);
  const annotation = draft?.annotation;
  useAutoHideScrollbar(comment, Boolean(annotation && !annotation.completed));
  const dismiss = () => {
    if (work) { void session.dismissAnnotation(work.id).catch(error => session.fail(error)); return; }
    const drafts = { ...session.getSnapshot().drafts };
    delete drafts[identity];
    session.update({ drafts });
  };
  useLayoutEffect(() => () => {
    if (reserved.current) annotationSpace(reserved.current, identity, 0);
    reserved.current = null;
  }, [identity]);
  useLayoutEffect(() => {
    if (!annotation) return;
    const place = () => {
      const source = annotation.source;
      let sourceElement: Element | null | undefined = sourceRange?.startContainer.parentElement;
      let passageRange = sourceRange?.startContainer.isConnected ? sourceRange : null;
      let bounds:
        | { left: number; top: number; right: number; bottom: number }
        | undefined = sourceRange?.startContainer.isConnected ? sourceRange.getBoundingClientRect() : undefined;
      if (source.kind === "document" && session.surface) {
        sourceElement = session.surface.passageElement(source.liveAnchor ?? source.anchor);
        bounds = session.surface.anchorBounds(
          source.liveAnchor ?? source.anchor,
        );
      }
      if (!bounds && source.kind === "message") {
        const element = document.querySelector(
          `[data-message-id="${source.messageId}"] [data-message-content="${source.field}"], [data-source-message-id="${source.messageId}"][data-message-content="${source.field}"]`,
        );
        if (element?.textContent === source.text) {
          sourceElement = element;
          passageRange = textRange(element, source.from, source.to);
          bounds = passageRange?.getBoundingClientRect();
        }
      }
      const paragraph = source.kind === "document"
        ? sourceElement
        : passageRange?.startContainer.parentElement?.closest("p, h1, h2, h3, h4, h5, h6, li, pre, blockquote") ?? sourceElement;
      if (!(paragraph instanceof HTMLElement) || !bounds) {
        if (reserved.current) annotationSpace(reserved.current, identity, 0);
        reserved.current = null;
        setPosition(current => current.visibility === "hidden" ? current : { ...current, visibility: "hidden" });
        return;
      }
      const width = popup.current?.offsetWidth ?? 280;
      const height = popup.current?.offsetHeight ?? 44;
      if (reserved.current && reserved.current !== paragraph) annotationSpace(reserved.current, identity, 0);
      reserved.current = paragraph;
      const offset = annotationSpace(paragraph, identity, height + 8);
      const paragraphBounds = paragraph.getBoundingClientRect();
      const viewport = { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight };
      for (let parent = sourceElement; parent; parent = parent.parentElement) {
        if (!parent.matches(".document-scroll, .aside-reader-scroll, .aside-conversation-scroll, .response-scroll")) continue;
        const rectangle = parent.getBoundingClientRect();
        viewport.left = Math.max(viewport.left, rectangle.left);
        viewport.top = Math.max(viewport.top, rectangle.top);
        viewport.right = Math.min(viewport.right, rectangle.right);
        viewport.bottom = Math.min(viewport.bottom, rectangle.bottom);
      }
      const top = paragraphBounds.top + offset + 4;
      if (top + height <= viewport.top || top >= viewport.bottom || paragraphBounds.right <= viewport.left || paragraphBounds.left >= viewport.right) {
        setPosition(current => current.visibility === "hidden" ? current : { ...current, visibility: "hidden" });
        return;
      }
      const left = Math.max(viewport.left + 8, Math.min(bounds.left, viewport.right - width - 8));
      const clipPath = `inset(${Math.max(0, viewport.top - top)}px 0 ${Math.max(0, top + height - viewport.bottom)}px 0)`;
      setPosition(current => current.left === left && current.top === top && current.clipPath === clipPath && current.visibility === "visible" ? current : { left, top, clipPath, visibility: "visible" });
    };
    const element = comment.current;
    if (element) {
      element.style.height = "auto";
      element.style.height = `${Math.min(160, element.scrollHeight)}px`;
    }
    place();
    const observer = new ResizeObserver(place);
    if (popup.current) observer.observe(popup.current);
    if (reserved.current) {
      observer.observe(reserved.current);
      const viewport = reserved.current.closest(".document-scroll, .aside-conversation-scroll, .response-scroll");
      if (viewport) observer.observe(viewport);
    }
    window.addEventListener("resize", place);
    document.addEventListener("scroll", place, true);
    document.addEventListener("inknb-annotations-layout", place);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", place);
      document.removeEventListener("scroll", place, true);
      document.removeEventListener("inknb-annotations-layout", place);
    };
  }, [annotation, draft?.content, destinations, sourceRange, session, state.ready, state.epoch]);
  async function send() {
    if (sending) return;
    setSending(true);
    try {
      await session.sendAnnotation(identity);
      setAnnouncement("Annotation sent in a new aside.");
    } catch (error) {
      session.fail(error);
    } finally {
      setSending(false);
    }
  }
  return createPortal(
    <>
      <span
        className="annotation-announcement"
        role="status"
        aria-live="polite"
      >
        {announcement}
      </span>
      {annotation && (
        <div
          ref={popup}
          className="passage-annotation"
          data-completed={annotation.completed}
          style={position}
          role="dialog"
          aria-label="Annotate passage"
          onKeyDown={(event) => {
            if (
              event.nativeEvent.isComposing ||
              event.nativeEvent.keyCode === 229
            )
              return;
            if (event.key === "Escape") {
              event.stopPropagation();
              dismiss();
              return;
            }
            if (event.key !== "Enter" || event.shiftKey || event.altKey) return;
            event.preventDefault();
            event.stopPropagation();
            if (event.metaKey || event.ctrlKey) {
              if (!event.repeat) void send();
              return;
            }
            if (event.target !== comment.current) return;
            setSending(true);
            void session.commitAnnotation(identity).then(() => {
              setAnnouncement("Annotation queued for your agent. Click it while writing a reply to add context.");
              requestAnimationFrame(() => grip.current?.focus({ preventScroll: true }));
            }).catch(error => session.fail(error)).finally(() => setSending(false));
          }}
        >
          <div className="passage-annotation-row">
            {annotation.completed && (
              <button
                type="button"
                ref={grip}
                className="annotation-token"
                data-inknb-control={`annotation.token:${work?.id ?? identity}`}
                draggable={!sending}
                aria-label={
                  annotation.completed
                    ? `Annotation: ${draft.content || annotation.source.quote}. Click to add to your active reply, or drag into a reply.`
                    : "Drag annotation into a reply or choose a destination"
                }
                aria-expanded={destinations}
                onClick={() => {
                  const destination = reply.current;
                  if (!destination?.isConnected || !destination.getClientRects().length) { setDestinations(!destinations); return; }
                  destination.dispatchEvent(new CustomEvent("inknb-insert-annotation", { detail: { source: annotation.source, comment: draft.content, ...(work ? { annotationId: work.id } : {}) } }));
                  setAnnouncement("Annotation added to your reply context.");
                }}
                onDragEnd={event => { if (!work && event.dataTransfer.dropEffect === "copy") dismiss(); }}
                onDragStart={(event) => {
                  event.dataTransfer.effectAllowed = "copy";
                  event.dataTransfer.setData(
                    annotationTransferType,
                    JSON.stringify({
                      source: annotation.source,
                      comment: draft.content,
                      ...(work ? { annotationId: work.id } : {}),
                    }),
                  );
                  setDestinations(false);
                }}
              >
                {draft.content || annotation.source.quote}
              </button>
            )}
            {!annotation.completed && (
              <textarea
                ref={comment}
                value={draft.content}
                rows={1}
                aria-label="Comment on selected passage"
                data-inknb-control={`annotation.comment:${identity}`}
                aria-keyshortcuts="Enter Meta+Enter Shift+Enter"
                aria-description="Enter queues an annotation for your agent. Command Enter sends a new aside. Shift Enter adds a line."
                placeholder="Comment…"
                disabled={sending}
                onChange={(event) => {
                  const current = session.getSnapshot();
                  session.update({
                    drafts: {
                      ...current.drafts,
                      [identity]: {
                        ...current.drafts[identity],
                        content: event.target.value,
                      },
                    },
                  });
                }}
              />
            )}
          </div>
          {destinations && (
            <div
              className="annotation-destinations"
              role="group"
              aria-label="Annotation destinations"
            >
              {annotation.completed && !work && (
                <button
                  type="button"
                  className="text-button"
                  onClick={() => {
                    const current = session.getSnapshot();
                    session.update({
                      drafts: {
                        ...current.drafts,
                        [identity]: {
                          ...current.drafts[identity],
                          annotation: { ...annotation, completed: false },
                        },
                      },
                    });
                    setDestinations(false);
                    requestAnimationFrame(() =>
                      comment.current?.focus({ preventScroll: true }),
                    );
                  }}
                >
                  Edit comment
                </button>
              )}
              {Array.from(
                document.querySelectorAll<HTMLElement>(".reference-editor"),
              ).map((element) => (
                <button
                  type="button"
                  className="text-button"
                  key={element.dataset.inknbControl}
                  onClick={() => {
                    element.dispatchEvent(
                      new CustomEvent("inknb-insert-annotation", {
                        detail: {
                          source: annotation.source,
                          comment: draft.content,
                          ...(work ? { annotationId: work.id } : {}),
                        },
                      }),
                    );
                    if (!work) dismiss();
                  }}
                >
                  {element
                    .closest(".margin-note")
                    ?.querySelector(".message")
                    ?.textContent?.slice(0, 70) || "New aside draft"}
                </button>
              ))}
              <button
                type="button"
                className="text-button"
                disabled={sending}
                onClick={() => void send()}
              >
                Send in a new aside
              </button>
            </div>
          )}
        </div>
      )}
    </>,
    document.body,
  );
}
