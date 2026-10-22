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

Titles identify the surface. Secondary text explains its contents. Actions use their shared control dimensions and remain aligned with the title. Labels wrap or truncate deliberately. Empty states, errors, and long labels must not change the panel's chosen width.

## Components

Use `PanelPopover` for a toolbar panel. Supply its title, actions, and optional leading navigation. The component owns the dialog, accessible title, heading, width, material, edge, radius, and elevation.

Use `PanelBody` for scrollable content. Its `list` layout supplies row spacing. Its `detail` layout supplies the content gutter. Use `PanelEmpty` for empty and loading messages.

Decisions, Activity, History, Agents, and Linked resources use this structure. Feature styles do not override the panel or body geometry. Add a shared variant when the structure needs another supported layout.

Use `IconButton` for icon actions. Text actions use `text-button`. Menus share row spacing, target size, typography, radius, and paper elevation. Asides and cards use the note material and card tokens. A feature does not define another paper surface.

Application choice menus use the shared menu surface and accessible menu primitives. Single choices show a check beside the selected item. Native HTML dropdowns are rejected by the design contract.

Agent attribution uses the session name and role. Unnamed sessions include a short session identifier. Replies, full responses, decisions, recipients, and connection panels share the same label.

Aside cards use one 16 pixel content gutter on every edge. A single header contains collapse and thread actions. Passage context sits below that header. Copy reference remains visible and confirms a successful copy in place.

Suggested changes use the note material, neutral card edge, and 16 pixel content gutter. The header places collapse on the left. The footer groups decisions and suggestion navigation. Color marks changed content. Diff blocks use a light wash without vertical rails.

Whole-table anchors highlight the table surface. They do not underline or highlight its text separately. Object selections suppress the browser's text selection paint. Text selections within cells retain text highlighting.

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
