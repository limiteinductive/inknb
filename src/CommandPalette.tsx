import { shortcutLabel } from "./shortcuts";
import { useEffect, useId, useState, useSyncExternalStore } from "react";
import { Input, TextField } from "react-aria-components";
import { Search } from "lucide-react";
import { PanelBody, PanelEmpty, PanelModal } from "./PanelPopover";
import { compactLibraryWidth, workspace } from "./window-workspace";
import { currentSuggestions, nonOverlappingSuggestions } from "./suggestions";
import { resolvableAsides } from "./aside-state";
import type { WindowDocument } from "./window-document";
import { z } from "zod";
import { documentSearchMatchSchema, searchDocuments } from "./document-search";
import type { DocumentSearchMatch } from "./document-search";
import "./command-palette.css";

interface PaletteCommand {
  id: string;
  label: string;
  shortcut?: string;
  disabled?: boolean;
  detail?: string;
}

interface PaletteOption extends PaletteCommand {
  select: () => Promise<void>;
}

export default function CommandPalette({ session }: { session?: WindowDocument }) {
  const library = useSyncExternalStore(workspace.subscribe, workspace.getSnapshot);
  const state = useSyncExternalStore(session?.subscribe ?? workspace.subscribe, session?.getSnapshot ?? (() => null));
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [searchMatches, setSearchMatches] = useState<DocumentSearchMatch[]>([]);
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
    { id: "project-search", label: "Search project…" },
    { id: "sidebar", label: library.sidebarOpen ? "Hide library" : "Show library" },
    { id: "new", label: "New document" },
    { id: "open", label: "Open document…" },
    { id: "back", label: "Go back", disabled: library.historyIndex <= 0 },
    { id: "forward", label: "Go forward", disabled: library.historyIndex >= library.history.length - 1 },
    { id: "activity", label: "Notifications" },
    { id: "decisions", label: "Decisions" },
    ...(state ? [
      { id: "comment", label: "Add aside" },
      { id: "asides", label: state.asidesOpen && !state.focus ? "Hide asides" : "Show asides" },
      { id: "review", label: `Review suggestions${proposals.length ? ` (${proposals.length})` : ""}`, disabled: !proposals.length },
      { id: "accept-asides", label: `Accept all suggestions${acceptable.length ? ` (${acceptable.length})` : ""}`, disabled: !acceptable.length, detail: proposals.length > acceptable.length ? `${proposals.length - acceptable.length} overlapping suggestions need individual review.` : undefined },
      { id: "resolve-asides", label: `Resolve all asides${resolvable.length ? ` (${resolvable.length})` : ""}`, disabled: !resolvable.length },
      { id: "outline", label: state.outlineOpen ?? state.preferences.document_outline ? "Hide document outline" : "Show document outline" },
      { id: "history", label: "Document history" },
      { id: "resources", label: "Linked resources" },
      { id: "agents", label: "Agent connections" },
      { id: "focus", label: state.focus ? "Leave focus mode" : "Enter focus mode" },
      { id: "find", label: "Find in document…" },
      { id: "save", label: "Save document" },
      { id: "save-as", label: "Save document as…" },
      ...(state.metadata.page ? [{ id: "page", label: state.pageVisible ? "Show prose" : "Show document page" }] : []),
      ...(state.metadata.preview || state.metadata.previewLastGood ? [{ id: "preview", label: "Open published output" }] : []),
    ] : []),
    { id: "text-larger", label: "Larger text" },
    { id: "text-smaller", label: "Smaller text" },
    { id: "text-reset", label: "Default text size" },
  ];
  for (const command of commands) command.shortcut = shortcutLabel(command.id, library.preferences);
  const terms = query.toLocaleLowerCase().trim().split(/\s+/);
  const searchVersion = library.documents.map(entry => `${entry.id}:${entry.title}:${entry.modifiedAt}`).join("|");
  useEffect(() => {
    if (!open || !searching) return;
    let current = true;
    setSearchMatches([]);
    void workspace.request({ kind: "search", query }).then(result => {
      if (!current) return;
      const committed = z.array(documentSearchMatchSchema).parse(result);
      const local = searchDocuments([...workspace.sessions].map(([documentId, session]) => ({ documentId, title: workspace.documentTitle(documentId), text: session.getSnapshot().text })), query);
      const matches = new Map([...committed.filter(match => !workspace.sessions.has(match.documentId)), ...local].map(match => [match.documentId, match]));
      setSearchMatches(workspace.getSnapshot().documents.flatMap(entry => matches.has(entry.id) ? [matches.get(entry.id)!] : []));
    }).catch(error => { if (current) workspace.fail(error); });
    return () => { current = false; };
  }, [open, searching, query, searchVersion]);
  const matches: PaletteOption[] = searching ? searchMatches.map(match => ({
    id: match.documentId,
    label: match.title,
    detail: match.detail,
    select: async () => {
      if (match.from !== null && match.to !== null) await workspace.reveal(match.documentId, match.from, match.to);
      else await workspace.activate(match.documentId);
      if (window.innerWidth <= compactLibraryWidth) workspace.update({ sidebarOpen: false });
      requestAnimationFrame(() => workspace.active?.surface?.focus());
    },
  })) : commands.filter(command => terms.every(term => command.label.toLocaleLowerCase().includes(term))).map(command => ({ ...command, select: () => workspace.command(command.id) }));
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
