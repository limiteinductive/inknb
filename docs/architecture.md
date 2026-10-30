# Architecture

Agent UI controls use an explicit navigation allowlist. Suggestion decisions, bulk acceptance, human message submission, and human resolution controls remain unavailable through `ui_action`. Agents use the validated document and conversation tools. Automatic closure handles a new completion or a discussion whose review blocker has cleared.

Agent editing uses a `long-term` document permission model. Annotation format 6 stores `agentAccess` with a default of `read`. The writer grants `edit` in the document's agent connection control. The grant survives restart and reconnection of the same agent session. Disconnecting or connecting another session resets it to `read`. Configuration and agent UI tools cannot grant access.

Direct edits require a connected agent and document edit access. Each change carries the document identity, current revision, exact range, and expected text. Request and aside identities record optional context. Multiple changes can use one request. Each applied change enters the app-owned ProseMirror Undo history. Direct changes without an aside retain their operation record with null context identities.

Agents create comments with `annotation_create`. They attach suggestions with `edit_propose` and the returned thread identity. A human request is optional. The proposed passage can differ from the discussion passage. Suggestions require human acceptance. Legacy request permission fields remain historical metadata. `requests_list` reports the document's current access in its permission field.

Accept all asides applies the current document's valid, non-overlapping suggestions in one Undo transaction. Existing suggestion lifecycle rules resolve the linked asides. Conflicting suggestions remain open.

Table suggestions use one native table projection and one review bar. Structural comparison associates each proposal with its table. Projected source ranges identify changed cells. Preview transactions leave the document unchanged. Each acceptance uses the existing proposal revision and text checks.

The Show asides and Hide asides commands toggle the whole column. Each document stores its column visibility in its library entry. Hiding the column retains thread expansion states and drafts. New aside commands and passage navigation reveal the column. Selecting text or pressing Shift+Command+A creates an aside.

Each table exposes the shared comment-plus icon. The action captures the whole table and opens its composer in one click. Selection and deletion remain in the table context menu.

Aside scope follows selection in the `long-term` design. A selected passage creates a source anchor. No selection creates a whole-document aside with no source or preview anchor. The composer captures this scope when opened. Moving the selection does not change it. Whole-document asides appear above passage asides and remain unanchored through text changes. Existing cursor anchors retain their locations.

The `long-term` file-aside command uses Command+Option+A and appears in the Edit menu. It opens an unanchored aside regardless of selection. Command+Shift+A follows the selection. Both commands retain an existing composer draft and its captured scope. Detached previews send the file-aside command to their document owner.

Aside browsing uses a `long-term` design. Each window stores independent thread expansion states for each document. Unresolved threads start expanded. Unread replies reopen their own thread. Reading a reply retains its open state. Explicit collapse applies until new activity arrives. Completed threads stay in History. Open cards remain visible when an agent completes their discussion. Unread completed replies open by default. Writer actions control each card independently. Selecting or opening an aside preserves the reading position, other open threads, and composer drafts. Show passage and aside references provide explicit source navigation. Collapsed margin markers open their own thread directly. Pointer exit, focus changes, History dismissal, and source changes retain open cards. Nearby threads have separate cards and markers. A scrollable margin shows threads in source order. Unattached threads follow anchored threads. Selection controls the manuscript highlight and optional inline presentation separately from expansion. New aside drafts share the margin with existing threads. Human messages omit visible author labels. Agent messages show their registered names. Collapse controls retain accessible labels.

Aside composer shortcuts use a `long-term` design. Enter sends the current draft. Command+Enter and Control+Enter insert a line break at the selection. Shift+Enter inserts a line break. Composition keystrokes do not send requests. The shared composer applies these rules to new asides and replies.

Agent aside creation uses a `long-term` passage mapping design. Each document session retains immutable CodeMirror text and composed position mappings for its latest 128 read revisions. Text transactions advance these mappings. Aside creation validates its original passage and maps it into the current document before mutation. Changed or removed passages fail validation. Reloads clear the read snapshots. Annotation writes remain idempotent by message identity. Prose edits retain revision and permission checks.

Detached previews use a `long-term` design. The app-owned document library owns one reusable preview window and its document target. The `detached_preview` configuration selects a fixed document or the active document. The default keeps the chosen document. Configuration changes update the target immediately. The renderer receives snapshots from the app-owned document session and sends typed actions to that owner. It does not create a document session. Docking returns the renderer to the writing window. The detached window displays the shared aside margin and sends validated human actions to the document owner. Each window controls its margin visibility. Closing a writing window preserves the detached preview and its document host.

Status: version 0.5.0 passed local release verification. See [release verification](release-verification.md).

## Naming

The app name is `ink and butter`. The repository, CLI executable, MCP server, and Rust packages use `inknb`. A margin conversation is an aside.

The app icon depicts an ink-blue butter block and a cut pat on an ivory tile. `app-icon.png` is the source. `tauri icon app-icon.png --output src-tauri/icons --png 512` generates the bundled image.

The persistent macOS identifier remains `io.github.limiteinductive.aside`. The support directory remains `aside`. Annotation sidecars retain the `.aside.json` suffix. These identifiers define the existing data identity.

## Foundation

The design is `long-term`. The app uses Tauri 2 with React and TypeScript. ProseMirror owns structured document transactions and Undo. Writing windows own selection and composition. Immutable source projections retain the original document format. React Aria supplies accessible control behavior. Shared tokens define typography, spacing, colors, icons, and motion.

Each frontend document session owns its transactions. Agent requests enter the document's dispatcher. Rust owns filesystem coordination, recovery, native dialogs, local IPC, and external command transport. The app contains no model runtime or credential store.

Writing windows apply local typing immediately. ProseMirror collaboration steps reconcile each view with the app-owned document model. The host persists accepted transactions before acknowledgement. Agent reads inspect committed source. Agent mutations enter the JavaScript transaction loop with revision and expected-text preconditions. A stale mutation returns a conflict.

LaTeX title declarations remain in the original source. At `\maketitle`, a read-only title block displays their title, author, and explicit date; abstract environments retain an editable body beneath an app-generated heading. Native document format 3 rebuilds earlier LaTeX views from their verified source while retaining the document identity, operation records, and matching object identities.

## Files

Documents contain UTF-8 text. New documents receive local text files through the app. Imported files retain their paths and contents. The writer interface requires no Markdown syntax.

The adjacent `<filename>.aside.json` sidecar uses annotation format 6. It reads formats 1 through 5. Formats 1 through 4 receive read access. Format 5 retains its document grant. It stores document identity, access, annotations, requests, proposals, and provenance. Each document has its own recovery snapshot. Startup migrates the earlier shared snapshot.

Writes use temporary files and atomic replacement. Recovery remains available until the document and sidecar both persist. External changes compare against the last saved fingerprint. The recovery snapshot retains the common file text. External source changes merge through native document transactions. Independent changes save automatically. Overlapping passage changes preserve the current writing and create one review suggestion for the external version. File fingerprints still guard each write.

Recovery writes run during continuous typing. A serialized queue bounds recovery to one active write. Reconciliation keeps the document's Undo history, anchors, and pending suggestions. Explicit Save and automatic Save use the same file reconciliation path.

## Library and navigation

The Spaces design is `long-term`. A hidden app-owned host retains document sessions, source projections, anchors, conversations, revision storage, and Undo. Closing a writing window leaves other windows usable.

Spaces contain document references and an optional home document. Membership is independent of folders. One document can belong to several Spaces. Each Space owns its pinned shortcuts. Folder priorities and document order remain library metadata.

Each writing window owns navigation, selection, scroll position, layout, expanded discussions, and unsent drafts. The library stores these records separately from document models. Version 3 migrates the earlier library view state into the default Writing space.

Sidebars, search, pins, navigation, and Activity use the window's Space membership. Global app issues remain visible across Spaces. Notification targets open a Space that contains their document. Aside links can open another Space without changing membership.

Human New and Open commands assign documents to the current Space. Agent creation uses the saved default Space unless the request supplies a Space identity. Background creation preserves window navigation.

Writing windows exchange revisioned ProseMirror steps with the host. The host rebases each view through the shared step history. Conflicting recovery retains the window's pending source. Closing and quitting flush source steps and drafts before destroying windows.

Command+K opens project search. It searches document titles and text within the current Space. Selecting a text result reveals its first matching passage. The sidebar has no search field. Project search also appears in the Command+P palette. Folders contain document references. The canonical source, conversations, revision history, and Undo remain shared across windows.

The sidebar header owns its toggle, Commands, and notifications. The writing view has no top bar. A standalone library toggle remains when the sidebar is hidden. Command+P opens the command palette. It filters commands by name and supports arrow keys, Enter, and Escape. Back and Forward remain available through the palette and native shortcuts. Narrow windows show the library in a dismissible modal drawer. Navigation closes that drawer and restores writing focus.

The document title is static text. One plus button beside the document list creates a document. Agents manage collections as document references without moving files. The native File menu and keyboard shortcuts provide New, Open, Save, and Save As. The palette provides document, view, aside, review, history, agent, and linked resource commands. The aside heading shows the conversation count, New aside, and Hide controls.

Double-clicking a document name edits it inline. F2 starts editing the focused name. Enter or leaving the field saves. Escape cancels. Document rows have no action menu.

Preview resizing uses a `long-term` design. React Resizable Panels owns pointer gestures, keyboard resizing, constraints, and accessibility state. The library stores the preferred preview width after user interaction. Available workspace space constrains the displayed width. Fullscreen retains the preferred width. Navigation labels and controls disable text selection. Document text and conversation messages remain selectable.

The separator has a physical grab area around its line. Pointer capture starts on press. Resize persistence uses the callback layout. The group restores preferred widths after geometry changes. Native file drag handling is disabled. React Aria owns document drag operations.

Window chrome uses a `long-term` native design. AppKit notifications track fullscreen entry, fullscreen exit, resizing, window updates, and display scale changes. Native window updates enforce the traffic-light bounds. Unchanged frames require no native mutation. The application owns and removes its notification observers.

Each window owns its chrome state. The sidebar and detached preview use the same native control alignment. Chrome events target their owning window. The detached title uses the measured control inset.

The detached preview toolbar reveals within a 64-pixel hover zone below the document area's top edge. The zone observes pointer movement without intercepting document input. Sandboxed frames report pointer positions through their validated message channels. Dragging a selection does not activate the hover zone.

Interface geometry uses shared control, badge, and label metrics. Count badges have a fixed height and centered tabular numerals. Single-digit notification badges are circular. Longer counts keep that height and expand horizontally. Activity, History, and command panels share panel headings, body gutters, and height limits. Notifications and command panels use dismissible modal dialogs. The detached preview retains its anchored History popover. Status indicators align with their first text line. Search focus uses one background wash across the field. Its input has no separate underline.

Windowed navigation shares the traffic lights' vertical center and reserves space after their measured bounds. Fullscreen navigation uses the left toolbar inset. The windowed inset returns during fullscreen exit. The same geometry applies with the sidebar open or closed. Agent snapshots measure current native control bounds on the main thread.

Back and Forward restore visited documents and explicit passage jumps. Typing and scrolling do not add visits. A new visit after Back removes the forward branch. Navigation does not enter text Undo history.

Workspace scroll captures clamp negative browser offsets to zero before storing document or navigation state.

Agent operations route by document, request, component, or message identity. Interface actions require the visible document. Background document replies retain their original session owner.

The agreed verbatim and presentation requirements appear in [product direction](product-direction.md). The general preview host implements the separate agent presentation model.

## Anchors

Mark done resolves the discussion and closes its expanded view. Focus moves to its collapsed row. Completed discussions remain visible as muted, single-line rows with checkmarks. Their accessible names identify them as done. Reopen expands the thread and selects its passage.

Gutter dots identify unread incoming aside activity. Local library records store read signatures without changing annotation revisions. Agent replies, proposals, components, source changes, and anchor suggestions change those signatures. Human messages and passage movement do not. A visible conversation in the focused app acknowledges its displayed activity. Hidden documents retain unread state. Existing conversations start read when read tracking is first installed.

Anchors use UTF-16 offsets compatible with CodeMirror. Each edit maps the offsets through its change set. A quoted passage and surrounding context support relocation after external changes. Ambiguous matches remain detached. Changes to reviewed text mark the anchor as changed.

Detached anchors retain historical offsets and quotes. Storage checks their range order without requiring those offsets to fit the current source.

Document review uses a `long-term` queue derived from applicable proposals. The badge counts pending suggestions independently of discussion visibility. Source order determines navigation. Passage markers and the Review suggestions command open the suggestion's aside and reveal its document location.

An expanded aside shows its formatted suggestion inside the manuscript at the target passage. Collapsing the aside restores the source view. The preview preserves paragraph, list, and table structure. Show original switches the local preview version. The source text remains unchanged until acceptance.

Accept and Dismiss appear beside the inline preview. Each action awaits the document transaction before advancing. Accepted changes enter the document's Undo history. Earlier suggestions stay in their asides and cannot be accepted.

## Context menus

Context menus use a `long-term` native design. The app owns menu contents through Tauri. Text fields retain native editing commands. The manuscript offers Add aside. Preview text offers Copy and Add aside. Preview surfaces offer Comment on region. App chrome has no context menu. Trusted preview and component runtimes route context events through their validated host bridges. Embedded content receives no native menu capability. Each window releases the previous menu before creating another.

Region mode disables native text selection and owns pointer gestures across preview text. HTML uses a runtime selection style and capture handlers. PDF overrides its text layer selection styles and captures pointer and mouse presses. Leaving region mode restores text selection.

## Configuration

The configuration design is `long-term`. Rust owns a typed, versioned `inknb.toml` in the application support directory. The frontend receives effective values.

Startup migrates existing JSON preferences. Optional TOML keys use defaults. Unknown keys, unsupported versions, invalid values, and files over 64 KiB produce diagnostics.

A native task checks the file every 500 milliseconds. Accepted values apply across document sessions without changing text, selection, or Undo history. Configuration revisions order frontend notifications.

The app caches the last accepted configuration for recovery after restart. Invalid or unavailable files preserve those values. Recovery metadata is separate from the editable configuration.

Agents discover the file, effective values, diagnostics, and generated schema through `configuration_read`. `configuration_write` validates TOML before atomic replacement and checks the previous fingerprint.

The writer interface has no settings panel, settings shortcut, or settings menu. See [configuration](configuration.md).

## Agent connections

The app exposes a local Unix socket with permissions restricted to the current user. A CLI and an MCP server use that protocol. Requests route to the live frontend through a request-response bridge.

The connection design is `long-term`. The external agent registers itself for a specific document through `agent_connect`. The document identity is a precondition. Connection changes persist before delivery starts.

Session identity uses the provider and session ID. Display names and roles are mutable metadata. Reconnecting refreshes their stored attribution across messages, suggestions, decisions, and request bindings. Disconnect retains those values in existing records. Unnamed sessions show a short session identifier.

The bundled `inknb connect --name <name> --role <role>` command reads the calling Codex shell's `CODEX_THREAD_ID`. The MCP server does not infer session identity from its inherited environment. Codex delivery uses the installed `codex queue` command with that registered session ID. Claude delivery uses the documented MCP channel contract. Channel availability depends on the external Claude installation and account policy. Connection errors remain visible and retain unsent requests.

Pending asides adopt the registered agent and send automatically. Delivered and answered requests do not resend on reconnect. Delivery receipts reconcile completed sends. The transport retries failures before process start. Uncertain sends require agent reconciliation. Request provenance remains attached to each delivery. An in-flight delivery can finish after Disconnect. Delivery completion cannot mutate another document.

The writer interface has no provider, session, executable, or MCP configuration controls. It shows connection status, document edit access, and Disconnect. Connection grants no prose edit permission.

Codex receives end-to-end verification with an existing session. Claude remains unverified on this machine. The user selected Codex for integration testing.

The external agent owns routine document operations, including PDF export. It saves the current Markdown through MCP and runs the document's existing build tools. Generated files attach to anchored replies as local references.

The agent protocol provides live document state, selection, annotations, replies, sources, proposed edits, authorized changes, navigation, and rendered screenshots. The protocol does not select models or start an independent agent conversation.

Aside anchors provide context for edits. Document access authorizes direct changes. Exact revision and text checks reject stale operations. Undo restores text, anchors, and the applied edit status.

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

The Ink and butter palette uses a warm white page, dark blue text, blue controls, and pale yellow source references. The library uses butter selection fills and soft focus fills. Light and dark appearances share semantic tokens.

The paper material design is `long-term`. One static, seamless SVG combines fine grain and directional fibers. Navigation and the toolbar use the full texture. Manuscript and Markdown preview surfaces use a softer reading texture. Asides, menus, dialogs, decision cards, and response panels use the shared note texture. Wide-margin, floating, and inline asides share that texture. Aside composers use the same surface. Shared radius and elevation tokens define cards and panels. Text, icons, images, PDF pages, and external previews retain their own rendering. Increased contrast and reduced transparency remove the decorative texture.

The sidebar uses the navigation paper surface and a faint divider. Search has no resting border. Search focus surrounds the complete field. The active library toggle uses ink without a selection fill.

The sidebar shows one document list. Search and collection filters select its contents. Collections appear after the first collection is created.

Document order is the saved library array order. React Aria provides pointer and keyboard drag interactions with insertion indicators. The existing document icon is the keyboard drag control. Reordering changes library metadata and preserves the active document. Filtered views share the same order. Moving a visible document preserves the relative order of other documents.

The active document row uses a butter selection fill. Keyboard focus uses the shared hover fill. Rows retain their text and icon geometry across states.

All open conversations share one independently scrolling column outside the document surface. Passage references belong to messages. Suggestions retain their edit targets.

Older anchored discussions appear in the same column as discussions with message references. Their source excerpts remain navigable.

The text column retains its geometry when a margin thread opens. Typing has no animation. Short transitions identify opened threads and applied changes. Reduced motion removes positional animation.

The editor uses platform-native selection and caret rendering. Selecting text opens a contextual comment field. The document view owns its placement, clipping, and scrolling.

The selection action uses the same speech bubble icon as the header. Placement uses the full selection bounds when space is available. Selections that fill the viewport use the active end. A draft captures its passage when opened. Text changes map that anchor. Moving the editor selection does not move the draft.

Preview reading progress uses a `long-term` shared indicator. A two-pixel line below the toolbar tracks the visible renderer's scroll fraction. HTML and Markdown report their document geometry. PDF uses its viewer's scroll geometry. Resizing updates the fraction. A document that fits in the viewport reports completion. Preview containers show no perimeter focus outline. Links and controls retain their focus indicators.

The document view design is `long-term`. Each document stores Write, Preview, or Both independently from native fullscreen and detached window ownership. Source and preview retain their mounted state across view changes. The source retains its selection, Undo history, and scroll position. View changes capture the window scroll position. Text edits map source anchors through their change sets.

One optional aside margin sits outside the document surfaces in each window. All conversation contexts use that margin. Threads retain independent expansion states. Completed threads remain visible as compact rows.

The aside column moves below the document when the window cannot fit both surfaces side by side. Narrow Both views stack the source and preview. The resize separator supports both orientations. The library stores the preferred horizontal preview width.

The document toolbar and status bar belong to the window layout. Preview controls appear in the document toolbar. Preview-only mode hides the source without entering native fullscreen. Fullscreen changes only the native window state.

The preview host design is `long-term`. External agents publish immutable local HTML or PDF packages with exact source snapshots and optional source maps. The app uses an isolated HTML frame or a bundled PDF.js viewer. Markdown remains the fallback before publication.

Text fingerprints track preview freshness independently of annotation revisions. Publication compares the previous artifact identity. The last successful render stays visible during updates and failures.

Preview asides use a `long-term` design across Markdown, HTML, and PDF. Text selection captures a quote and rendered location. The toolbar region action captures a local PNG and rendered location. Drafts and saved threads retain the image identity. Agent tools return the saved image. Markdown uses immutable HTML snapshots and block source mappings in the shared renderer.

Preview discussions retain their rendered artifact and location. Source mappings can attach them to verbatim. Layout-only discussions have no source anchor. All preview discussions use the margin and confer no prose edit permission.

Agent tools expose publication, source mappings, build status, renderer diagnostics, fullscreen, and scrolling. Durable events support external build hooks. See [published previews](previews.md).

## References

- [Tauri architecture](https://v2.tauri.app/concept/architecture/)
- [CodeMirror guide](https://codemirror.net/docs/guide/)
- [React Aria](https://react-aria.adobe.com/getting-started)
- [Codex queue](https://learn.chatgpt.com/docs/developer-commands)
- [Claude channels](https://code.claude.com/docs/en/channels-reference)

## Pasted images

The writer and aside composers accept clipboard images. One local content-addressed store owns PNG, JPEG, GIF, and WebP bytes. Each image must fit within 12 MB. Image imports finish before a reference enters a document or draft.

Selected manuscript images use an outline. Their context menu provides Copy Image, Save Image As, Open Image, Delete Image, Add aside, and Comment on region. Command-C copies image pixels as PNG. Saving retains the original bytes and format. Image deletion uses document Undo. Markdown image destinations containing spaces use angle brackets.

Writer pastes insert regular Markdown references to the stored local files. The insertion uses the document's Undo history. Its target follows intervening edits. A changed selection or closed writing surface rejects the pending insertion. Saving or moving the manuscript keeps these absolute local references valid. Copying a manuscript to another computer also requires its referenced image files.

Aside drafts and messages store image identities, names, media types, and paths. A message can contain images without text. Drafts retain images across navigation, restart, and detached preview windows. Removing a draft attachment leaves its immutable bytes available to existing references and Undo. Annotation format 7 adds message images and reads prior formats with empty image lists.

Agents read submitted images through image_read. The tool requires an image referenced by a message in the requested aside. It does not expose unsent draft images. Writer images remain ordinary local file references.


## Markdown tables

Markdown tables retain whole words and numeric values. Tables can extend beyond the prose width within the preview. Wider tables scroll horizontally within their own region. Longer cell prose wraps between words. Keyboard focus enables horizontal scrolling. Cell wrappers preserve Markdown alignment and source targets for preview asides.

## Document pages and linked resources

Document pages bind immutable layout packages to canonical native node identities. Native app controls map field edits and structural moves into document transactions. The host owns durability and shared Undo. Window state retains conflicting field drafts. Sandboxed layout code receives read-only snapshots.

Linked resources belong to document metadata. Internal targets use document identities. Backlinks derive from the shared document host. Resource changes preserve source text and Space membership.

The heading outline uses native heading identities. A compact rail tracks the current section from heading positions in the document viewport. An expanded heading list overlays the gutter without resizing the manuscript. Each window stores its visibility choice for each document. Configuration supplies the default.

Document structure uses semantic heading nodes. `document_read.native.outline` and the navigation outline share heading identities, levels, titles, and source positions. Each document read includes the authoring contract. Agents use headings for sections and bold spans for inline emphasis. The reading typography owns heading presentation. Structural edits retain the document's permission and review requirements.

The outline remains beside the manuscript while the document scrolls. A configured panel uses the compact rail when its workspace has at most 760 pixels available. The rail opens on hover or focus. Its list fits the document viewport, including when a notes reader shares the window. Configuration retains the preferred presentation, side, and width.

App context menus share selection restoration and native clipboard commands. Suggestion displays share word-level removed and inserted text. File-aside scope and composer position remain separate state.


The document toolbar docks at the top of the manuscript. The document reserves its opening header space inside the scroll canvas. Scrolling changes the header's width, corners, and inset without resizing the scroll viewport. The toolbar floats beyond the opening region and docks again near the top. Reduced motion disables the transition. Each mounted document retains its own toolbar state.

Open passage asides keep a quiet underline while their conversations are collapsed. Expanded or focused conversations add the passage background. Resolving a discussion removes its persistent underline. Focus mode and document captures hide the annotation underline.

Draft passage asides paint their captured source anchor while the composer is open. Moving focus to the composer does not change that range. Closing the composer removes the draft decoration.

New aside composers show a source excerpt when they have one. Source excerpts navigate to their passages. Creating an aside focuses its input and reveals the draft within the aside column. Reading existing asides preserves the document scroll position.

Text-size shortcuts and native menu commands use the configuration store. Size changes read the latest saved value under its lock. The store changes only the `font_size` field and publishes the result to writing windows.

## Sending selected text as an aside

Command-Shift-Return sends selected manuscript text as a new aside. The host checks the revision and exact source passage. One recovery snapshot stores the new aside and the text removal. Agent delivery starts after recovery succeeds. The aside stays anchored at the removal point. Document Undo restores the removed text. The submitted aside remains in the conversation. Existing composer drafts remain saved.


## Decisions and connected agents

This design is long-term. Document metadata owns decision records and named agent connections. New drafts start with the default agent. Each queued request retains its recipient snapshot. Connection identities are self-declared and confer no edit permission.

Annotation format 12 migrates the single connection into the connections list. Messages, proposals, and decisions retain their creator identity. Connection updates preserve historical attribution. Drafts retain the selected recipients. A human message can create several requests, each bound to one agent. These requests share one message and one aside. Every selected agent must settle its own request before automatic closure. `comment_recipients` selects a compact multi-recipient menu or automatic routing to the document default. Agent configuration controls this behavior.

Each decision has a retry-safe identity, question, options, recommendation, optional Markdown context, and optional passage anchor. Live anchors follow document transactions. The original anchor remains available for retry validation. Human answers retain exact text, the chosen option, and the recorded time.

The writing window submits answers through a dedicated host action. MCP tools and agent UI controls cannot submit human answers. Decision states are open, answered, acknowledged, withdrawn, and superseded. Answered records cannot be withdrawn or replaced.

Decision cards appear in the document margin and the Space decisions list. Both presentations share the document session and saved answer drafts. The list retains closed records in history.

Decision changes and their events commit in one recovery transaction. Read-by-ID uses a persistent SQLite index updated in that transaction. Successful source saves retain this index. Startup seeds missing index entries from document metadata. Agent waits read these durable records until completion or their original deadline. Waits survive desktop restarts and support MCP cancellation.

The running desktop app publishes the tool catalog. MCP bridges retain the last available catalog during restarts and emit tools/list_changed notifications when it changes. Tool calls run concurrently. Each MCP connection remembers its registered caller. Explicit caller identity supports shared transports.

Notifications use a `long-term` inbox shared by the list, unread badge, and native alerts. Each aside groups its question, pending suggestions, and completed reply. Linked suggestions share their source aside's group. Questions take priority over suggestions and completed replies. Delivery failures, save errors, source changes, and detached passages retain actionable entries. Delivery receipts, progress replies, successful builds, and routine document changes remain in the event journal.

The macOS notifications switch controls native alerts. The decision_notifications configuration field can exclude decisions from enabled native alerts. Apple UserNotifications owns authorization and delivery. Native alerts appear while the app is in the background. Alerts from one aside replace its previous banner. Selecting an alert opens its document and discussion. Enabling alerts leaves existing inbox entries quiet. External relays consume decision.created through the existing event hook API. Named consumer checkpoints retain unhandled events across restarts. External destinations and credentials remain outside document metadata.

The interface design system is `long-term`. Design tokens own the spacing scale and interface type roles. PanelPopover owns each toolbar panel's dialog and heading. PanelBody owns content gutters and scrolling. PanelEmpty owns empty messages. Features supply content and actions. The design contract check runs during type checks and production builds. `docs/design-system.md` defines component ownership and visual release criteria.

Bulk aside resolution is `long-term`. One document operation resolves all open discussions that have no pending or outdated edit proposal. It preserves prose, drafts, suggestions, and decisions. Resolved threads close in every writing window. The command palette, Edit menu, and each aside's actions menu expose the operation. The palette shows the number of eligible discussions and disables the command when none remain.

Human aside messages show compact delivery receipts. Saved requests have no recipient. Queued requests await transport or agent pickup. Sent requests have a delivery acknowledgement. Replied requests have an agent response. Failures retain a visible warning and expandable details.

Resolved asides stay outside the document's inline and margin layouts. Saved expansion, unread state, and selection do not override resolution. History retains the conversation and its reopen action. Unread completed replies remain in Notifications until read.

Operation failures appear through the toolbar's Activity control. Its attention state uses the same control bounds and badge. A synchronized document with no pending writing clears its host timeout. Recovery matches the stored failure message before clearing it.

Passage edits retain their mapped discussion anchors without a repair banner. Changed or detached passages retain their original quote in a collapsed disclosure. The aside menu provides manual relocation to selected text. Proposal conflicts determine whether an edit suggestion is outdated.
## Aside reading

All open discussions appear in one independently scrolling column. Document and message references provide context within each conversation. Older thread anchors remain navigable. Narrow windows place the same column below the document. The column retains its scroll position and shared conversation drafts per document window. Incoming replies preserve the document position.

## Agent conversation completion

Replies declare whether work is ongoing or complete. A working reply keeps its request active. A complete reply records the answer and resolves the discussion when human requests, choices, linked suggestions, and drafts permit closure. Suggestion review can finish a declared completion without another agent wakeup. Unread final answers remain in Activity and open directly to the conversation. Replies from older clients retain their existing behavior.

A final reply can name an existing continuation aside. The original retains a replacement link and closes when review permits it. Backlinks connect the continuation to its source. A human reopen persists until a later completion.

## Conversation edit turns

New proposals retain the originating message identity as `turnId`. A human request supplies its message identity. Thread-only edits use the current human turn or the opening agent message. Rendering groups edits by that identity. Older proposals use their request identity or the messages present at their creation time. Unmatched edits appear before the known turns. Status changes preserve turn placement.


## Message passage annotations

Annotation layout reuses whitespace above the source block. Missing space adds temporary padding. Scroll compensation preserves the passage position during opening, resizing, and removal. Short scroll regions receive temporary space below their content. Draft fields have a viewport-relative height limit.

The `long-term` reference model stores citations on individual messages. A source identifies a document passage or a passage in a human or agent message. Document references retain the original quotation and a live mapped anchor. Message references retain the message identity, field, plain text snapshot, and UTF-16 range. Suggestions retain their edit targets. Annotation format 14 stores independent annotation work and message references. It reads earlier sidecars.

Selecting document or message text opens a contextual comment field. Enter sends the annotation in a new unanchored aside. Shift+Enter inserts a line. Command+Enter sends the same aside. The manuscript stays unchanged. Clicking an annotation while composing a reply adds context above that reply. Dragging provides the same behavior. Dropping into manuscript text has no effect. The comment appears above its source excerpt. The reply text and caret stay unchanged. Clearing the source selection dismisses an empty prompt. Written and completed annotations persist across focus changes and further selections. Double-click or F2 edits the existing annotation. Sending an edited annotation saves the comment under the same identity before opening its aside. Saves compare the original comment. A conflicting save keeps the draft. Escape cancels an edit. Delete dismisses the annotation and its outstanding requests. Send and delete use unboxed icons. Context already added to a draft remains saved. Reply editors use native ProseMirror transactions for typing, insertion, clipboard references, and Undo. Unfinished comments and reply references persist with document drafts. Completed annotations persist in document metadata. One aside column contains all open discussions. Scope labels, placement modes, and repeated saved-status copy are absent.

Agents capture document or message sources with `passage_reference_create`. They attach passage context through `annotations` on `conversation_reply` and `annotation_create`. Inline citations use `references` over content ranges.


## Annotation work queue

Annotations retain an identity, comment, source, creation time, status, and optional continuation. Their delivery requests have an annotation trigger and no thread. Agents read annotations_list or annotation_read and resolve completed work with annotation_resolve. These operations create no conversation. Read access permits comments and suggestions. Direct source edits retain the document edit permission gate.

An agent can pass annotationId to edit_propose to create a suggestion directly. Passing annotationId to annotation_create opens a discussion with that annotation as context. The original annotation waits for the linked suggestion or discussion. Resolving the continuation resolves the annotation. Passing annotationId to edit_apply resolves the annotation after the edit succeeds. Human replies that include annotation context link the work to that conversation. Unresolved questions and pending suggestions keep linked work open.

Keyboard customization is `long-term`. One command catalog owns identities, contexts, and default bindings. The typed configuration stores overrides and sequence timing. Agents discover defaults and active bindings through `configuration_read` and apply atomic updates through `configuration_write`.

The same bindings drive native menu accelerators, writing windows, editors, composers, annotations, palette hints, and tooltips. Configuration validation rejects unknown commands, overlapping shortcuts, and ambiguous sequence prefixes. Disabling or replacing a binding also suppresses its retired default. Invalid configuration retains the last accepted values. The interface has no shortcut settings panel.

Document deletion is `long-term` and recoverable. The library stores a Trash record with the source revision, text hash, deletion identity, time, and previous Space memberships. Source files, metadata, saved window drafts, and document identities remain intact. Active library and Space lists exclude documents in Trash. Agents use `document_delete`, `document_trash_list`, and `document_restore`. No Trash management panel is required.

Deletion requires an authorized connected agent, document edit permission, and a matching source revision and hash. The host flushes writing windows before it serializes the deletion and checks the source again. Failed flushes or changed sources reject the operation. Agent work and navigation reject deleted targets. Restoration preserves permissions and returns the document to its previous Spaces, or the default Space when needed.
