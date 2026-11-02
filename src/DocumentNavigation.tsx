import { shortcutTooltip } from "./shortcuts";
import { useSyncExternalStore } from "react";
import { ChevronLeft, ChevronRight, PanelLeft } from "lucide-react";
import IconButton from "./IconButton";
import { workspace } from "./window-workspace";

export default function DocumentNavigation() {
  const library = useSyncExternalStore(
    workspace.subscribe,
    workspace.getSnapshot,
  );
  return (
    <nav className="history-controls" aria-label="Document navigation">
      <IconButton
        icon={PanelLeft}
        label={shortcutTooltip(library.sidebarOpen ? "Hide library" : "Show library", "sidebar", library.preferences)}
        agentControl="library.toggle"
        active={library.sidebarOpen}
        onPress={() => void workspace.command("sidebar")}
      />
      <IconButton
        icon={ChevronLeft}
        label={shortcutTooltip("Back", "back", library.preferences)}
        agentControl="navigation.back"
        disabled={library.historyIndex <= 0}
        onPress={() => void workspace.command("back").catch(error => workspace.fail(error))}
      />
      <IconButton
        icon={ChevronRight}
        label={shortcutTooltip("Forward", "forward", library.preferences)}
        agentControl="navigation.forward"
        disabled={library.historyIndex >= library.history.length - 1}
        onPress={() => void workspace.command("forward").catch(error => workspace.fail(error))}
      />
    </nav>
  );
}
