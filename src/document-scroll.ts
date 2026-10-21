export function documentScroll(element: HTMLElement): HTMLElement {
  return element.closest<HTMLElement>(".document-scroll, .aside-reader-scroll") ?? element;
}
