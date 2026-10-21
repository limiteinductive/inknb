import { useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

export default function DocumentToolbar({
  children,
  active = true,
  className = "",
}: {
  children: ReactNode;
  active?: boolean;
  className?: string;
}) {
  const container = useRef<HTMLDivElement>(null);
  const [scrolling, setScrolling] = useState(false);
  const [hovering, setHovering] = useState(false);
  const [docked, setDocked] = useState(true);
  useLayoutEffect(() => {
    const host = container.current?.parentElement;
    if (!host || !active) return;
    const viewport = host.querySelector<HTMLElement>(".document-scroll");
    const updateDock = () => {
      const top = Math.max(0, viewport?.scrollTop ?? 0);
      setDocked(current => top <= (current ? 64 : 16));
    };
    updateDock();
    let timer: ReturnType<typeof setTimeout>;
    const updatePointer = (top: number | null) => {
      const offset = top === null ? -1 : top - host.getBoundingClientRect().top;
      setHovering(!host.closest("[hidden]") && offset >= 0 && offset <= 64);
    };
    const move = (event: PointerEvent) => {
      updatePointer(
        event.pointerType === "mouse" && event.buttons === 0
          ? event.clientY
          : null,
      );
    };
    const framePointer = (event: Event) => {
      updatePointer((event as CustomEvent<number | null>).detail);
    };
    const leave = () => setHovering(false);
    const reveal = () => {
      if (host.closest("[hidden]")) return;
      updateDock();
      setScrolling(true);
      clearTimeout(timer);
      timer = setTimeout(() => setScrolling(false), 1200);
    };
    const reset = () => {
      clearTimeout(timer);
      setScrolling(false);
      setHovering(false);
    };
    host.addEventListener("pointermove", move, { passive: true });
    host.addEventListener("pointerleave", leave);
    host.addEventListener("inknb-frame-pointer", framePointer);
    host.addEventListener("scroll", reveal, { capture: true, passive: true });
    document.addEventListener("visibilitychange", reset);
    return () => {
      clearTimeout(timer);
      host.removeEventListener("pointermove", move);
      host.removeEventListener("pointerleave", leave);
      host.removeEventListener("inknb-frame-pointer", framePointer);
      host.removeEventListener("scroll", reveal, true);
      document.removeEventListener("visibilitychange", reset);
    };
  }, [active]);
  return (
    <div
      ref={container}
      className="document-toolbar"
      data-docked={docked}
      data-scroll-revealed={scrolling}
      data-pointer-revealed={hovering}
    >
      <header className={`titlebar ${className}`} data-tauri-drag-region>
        {children}
      </header>
    </div>
  );
}
