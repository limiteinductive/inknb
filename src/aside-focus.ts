export function revealAsideComposer(
  element: HTMLElement,
  reduceMotion: boolean,
): () => void {
  let frame = requestAnimationFrame(() => {
    frame = requestAnimationFrame(() => {
      if (!element.isConnected || !element.getClientRects().length) return;
      element.focus({ preventScroll: true });
      const viewport = element.closest<HTMLElement>(
        ".aside-reader-scroll, .document-scroll",
      );
      const card = element.closest<HTMLElement>(".new-aside");
      if (!viewport || !card) return;
      const bounds = viewport.getBoundingClientRect();
      const toolbar = viewport
        .closest(".document-container")
        ?.querySelector(".document-toolbar .titlebar")
        ?.getBoundingClientRect();
      const top = Math.max(bounds.top, toolbar?.bottom ?? bounds.top) + 16;
      const bottom = bounds.bottom - 24;
      const cardTop = card.getBoundingClientRect().top;
      const cardBottom = card.getBoundingClientRect().bottom;
      const distance =
        cardTop < top
          ? cardTop - top
          : cardBottom > bottom
            ? Math.min(cardBottom - bottom, cardTop - top)
            : 0;
      if (distance)
        viewport.scrollBy({
          top: distance,
          behavior:
            reduceMotion ||
            window.matchMedia("(prefers-reduced-motion: reduce)").matches
              ? "instant"
              : "smooth",
        });
    });
  });
  return () => cancelAnimationFrame(frame);
}

export function focusAside(
  element: HTMLElement,
  identity: string | null,
): void {
  const host = element.closest<HTMLElement>(".document-body");
  if (!host || host.dataset.focusedAside === (identity ?? "")) return;
  host.dataset.focusedAside = identity ?? "";
  for (const card of host.querySelectorAll<HTMLElement>("[data-aside-id]"))
    card.toggleAttribute("data-emphasized", card.dataset.asideId === identity);
  host.dispatchEvent(
    new CustomEvent("inknb-aside-focus", { detail: { id: identity } }),
  );
}
