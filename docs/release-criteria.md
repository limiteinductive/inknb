# Release criteria

Evidence appears in [release verification](release-verification.md). Unchecked release criteria identify unfinished work. Planned presentation criteria describe a later release.

## Library and navigation

- [x] Named documents and collections survive restart.
- [x] Search finds verbatim text across collections.
- [x] Document switches retain Undo, selection, scroll, conversations, and drafts.
- [x] Back and Forward restore visits without changing text Undo history.
- [x] A new visit after Back clears the forward branch.
- [x] Separate recovery records preserve concurrent document changes.
- [x] Background agent replies and attachments reach their original document.
- [x] Draft clearing checks the submitted draft identity after local recovery.
- [x] Native screenshots confirm sidebar, navigation, asides, and preview at normal and compact sizes.

## Planned presentation work

- [ ] An agent formats a separate presentation without changing verbatim text.
- [ ] Preview feedback attaches to the corresponding source passage.
- [ ] Asides cite source passages and earlier conversation turns.

## Documents

- [x] New, open, save, save as, and reopen preserve UTF-8 Markdown exactly.
- [x] Undo, redo, selection, paste, composition, search, and keyboard shortcuts work in the desktop app.
- [x] Autosave and recovery preserve unsaved work across restart.
- [x] External edits show Reload and Save a copy controls without replacing the current buffer.
- [x] Figure and table insertions preserve existing Markdown conventions.
- [x] Local export workflows remain available.

## Conversations

- [x] A request can attach to a caret, selected passage, or document.
- [x] Margin and Inline use the same persistent threads.
- [x] Threads and provenance survive edits, save, and restart.
- [x] Deleted passages, changed passages, and ambiguous anchors remain explicit.
- [x] Replies, sources, proposed edits, and authorized insertions appear at their anchors.
- [x] Stale proposals fail without changing the document.
- [x] Changed or missing sources receive visible freshness markers.

## Agent connections

- [x] An existing Codex session registers itself without human session IDs or executable fields.
- [x] Saved pending asides send when the agent joins. Connection grants no prose edit permission.
- [x] A real existing Codex session receives an editor request and replies through inknb MCP.
- [x] Claude channel support states its external requirements and verification status.
- [x] Disconnect and reconnect preserve pending requests without duplicate delivery.
- [x] The app contains no model selection, credentials, context engine, or agent harness.
- [x] Local IPC rejects invalid requests and restricts access to the current user.
- [x] MCP screenshots capture the rendered app and identify the captured state.

## Automation

- [x] Unrelated typing preserves pending proposals and their target text.
- [x] Affected proposals create read-only refresh work for the agent.
- [x] Changed sources create fingerprint-scoped reviews beside affected passages.
- [x] Detached discussions accept exact matches or human-confirmed candidates.
- [x] Figure and table tools prepare insertions for human acceptance.
- [x] Document moves preserve annotations and direct local references with recovery.
- [x] Delivery receipts prevent automatic resends after completed or uncertain sends.
- [x] Versioned socket events support replay and durable consumer checkpoints.
- [x] Executable hooks retry unacknowledged failures and reconnect after restart.
- [x] Independent backends can post findings without gaining prose edit permission.

## Components and UI control

- [x] Agents register immutable local packages and load them without a desktop rebuild.
- [x] Component state survives native input, code updates, save, and restart.
- [x] Component revisions reject conflicting state writes.
- [x] Concurrent retries mount one instance for one component identity.
- [x] Local JavaScript modules load inside component packages.
- [x] Component interactions reach an external backend and return visible results.
- [x] Frame isolation blocks manuscript access, native commands, network requests, and remote navigation.
- [x] Agent UI actions expose declared controls and reject stale snapshots.
- [x] Native edit acceptance and permission controls remain human actions.

## Interface

- [x] Writing, conversation, source, proposal, pending, error, and empty states receive screenshot review.
- [x] Light and dark appearances remain readable at supported window sizes.
- [x] Opening a visible margin thread preserves text geometry, selection, cursor, and scroll.
- [x] Keyboard focus, native dialogs, menus, and scrolling work through computer use.
- [x] Motion remains short, interruptible, and compatible with reduced motion.
- [x] Shared components and tokens control the complete interface.

## Delivery

- [x] Focused behavior and integration tests pass.
- [x] The installed app completes a real request, reply, edit, undo, save, and restart workflow.
- [x] A locally installable app bundle and reproducible build instructions exist.
- [x] Source, documentation, fixtures, assets, and Git history pass the privacy audit.
- [x] The personal GitHub repository remains private.
