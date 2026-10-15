# Architecture

Status: verified for the local Apple Silicon release. See [release verification](release-verification.md).

## Naming

The app name is `ink and butter`. The repository, CLI executable, MCP server, and Rust packages use `inknb`. A margin conversation is an aside.

The persistent macOS identifier remains `io.github.limiteinductive.aside`. The support directory remains `aside`. Annotation sidecars retain the `.aside.json` suffix. These identifiers define the existing data identity.

## Foundation

The design is `long-term`. The app uses Tauri 2 with React and TypeScript. CodeMirror 6 owns the live text buffer, selection, composition, and undo history. React Aria supplies accessible control behavior. Shared tokens define typography, spacing, colors, icons, and motion.

The frontend document session is the single transaction owner. Agent requests enter that session through the same dispatcher as human actions. Rust owns filesystem coordination, recovery, native dialogs, local IPC, and external command transport. The app contains no model runtime or credential store.

CodeMirror applies local typing immediately. Serialized persistence snapshots follow each transaction. Agent reads inspect the live buffer. Agent mutations enter the JavaScript transaction loop with revision and expected-text preconditions. A stale mutation returns a conflict.

## Files

The document remains a UTF-8 Markdown file. The adjacent `<filename>.aside.json` sidecar stores a versioned document identity, annotations, requests, proposals, and provenance. A recovery snapshot contains the latest unsaved text and metadata.

Writes use temporary files and atomic replacement. Recovery remains available until the document and sidecar both persist. External changes compare against the last saved fingerprint. Conflicting changes require an explicit reconciliation action in the app.

External file changes show Reload and Save a copy controls. The buffer changes after an explicit Reload action. Recovery writes run during continuous typing. A serialized queue bounds recovery to one active write.

## Anchors

Anchors use UTF-16 offsets compatible with CodeMirror. Each edit maps the offsets through its change set. A quoted passage and surrounding context support relocation after external changes. Ambiguous matches remain detached. Changes to reviewed text mark the anchor as changed.

## Agent connections

The app exposes a local Unix socket with permissions restricted to the current user. A CLI and an MCP server use that protocol. Requests route to the live frontend through a request-response bridge.

The connection design is `long-term`. The external agent registers itself for a specific document through `agent_connect`. The document identity is a precondition. Connection changes persist before delivery starts.

The bundled `inknb connect` command reads the calling Codex shell's `CODEX_THREAD_ID`. The MCP server does not infer session identity from its inherited environment. Codex delivery uses the installed `codex queue` command with that registered session ID. Claude delivery uses the documented MCP channel contract. Channel availability depends on the external Claude installation and account policy. Connection errors remain visible and retain unsent requests.

Pending asides adopt the registered agent and send automatically. Delivered and answered requests do not resend on reconnect. Failed deliveries require an explicit Retry. Request provenance remains attached to each delivery. An in-flight delivery can finish after Disconnect. Delivery completion cannot mutate another document.

The writer interface has no provider, session, executable, or MCP configuration controls. It shows connection status and a Disconnect action. Connection grants no prose edit permission.

Codex receives end-to-end verification with an existing session. Claude remains unverified on this machine. The user selected Codex for integration testing.

The external agent owns routine document operations, including PDF export. It saves the current Markdown through MCP and runs the document's existing build tools. Generated files attach to anchored replies as local references.

The agent protocol provides live document state, selection, annotations, replies, sources, proposed edits, authorized changes, navigation, and rendered screenshots. The protocol does not select models or start an independent agent conversation.

Edits stay within the passage attached to their human request. Direct changes require explicit edit permission and an unchanged anchor. Proposals require human acceptance. Undo restores text, anchors, and the applied edit status.

A completed edit consumes its request's direct edit permission. Undo preserves that completed operation in the history.

## Interface

The Ink and butter palette uses a warm white page, dark blue text, blue controls, and pale yellow source references. Light and dark appearances share semantic tokens.

Margin conversations appear beside the selected passage. Inline conversations occupy a view decoration attached to the same anchor. Presentation changes preserve the annotation data.

Unattached conversations open in the margin in either placement. The writer can attach them to a new selection.

The text column retains its geometry when a margin thread opens. Typing has no animation. Short transitions identify opened threads and applied changes. Reduced motion removes positional animation.

The editor uses platform-native selection and caret rendering.

The figure picker accepts local files without format restrictions. It inserts an escaped Markdown reference. The document's external build determines format support.

## References

- [Tauri architecture](https://v2.tauri.app/concept/architecture/)
- [CodeMirror guide](https://codemirror.net/docs/guide/)
- [React Aria](https://react-aria.adobe.com/getting-started)
- [Codex queue](https://learn.chatgpt.com/docs/developer-commands)
- [Claude channels](https://code.claude.com/docs/en/channels-reference)
