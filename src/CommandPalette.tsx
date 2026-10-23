import { useEffect, useId, useState, useSyncExternalStore } from "react";
import { Input, TextField } from "react-aria-components";
import { Search } from "lucide-react";
import { PanelBody, PanelEmpty, PanelModal } from "./PanelPopover";
import { workspace } from "./window-workspace";
import { currentSuggestions } from "./suggestions";
import type { WindowDocument } from "./window-document";
import "./command-palette.css";

interface PaletteCommand {
  id: string;
  label: string;
  shortcut?: string;
  disabled?: boolean;
}

export default function CommandPalette({ session }: { session?: WindowDocument }) {
  const library = useSyncExternalStore(workspace.subscribe, workspace.getSnapshot);
  const state = useSyncExternalStore(session?.subscribe ?? workspace.subscribe, session?.getSnapshot ?? (() => null));
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const listId = useId();
  const open = library.commandSurface === "commands";
  useEffect(() => {
    if (!open) return;
    setQuery("");
    setSelectedIndex(0);
  }, [open]);
  const proposals = state ? currentSuggestions(state) : [];
  const commands: PaletteCommand[] = [
    { id: "sidebar", label: library.sidebarOpen ? "Hide library" : "Show library", shortcut: "⌘\\" },
    { id: "new", label: "New document", shortcut: "⌘N" },
    { id: "open", label: "Open document…", shortcut: "⌘O" },
    { id: "back", label: "Go back", shortcut: "⌘[", disabled: library.historyIndex <= 0 },
    { id: "forward", label: "Go forward", shortcut: "⌘]", disabled: library.historyIndex >= library.history.length - 1 },
    { id: "activity", label: "Notifications", shortcut: "⌘⇧K" },
    { id: "decisions", label: "Decisions" },
    ...(state ? [
      { id: "comment", label: "Add aside", shortcut: "⌘⇧A" },
      { id: "asides", label: state.asidesOpen && !state.focus ? "Hide asides" : "Show asides" },
      { id: "review", label: `Review suggestions${proposals.length ? ` (${proposals.length})` : ""}`, disabled: !proposals.length },
      { id: "outline", label: state.outlineOpen ?? state.preferences.document_outline ? "Hide document outline" : "Show document outline" },
      { id: "history", label: "Document history" },
      { id: "resources", label: "Linked resources" },
      { id: "agents", label: "Agent connections" },
      { id: "focus", label: state.focus ? "Leave focus mode" : "Enter focus mode", shortcut: "⌘⇧F" },
      { id: "find", label: "Find in document…", shortcut: "⌘F" },
      { id: "save", label: "Save document", shortcut: "⌘S" },
      { id: "save-as", label: "Save document as…", shortcut: "⌘⇧S" },
      ...(state.metadata.page ? [{ id: "page", label: state.pageVisible ? "Show prose" : "Show document page" }] : []),
      ...(state.metadata.preview || state.metadata.previewLastGood ? [{ id: "preview", label: "Open published output", shortcut: "⌘⇧P" }] : []),
    ] : []),
    { id: "text-larger", label: "Larger text", shortcut: "⌘+" },
    { id: "text-smaller", label: "Smaller text", shortcut: "⌘−" },
    { id: "text-reset", label: "Default text size", shortcut: "⌘0" },
  ];
  const terms = query.toLocaleLowerCase().trim().split(/\s+/);
  const matches = commands.filter(command => terms.every(term => command.label.toLocaleLowerCase().includes(term)));
  const selected = matches[Math.min(selectedIndex, matches.length - 1)];
  const run = (command: PaletteCommand) => {
    if (command.disabled) return;
    workspace.update({ commandSurface: null });
    void workspace.command(command.id).catch(error => workspace.fail(error));
  };
  return <PanelModal open={open} onOpenChange={open => workspace.update({ commandSurface: open ? "commands" : null })} className="command-palette" title="Commands" size="wide" placement="top">
    <PanelBody className="command-search-body">
      <TextField className="command-search" aria-label="Search commands" value={query} onChange={value => { setQuery(value); setSelectedIndex(0); }}>
        <Search size={17} aria-hidden="true" />
        <Input autoFocus placeholder="Search commands…" role="combobox" aria-expanded="true" aria-autocomplete="list" aria-controls={listId} aria-activedescendant={selected ? `${listId}-${selected.id}` : undefined} data-inknb-control="commands.search" onKeyDown={event => {
          if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            const direction = event.key === "ArrowDown" ? 1 : -1;
            const next = (selectedIndex + direction + matches.length) % matches.length;
            setSelectedIndex(matches.length ? next : 0);
            document.getElementById(`${listId}-${matches[next]?.id}`)?.scrollIntoView({ block: "nearest" });
          }
          if (event.key === "Enter") {
            event.preventDefault();
            if (selected && !event.repeat) run(selected);
          }
        }} />
      </TextField>
    </PanelBody>
    <PanelBody className="command-results" layout="list">
      <div id={listId} role="listbox" aria-label="Commands">
        {matches.map(command => <button type="button" key={command.id} id={`${listId}-${command.id}`} role="option" aria-selected={command === selected} aria-disabled={command.disabled || undefined} className="command-option" tabIndex={-1} data-inknb-control={`command:${command.id}`} onMouseEnter={() => setSelectedIndex(matches.indexOf(command))} onMouseDown={event => event.preventDefault()} onClick={() => run(command)}>
          <span>{command.label}</span>
          {command.shortcut && <kbd>{command.shortcut}</kbd>}
        </button>)}
      </div>
      {!matches.length && <PanelEmpty>No matching commands.</PanelEmpty>}
    </PanelBody>
  </PanelModal>;
}
