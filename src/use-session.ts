import { createContext, useContext, useSyncExternalStore } from "react";
import type { DocumentSession } from "./session";

export const SessionContext = createContext<DocumentSession | null>(null);

export function useDocumentSession(): DocumentSession {
  const session = useContext(SessionContext);
  if (!session) throw new Error("The document session is unavailable.");
  return session;
}

export function useSession() {
  const session = useDocumentSession();
  return useSyncExternalStore(session.subscribe, session.getSnapshot);
}
