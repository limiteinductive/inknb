# Interface quality checklist

This checklist defines the interface audit for ink and butter. An unchecked item has no release verification recorded here.

Each release verifies its affected workflows against these criteria. A full app audit covers the complete list.

## Interaction

- [ ] Standard interactions use maintained UI primitives. Custom gesture code addresses a documented gap in those primitives.
- [ ] Navigation labels, icons, buttons, and window controls do not create text selections.
- [ ] Manuscript text, aside messages, source excerpts, and preview text support selection and copying.
- [ ] Search, rename, and composer fields support selection, replacement, and standard editing shortcuts.
- [ ] A pointer click activates the intended control once. Moving off a pressed control cancels activation.
- [ ] Pointer focus does not leave a keyboard focus ring on buttons or navigation rows.
- [ ] Keyboard focus remains visible, distinct from the active document, and contained within the control's bounds.
- [ ] Tab and Shift-Tab follow the visible reading order. Arrow keys follow the component's established behavior.
- [ ] Escape cancels the nearest temporary interaction. Closing a menu, dialog, or pane restores a useful focus target.
- [ ] Focus does not move while the user types because an agent reply, save, or preview update arrives.
- [ ] Hover, pressed, focused, selected, disabled, loading, and error states each have a defined appearance.
- [ ] Cursors match the action. Resize boundaries use a resize cursor. Drag targets use grab and grabbing cursors.
- [ ] Icons have accessible names and concise tooltips. Shortcuts supplement visible actions.

## Dragging and resizing

- [ ] A divider has a usable grab area around its visible line.
- [ ] Divider movement follows the pointer without delayed easing, jumps, or text selection.
- [ ] Dragging continues across HTML frames, PDF content, pane boundaries, and the window edge.
- [ ] Release, cancellation, and window deactivation end the gesture without leaving a stuck cursor or overlay.
- [ ] Minimum pane widths preserve useful controls. Narrow windows do not produce overlapping panes.
- [ ] The app remembers the chosen preview width across document changes, pane reopening, and restart.
- [ ] Window resizing constrains the visible width without overwriting the chosen width.
- [ ] Fullscreen entry and exit preserve the previous pane arrangement and chosen width.
- [ ] Keyboard users can resize the preview and receive its current size through accessibility APIs.
- [ ] Document dragging distinguishes a click from a reorder. The insertion target remains clear.
- [ ] Reordering supports cancellation, scrolling, keyboard input, and persistence after restart.
- [ ] Search and collection views preserve one consistent document order.

## Writing and navigation

- [ ] Typing, selection, Undo, Redo, and clipboard actions preserve the user's exact text.
- [ ] Unicode, emoji, combining marks, input methods, dictation, and multiline paste do not corrupt text or anchors.
- [ ] Formatting changes stay separate from verbatim changes. Agent edits retain their permission and review requirements.
- [ ] Document switching preserves each document's Undo history, selection, scroll position, aside, and unsent draft.
- [ ] Back and Forward restore the intended document or passage. Typing does not create navigation history entries.
- [ ] Search results show enough context to identify the intended document and passage.
- [ ] Long titles, duplicate titles, empty documents, and large libraries remain usable.
- [ ] Rename, move, save, and external file changes preserve document identity and associated discussions.
- [ ] Selection actions remain near the selected passage and stay inside the visible window.
- [ ] An aside draft keeps its original attachment while the user selects another passage.
- [ ] Passage and discussion references lead to the intended location without losing the current draft.

## Panes and macOS integration

- [ ] Preview remains at the far right. Asides retain their separate pane.
- [ ] Each pane owns its controls and scroll position. Controls move with the pane they affect.
- [ ] Opening and closing a pane does not unexpectedly scroll the manuscript or erase a selection.
- [ ] Traffic lights and navigation controls align in windowed mode. Fullscreen uses the available top-left space.
- [ ] Window dragging works on empty titlebar space without intercepting controls or selection.
- [ ] Minimum size, maximization, fullscreen, display changes, and restored window bounds remain usable.
- [ ] Background, hidden, minimized, sleeping, and resumed windows retain correct state.
- [ ] Native menus, standard shortcuts, file dialogs, and document titles match the current document.
- [ ] Mouse, trackpad, keyboard, and accessibility input can complete the same essential tasks.

## Visual consistency

Use [the design system](design-system.md) for the measurements and shared component contracts.

- [ ] Typography, spacing, radii, icon sizes, strokes, colors, and motion use shared tokens.
- [ ] Selected rows, keyboard focus, hover, and pending changes remain visually distinct.
- [ ] Ink and butter colors have consistent roles across light and dark appearances.
- [ ] Labels, icons, and controls align at supported display scales. Borders and rounded corners remain complete.
- [ ] Long labels truncate deliberately. Controls do not overlap or change size when their state changes.
- [ ] Empty, populated, loading, stale, failed, and recovered states receive visual inspection.
- [ ] The interface avoids duplicate navigation, redundant labels, permanent instructional copy, and decorative activity.
- [ ] Motion supports a specific state change. It stops when complete and respects reduced motion.
- [ ] Pane resizing and direct manipulation remain immediate. Animation does not delay the pointer.

## Accessibility

- [ ] Controls expose correct roles, names, values, states, and relationships through the native accessibility tree.
- [ ] Screen readers announce document navigation, dialogs, preview status, and errors without repeated interruptions.
- [ ] Text contrast meets WCAG AA. Control boundaries and essential state indicators remain distinguishable.
- [ ] Focus stays visible and unobscured. Color alone does not carry essential meaning.
- [ ] Targets have usable hit areas. Small icons receive sufficient spacing or larger invisible targets.
- [ ] Increased text size, reduced motion, increased contrast, and forced colors retain essential functionality.
- [ ] Hidden panes and background documents do not expose duplicate keyboard stops or active controls.
- [ ] Interactive components and preview frames preserve keyboard access and an exit path.

## Preview and agent behavior

- [ ] HTML and PDF content render at the current pane width without clipping their controls.
- [ ] Preview selection, copying, links, scrolling, and aside placement remain correct after resizing.
- [ ] Stale output identifies its source version. Failed updates retain the last successful output.
- [ ] Source mappings refer to the correct verbatim passage. Layout comments retain their presentation location.
- [ ] Background agent activity does not change the active document, focus, selection, or scroll position.
- [ ] Agent work produces visible results without adding model, credential, transport, or build forms to the writing surface.
- [ ] Human acceptance, edit permissions, and discussion resolution remain explicit human actions.
- [ ] External components and previews remain isolated from native APIs, credentials, and unintended network access.

## Reliability and release evidence

- [ ] Autosave, crash recovery, restart, disk errors, and external edits preserve current work and expose actionable failures.
- [ ] Repeated input does not create duplicate actions, submissions, documents, or agent operations.
- [ ] Typing, scrolling, pane dragging, and document switching remain responsive with realistic documents and discussions.
- [ ] Inactive documents release unnecessary work. Preview updates do not accumulate renderers or listeners.
- [ ] Existing checks pass. Every changed file receives a diff review.
- [ ] Native input verifies each changed gesture. A protocol action or screenshot alone does not establish gesture correctness.
- [ ] Screenshots cover light and dark appearances, wide and minimum windows, keyboard focus, and relevant failure states.
- [ ] Motion and drag checks inspect the running app across time. A still image does not verify smoothness.
- [ ] Release checks exercise the installed production bundle, including restart and preserved user data.
- [ ] Known failures and unavailable checks remain explicit. The release does not label an unverified gesture as verified.

## References

The criteria above combine product requirements with platform and accessibility guidance. They do not establish certification or a completed audit.

- [Apple Human Interface Guidelines: Windows](https://developer.apple.com/design/human-interface-guidelines/windows)
- [WAI-ARIA APG: Window Splitter](https://www.w3.org/WAI/ARIA/apg/patterns/windowsplitter/)
- [WAI-ARIA APG: Keyboard Interface](https://www.w3.org/WAI/ARIA/apg/practices/keyboard-interface/)
- [WCAG 2.2: Focus Visible](https://www.w3.org/WAI/WCAG22/Understanding/focus-visible.html)
- [WCAG 2.2: Focus Not Obscured](https://www.w3.org/WAI/WCAG22/Understanding/focus-not-obscured-minimum.html)
- [WCAG 2.2: Target Size](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html)
- [WCAG 2.2: Contrast](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html)
- [React Resizable Panels](https://github.com/bvaughn/react-resizable-panels)
