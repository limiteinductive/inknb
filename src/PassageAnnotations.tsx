import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { captureAnchor } from "./domain";
import type { PassageSource } from "./passage-reference";
import { annotationTransferType, textRange } from "./passage-reference";
import { useDocumentSession, useSession } from "./use-session";
import "./passage-annotations.css";
import { useAutoHideScrollbar } from "./use-auto-hide-scrollbar";

export default function PassageAnnotations({ active }: { active: boolean }) {
  const session = useDocumentSession();
  const state = useSession();
  const [selected, setSelected] = useState<string | null>(null);
  const selectedKey = useRef<string | null>(null);
  selectedKey.current = selected;
  const [position, setPosition] = useState({ left: 0, top: 0 });
  const [destinations, setDestinations] = useState(false);
  const [sending, setSending] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const popup = useRef<HTMLDivElement>(null);
  const comment = useRef<HTMLTextAreaElement>(null);
  const grip = useRef<HTMLButtonElement>(null);
  const range = useRef<Range | null>(null);
  const draft = selected ? state.drafts[selected] : null;
  const annotation = draft?.annotation;
  useAutoHideScrollbar(comment, Boolean(annotation && !annotation.completed));
  const dismiss = () => {
    const key = selectedKey.current;
    if (!key) return;
    const drafts = { ...session.getSnapshot().drafts };
    delete drafts[key];
    session.update({ drafts });
    selectedKey.current = null;
    setSelected(null);
  };
  useEffect(() => {
    if (!active || !annotation || !range.current || !window.CSS?.highlights)
      return;
    CSS.highlights.set("inknb-annotation", new Highlight(range.current));
    return () => {
      CSS.highlights.delete("inknb-annotation");
    };
  }, [active, annotation]);
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
      if (!selection?.rangeCount || selection.isCollapsed) {
        dismiss();
        return;
      }
      if (target.closest(".reference-editor, input, textarea")) return;
      const selectedRange = selection.getRangeAt(0);
      const container = selectedRange.commonAncestorContainer;
      const element =
        container.nodeType === Node.TEXT_NODE
          ? container.parentElement
          : (container as Element);
      const current = session.getSnapshot();
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
      range.current = selectedRange.cloneRange();
      setSelected(key);
      setDestinations(false);
      const drafts = { ...current.drafts };
      if (selectedKey.current && selectedKey.current !== key) delete drafts[selectedKey.current];
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
  useLayoutEffect(() => {
    if (!annotation || !active) return;
    const place = () => {
      if (!range.current?.startContainer.isConnected) range.current = null;
      const source = annotation.source;
      let bounds:
        | { left: number; top: number; right: number; bottom: number }
        | undefined = range.current?.getBoundingClientRect();
      if (source.kind === "document" && session.surface)
        bounds = session.surface.anchorBounds(
          source.liveAnchor ?? source.anchor,
        );
      if (!bounds && source.kind === "message") {
        const element = document.querySelector(
          `[data-message-id="${source.messageId}"] [data-message-content="${source.field}"]`,
        );
        if (element?.textContent === source.text)
          bounds = textRange(
            element,
            source.from,
            source.to,
          )?.getBoundingClientRect();
      }
      if (!bounds) return;
      const width = popup.current?.offsetWidth ?? 280;
      const height = popup.current?.offsetHeight ?? 44;
      const top =
        bounds.bottom + 8 + height < window.innerHeight
          ? bounds.bottom + 8
          : bounds.top - height - 8;
      setPosition({
        left: Math.max(8, Math.min(bounds.left, window.innerWidth - width - 8)),
        top: Math.max(8, Math.min(top, window.innerHeight - height - 8)),
      });
    };
    const element = comment.current;
    if (element) {
      element.style.height = "auto";
      element.style.height = `${Math.min(160, element.scrollHeight)}px`;
    }
    place();
    window.addEventListener("resize", place);
    document.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      document.removeEventListener("scroll", place, true);
    };
  }, [annotation, draft?.content, destinations, active, session]);
  async function send() {
    if (!selected || sending) return;
    setSending(true);
    try {
      await session.sendAnnotation(selected);
      if (selectedKey.current === selected) dismiss();
      setAnnouncement("Annotation sent in a new aside.");
    } catch (error) {
      session.fail(error);
    } finally {
      setSending(false);
    }
  }
  if (!active) return null;
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
            const current = session.getSnapshot();
            session.update({
              drafts: {
                ...current.drafts,
                [selected!]: {
                  ...current.drafts[selected!],
                  annotation: { ...annotation, completed: true },
                },
              },
            });
            setAnnouncement(
              "Annotation ready. Drag it into a reply, or press Command Enter to send a new aside.",
            );
            requestAnimationFrame(() =>
              grip.current?.focus({ preventScroll: true }),
            );
          }}
        >
          <div className="passage-annotation-row composer">
            {annotation.completed && (
              <button
                type="button"
                ref={grip}
                className="annotation-token"
                data-inknb-control="annotation.token"
                draggable={!sending}
                aria-label={
                  annotation.completed
                    ? `Annotation: ${draft.content || annotation.source.quote}. Drag into a reply or choose a destination.`
                    : "Drag annotation into a reply or choose a destination"
                }
                aria-expanded={destinations}
                onClick={() => setDestinations(!destinations)}
                onDragEnd={event => { if (event.dataTransfer.dropEffect === "copy") dismiss(); }}
                onDragStart={(event) => {
                  event.dataTransfer.effectAllowed = "copy";
                  event.dataTransfer.setData(
                    annotationTransferType,
                    JSON.stringify({
                      source: annotation.source,
                      comment: draft.content,
                    }),
                  );
                  event.dataTransfer.setData(
                    "text/plain",
                    `“${annotation.source.quote}”${draft.content ? ` ${draft.content}` : ""}`,
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
                data-inknb-control="annotation.comment"
                aria-keyshortcuts="Enter Meta+Enter Shift+Enter"
                aria-description="Enter keeps a draggable annotation. Command Enter sends a new aside. Shift Enter adds a line."
                placeholder="Comment…"
                disabled={sending}
                onChange={(event) => {
                  const current = session.getSnapshot();
                  session.update({
                    drafts: {
                      ...current.drafts,
                      [selected!]: {
                        ...current.drafts[selected!],
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
              {annotation.completed && (
                <button
                  type="button"
                  className="text-button"
                  onClick={() => {
                    const current = session.getSnapshot();
                    session.update({
                      drafts: {
                        ...current.drafts,
                        [selected!]: {
                          ...current.drafts[selected!],
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
                        },
                      }),
                    );
                    dismiss();
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
