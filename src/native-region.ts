import { invoke } from "@tauri-apps/api/core";
import type { NativeEditor } from "./native-editor";
import { captureAnchor } from "./domain";
import { nativeRange, semanticSignature } from "./native-schema";
import { sourcePosition } from "./native-source";
import { imageSchema } from "./images";
import { relativeRectangleSchema } from "./geometry";
import { documentScroll } from "./document-scroll";

export class NativeRegionPicker {
  private overlay: HTMLDivElement | null = null;

  constructor(readonly owner: NativeEditor) {}

  stop(restoreFocus = true): void {
    this.overlay?.remove();
    this.overlay = null;
    if (restoreFocus && this.owner.dom.getClientRects().length)
      this.owner.focus();
  }

  start(): void {
    if (document.documentElement.dataset.documentCapture) return;
    this.stop(false);
    this.owner.closeFind();
    const owner = this.owner;
    const viewport = documentScroll(owner.dom);
    const documentBounds = owner.dom.getBoundingClientRect();
    const visible = viewport.getBoundingClientRect();
    const bounds = {
      left: Math.max(documentBounds.left, visible.left),
      right: Math.min(documentBounds.right, visible.right),
      top: Math.max(documentBounds.top, visible.top),
      bottom: Math.min(documentBounds.bottom, visible.bottom),
    };
    owner.selectSource(owner.selection.from);
    const overlay = document.createElement("div");
    overlay.className = "document-region-picker";
    overlay.tabIndex = 0;
    overlay.setAttribute("role", "application");
    overlay.setAttribute(
      "aria-label",
      "Drag to choose a region. Escape to cancel.",
    );
    Object.assign(overlay.style, {
      left: `${bounds.left}px`,
      top: `${bounds.top}px`,
      width: `${bounds.right - bounds.left}px`,
      height: `${bounds.bottom - bounds.top}px`,
    });
    const selection = document.createElement("div");
    selection.className = "document-region-selection";
    selection.hidden = true;
    overlay.append(selection);
    let start: { left: number; top: number } | null = null;
    overlay.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        this.stop();
      }
    });
    overlay.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      start = { left: event.clientX, top: event.clientY };
      overlay.setPointerCapture(event.pointerId);
      selection.hidden = false;
      Object.assign(selection.style, {
        left: `${event.clientX - bounds.left}px`,
        top: `${event.clientY - bounds.top}px`,
        width: "0px",
        height: "0px",
      });
    });
    overlay.addEventListener("pointermove", (event) => {
      if (!start) return;
      const left = Math.max(bounds.left, Math.min(bounds.right, event.clientX));
      const top = Math.max(bounds.top, Math.min(bounds.bottom, event.clientY));
      Object.assign(selection.style, {
        left: `${Math.min(start.left, left) - bounds.left}px`,
        top: `${Math.min(start.top, top) - bounds.top}px`,
        width: `${Math.abs(start.left - left)}px`,
        height: `${Math.abs(start.top - top)}px`,
      });
    });
    overlay.addEventListener("pointercancel", () => this.stop());
    overlay.addEventListener("pointerup", (event) => {
      event.preventDefault();
      if (!start) return;
      start = null;
      const rectangle = selection.getBoundingClientRect();
      if (rectangle.width < 4 || rectangle.height < 4) {
        selection.hidden = true;
        return;
      }
      const objects = [
        owner.dom,
        ...owner.dom.querySelectorAll<HTMLElement>("[data-native-identity]"),
      ]
        .map((element) => ({
          element,
          bounds: element.getBoundingClientRect(),
        }))
        .filter(
          (object) =>
            object.bounds.left <= rectangle.left &&
            object.bounds.top <= rectangle.top &&
            object.bounds.right >= rectangle.right &&
            object.bounds.bottom >= rectangle.bottom,
        )
        .sort((first, second) => {
          if (first.element.contains(second.element)) return 1;
          if (second.element.contains(first.element)) return -1;
          return (
            first.bounds.width * first.bounds.height -
            second.bounds.width * second.bounds.height
          );
        });
      const object = objects[0];
      const identity = object?.element.dataset.nativeIdentity;
      if (!object || !identity) {
        this.stop();
        return;
      }
      const state = owner.editor.state;
      let node = state.doc;
      let position = -1;
      state.doc.descendants((candidate, offset) => {
        if (candidate.attrs.identity === identity) {
          node = candidate;
          position = offset;
        }
      });
      const range = nativeRange(node, position);
      const region = relativeRectangleSchema.parse({
        left: (rectangle.left - object.bounds.left) / object.bounds.width,
        top: (rectangle.top - object.bounds.top) / object.bounds.height,
        width: rectangle.width / object.bounds.width,
        height: rectangle.height / object.bounds.height,
      });
      const anchor = captureAnchor(owner.source.toString(), {
        from: sourcePosition(owner.projection, range.from),
        to: sourcePosition(owner.projection, range.to, -1),
      });
      anchor.native = {
        from: { identity, offset: 0 },
        to: { identity, offset: range.to - range.from },
        quote: semanticSignature(node),
        region: { identity, rectangle: region },
      };
      const revision = owner.session.getSnapshot().metadata.revision;
      const scrollTop = viewport.scrollTop;
      const scrollLeft = viewport.scrollLeft;
      this.stop(false);
      document.documentElement.dataset.documentCapture = "true";
      void new Promise<void>((resolve) =>
        requestAnimationFrame(() => resolve()),
      )
        .then(async () => {
          const image = imageSchema.parse(
            await invoke("document_capture", {
              rectangle: {
                left: rectangle.left,
                top: rectangle.top,
                width: rectangle.width,
                height: rectangle.height,
              },
            }),
          );
          const current = owner.dom.getBoundingClientRect();
          if (
            !owner.dom.getClientRects().length ||
            owner.session.getSnapshot().metadata.revision !== revision ||
            viewport.scrollTop !== scrollTop ||
            viewport.scrollLeft !== scrollLeft ||
            current.left !== documentBounds.left ||
            current.top !== documentBounds.top ||
            current.width !== documentBounds.width ||
            current.height !== documentBounds.height
          )
            throw Error(
              "The document changed during capture. Choose the region again.",
            );
          owner.session.startComment();
          const snapshot = owner.session.getSnapshot();
          const draft = snapshot.drafts.new ?? { content: "", images: [] };
          owner.session.update({
            composerAnchor: anchor,
            drafts: {
              ...snapshot.drafts,
              new: { ...draft, images: [...draft.images, image] },
            },
          });
        })
        .catch((error) => owner.session.fail(error))
        .finally(() => {
          delete document.documentElement.dataset.documentCapture;
        });
    });
    document.body.append(overlay);
    this.overlay = overlay;
    overlay.focus();
  }
}
