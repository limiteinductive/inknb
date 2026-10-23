import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { Button } from "react-aria-components";
import { X } from "lucide-react";
import { useDocumentSession, useSession } from "./use-session";
import { documentOutline } from "./document-structure";
import { workspace } from "./window-workspace";

export default function DocumentOutline({ active }: { active: boolean }) {
  const session = useDocumentSession();
  const state = useSession();
  const container = useRef<HTMLElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLOListElement>(null);
  const panelId = useId();
  const [expanded, setExpanded] = useState(false);
  const [availableWidth, setAvailableWidth] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(window.innerHeight);
  const [current, setCurrent] = useState<string | null>(null);
  const visible = state.outlineOpen ?? state.preferences.document_outline;
  const options = state.preferences.outline;
  const docked = options.presentation === "panel" && availableWidth > 760;
  const panelVisible = docked || expanded;
  const model = session.model;
  const headings = useMemo(() => {
    if (!model) return [];
    return documentOutline(model.state.doc, model.projection)
      .filter((heading) => heading.level >= options.min_level && heading.level <= options.max_level)
      .map((heading) => ({ ...heading, title: heading.title || "Untitled heading" }));
  }, [model?.state.doc, model?.projection, options.min_level, options.max_level]);
  useLayoutEffect(() => {
    const element = container.current?.closest<HTMLElement>(".workspace");
    const viewport = container.current?.closest<HTMLElement>(".document-scroll");
    if (!element || !viewport) return;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        if (entry.target === element) {
          const reserved = element.closest<HTMLElement>(".document-body")?.dataset.asidesReserved === "true";
          const proseWidth = state.preferences.line_width + Number.parseFloat(getComputedStyle(element).getPropertyValue("--document-column-inset"));
          setAvailableWidth(reserved ? Math.min(entry.contentRect.width, proseWidth) : entry.contentRect.width);
        }
        if (entry.target === viewport) setViewportHeight(entry.contentRect.height);
      }
    });
    observer.observe(element);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [active, visible, state.pageVisible, state.preferences.line_width, headings.length]);
  useEffect(() => {
    const viewport =
      container.current?.closest<HTMLElement>(".document-scroll");
    const surface = session.surface?.dom;
    if (!viewport || !surface || !visible || !active || state.pageVisible)
      return;
    const measure = () => {
      const threshold = viewport.getBoundingClientRect().top + 96;
      let identity: string | null = headings[0]?.identity ?? null;
      for (const heading of headings) {
        const element = surface.querySelector<HTMLElement>(
          `[data-native-identity="${CSS.escape(heading.identity)}"]`,
        );
        if (!element?.getClientRects().length) continue;
        if (element.getBoundingClientRect().top > threshold) break;
        identity = heading.identity;
      }
      if (
        viewport.scrollTop > 0 &&
        viewport.scrollTop + viewport.clientHeight >= viewport.scrollHeight - 2
      )
        identity = headings.at(-1)?.identity ?? null;
      setCurrent(identity);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(surface);
    observer.observe(viewport);
    viewport.addEventListener("scroll", measure, { passive: true });
    surface.addEventListener("inknb-source-layout", measure);
    return () => {
      observer.disconnect();
      viewport.removeEventListener("scroll", measure);
      surface.removeEventListener("inknb-source-layout", measure);
    };
  }, [
    active,
    visible,
    headings,
    session,
    state.epoch,
    state.ready,
    state.pageVisible,
  ]);
  useLayoutEffect(() => {
    const selected = list.current?.querySelector<HTMLElement>(
      '[aria-current="location"]',
    );
    if (!panelVisible || !options.follow || !selected || !list.current) return;
    list.current.scrollTop =
      selected.offsetTop -
      list.current.offsetTop -
      (list.current.clientHeight - selected.offsetHeight) / 2;
  }, [panelVisible, options.follow, current]);
  useLayoutEffect(() => {
    if (!active || !visible || state.pageVisible || !headings.length) setExpanded(false);
  }, [active, visible, state.pageVisible, headings.length]);
  if (!visible || state.pageVisible || !headings.length) return null;
  const currentHeading = headings.find(
    (heading) => heading.identity === current,
  );
  const rootLevel = Math.min(6, ...headings.map((heading) => heading.level));
  return (
    <nav
      ref={container}
      className="document-outline"
      aria-label="Document outline"
      data-presentation={docked ? "panel" : "rail"}
      data-side={options.side}
      style={{
        "--outline-width": `${options.width}px`,
        "--outline-viewport-height": `${viewportHeight}px`,
      } as CSSProperties}
      onPointerEnter={(event) => {
        if (!docked && event.pointerType !== "touch" && event.buttons === 0)
          setExpanded(true);
      }}
      onPointerLeave={(event) => {
        if (!docked && event.pointerType !== "touch" && !event.currentTarget.querySelector(":focus-visible, [data-focus-visible]"))
          setExpanded(false);
      }}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget))
          setExpanded(false);
      }}
      onKeyDownCapture={(event) => {
        if (event.key !== "Escape" || !expanded || docked) return;
        event.preventDefault();
        event.stopPropagation();
        trigger.current?.focus({ preventScroll: true });
        setExpanded(false);
      }}
    >
      <Button
        ref={trigger}
        className="outline-rail"
        hidden={docked}
        data-inknb-control="outline.expand"
        aria-label={`Document contents${currentHeading ? `: ${currentHeading.title}` : ""}`}
        aria-expanded={expanded}
        aria-controls={panelId}
        onFocus={() => setExpanded(true)}
        onPress={() => setExpanded(true)}
        onKeyDown={(event) => {
          if (event.key !== "ArrowDown") return;
          event.preventDefault();
          setExpanded(true);
          requestAnimationFrame(() =>
            (
              list.current?.querySelector<HTMLButtonElement>(
                '[aria-current="location"]',
              ) ?? list.current?.querySelector("button")
            )?.focus(),
          );
        }}
      >
        <span
          className="outline-ticks"
          aria-hidden="true"
          style={{
            height: `${Math.min(224, Math.max(24, headings.length * 12))}px`,
          }}
        >
          {headings.map((heading) => (
            <span
              key={heading.identity}
              data-current={heading.identity === current}
              style={{
                width: `${Math.max(8, 24 - (heading.level - 1) * 4)}px`,
              }}
            />
          ))}
        </span>
      </Button>
      <div className="outline-panel" id={panelId} hidden={!panelVisible}>
        <div className="document-outline-heading">
          <span>Contents</span>
          <Button
            className="icon-button"
            aria-label="Hide document outline"
            data-inknb-control="outline.hide"
            onPress={() => session.update({ outlineOpen: false })}
          >
            <X size={14} aria-hidden="true" />
          </Button>
        </div>
        <ol
          ref={list}
          onKeyDown={(event) => {
            if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key))
              return;
            const buttons = Array.from(
              event.currentTarget.querySelectorAll("button"),
            );
            const index = buttons.findIndex(
              (button) => button === document.activeElement,
            );
            const next =
              event.key === "Home"
                ? 0
                : event.key === "End"
                  ? buttons.length - 1
                  : index + (event.key === "ArrowDown" ? 1 : -1);
            event.preventDefault();
            buttons[Math.max(0, Math.min(buttons.length - 1, next))]?.focus();
          }}
        >
          {headings.map((heading) => (
            <li key={heading.identity}>
              <Button
                aria-label={heading.title}
                aria-current={
                  heading.identity === current ? "location" : undefined
                }
                style={{
                  paddingInlineStart: `${8 + Math.max(0, heading.level - rootLevel) * options.indent}px`,
                }}
                data-inknb-control={`outline:${heading.identity}`}
                onPress={() => {
                  workspace.reveal(
                    state.metadata.documentId,
                    heading.from,
                    heading.from,
                  );
                  const viewport =
                    container.current?.closest<HTMLElement>(".document-scroll");
                  const bounds = session.surface?.dom
                    .querySelector(
                      `[data-native-identity="${CSS.escape(heading.identity)}"]`,
                    )
                    ?.getBoundingClientRect();
                  if (viewport && bounds)
                    viewport.scrollBy({
                      top:
                        bounds.top - viewport.getBoundingClientRect().top - 95,
                      behavior: "instant",
                    });
                  setCurrent(heading.identity);
                  setExpanded(false);
                }}
              >
                <span>{heading.title}</span>
              </Button>
            </li>
          ))}
        </ol>
      </div>
    </nav>
  );
}
