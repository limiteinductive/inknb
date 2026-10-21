import { invoke } from "@tauri-apps/api/core";
import { parseAsideLink } from "./aside-reference";
import type { AsideReference } from "./domain";

export class LinkGesture {
  private pressed: { link: HTMLAnchorElement; left: number; top: number; moved: boolean } | null = null;
  constructor(
    readonly documentPath: () => string | null,
    readonly openAside: (reference: AsideReference) => void,
    readonly fail: (error: unknown) => void,
  ) {}
  pointerDown(event: PointerEvent): void {
    const link = event.button === 0 && event.target instanceof Element
      ? event.target.closest<HTMLAnchorElement>("a[href]") : null;
    this.pressed = link ? { link, left: event.clientX, top: event.clientY, moved: false } : null;
  }
  pointerMove(event: PointerEvent): void {
    if (this.pressed && event.buttons && Math.hypot(event.clientX - this.pressed.left, event.clientY - this.pressed.top) > 4)
      this.pressed.moved = true;
  }
  click(event: MouseEvent): boolean {
    const link = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>("a[href]") : null;
    if (!link) return false;
    event.preventDefault();
    const pressed = this.pressed;
    this.pressed = null;
    if (event.shiftKey || event.altKey || event.detail > 1 || (event.detail !== 0 && (pressed?.link !== link || pressed.moved)) || !getSelection()?.isCollapsed)
      return false;
    const reference = link.getAttribute("href") ?? "";
    const aside = parseAsideLink(reference);
    void Promise.resolve().then(() => {
      if (aside) this.openAside(aside);
      else return invoke("open_reference", { documentPath: this.documentPath(), reference });
    }).catch(this.fail);
    return true;
  }
}
