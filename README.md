# ink and butter

ink and butter is a local writing app for macOS. Conversations attach to passages in the document. Existing agent sessions receive requests and return replies, sources, and proposed edits.

The app uses Tauri, React, ProseMirror, and React Aria. Documents contain plain UTF-8 text. Adjacent JSON files store annotations and provenance.

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

Start a named document or open a local text file. The library lists each document once and provides search and optional collection filters. Back and Forward restore visited documents and passages. Command-[ and Command-] provide the same navigation. Select a passage and press Shift-Command-A to add an aside. An empty selection attaches the request to the cursor. Select all text to attach a document request.

Drag a document row to change its saved order. The document icon provides the keyboard drag control. Search and collections share the saved order.

Agents can leave comments and suggestions in their own asides. The document's agent connection control grants edit access for the whole document. Direct edits require this access. Aside passages provide context. Proposed changes have Accept and Dismiss controls. Applied changes enter the editor's undo history.

Ask your agent to customize the app through `inknb.toml`. Changes reload automatically. Margin is the default conversation placement. Inline uses the same annotation data. See [configuration](docs/configuration.md).

The writing surface renders Markdown and LaTeX documents. Agents can publish separate HTML or PDF presentations with source maps. The preview supports formatting asides and fullscreen. Existing Markdown remains the fallback before publication. See [product direction](docs/product-direction.md).

Ask your agent to handle routine document work, including file lookup, figure insertion, and PDF export. The agent reads the live snapshot, runs the document's build tools, and publishes output through `preview_publish`. Local file references can also attach to replies through `source_attach`. A referenced file opens from the reply. Export tools and build configuration stay with the document and external agent.

## Work with your agent

Ask your existing agent: "Work with me in ink and butter." The agent handles its connection and tool setup. The editor shows a quiet connection indicator. Use that indicator to disconnect.

Saved asides wait locally until the agent joins. Pending requests then send automatically. Connecting does not grant permission to edit prose. The document's access setting controls direct edits.

The session retains its own context and permissions. ink and butter does not select a model, manage credentials, or run the agent. MCP tools read the live buffer and return replies, sources, and edits.

See [the agent guide](docs/agents.md) for setup and transport details. Codex supplies the end-to-end integration verification. Claude channel support remains unverified on the development machine.

## Automate

External backends can subscribe to local events, replay missed work, and post anchored findings through MCP or the socket protocol. `inknb watch` streams events. `inknb hook` runs an external handler with durable checkpoints.

See [the automation contract](docs/automation.md) and [the figure-reference backend](examples/check-figure-references.mjs).

## Build components

Agents can register local HTML, CSS, and JavaScript packages and attach interactive components to asides. Data, state, and code updates work while the app runs. Components inherit the writing theme and use the existing margin or inline layout.

`ui_inspect` and `ui_action` expose navigation and component controls. Native edit acceptance and permission grants stay under human control. See [the component contract](docs/components.md), [the evidence component](examples/evidence-component), and [its external backend](examples/evidence-backend.mjs).

## Local data

Imported text stays in the file you opened. New documents receive local text files. `<filename>.aside.json` stores conversations, document access, proposed edits, and source fingerprints. Keep both files when moving a document.

The app stores `inknb.toml`, library metadata, and separate document recovery journals in the user's application support folder. Each document retains its Undo history, selection, and unsent aside drafts while switching. Recovery writes continue during typing. New text and annotation snapshots use atomic replacement.

External changes show Reload and Save a copy controls. Source changes mark their conversations and attached passages. Ambiguous anchors remain detached until the writer attaches them again.

The control socket permits connections from the current user. The MCP screenshot tool captures actual WebKit pixels with a build fingerprint, document revision, viewport, and capture identity.

## Naming and upgrades

The app name is **ink and butter**. The repository, CLI, and MCP server use **inknb**. A margin conversation is an **aside**.

The persistent application identity, support directory, and `.aside.json` format remain stable. Existing preferences migrate to `inknb.toml`. Recovery data and conversations load directly. Update the MCP command path when moving from the earlier app bundle.

Agents publish local HTML or PDF output in the preview pane. See [published previews](docs/previews.md) for the package format, source mappings, and external build hooks.
