import type { SessionState } from "./session";

export type PreviewState = SessionState & { title: string };

export interface PreviewWindowSnapshot {
  sequence: number;
  asideWidth: number;
  state: PreviewState;
}
