# ink and butter

ink and butter is a local Markdown writing app for macOS. Conversations attach to passages in the document. Existing agent sessions receive requests and return replies, sources, and proposed edits.

The app uses Tauri, React, CodeMirror, and React Aria. Document text stays in Markdown files. Adjacent JSON files store annotations and provenance.

See [the architecture](docs/architecture.md), [release criteria](docs/release-criteria.md), and [release verification](docs/release-verification.md).

## Build

The build uses Node.js 22.22 or newer, Rust 1.93 or newer, and the Xcode command line tools.

```sh
npm ci
npm run check
npm test
cargo test --locked --package inknb-core --package inknb
npm run bundle
```

The locally signed app appears at `src-tauri/target/release/bundle/macos/ink and butter.app`. The bundle contains the editor and `inknb`. The installed app needs no Node.js or Rust runtime.

`npm run desktop` starts the development app. `npm run bundle` creates the local macOS release bundle.

## Write

Open a Markdown file or start a new document. Select a passage and press Shift-Command-A to add an aside. An empty selection attaches the request to the cursor. Select all text to attach a document request.

Requests permit replies and proposals by default. The Allow this edit switch permits a direct change within the attached passage. Proposed changes have Accept and Dismiss controls. Accepted changes enter the editor's undo history.

Settings control conversation placement, appearance, typeface, text size, reduced motion, and autosave. Margin is the default placement. Inline uses the same annotation data.

The document menu inserts local figures and Markdown tables. Reading preview renders standard Markdown and tables. Existing Pandoc syntax remains in the source file. The reading preview does not resolve Pandoc extensions.

Ask your agent to handle routine document work, including file lookup, figure insertion, and PDF export. The agent can save the live document with `document_save`, run the document's existing build script, and attach the generated PDF to its reply with `source_attach`. The file opens from the reply. Export tools and build configuration stay with the document and external agent.

## Connect Codex

Add the installed MCP server to Codex:

```toml
[mcp_servers.inknb]
command = "/Applications/ink and butter.app/Contents/MacOS/inknb"
args = ["mcp"]
```

Open an existing Codex session with that server available. Enter its exact session UUID in ink and butter's settings. Requests use the installed `codex queue` command. A closed session receives the queued request when it resumes.

The session retains its own context and permissions. ink and butter does not select a model, manage credentials, or run the agent. MCP tools read the live buffer and return replies, sources, and edits.

## Claude Code

Claude Code uses a local MCP channel. This connection remains unverified on the development machine. Codex supplies the end-to-end integration verification.

```json
{
  "mcpServers": {
    "inknb": {
      "command": "/Applications/ink and butter.app/Contents/MacOS/inknb",
      "args": ["mcp", "--claude-channel", "--connection", "writing"]
    }
  }
}
```

Use the same connection name in ink and butter. Claude's current channel preview requires its documented channel opt-in and a compatible account policy. The local development opt-in is `--dangerously-load-development-channels server:inknb`. ink and butter does not alter that policy or the agent's login.

## Local data

Markdown stays in the file you opened. `<filename>.aside.json` stores conversations, request permissions, proposed edits, and source fingerprints. Keep both files when moving a document.

The app stores preferences, the last document path, and its recovery journal in the user's application support folder. Recovery writes continue during typing. New text and annotation snapshots use atomic replacement.

External changes show Reload and Save a copy controls. Source changes mark their conversations and attached passages. Ambiguous anchors remain detached until the writer attaches them again.

The control socket permits connections from the current user. The MCP screenshot tool captures actual WebKit pixels with a build fingerprint, document revision, viewport, and capture identity.

## Naming and upgrades

The app name is **ink and butter**. The repository, CLI, and MCP server use **inknb**. A margin conversation is an **aside**.

The persistent application identity, support directory, and `.aside.json` format remain stable. Existing preferences, recovery data, and conversations load directly. Update the MCP command path when moving from the earlier app bundle.
