# Writing and organization

The agreed design is `long-term`.

The writer edits plain verbatim text. The app preserves the writer's words. Markdown and LaTeX syntax are agent responsibilities.

Named documents belong to optional collections. A collapsible library lists each document once. Search and collection filters select its contents. Titles and collection membership are metadata.

Each document owns its text buffer, Undo history, selection, conversations, drafts, and recovery. Switching documents retains that state. Back and Forward restore visited documents and explicit passage jumps. Typing and scrolling do not add visits.

External agents manage routine file operations and output generation. The writer can rename and organize documents directly.

External agents manage customization through `inknb.toml`. The file reloads while the app runs. The writing interface has no settings panel.

Agentic hyperminimalism guides organization. Agents manage Space names, document membership, and home documents through tools. The writer switches Spaces and opens dedicated windows.

The separate presentation model uses immutable HTML or PDF packages with exact verbatim snapshots. Source mappings connect rendered elements or page regions to verbatim passages. Text fingerprints expose stale output after edits.

The far-right preview displays that presentation. Preview selections create formatting asides with rendered locations. Available source mappings connect those discussions to current verbatim.

Linked references to source passages and earlier aside messages remain planned.
