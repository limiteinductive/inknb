interface AnnotationSpace {
  heights: Map<string, number>;
  padding: number;
  style: HTMLStyleElement;
}

const spaces = new Map<HTMLElement, AnnotationSpace>();

export function annotationSpace(element: HTMLElement, identity: string, height: number): number {
  let space = spaces.get(element);
  if (!space && height > 0) {
    space = { heights: new Map(), padding: parseFloat(getComputedStyle(element).paddingTop) || 0, style: document.createElement("style") };
    document.head.append(space.style);
    spaces.set(element, space);
  }
  if (!space) return 0;
  const previous = space.heights.get(identity) ?? 0;
  if (height > 0) space.heights.set(identity, height);
  else space.heights.delete(identity);
  let offset = space.padding;
  for (const [key, reserved] of space.heights) {
    if (key === identity) break;
    offset += reserved;
  }
  if (!space.heights.size) {
    space.style.remove();
    spaces.delete(element);
  } else {
    const path: string[] = [];
    for (let node: Element | null = element; node; node = node.parentElement) {
      const position = node.parentElement ? Array.from(node.parentElement.children).indexOf(node) + 1 : 1;
      path.unshift(`${node.tagName.toLowerCase()}:nth-child(${position})`);
    }
    const total = [...space.heights.values()].reduce((sum, reserved) => sum + reserved, space.padding);
    const rule = `${path.join(" > ")} { padding-top: ${total}px !important; }`;
    if (space.style.textContent !== rule) space.style.textContent = rule;
  }
  if (previous !== height) requestAnimationFrame(() => document.dispatchEvent(new Event("inknb-annotations-layout")));
  return offset;
}
