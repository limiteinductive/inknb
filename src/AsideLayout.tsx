import { useContext, useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { Button } from "react-aria-components";
import { ArrowLeft, MessageSquare } from "lucide-react";
import Asides from "./Asides";
import { useAutoHideScrollbar } from "./use-auto-hide-scrollbar";
import IconButton from "./IconButton";
import { asideVisible } from "./aside-state";
import { SessionContext, useAsideSession, useAsideState } from "./use-session";

export function DocumentNotesButton({ compact = false }: { compact?: boolean }) {
  const session = useAsideSession();
  const state = useAsideState();
  const count = state.metadata.threads.filter((thread) => asideVisible(state, thread) && !thread.previewAnchor && (!thread.anchor || thread.anchor.status === "detached")).length;
  if (compact !== (state.asideNarrow || state.preferences.placement === "inline")) return null;
  const open = () => session.update({ asidesOpen: true, asideReader: { ...state.asideReader, open: true, documentNotes: true } });
  if (compact) return <IconButton icon={MessageSquare} label={`Document notes, ${count} open`} agentControl="asides.document" active={state.asideReader.open && state.asideReader.documentNotes} onPress={open} />;
  return <Button className="text-button" data-inknb-control="asides.document" aria-pressed={state.asideReader.open && state.asideReader.documentNotes} onPress={open}><MessageSquare size={14} aria-hidden="true" /><span>Document notes</span><span className="aside-note-count">{count}</span></Button>;
}

export default function AsideLayout({
  children,
  active,
  historyOpen,
  preferredWidth = 400,
  onWidthChange,
}: {
  children: ReactNode;
  active: boolean;
  historyOpen: boolean;
  preferredWidth?: number;
  onWidthChange?: (width: number) => void;
}) {
  const session = useAsideSession();
  const state = useAsideState();
  const documentSession = useContext(SessionContext);
  const container = useRef<HTMLDivElement>(null);
  const readerViewport = useRef<HTMLDivElement>(null);
  const drag = useRef<{ start: number; width: number } | null>(null);
  const [width, setWidth] = useState(window.innerWidth);
  const minimumWidth = 320;
  const minimumProse = Math.min(480, state.preferences.line_width);
  const maximumWidth = Math.max(
    minimumWidth,
    Math.min(480, width - minimumProse - 176),
  );
  const cardWidth = Math.max(
    minimumWidth,
    Math.min(preferredWidth, maximumWidth),
  );
  const narrow = width < minimumProse + cardWidth + 176;
  const inline = narrow || state.preferences.placement === "inline";
  const open = state.asidesOpen && !state.focus;
  const contextualReader = !documentSession && inline && !state.asideReader.open;
  const reading = open && (state.asideReader.open || contextualReader);
  useAutoHideScrollbar(readerViewport, reading);
  const reserved = open && (!inline || (reading && !narrow));
  const heading = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = container.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) =>
      setWidth(entry.contentRect.width),
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useLayoutEffect(() => {
    if (state.asideNarrow !== narrow) session.update({ asideNarrow: narrow });
  }, [narrow, state.asideNarrow, session]);
  useLayoutEffect(() => {
    if (reading && readerViewport.current)
      readerViewport.current.scrollTop = state.asideReader.scrollTop;
  }, [reading]);
  useLayoutEffect(() => {
    if (!heading.current) return;
    const observer = new ResizeObserver(([entry]) => container.current?.style.setProperty("--aside-heading-height", `${entry.borderBoxSize[0].blockSize}px`));
    observer.observe(heading.current);
    return () => observer.disconnect();
  }, [open, reading, reserved]);
  return (
    <div
      className="document-body"
      ref={container}
      data-asides-layout={inline ? "inline" : "margin"}
      data-asides-open={open}
      data-asides-reserved={reserved}
      data-asides-narrow={narrow}
      data-aside-reader={reading}
      data-review-open={state.reviewOpen && !state.focus}
      style={{ "--aside-card-width": `${cardWidth}px` } as CSSProperties}
    >
      <div
        className="document-scroll"
        data-inknb-scroll="true"
        aria-label="Document and contextual asides"
        tabIndex={0}
        onScroll={(event) => {
          const viewport = event.currentTarget;
          viewport.style.setProperty(
            "--document-scroll-floor",
            `${viewport.scrollTop + viewport.clientHeight}px`,
          );
          container.current?.style.setProperty("--document-scroll-top", `${Math.max(0, viewport.scrollTop)}px`);
        }}
      >
        <div className="document-canvas">
          <div className="document-surface-container">{children}</div>
          {open && !inline && !reading && (
            <div className="annotation-margin">
              <Asides historyOpen={historyOpen} />
            </div>
          )}
        </div>
      </div>
      {open && (reserved || reading) && (
        <aside
          className="aside-dock"
          aria-label={reading ? "Aside reader" : "Aside navigation"}
        >
          <div className="aside-dock-heading" ref={heading}>
            {reading && (
              <Button
                className="text-button"
                data-inknb-control="asides.return"
                onPress={() =>
                  {
                    session.update(contextualReader ? { asidesOpen: false } : {
                      asideReader: { ...state.asideReader, open: false },
                    });
                    requestAnimationFrame(() => container.current?.closest(".app")?.querySelector<HTMLButtonElement>('[data-inknb-control="asides.document"]')?.focus({ preventScroll: true }));
                  }
                }
              >
                <ArrowLeft size={14} aria-hidden="true" />
                Return to margin
              </Button>
            )}
            <DocumentNotesButton />
          </div>
          {reading && (
            <div
              className="aside-reader-scroll"
              ref={readerViewport}
              data-inknb-scroll="true"
              data-inknb-control="asides.reader"
              tabIndex={0}
              aria-label="Independently scrolling asides"
              onScroll={(event) => {
                session.update({
                  asideReader: {
                    ...session.getSnapshot().asideReader,
                    scrollTop: Math.max(0, event.currentTarget.scrollTop),
                  },
                });
              }}
            >
              <Asides historyOpen={false} reading allNotes={contextualReader} />
            </div>
          )}
          {reserved && (
            <div
              className="aside-resizer"
              role="separator"
              aria-label="Resize asides"
              aria-orientation="vertical"
              aria-valuemin={minimumWidth}
              aria-valuemax={Math.round(maximumWidth)}
              aria-valuenow={Math.round(cardWidth)}
              tabIndex={active ? 0 : -1}
              data-inknb-control="asides.resize"
              onPointerDown={(event) => {
                if (event.button !== 0 || !active) return;
                event.preventDefault();
                drag.current = { start: event.clientX, width: cardWidth };
                event.currentTarget.setPointerCapture(event.pointerId);
              }}
              onPointerMove={(event) => {
                if (!drag.current) return;
                onWidthChange?.(
                  Math.min(
                    maximumWidth,
                    Math.max(
                      minimumWidth,
                      drag.current.width + drag.current.start - event.clientX,
                    ),
                  ),
                );
              }}
              onPointerUp={() => {
                drag.current = null;
              }}
              onPointerCancel={() => {
                drag.current = null;
              }}
              onLostPointerCapture={() => {
                drag.current = null;
              }}
              onKeyDown={(event) => {
                if (
                  !["ArrowLeft", "ArrowRight", "Home", "End"].includes(
                    event.key,
                  )
                )
                  return;
                event.preventDefault();
                const next =
                  event.key === "Home"
                    ? minimumWidth
                    : event.key === "End"
                      ? maximumWidth
                      : cardWidth + (event.key === "ArrowLeft" ? 24 : -24);
                onWidthChange?.(
                  Math.min(maximumWidth, Math.max(minimumWidth, next)),
                );
              }}
            />
          )}
        </aside>
      )}
    </div>
  );
}
