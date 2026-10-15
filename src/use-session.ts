import { useSyncExternalStore } from "react";
import { session } from "./session";

export function useSession() {
  return useSyncExternalStore(session.subscribe, session.getSnapshot);
}
