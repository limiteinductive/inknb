import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import "./link-preview.css";

interface Preview {
  link: HTMLAnchorElement;
  reference: string;
  title: string;
  description: string;
  rectangle: DOMRect;
}

export default function LinkPreview() {
  const [preview, setPreview] = useState<Preview | null>(null);
  const surface = useRef<HTMLDivElement>(null);
  const identity = useId();
  useEffect(() => {
    let active: HTMLAnchorElement | null = null;
    let dismissed: HTMLAnchorElement | null = null;
    let opening: ReturnType<typeof setTimeout> | undefined;
    let closing: ReturnType<typeof setTimeout> | undefined;
    const cache = new Map<
      string,
      Promise<{ title: string; description: string }>
    >();
    const hide = () => {
      clearTimeout(opening);
      clearTimeout(closing);
      active = null;
      setPreview(null);
    };
    const leave = () => {
      clearTimeout(opening);
      clearTimeout(closing);
      closing = setTimeout(hide, 180);
    };
    const enter = (event: PointerEvent | FocusEvent) => {
      if (surface.current?.contains(event.target as Node)) {
        clearTimeout(closing);
        return;
      }
      const link =
        event.target instanceof Element
          ? event.target.closest<HTMLAnchorElement>("a[href]")
          : null;
      if (
        !link ||
        link === dismissed ||
        (event instanceof PointerEvent &&
          (event.buttons || event.pointerType === "touch"))
      )
        return;
      if (link === active) {
        clearTimeout(closing);
        return;
      }
      hide();
      const reference = link.getAttribute("href") ?? "";
      let destination: URL;
      try {
        destination = new URL(reference);
      } catch {
        return;
      }
      if (
        !["http:", "https:"].includes(destination.protocol) ||
        destination.username ||
        destination.password
      )
        return;
      if (!getSelection()?.isCollapsed) return;
      active = link;
      const rectangle =
        event instanceof PointerEvent
          ? ([...link.getClientRects()].find(
              (rectangle) =>
                event.clientY >= rectangle.top &&
                event.clientY <= rectangle.bottom &&
                event.clientX >= rectangle.left &&
                event.clientX <= rectangle.right,
            ) ?? link.getBoundingClientRect())
          : (link.getClientRects()[0] ?? link.getBoundingClientRect());
      opening = setTimeout(
        () => {
          if (!link.isConnected || active !== link) return;
          setPreview({
            link,
            reference,
            title: "",
            description: "",
            rectangle,
          });
          if (!cache.has(reference)) {
            if (cache.size >= 100) cache.delete(cache.keys().next().value!);
            cache.set(
              reference,
              invoke<string>("link_preview", { reference })
                .then((html) => {
                  const document = new DOMParser().parseFromString(
                    html,
                    "text/html",
                  );
                  const title =
                    document
                      .querySelector(
                        'meta[property="og:title"],meta[name="twitter:title"]',
                      )
                      ?.getAttribute("content") ?? document.title;
                  const description =
                    document
                      .querySelector(
                        'meta[property="og:description"],meta[name="description"],meta[name="twitter:description"]',
                      )
                      ?.getAttribute("content") ?? "";
                  return {
                    title: title.replace(/\s+/g, " ").trim().slice(0, 240),
                    description: description
                      .replace(/\s+/g, " ")
                      .trim()
                      .slice(0, 420),
                  };
                })
                .catch(() => ({ title: "", description: "" })),
            );
          }
          void cache.get(reference)!.then((metadata) => {
            if (active === link)
              setPreview((previous) =>
                previous?.link === link && previous.reference === reference
                  ? { ...previous, ...metadata }
                  : previous,
              );
          });
        },
        event.type === "focusin" ? 0 : 450,
      );
    };
    const exit = (event: PointerEvent | FocusEvent) => {
      const next = event.relatedTarget;
      if (!(next instanceof Node) || !dismissed?.contains(next))
        dismissed = null;
      if (!active) return;
      if (
        next instanceof Node &&
        (active?.contains(next) || surface.current?.contains(next))
      )
        return;
      leave();
    };
    const keyDown = (event: KeyboardEvent) => {
      if (
        event.key === "Enter" &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey &&
        !event.shiftKey &&
        document.activeElement instanceof HTMLAnchorElement
      ) {
        event.preventDefault();
        event.stopPropagation();
        document.activeElement.click();
        hide();
        return;
      }
      if (event.key !== "Escape" || !active) return;
      dismissed = active;
      hide();
      event.stopPropagation();
    };
    const selection = () => {
      if (!getSelection()?.isCollapsed) hide();
    };
    document.addEventListener("pointerover", enter);
    document.addEventListener("pointerout", exit);
    document.addEventListener("focusin", enter);
    document.addEventListener("focusout", exit);
    document.addEventListener("pointerdown", hide, true);
    document.addEventListener("keydown", keyDown, true);
    document.addEventListener("selectionchange", selection);
    document.addEventListener("scroll", hide, true);
    window.addEventListener("resize", hide);
    window.addEventListener("blur", hide);
    return () => {
      hide();
      document.removeEventListener("pointerover", enter);
      document.removeEventListener("pointerout", exit);
      document.removeEventListener("focusin", enter);
      document.removeEventListener("focusout", exit);
      document.removeEventListener("pointerdown", hide, true);
      document.removeEventListener("keydown", keyDown, true);
      document.removeEventListener("selectionchange", selection);
      document.removeEventListener("scroll", hide, true);
      window.removeEventListener("resize", hide);
      window.removeEventListener("blur", hide);
    };
  }, []);
  useLayoutEffect(() => {
    if (!preview || !surface.current) return;
    const { link, rectangle } = preview;
    const tooltip = surface.current;
    const describedBy = link.getAttribute("aria-describedby");
    link.setAttribute(
      "aria-describedby",
      [describedBy, identity].filter(Boolean).join(" "),
    );
    const bounds = tooltip.getBoundingClientRect();
    const left = Math.max(
      8,
      Math.min(rectangle.left, window.innerWidth - bounds.width - 8),
    );
    const below = rectangle.bottom + 8;
    const top =
      below + bounds.height <= window.innerHeight - 8
        ? below
        : Math.max(8, rectangle.top - bounds.height - 8);
    tooltip.style.left = `${left}px`;
    tooltip.style.top = `${top}px`;
    return () => {
      if (describedBy) link.setAttribute("aria-describedby", describedBy);
      else link.removeAttribute("aria-describedby");
    };
  }, [preview, identity]);
  if (!preview) return null;
  const destination = new URL(preview.reference);
  return createPortal(
    <div
      ref={surface}
      id={identity}
      role="tooltip"
      className="hover-surface link-preview"
    >
      {preview.title && <strong>{preview.title}</strong>}
      {preview.description && <p>{preview.description}</p>}
      <span className="link-preview-destination">
        {destination.host}
        {destination.pathname === "/" ? "" : destination.pathname}
        {destination.search}
        {destination.hash}
      </span>
    </div>,
    document.body,
  );
}
