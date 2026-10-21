# ink and butter development

This is a personal project. Use fresh code, public dependencies, and synthetic fixtures. Keep private company code, research, data, paths, and assets out of this repository and its history.

Present consequential design decisions to the user. Record agreed decisions in the architecture document.

Preserve human verbatim text. Each document owns its live transactions, selection, Undo history, drafts, and recovery. Agent operations carry explicit revision and text preconditions.

Keep model selection, credentials, context management, and agent execution in external agent environments. The app provides tools and transport adapters.

Use the shared design tokens and accessible components. Follow `docs/design-system.md` for every new UI surface. Reuse the shared component before adding feature styles. Add missing layouts to the shared component and apply them to sibling surfaces. Feature styles do not override shared panel padding, typography, width, radius, or elevation. Run `npm run check`, including its design contract gate. Inspect affected component states in the actual app at wide and minimum widths, in light and dark appearances. Record the visual evidence.

Margin is the default conversation placement. Inline is a presentation preference over the same annotation model.

Treat the interface as one design system. Carry material, color, typography, spacing, edge, and elevation changes through navigation, toolbars, reading surfaces, asides, review controls, menus, and dialogs. Check the whole interface without waiting for separate requests about each surface.

Exercise the actual desktop app with computer use. Capture and inspect screenshots after meaningful UI changes. Use inknb MCP for live state and screenshots once available. Check native dialogs, focus, selection, scrolling, and keyboard behavior. Inspect motion through interaction and recordings where available.

Verify release criteria from current evidence. Screenshots and successful tool calls alone do not establish functional completion.

Run existing checks and exercise the desktop app. Add tests only when the user asks. Keep prose direct. Do not use em dashes or inline code comments. Use descriptive names.
