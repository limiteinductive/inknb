import { useLayoutEffect, useRef } from "react";

export default function LibrarySelection() {
  const selection = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const indicator = selection.current;
    const host = indicator?.parentElement;
    if (!indicator || !host) return;
    let previousRow: HTMLElement | null = null;
    let previousGeometry = "";
    const measure = () => {
      const row = host.querySelector<HTMLElement>(
        '.library-document[aria-selected="true"]',
      );
      if (!row?.getClientRects().length) {
        indicator.dataset.visible = "false";
        previousRow = null;
        return;
      }
      const bounds = row.getBoundingClientRect();
      const parent = host.getBoundingClientRect();
      const left =
        Math.round((bounds.left - parent.left) * devicePixelRatio) /
        devicePixelRatio;
      const top =
        Math.round((bounds.top - parent.top) * devicePixelRatio) /
        devicePixelRatio;
      const geometry = `${left}:${top}:${bounds.width}:${bounds.height}`;
      if (row === previousRow && geometry === previousGeometry) return;
      indicator.dataset.animated = String(
        Boolean(previousRow && previousRow !== row),
      );
      indicator.style.transform = `translate3d(${left}px, ${top}px, 0)`;
      indicator.style.width = `${bounds.width}px`;
      indicator.style.height = `${bounds.height}px`;
      indicator.dataset.visible = "true";
      previousRow = row;
      previousGeometry = geometry;
    };
    const mutation = new MutationObserver(measure);
    mutation.observe(host, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["aria-selected", "aria-expanded"],
    });
    const resize = new ResizeObserver(measure);
    resize.observe(host);
    measure();
    return () => {
      mutation.disconnect();
      resize.disconnect();
    };
  }, []);
  return (
    <div ref={selection} className="library-selection" aria-hidden="true" />
  );
}
