import { useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { MessageSquare } from "lucide-react";
import Asides from "./Asides";
import { useAutoHideScrollbar } from "./use-auto-hide-scrollbar";
import IconButton from "./IconButton";
import { asideVisible } from "./aside-state";
import { useAsideSession, useAsideState } from "./use-session";

export function AsidesButton() {
  const session = useAsideSession();
  const state = useAsideState();
  const count = state.metadata.threads.filter(thread => asideVisible(state, thread)).length;
  return <IconButton icon={MessageSquare} label={`Asides, ${count} open`} agentControl="asides.toggle" active={state.asidesOpen && !state.focus} onPress={() => session.update({ asidesOpen: !state.asidesOpen, focus: false })} />;
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
  const container = useRef<HTMLDivElement>(null);
  const readerViewport = useRef<HTMLDivElement>(null);
  const documentViewport = useRef<HTMLDivElement>(null);
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
  const hasContent = state.composer || state.metadata.threads.some(thread => asideVisible(state, thread)) || state.metadata.decisions.some(decision => ["open", "answered"].includes(decision.status));
  const open = state.asidesOpen && !state.focus && hasContent;
  const reserved = open && !narrow;
  useAutoHideScrollbar(readerViewport, open);
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
    if (open && readerViewport.current)
      readerViewport.current.scrollTop = state.asideReader.scrollTop;
  }, [open]);
  useLayoutEffect(() => {
    const viewport = documentViewport.current;
    if (!viewport) return;
    let frame = 0;
    const measure = () => {
      frame = 0;
      viewport.style.setProperty(
        "--document-scroll-floor",
        `${viewport.scrollTop + viewport.clientHeight}px`,
      );
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    viewport.addEventListener("scroll", schedule, { passive: true });
    return () => {
      cancelAnimationFrame(frame);
      viewport.removeEventListener("scroll", schedule);
    };
  }, []);
  useLayoutEffect(() => {
    const viewport = readerViewport.current;
    if (!open || !viewport) return;
    let timer: ReturnType<typeof setTimeout>;
    let scrollTop = viewport.scrollTop;
    const persist = () => {
      clearTimeout(timer);
      const reader = session.getSnapshot().asideReader;
      if (reader.scrollTop !== scrollTop)
        session.update({ asideReader: { ...reader, scrollTop } });
    };
    const remember = () => {
      scrollTop = Math.max(0, viewport.scrollTop);
      clearTimeout(timer);
      timer = setTimeout(persist, 150);
    };
    viewport.addEventListener("scroll", remember, { passive: true });
    viewport.addEventListener("scrollend", persist);
    return () => {
      viewport.removeEventListener("scroll", remember);
      viewport.removeEventListener("scrollend", persist);
      persist();
    };
  }, [open, session]);
  return (
    <div
      className="document-body"
      ref={container}
      data-asides-layout={narrow ? "inline" : "margin"}
      data-asides-open={open}
      data-asides-reserved={reserved}
      data-asides-narrow={narrow}
      data-aside-reader={open}
      data-review-open={state.reviewOpen && !state.focus}
      style={{ "--aside-card-width": `${cardWidth}px` } as CSSProperties}
    >
      <div
        className="document-scroll"
        ref={documentViewport}
        data-inknb-scroll="true"
        aria-label="Document"
        tabIndex={0}
      >
        <div className="document-canvas">
          <div className="document-surface-container">{children}</div>

        </div>
      </div>
      {open && (
        <aside
          className="aside-dock"
          aria-label="Asides"
        >
            <div
              className="aside-reader-scroll"
              ref={readerViewport}
              data-inknb-scroll="true"
              data-inknb-control="asides.reader"
              tabIndex={0}
              aria-label="Independently scrolling asides"
            >
              <Asides historyOpen={historyOpen} />
            </div>
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
