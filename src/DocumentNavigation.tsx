import { shortcutTooltip } from "./shortcuts";
import { useSyncExternalStore } from "react";
import { PanelLeft } from "lucide-react";
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
    </nav>
  );
}
