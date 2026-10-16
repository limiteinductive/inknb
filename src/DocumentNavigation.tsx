import { useSyncExternalStore } from "react";
import { ArrowLeft, ArrowRight, PanelLeft } from "lucide-react";
import IconButton from "./IconButton";
import { workspace } from "./workspace";

export default function DocumentNavigation({
  onNavigate,
}: {
  onNavigate?: () => void;
}) {
  const library = useSyncExternalStore(
    workspace.subscribe,
    workspace.getSnapshot,
  );
  return (
    <nav className="history-controls" aria-label="Document navigation">
      <IconButton
        icon={PanelLeft}
        label={library.sidebarOpen ? "Hide library" : "Show library"}
        agentControl="library.toggle"
        active={library.sidebarOpen}
        onPress={() => void workspace.command("sidebar")}
      />
      <IconButton
        icon={ArrowLeft}
        label="Back"
        agentControl="navigation.back"
        disabled={library.historyIndex <= 0}
        onPress={() => {
          workspace.navigate(-1);
          onNavigate?.();
        }}
      />
      <IconButton
        icon={ArrowRight}
        label="Forward"
        agentControl="navigation.forward"
        disabled={library.historyIndex >= library.history.length - 1}
        onPress={() => {
          workspace.navigate(1);
          onNavigate?.();
        }}
      />
    </nav>
  );
}
