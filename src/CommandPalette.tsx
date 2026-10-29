import { useEffect, useId, useState, useSyncExternalStore } from "react";
import { Input, TextField } from "react-aria-components";
import { Search } from "lucide-react";
import { PanelBody, PanelEmpty, PanelModal } from "./PanelPopover";
import { compactLibraryWidth, workspace } from "./window-workspace";
import { currentSuggestions, nonOverlappingSuggestions } from "./suggestions";
import { resolvableAsides } from "./aside-state";
import type { WindowDocument } from "./window-document";
import { documentPosition } from "./native-source";
import "./command-palette.css";

interface PaletteCommand {
  id: string;
  label: string;
  shortcut?: string;
  disabled?: boolean;
}

interface PaletteOption extends PaletteCommand {
  detail?: string;
  select: () => Promise<void>;
}

export default function CommandPalette({ session }: { session?: WindowDocument }) {
  const library = useSyncExternalStore(workspace.subscribe, workspace.getSnapshot);
  const state = useSyncExternalStore(session?.subscribe ?? workspace.subscribe, session?.getSnapshot ?? (() => null));
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const listId = useId();
  const searching = library.commandSurface === "project-search";
  const open = library.commandSurface === "commands" || searching;
  useEffect(() => {
    if (!open) return;
    setQuery("");
    setSelectedIndex(0);
  }, [open, searching]);
  const proposals = state ? currentSuggestions(state) : [];
  const acceptable = state ? nonOverlappingSuggestions(state) : [];
  const resolvable = state ? resolvableAsides(state.metadata) : [];
  const commands: PaletteCommand[] = [
    { id: "project-search", label: "Search project…", shortcut: "⌘K" },
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
      { id: "accept-asides", label: `Accept all asides${acceptable.length ? ` (${acceptable.length})` : ""}`, disabled: !acceptable.length },
      { id: "resolve-asides", label: `Resolve all asides${resolvable.length ? ` (${resolvable.length})` : ""}`, disabled: !resolvable.length },
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
  const search = query.trim();
  const expression = search ? new RegExp(search.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "iu") : null;
  const matches: PaletteOption[] = searching ? library.documents.flatMap(entry => {
    const document = workspace.sessions.get(entry.id);
    if (!document) return [];
    const snapshot = document.getSnapshot();
    const match = expression?.exec(snapshot.text);
    if (expression && !expression.test(entry.title) && !match) return [];
    const model = document.model;
    const detail = match && model
      ? model.state.doc.textBetween(documentPosition(model.projection, match.index), documentPosition(model.projection, Math.min(snapshot.text.length, match.index + Math.max(search.length, 72))), " ", " ")
      : undefined;
    return [{
      id: entry.id,
      label: entry.title,
      detail,
      select: async () => {
        if (match) workspace.reveal(entry.id, match.index, match.index + match[0].length);
        else workspace.activate(entry.id);
        if (window.innerWidth <= compactLibraryWidth) workspace.update({ sidebarOpen: false });
        requestAnimationFrame(() => workspace.active?.surface?.focus());
      },
    }];
  }) : commands.filter(command => terms.every(term => command.label.toLocaleLowerCase().includes(term))).map(command => ({ ...command, select: () => workspace.command(command.id) }));
  const selected = matches[Math.min(selectedIndex, matches.length - 1)];
  const run = (command: PaletteOption) => {
    if (command.disabled) return;
    workspace.update({ commandSurface: null });
    void command.select().catch(error => workspace.fail(error));
  };
  const title = searching ? "Search project" : "Commands";
  return <PanelModal open={open} onOpenChange={open => workspace.update({ commandSurface: open ? searching ? "project-search" : "commands" : null })} className="command-palette" title={title} size="wide" placement="top">
    <PanelBody className="command-search-body">
      <TextField className="command-search" aria-label={searching ? "Search project" : "Search commands"} value={query} onChange={value => { setQuery(value); setSelectedIndex(0); }}>
        <Search size={17} aria-hidden="true" />
        <Input autoFocus placeholder={searching ? "Search titles or text…" : "Search commands…"} role="combobox" aria-expanded="true" aria-autocomplete="list" aria-controls={listId} aria-activedescendant={selected ? `${listId}-${selected.id}` : undefined} data-inknb-control={searching ? "project.search" : "commands.search"} onKeyDown={event => {
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
      <div id={listId} role="listbox" aria-label={searching ? "Project documents" : "Commands"}>
        {matches.map(command => <button type="button" key={command.id} id={`${listId}-${command.id}`} role="option" aria-selected={command === selected} aria-disabled={command.disabled || undefined} className="command-option" tabIndex={-1} data-inknb-control={`${searching ? "project.document" : "command"}:${command.id}`} onMouseEnter={() => setSelectedIndex(matches.indexOf(command))} onMouseDown={event => event.preventDefault()} onClick={() => run(command)}>
          <span><span className="command-option-label">{command.label}</span>{command.detail && <small>{command.detail}</small>}</span>
          {command.shortcut && <kbd>{command.shortcut}</kbd>}
        </button>)}
      </div>
      {!matches.length && <PanelEmpty>{searching ? "No matching documents." : "No matching commands."}</PanelEmpty>}
    </PanelBody>
  </PanelModal>;
}
