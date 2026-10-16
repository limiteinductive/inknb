# Architecture

Status: version 0.4.1 passed local release verification. See [release verification](release-verification.md).

## Naming

The app name is `ink and butter`. The repository, CLI executable, MCP server, and Rust packages use `inknb`. A margin conversation is an aside.

The persistent macOS identifier remains `io.github.limiteinductive.aside`. The support directory remains `aside`. Annotation sidecars retain the `.aside.json` suffix. These identifiers define the existing data identity.

## Foundation

The design is `long-term`. The app uses Tauri 2 with React and TypeScript. CodeMirror 6 owns the live text buffer, selection, composition, and undo history. React Aria supplies accessible control behavior. Shared tokens define typography, spacing, colors, icons, and motion.

Each frontend document session owns its transactions. Agent requests enter the document's dispatcher. Rust owns filesystem coordination, recovery, native dialogs, local IPC, and external command transport. The app contains no model runtime or credential store.

CodeMirror applies local typing immediately. Serialized persistence snapshots follow each transaction. Agent reads inspect the live buffer. Agent mutations enter the JavaScript transaction loop with revision and expected-text preconditions. A stale mutation returns a conflict.

## Files

Documents contain UTF-8 text. New documents receive local text files through the app. Imported files retain their paths and contents. The writer interface requires no Markdown syntax.

The adjacent `<filename>.aside.json` sidecar uses annotation format 3. It reads formats 1 and 2 directly and stores a versioned document identity, annotations, requests, proposals, and provenance. Each document has its own recovery snapshot. Startup migrates the earlier shared snapshot.

Writes use temporary files and atomic replacement. Recovery remains available until the document and sidecar both persist. External changes compare against the last saved fingerprint. Conflicting changes require an explicit reconciliation action in the app.

External file changes show Reload and Save a copy controls. The buffer changes after an explicit Reload action. Recovery writes run during continuous typing. A serialized queue bounds recovery to one active write.

## Library and navigation

The workspace design is `long-term`. It owns document sessions, titles, collections, the open list, and navigation history. A local library file stores those records and document view state.

Each document retains its editor, Undo history, selection, conversations, and unsent drafts during navigation. The library searches exact document text and titles. Collections contain document references.

The sidebar header owns its toggle and Back and Forward controls. The writing header owns those controls while the sidebar is hidden. Narrow windows show the library in a dismissible modal drawer. Navigation closes that drawer and restores writing focus.

The document title is static text. The sidebar provides New and Open actions. The native File menu and keyboard shortcuts provide Save and Save As. The Preview action appears while its pane is closed.

Back and Forward restore visited documents and explicit passage jumps. Typing and scrolling do not add visits. A new visit after Back removes the forward branch. Navigation does not enter text Undo history.

Agent operations route by document, request, component, or message identity. Interface actions require the visible document. Background document replies retain their original session owner.

The agreed verbatim and presentation requirements appear in [product direction](product-direction.md). The separate agent presentation model remains planned.

## Anchors

Anchors use UTF-16 offsets compatible with CodeMirror. Each edit maps the offsets through its change set. A quoted passage and surrounding context support relocation after external changes. Ambiguous matches remain detached. Changes to reviewed text mark the anchor as changed.

## Agent connections

The app exposes a local Unix socket with permissions restricted to the current user. A CLI and an MCP server use that protocol. Requests route to the live frontend through a request-response bridge.

The connection design is `long-term`. The external agent registers itself for a specific document through `agent_connect`. The document identity is a precondition. Connection changes persist before delivery starts.

The bundled `inknb connect` command reads the calling Codex shell's `CODEX_THREAD_ID`. The MCP server does not infer session identity from its inherited environment. Codex delivery uses the installed `codex queue` command with that registered session ID. Claude delivery uses the documented MCP channel contract. Channel availability depends on the external Claude installation and account policy. Connection errors remain visible and retain unsent requests.

Pending asides adopt the registered agent and send automatically. Delivered and answered requests do not resend on reconnect. Delivery receipts reconcile completed sends. The transport retries failures before process start. Uncertain sends require agent reconciliation. Request provenance remains attached to each delivery. An in-flight delivery can finish after Disconnect. Delivery completion cannot mutate another document.

The writer interface has no provider, session, executable, or MCP configuration controls. It shows connection status and a Disconnect action. Connection grants no prose edit permission.

Codex receives end-to-end verification with an existing session. Claude remains unverified on this machine. The user selected Codex for integration testing.

The external agent owns routine document operations, including PDF export. It saves the current Markdown through MCP and runs the document's existing build tools. Generated files attach to anchored replies as local references.

The agent protocol provides live document state, selection, annotations, replies, sources, proposed edits, authorized changes, navigation, and rendered screenshots. The protocol does not select models or start an independent agent conversation.

Edits stay within the passage attached to their human request. Direct changes require explicit edit permission and an unchanged anchor. Proposals require human acceptance. Undo restores text, anchors, and the applied edit status.

A completed edit consumes its request's direct edit permission. Undo preserves that completed operation in the history.

## Automation

The local protocol uses version 1 over a Unix socket. A durable SQLite event journal supports subscriptions, replay cursors, named consumer checkpoints, and external executable hooks. See [the automation contract](automation.md).

Human and maintenance requests share one queue. Maintenance work permits replies and proposals. External backends can post anchored findings through the same live document owner. Human replies keep discussions under human control.

Pending proposals follow unrelated edits. Changes to their passage create refresh work. Source changes create fingerprint-scoped reviews. Detached passages receive exact or human-confirmed attachment candidates.

Document moves retain recovery journals until files and events commit. Local figure and document references inside the document folder retain their relative paths.

## Agent components

The component design is `long-term`. Immutable local packages define interactive HTML, CSS, and JavaScript. Package registration stores content by fingerprint. Sidecars store instance references, data, state, and component revisions.

Instances belong to asides and use their existing anchors and placement. Components publish durable events for external backends. The host serializes state updates with revision preconditions. Mounting and data updates preserve the manuscript and cursor.

The host serves package assets through a custom protocol. Sandboxed frames receive an explicit bridge for context, state, and events. Components have no native command or manuscript access. Host UI actions expose a declared set of navigation controls. Human edit acceptance and permission controls remain excluded.

See [the component contract](components.md) for the runtime API and package format.

## Interface

The Ink and butter palette uses a warm white page, dark blue text, blue controls, and pale yellow source references. Light and dark appearances share semantic tokens.

Margin conversations appear beside the selected passage. Inline conversations occupy a view decoration attached to the same anchor. Presentation changes preserve the annotation data.

Unattached conversations open in the margin in either placement. The writer can attach them to a new selection.

The text column retains its geometry when a margin thread opens. Typing has no animation. Short transitions identify opened threads and applied changes. Reduced motion removes positional animation.

The editor uses platform-native selection and caret rendering. A completed selection exposes one aside action at its active end. CodeMirror owns action placement, clipping, and scrolling. Opening an aside preserves the editor selection and focuses the composer. The interaction design is `long-term`.

The selection action uses the same speech bubble icon as the header. Placement uses the full selection bounds when space is available. Selections that fill the viewport use the active end. A draft captures its passage when opened. Text changes map that anchor. Moving the editor selection does not move the draft.

The reading preview design is `long-term`. The manuscript, reading preview, and asides occupy separate panes. Each pane scrolls independently. Opening preview retains aside drafts and discussion state.

Preview occupies a root pane at the far right. Its header contains expand or restore and close icons with tooltips and accessible names. Its content spans the window height. The writing pane owns the manuscript, asides, title bar, and status bar. Its controls stay inside its width when preview opens.

Wide writing panes show manuscript and asides in columns. Narrow writing panes stack asides below the manuscript. Preview retains its own column. Focus mode hides preview and asides. It restores their visibility on exit.

Fullscreen preview uses the native window fullscreen mode and displays only the rendered document. Exit fullscreen and Escape restore the side pane. The app restores the window's previous fullscreen state. Closing preview returns focus to the manuscript.

Preview uses the same Markdown buffer, local asset resolution, and sanitized renderer. Agent UI controls expose preview navigation, fullscreen, and scrolling. The UI snapshot includes preview mode and pane geometry.

## References

- [Tauri architecture](https://v2.tauri.app/concept/architecture/)
- [CodeMirror guide](https://codemirror.net/docs/guide/)
- [React Aria](https://react-aria.adobe.com/getting-started)
- [Codex queue](https://learn.chatgpt.com/docs/developer-commands)
- [Claude channels](https://code.claude.com/docs/en/channels-reference)
