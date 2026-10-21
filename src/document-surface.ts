import type { Anchor } from "./domain";

export interface WritingSurface {
  readonly dom: HTMLElement;
  coordsAtPos(position: number): { left: number; top: number; right: number; bottom: number };
  anchorBounds(anchor: Anchor): { left: number; top: number; right: number; bottom: number };
  scrollToSource(position: number, anchor?: Anchor): void;
  requestMeasure(): void;
  focus(): void;
}
