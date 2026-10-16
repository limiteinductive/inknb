# Writing and organization

The agreed design is `long-term`.

The writer edits plain verbatim text. The app preserves the writer's words. Markdown and LaTeX syntax are agent responsibilities.

Named documents belong to optional collections. A collapsible library shows open documents and searches all writing. Titles and collection membership are metadata.

Each document owns its text buffer, Undo history, selection, conversations, drafts, and recovery. Switching documents retains that state. Back and Forward restore visited documents and explicit passage jumps. Typing and scrolling do not add visits.

External agents manage routine file operations and output generation. The writer can rename and organize documents directly.

The separate presentation model remains planned. It will describe formatting through references to verbatim passages. It must preserve the source text and expose stale references after edits.

The far-right preview will display that presentation. Selections in preview will map to source passages for formatting feedback through asides.

Linked references to source passages and earlier aside messages remain planned.
