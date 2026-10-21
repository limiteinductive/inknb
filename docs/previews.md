# Published previews

Design: `long-term`. The human writes verbatim text. An external agent builds its presentation and publishes a complete local package.

The app displays HTML or PDF in Preview and Both document views. The same renderer supports a detached native window, fullscreen, text selection, and layout discussions. The app starts no compiler or model.

## Detached window

The detach control moves the preview into one reusable, resizable native window. Detaching another document changes its target.

The `detached_preview` configuration controls its target. `document` keeps the chosen document. `active_document` follows the active writing document. The default is `document`. Configuration changes apply immediately to an open window.

The workspace owns the window's target. The writing session owns the text and preview state. It sends live snapshots to the detached renderer through native window messages. The detached window owns no writing buffer, Undo history, or recovery file. It displays the same aside controls through validated requests to the document owner. Its aside margin visibility belongs to that window.

The dock control returns the preview to its document. Closing the detached window closes only that preview. Closing the writer also closes the detached window.

Preview asides open in the owning document's writing window. Rendered selection anchors keep their artifact identity and source snapshot.

## Publish a package

Read `document_read` for the exact text and its `textHash`. Copy that text to a UTF-8 snapshot inside the package. Build the presentation from that snapshot.

Read `preview_read` for the latest artifact identity. Call `preview_build` with the snapshot hash, `status: "building"`, and `message: null`.

Finish writing all files before publication. Call `preview_publish` with `documentId`, the absolute package directory, and `expectedArtifactId`. Use null when no preview exists.

Publication checks the previous identity again after validation. A concurrent publication rejects the operation. A newer manuscript does not reject an older snapshot. The pane marks that output as earlier text.

On build failure, call `preview_build` with `status: "failed"` and a concise diagnostic. The previous output stays visible. A successful publication clears the build status.

`preview_read` exposes publication, last successful render, source snapshot, source mappings, external build status, and renderer diagnostics. Runtime status is null until the pane mounts.

## Package format

The package contains `inknb-preview.json`, the source snapshot, the entry file, and its local assets.

```json
{
  "version": 1,
  "documentId": "00000000-0000-4000-8000-000000000001",
  "kind": "html",
  "title": "Garden observations",
  "entry": "index.html",
  "source": "source.txt",
  "sourceMap": [
    {
      "id": "opening",
      "source": { "from": 0, "to": 6, "expectedText": "Garden" },
      "target": { "kind": "element", "elementId": "opening" }
    }
  ]
}
```

`kind` is `html` or `pdf`. HTML entry names end in `.html`. PDF entries contain complete PDF bytes. Titles contain at most 160 bytes.

Packages contain regular files and directories. Symbolic links are rejected. Limits are 512 files, 64 MiB per file, and 128 MiB per package. Source snapshots use at most 4 MiB.

Publication captures immutable files under their content identity. Later changes to the build directory cannot alter a published preview. Every served file is checked against its recorded fingerprint.

HTML uses relative local asset references. Network access, native commands, forms, child frames, and external navigation are blocked. JavaScript can provide local presentation behavior. The host owns selection and location messages.

PDF rendering uses a bundled PDF.js viewer and local rendering resources. PDF scripts and external links do not run. Compilation can use TeX, Typst, Pandoc, or another external tool.

## Source mappings

Mappings use exact UTF-16 source offsets. `expectedText` must match the snapshot range. Mapping identities must be unique.

An HTML mapping targets an element ID. Each mapped ID must occur exactly once in the entry HTML and rendered page. Include stable IDs in generated output.

A PDF mapping uses this target:

```json
{
  "kind": "page",
  "page": 1,
  "rectangle": { "left": 0.12, "top": 0.2, "width": 0.76, "height": 0.08 }
}
```

Pages start at one. Rectangles use normalized coordinates from the page's top-left corner. Every rectangle must stay within its page.

Supply mappings from the build process when available. The app validates text ranges and rendered targets. It does not infer layout coordinates from a source file.

## Preview asides

Select rendered text to reveal the aside bubble. Keyboard text selection also exposes it. Choose Comment on region in the preview toolbar, then drag a box for visual feedback. Escape cancels region mode. Option-drag also selects a region.

Markdown, HTML, and PDF use the same aside flow in the pane and detached window. Region selection captures only the chosen preview area. Its PNG appears in the aside draft and saved conversation. The image remains unchanged after later preview updates. Agents inspect it with preview_capture_read and the threadId.

The built-in Markdown renderer creates immutable HTML preview packages with block source mappings. It uses the same sandbox and selection runtime as published HTML. Source changes update its rendering after typing pauses. Preview scroll position carries into the next Markdown snapshot.

Each discussion retains its artifact identity, source hash, quote, and rendered location. Source mappings attach the discussion to current verbatim when relocation succeeds. Layout-only discussions have no manuscript anchor.

Preview comments grant no prose edit permission. Agents can reply, rebuild, and publish revised presentation. Changing verbatim requires document edit access. Suggestions can attach to the preview discussion and target an exact source passage.

The discussion's location control opens its original rendered version. An earlier-version indicator offers a return to the latest publication. Publication does not move existing comments to another version.

## External automation

`examples/preview-backend.mjs` handles document events through the existing hook runner. It invokes an external builder with the document snapshot on standard input. The builder prints its absolute package directory.

```sh
inknb hook --consumer paper-preview --document DOCUMENT_UUID -- /absolute/path/to/node /absolute/path/to/preview-backend.mjs /absolute/path/to/inknb /absolute/path/to/builder
```

The hook skips snapshots whose text hash already matches the publication. It reports failures without removing the last output. A failed event remains unacknowledged for retry.

Build programs own dependencies, temporary output, source maps, and rebuild policy. The hook runs outside the app. No build settings appear in the writing interface.

`preview.published`, `preview.rendered`, and `preview.build` are durable events. Publication payloads contain `preview`. Build payloads contain `build`.

Annotation format 6 reads formats 1 through 5. Format 5 edit grants remain intact. Earlier apps cannot read format 6. Registered packages and screenshot crops stay in local application support data.

## Document pages

A document page binds an immutable HTML layout to native document nodes. `document_read.native.content` supplies the node identities. The manuscript remains the canonical source.

The preview manifest accepts an optional `page` object:

```json
{
  "page": {
    "bindings": [
      { "identity": "00000000-0000-4000-8000-000000000001", "elementId": "title", "role": "text" },
      { "identity": "00000000-0000-4000-8000-000000000002", "elementId": "notes", "role": "container" },
      { "identity": "00000000-0000-4000-8000-000000000003", "elementId": "note", "role": "item" }
    ]
  }
}
```

Every text block needs one `text` binding. Each element ID must occur once. A `container` binds a native parent. An `item` binds a movable child. All bindings use native identities from the current document.

`page_publish` takes the document identity, current revision, and package directory. Its source snapshot must match the current source exactly. `page_open` opens the saved page. The toolbar switches between prose and page views. `page_read` returns the package and retired bindings.

The sandbox receives a read-only native snapshot through `window.inknbPage.document`. `window.inknbPage.subscribe(listener)` observes later snapshots and returns an unsubscribe function. It grants no write or network capability.

Native app controls own text editing, adding notes, card moves, asides, and Undo. Moves preserve node identities. New notes appear in the existing layout. Window drafts retain conflicting text until the human chooses the current content.

`object_move` provides the corresponding agent operation. It requires edit permission, a connected agent, the current revision, and expected object text.
