import { createContext, useContext, useSyncExternalStore } from "react";
import { useSyncExternalStoreWithSelector } from "use-sync-external-store/with-selector";
import type { WindowDocument } from "./window-document";
import type { DocumentSession, SessionState } from "./session";

export const SessionContext = createContext<WindowDocument | null>(null);

export function useDocumentSession(): WindowDocument {
  const session = useContext(SessionContext);
  if (!session) throw new Error("The document session is unavailable.");
  return session;
}

export function useSession() {
  const session = useDocumentSession();
  return useSyncExternalStore(session.subscribe, session.getSnapshot);
}

export type AsideSession = Pick<
  DocumentSession,
  | "getSnapshot"
  | "subscribe"
  | "update"
  | "fail"
  | "comment"
  | "answerDecision"
  | "markThreadRead"
  | "collapseThread"
  | "resolve"
  | "resolveAll"
  | "reanchor"
  | "revealSource"
  | "revealPreview"
  | "selectThread"
  | "toggleThread"
  | "openAside"
  | "control"
  | "proposal"
  | "restoreFocus"
  | "startComment"
  | "hasUnreadActivity"
  | "componentMessage"
  | "hideComponent"
>;
export const AsideContext = createContext<AsideSession | null>(null);

export function useAsideSession(): AsideSession {
  const aside = useContext(AsideContext);
  const document = useContext(SessionContext);
  const session = aside ?? document;
  if (!session) throw new Error("The aside session is unavailable.");
  return session;
}

export function useAsideState() {
  const session = useAsideSession();
  return useSyncExternalStore(session.subscribe, session.getSnapshot);
}

export function useAsideSelector<Selected>(
  select: (state: SessionState) => Selected,
  equal?: (previous: Selected, next: Selected) => boolean,
): Selected {
  const session = useAsideSession();
  return useSessionSelector(session, select, equal);
}

export function useSessionSelector<Selected>(
  session: Pick<DocumentSession, "getSnapshot" | "subscribe">,
  select: (state: SessionState) => Selected,
  equal?: (previous: Selected, next: Selected) => boolean,
): Selected {
  return useSyncExternalStoreWithSelector(
    session.subscribe,
    session.getSnapshot,
    undefined,
    select,
    equal,
  );
}

export function sameFields(previous: Record<string, unknown>, next: Record<string, unknown>): boolean {
  return Object.keys(previous).length === Object.keys(next).length &&
    Object.entries(previous).every(([key, value]) => Object.is(value, next[key]));
}

export function sameItems(previous: readonly unknown[], next: readonly unknown[]): boolean {
  return previous.length === next.length && previous.every((value, index) => Object.is(value, next[index]));
}
