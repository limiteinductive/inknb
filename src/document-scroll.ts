export function documentScroll(element: HTMLElement): HTMLElement {
  return element.closest<HTMLElement>(".document-scroll, .aside-reader-scroll, .aside-conversation-scroll, .composer-content") ?? element;
}
