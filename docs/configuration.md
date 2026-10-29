# Configuration

External agents manage customization through a local `inknb.toml`. The app creates the file on startup. The app has no settings panel. The View menu provides text-size commands.

On macOS, the file lives at `~/Library/Application Support/aside/inknb.toml`. The existing support directory retains its name across app upgrades. `configuration_read` returns the exact path.

```toml
version = 1
placement = "margin"
appearance = "system"
typeface = "editorial"
font_size = 17
line_width = 620
reduce_motion = false
autosave = true
agent_edits = true
detached_preview = "document"
library_depth = 1
library_sort = "recent"
document_outline = true

[outline]
presentation = "panel"
side = "left"
width = 200
min_level = 1
max_level = 6
indent = 10
follow = true
```

All keys are optional. Omitted keys use the values above. Unknown keys and unsupported versions fail validation.

| Key                | Values                             | Effect                                                                    |
| ------------------ | ---------------------------------- | ------------------------------------------------------------------------- |
| `version`          | `1`                                | Configuration format                                                      |
| `placement`        | `margin`, `inline`                 | Conversation placement                                                    |
| `appearance`       | `system`, `light`, `dark`          | Color appearance                                                          |
| `typeface`         | `editorial`, `system`, `monospace` | Writing typeface                                                          |
| `font_size`        | 14 through 28                      | Writing size in pixels                                                    |
| `line_width`       | 440 through 820                    | Maximum writing column width in pixels                                    |
| `reduce_motion`    | Boolean                            | Disables positional animation when true                                   |
| `autosave`         | Boolean                            | Saves documents automatically when true                                   |
| `agent_edits`      | Boolean                            | Default agent edit access for documents without an override               |
| `detached_preview` | `document`, `active_document`      | Keeps the detached preview on its document or follows the active document |

The macOS reduced motion preference also applies. Recovery writes continue when autosave is false.

New documents inherit `agent_edits`. Changes apply immediately to documents that inherit the default. The document's agent connection control sets an override. Use **Use app default** there to clear it. Existing saved permissions remain overrides. Connecting or disconnecting an agent preserves this choice. Direct edits still require a connected agent and exact text checks.

The app reuses one detached preview window. With `document`, detaching another document changes that window's target. With `active_document`, navigation changes its target. Changing the setting applies immediately. It does not open a preview window.

`library_depth` sets the maximum number of folder layers. Its default is `1`. Use `0` for a flat library or `-1` for unlimited nesting. Documents remain leaves. Only folders can contain other items.

Lowering the limit lifts excess folders to the root and preserves their contents. At depth `0`, all documents move to the root. Empty folder records remain available for reuse. Increasing the limit permits new nesting and does not restore previous grouping. These operations preserve manuscript text, file paths, drafts, and Undo history.

`library_sort` accepts `recent`, `alphabetical`, or `manual`. Higher priority scores sort first among siblings. Equal scores use this setting.

The previous `library_layout` key remains accepted for compatibility. `flat` maps to depth `0`, and `tree` maps to depth `1`. An explicit `library_depth` takes precedence. New configurations use `library_depth`.

## Agent tools

`configuration_read` takes no parameters. It returns the file path, TOML source, SHA-256 fingerprint, effective configuration, diagnostic, revision, and JSON schema.

`configuration_write` takes `source` and `expectedFingerprint`. It validates the complete source before writing. The fingerprint must match the current file. Writes use atomic replacement.

Both tools are available through MCP and `inknb call`. Configuration tools do not need a document identity.

Agents can also edit the file directly. The app checks it every 500 milliseconds. Atomic file replacement prevents intermediate content from becoming active.

## Validation and recovery

The complete configuration must pass validation before it becomes active. Parse errors include TOML locations. Value errors identify the invalid field. Files must contain UTF-8 text and fit within 64 KiB.

Invalid or unavailable files preserve the last accepted values. `configuration_read.diagnostic` describes the problem. A corrected file clears the diagnostic and applies across all document sessions.

The app stores accepted values in `configuration-last-good.toml` for restart recovery. This file is internal recovery metadata. Agents edit `inknb.toml`.

The first upgrade migrates `preferences.json` to TOML and retains `preferences-migrated.json`. Existing values remain active. Later launches read TOML.

## Document outline

`document_outline` sets the default visibility of the heading outline. Its default is `true`. Each window remembers an explicit visibility choice for each document. The toolbar toggles visibility.

The `[outline]` table controls presentation. Changes apply across writing windows immediately, without changing manuscript text or per-document visibility choices.

| Key | Values | Default | Effect |
| --- | --- | --- | --- |
| `presentation` | `panel`, `rail` | `panel` | Shows headings directly, or opens them from a compact rail |
| `side` | `left`, `right` | `left` | Places the outline beside the document |
| `width` | 160 through 360 | 200 | Outline width in pixels |
| `min_level` | 1 through 6 | 1 | First included heading level |
| `max_level` | 1 through 6 | 6 | Last included heading level |
| `indent` | 0 through 24 | 10 | Indentation per heading level in pixels |
| `follow` | Boolean | `true` | Keeps the current section visible in the heading list |

`min_level` must not exceed `max_level`. The current section stays marked when `follow` is false. The panel stays beside the manuscript while scrolling. In narrow document regions, it appears above the manuscript. The rail opens on click or keyboard focus. Arrow keys move through the list. Escape closes the rail's list. Selecting a heading jumps to its native document identity. Heading edits update the outline.

Agents read `configuration_read` and write the desired `[outline]` values through `configuration_write`, preserving unrelated values and comments. The returned JSON schema includes every outline field and its limits.

## Text size shortcuts

Command-plus or Command-equals enlarges document text by one pixel. Command-minus reduces it by one pixel. Command-zero resets the size to 17 pixels. The existing 14 through 28 pixel limits apply. These commands save `font_size` and apply across writing windows. Other configuration fields and comments remain intact.

## Keyboard shortcuts

Agents read `configuration_read.shortcuts` for every command identity, context, default binding, active binding, and display hint. The `[shortcuts]` table configures application commands, document formatting, aside composers, and annotations. There is no shortcut settings panel.

```toml
shortcut_timeout_ms = 1500

[shortcuts]
sidebar = ["Mod+Alt+L", "F6"]
project-search = []
resolve-asides = ["Mod+K Mod+R"]
"editor.bold" = ["Mod+Shift+B"]
"composer.send" = ["Mod+Enter"]
"composer.line-break" = ["Enter", "Shift+Enter", "Alt+Enter"]
```

Each array replaces that command's defaults. An empty array disables its shortcuts. Removing the override restores defaults. A command can have several alternative bindings. Commands without default shortcuts can receive bindings.

`Mod` means Command on macOS and Control elsewhere. `Cmd`, `Meta`, and `Super` mean Command. `Ctrl`, `Alt`, `Option`, and `Shift` are explicit modifiers. Letters and digits are accepted directly. Other keys use `KeyboardEvent.code` names, including `Backslash`, `Equal`, `Escape`, and function keys. The editor resolves physical keys, so Option does not change their identity. macOS reserves some system shortcuts and controls native menu key equivalents.

Spaces separate strokes in a sequence. The next stroke must arrive within `shortcut_timeout_ms`, which accepts 200 through 5000 milliseconds. Escape cancels an unfinished sequence. Moving focus or changing bindings also cancels it. A failed sequence retries its last stroke as a new shortcut.

Validation rejects unknown commands, invalid keys, overlapping bindings, and ambiguous sequence prefixes. Application shortcuts overlap all contexts. Editor, composer, and annotation contexts are separate. Rebind or disable conflicting commands in one atomic configuration update. Invalid edits retain the last working configuration.

Bindings reload across open windows without restarting. Native menus, palette hints, and tooltips show the primary binding. All alternatives remain active. Native menus display key sequences as hints. Agents change bindings through `configuration_write` with the current fingerprint and preserve unrelated settings.

Standard control navigation and macOS system actions remain platform-owned. Shortcut configuration grants no document editing permission and does not expose human submission or review actions to agent UI tools.
