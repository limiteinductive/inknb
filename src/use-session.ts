import { createContext, useContext, useSyncExternalStore } from "react";
import type { WindowDocument } from "./window-document";
import type { DocumentSession } from "./session";

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
  | "setPlacement"
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
