# Interface design system

`src/tokens.css` owns design values. Shared components own the layout that uses them. Feature components supply content and behavior.

## Space and alignment

Use the 4, 8, 12, 16, 24, and 32 pixel spacing tokens. Use a named control token for a target's dimensions.

A panel has one 16 pixel content gutter. Its heading, empty message, detail text, and row labels share that left edge. List containers reserve 4 pixels around rows. Each row supplies the remaining 12 pixels. Nested cards have their own content gutter.

Keep related labels and controls closer than separate groups. A section gap uses 16 or 24 pixels. A label gap uses 4 or 8 pixels. Empty states use the body inset and a short message. They do not reserve a large blank area.

## Type and hierarchy

| Role | Size / line height | Weight |
| --- | --- | --- |
| Panel title | 14 / 20 | 600 |
| Section title | 16 / 24 | 600 |
| Interface body | 13 / 20 | 400 |
| Secondary label or action | 12 / 16 | 400 or 500 |

Panel headings have no browser heading margins. Interface titles use the system font. Manuscript and response prose retain their reading typography.

`reading-typography.css` owns all six heading levels in manuscripts and rendered responses. Their scale, weight, line height, and spacing use shared tokens. Headings have more space above than below. Consecutive headings use a smaller gap. Inline emphasis retains the body size. The design contract rejects separate heading styles in feature files.

Document headings express section structure. Sibling sections use the same level. Subsections use the next level. Headings occupy separate blocks before their explanations. Bold spans mark emphasis inside prose. Agents receive the current semantic outline and this authoring contract through `document_read.native`. The navigation outline and agent outline share one projection. Formatting changes preserve wording and follow document edit permissions.

Titles identify the surface. Secondary text explains its contents. Actions use their shared control dimensions and remain aligned with the title. Labels wrap or truncate deliberately. Empty states, errors, and long labels must not change the panel's chosen width.

## Components

Use `PanelPopover` for a toolbar panel. Supply its title, actions, and optional leading navigation. The component owns the dialog, accessible title, heading, width, material, edge, radius, and elevation.

Use `PanelBody` for scrollable content. Its `list` layout supplies row spacing. Its `detail` layout supplies the content gutter. Use `PanelEmpty` for empty and loading messages.

Decisions, Activity, History, Agents, and Linked resources use this structure. Feature styles do not override the panel or body geometry. Add a shared variant when the structure needs another supported layout.

Use `IconButton` for icon actions. Text actions use `text-button`. Menus share row spacing, target size, typography, radius, and paper elevation. Asides and cards use the note material and card tokens. A feature does not define another paper surface.

Web links reveal a preview after a short hover or on keyboard focus. The preview uses the shared hover surface. It shows the page title, description, and destination. It remains visible while hovered and dismisses on Escape, scrolling, or selection. Metadata requests use no browser credentials. Unavailable metadata leaves the destination visible.

Links use the hand pointer, including inside editable text. Whole-table annotations reserve space above the table and align with its right edge.

Annotations align above the right edge of their passage. Their opaque material and neutral edge separate them from the reading surface. Double-click or F2 edits the existing annotation. Enter saves its comment. Escape cancels an edit. Send and delete use the glyph variant of the shared icon control. These actions appear on hover or focus. A single click focuses the annotation. Hidden actions reserve no space.

Application choice menus use the shared menu surface and accessible menu primitives. Single choices show a check beside the selected item. Native HTML dropdowns are rejected by the design contract.

Agent attribution uses the session name and role. Unnamed sessions include a short session identifier. Replies, full responses, decisions, recipients, and connection panels share the same label.

Aside cards use one 16 pixel content gutter on every edge. A single header contains collapse and thread actions. Passage context sits below that header. Copy reference remains visible and confirms a successful copy in place.

Your messages use a tinted surface and align to the right. Agent replies use the full text width and display their session name. The shared conversation retains all messages in a scroll region. Aside cards stop at 640 pixels or the viewport height minus 128 pixels. Reader cards also fit the reader viewport, with a 240 pixel minimum reading allowance. Their heading and reply composer stay outside the message region. New replies preserve the position when the reader scrolls through earlier messages.

The reply editor grows with its text. One composer viewport scrolls the draft and its attachments. The form and editor have no separate scrollbars. Aside scrollbars appear during scrolling or near the edge, then hide after inactivity. Forced colors retain system scrollbars. Reduced motion removes the fade.

Aside scrollbars use a 4 pixel track with a 2 pixel thumb. Each viewport keeps a 2 pixel gap between its content and track. Reader cards stay inside the reader's content edge.

Edit summaries follow their originating turn. Each turn has one collapsed summary with counts by status. Expanding it shows the individual explanations and review actions. Later messages do not move earlier edits to the bottom.

Suggested changes use the note material, neutral card edge, and 16 pixel content gutter. The header places collapse on the left. The footer groups decisions and suggestion navigation. Color marks changed content. Diff blocks use a light wash without vertical rails.

Table suggestions share one table projection and one compact review bar. Proposed values occupy their cells. Changed cells are keyboard focusable and select the change to review. The bar provides accept, dismiss, original comparison, navigation, and collapse through shared icon controls. Pending changes retain the document's revision and text checks. Preview tables share the manuscript's table width and horizontal scrolling.

Whole-table anchors highlight the table surface. They do not underline or highlight its text separately. Object selections suppress the browser's text selection paint. Text selections within cells retain text highlighting.

Each table exposes the shared comment-plus icon with a tooltip and accessible label. Selection and deletion remain in the table context menu.

Double-clicking an image opens a fitted preview. The image context menu also provides Zoom Image. Clicking the preview toggles actual size. The viewer scrolls at actual size. Escape and the close icon return to the document without changing its content.

Wide tables expand the document column to use available space. Prose keeps its reading width and center. The aside gutter remains separate. Tables scroll horizontally when the available space cannot fit them. Tables inside cards, lists, and quotes stay within their parent.

## Build enforcement

`npm run design:check` parses JSX and CSS. It rejects nested panel dialogs, copied panel structure, local panel metric overrides, and raw layout or typography lengths in the shared panel and decision styles. `npm run check` and production builds run this check.

## Visual release check

Inspect the actual desktop app at wide and minimum window widths. Capture light and dark appearances. Inspect empty, populated, loading, and error states for every changed component family. Use long labels and keyboard navigation. Check scroll containment and visible focus.

Compare the heading and body left edges. Check the space above and below each group. Check the balance between the title and its actions. Confirm that body text remains readable and that control targets do not overlap. Inspect the adjacent toolbar, manuscript, and asides in the same screenshot.

Build checks verify component contracts. Screenshot inspection verifies composition. Record any unavailable visual checks in the release evidence.

## References

- [Spectrum spacing principles](https://spectrum.adobe.com/foundations/layout-and-structure/spacing/spacing-overview)
- [Spectrum component spacing](https://spectrum.adobe.com/foundations/layout-and-structure/spacing/component-spacing)
- [Spectrum typography](https://spectrum.adobe.com/foundations/typography/typography-system)


Passage annotations use the shared note material, control radius, spacing, and elevation. The comment field grows from one line. The field has no border or focus perimeter. The caret shows text focus. An annotation reserves space above its source paragraph. Multiple annotations on one paragraph stack in that space. The reservation changes no document content. Clicking an annotation adds context to the active reply. Dragging is optional. Written annotations remain visible when focus changes. Passage context sits above the reply, with the comment above its source excerpt. Citation text remains selectable. Reply citations remain editable.
