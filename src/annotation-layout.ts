interface AnnotationSpace {
  heights: Map<string, number>;
  padding: number;
  style: HTMLStyleElement;
  viewports: Set<HTMLElement>;
}

const spaces = new Map<HTMLElement, AnnotationSpace>();

export function annotationSpace(element: HTMLElement, identity: string, height: number): number {
  let space = spaces.get(element);
  if (!space && height > 0) {
    space = { heights: new Map(), padding: parseFloat(getComputedStyle(element).paddingTop) || 0, style: document.createElement("style"), viewports: new Set() };
    document.head.append(space.style);
    spaces.set(element, space);
  }
  if (!space) return 0;
  const content = element.querySelector(":scope > .tableWrapper") ?? element;
  const range = document.createRange();
  range.selectNodeContents(content);
  const contentTop = () => {
    const bounds = range.getBoundingClientRect();
    return bounds.height ? bounds.top : element.getBoundingClientRect().top + (parseFloat(getComputedStyle(element).paddingTop) || 0);
  };
  const padding = parseFloat(getComputedStyle(element).paddingTop) || 0;
  const beforeTop = contentTop();
  const viewports = new Map([...space.viewports].map(viewport => [viewport, viewport.style.overflowAnchor]));
  for (let parent = element.parentElement; parent; parent = parent.parentElement) {
    if (!parent.matches(".document-scroll, .aside-reader-scroll, .aside-conversation-scroll, .response-scroll")) continue;
    viewports.set(parent, parent.style.overflowAnchor);
    space.viewports.add(parent);
  }
  for (const viewport of viewports.keys()) viewport.style.overflowAnchor = "none";
  const previous = space.heights.get(identity) ?? 0;
  if (height > 0) space.heights.set(identity, height);
  else space.heights.delete(identity);
  let offset = 0;
  for (const [key, reserved] of space.heights) {
    if (key === identity) break;
    offset += reserved;
  }
  const total = [...space.heights.values()].reduce((sum, reserved) => sum + reserved, 0);
  let changed = previous !== height;
  if (!space.heights.size) {
    space.style.remove();
    spaces.delete(element);
  } else {
    let boundary = element;
    let ceiling = element.getBoundingClientRect().top;
    while (boundary.parentElement) {
      let sibling = boundary.previousElementSibling;
      while (sibling && !sibling.getBoundingClientRect().height) sibling = sibling.previousElementSibling;
      if (sibling) {
        const siblingRange = document.createRange();
        siblingRange.selectNodeContents(sibling);
        const siblingBounds = siblingRange.getBoundingClientRect();
        ceiling = siblingBounds.height ? siblingBounds.bottom : sibling.getBoundingClientRect().bottom;
        break;
      }
      boundary = boundary.parentElement;
      ceiling = boundary.getBoundingClientRect().top;
      if (boundary.matches(".native-content, .response-content, [data-message-content], td, th, li, blockquote")) break;
    }
    const whitespace = Math.max(0, beforeTop - (padding - space.padding) - ceiling);
    const path: string[] = [];
    for (let node: Element | null = element; node; node = node.parentElement) {
      const position = node.parentElement ? Array.from(node.parentElement.children).indexOf(node) + 1 : 1;
      path.unshift(`${node.tagName.toLowerCase()}:nth-child(${position})`);
    }
    const rule = `${path.join(" > ")} { padding-top: ${space.padding + Math.max(0, total - whitespace)}px !important; }`;
    if (space.style.textContent !== rule) {
      space.style.textContent = rule;
      changed = true;
    }
  }
  for (const [viewport, overflowAnchor] of viewports) {
    const anchored = viewport.contains(element) && element.getClientRects().length > 0;
    const bounds = viewport.getBoundingClientRect();
    const reveal = anchored && height > previous && beforeTop >= bounds.top && beforeTop < bounds.bottom
      ? Math.max(0, bounds.top + total - beforeTop)
      : 0;
    const reserved = parseFloat(viewport.style.getPropertyValue("--annotation-scroll-space")) || 0;
    const available = viewport.scrollHeight - viewport.clientHeight - reserved;
    const required = [...spaces.keys()].some(paragraph => viewport.contains(paragraph))
      ? Math.max(0, viewport.scrollTop + (anchored ? contentTop() - beforeTop - reveal : 0) - available)
      : 0;
    viewport.classList.toggle("annotation-scroll-space", required > 0);
    if (required) viewport.style.setProperty("--annotation-scroll-space", `${required}px`);
    else viewport.style.removeProperty("--annotation-scroll-space");
    const movement = anchored ? contentTop() - beforeTop - reveal : 0;
    if (movement) viewport.scrollBy({ top: movement, behavior: "instant" });
    viewport.style.overflowAnchor = overflowAnchor;
  }
  if (changed) requestAnimationFrame(() => document.dispatchEvent(new Event("inknb-annotations-layout")));
  return contentTop() - element.getBoundingClientRect().top - total + offset;
}
