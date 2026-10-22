import { useEffect } from "react";
import type { RefObject } from "react";

export function useAutoHideScrollbar(reference: RefObject<HTMLElement | null>, active = true) {
  useEffect(() => {
    const element = reference.current;
    if (!element || !active) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const reveal = () => {
      if (element.scrollHeight <= element.clientHeight) return;
      element.dataset.scrollbarVisible = "true";
      clearTimeout(timer);
      timer = setTimeout(() => delete element.dataset.scrollbarVisible, 1000);
    };
    const nearEdge = (event: PointerEvent) => {
      if (event.clientX >= element.getBoundingClientRect().right - 16) reveal();
    };
    element.dataset.autoHideScrollbar = "true";
    element.addEventListener("scroll", reveal, { passive: true });
    element.addEventListener("pointerenter", reveal, { passive: true });
    element.addEventListener("pointermove", nearEdge, { passive: true });
    return () => {
      clearTimeout(timer);
      element.removeEventListener("scroll", reveal);
      element.removeEventListener("pointerenter", reveal);
      element.removeEventListener("pointermove", nearEdge);
      delete element.dataset.autoHideScrollbar;
      delete element.dataset.scrollbarVisible;
    };
  }, [reference, active]);
}
