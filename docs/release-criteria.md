# Release criteria

Evidence appears in [release verification](release-verification.md). An unchecked criterion means the release is incomplete.

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

- [x] A real existing Codex session receives an editor request and replies through aside MCP.
- [x] Claude channel support states its external requirements and verification status.
- [x] Disconnect and reconnect preserve pending requests without duplicate delivery.
- [x] The app contains no model selection, credentials, context engine, or agent harness.
- [x] Local IPC rejects invalid requests and restricts access to the current user.
- [x] MCP screenshots capture the rendered app and identify the captured state.

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
