# Agent components

Design: `long-term`. Agents build local HTML, CSS, and JavaScript packages. The running app registers packages and mounts instances inside asides. Margin and inline placement use the same instance and state.

## Package

`protocol_info.componentGuide` returns this contract to agents. Register the compiled output directory. It contains `inknb-component.json` and its local assets. Bundle framework dependencies before registration. The app runs no build tool or model runtime.

```json
{
  "version": 1,
  "name": "evidence-browser",
  "title": "Evidence",
  "entry": "index.html",
  "height": 310
}
```

Format 1 requires a name, title, HTML entry, and height from 100 to 800. Packages contain at most 256 regular files. Each file stays below 8 MiB. The total stays below 20 MiB. Symbolic links are rejected.

`component_register` accepts the absolute package directory. It captures immutable bytes in local application support data and returns `bundleId`. Editing the source directory does not change registered code. Register again to obtain the updated bundle identity.

`component_mount` accepts the document identity and revision, an open thread, a stable component UUID, the bundle identity, data, and initial state. Reuse the component UUID after an uncertain response. Mounting does not open the aside or move the cursor.

`component_read` returns the instance and runtime status. `component_update` changes data, state, visibility, or code. It requires the current component revision. A code update preserves state unless the caller supplies new state. `component_unmount` removes the instance.

The sidecar stores component references, data, state, and component revisions. It contains no executable package content. Register the same package on another machine to resolve its bundle identity. Missing packages show an explicit recovery state.

## Runtime API

The host loads the version 1 bridge before the entry script. `window.inknb` exposes:

```js
inknb.subscribe(({ data, state, theme, revision }) => {
  render(data, state);
});
await inknb.setState({ selected: "weekly" });
await inknb.emit("inspect-result", { schedule: "weekly" });
```

`subscribe` receives initial context and later updates. It returns an unsubscribe function. `inknb.ready` resolves with initial context. `inknb.current` returns a copy of the current context.

Data is agent-controlled input. State records component interactions. Both accept JSON and stay below 256 KiB each. State writes use component revision preconditions. A stale write fails without overwriting a newer state.

`emit` appends a durable `component.event`. Its payload includes the component identity, event name, data, and component revision. External hooks or socket subscribers handle these events. Events grant no manuscript edit permission.

The host supplies semantic CSS variables for colors, fonts, borders, selection, and motion. Components update with the app's theme and reduced motion setting. Use responsive layouts and accessible labels. The example in `examples/evidence-component` works in both conversation placements.

The `examples/evidence-backend.mjs` hook handles the example's `inspect-result` event. It writes a result back into component data. Run it outside the app:

```sh
inknb hook --consumer evidence-backend -- /absolute/path/to/node /path/to/inknb/examples/evidence-backend.mjs /path/to/inknb
```

Component errors remain inside their card. Reload and Hide controls remain available. Hiding preserves the instance. The host bounds component height and leaves scrolling inside the writing interface.

## UI actions

`ui_inspect` returns host controls, component controls, scroll regions, and a `snapshotId`. `ui_action` requires that identity and the current document identity. Agent control IDs remain separate from DOM selectors.

Host actions cover navigation, focus, component visibility, source disclosure, and scrolling. Component controls support activation, focus, and input values. Inspect again after the interface changes. Actions acknowledge dispatch. Read state or consume the event stream to observe asynchronous work.

Native proposal acceptance, permission grants, human message submission, and conversation resolution are absent from the agent control surface. Component code cannot operate those controls.

Use `screenshot` after interactions. It captures the rendered desktop app with build, document, selection, and component status. Inspect the pixels before accepting a UI change.

## Isolation

The custom component protocol serves registered bytes only. Components run in sandboxed frames without same-origin access. They receive only their own data, state, and theme. The bridge checks each message's source frame and validates its shape.

Components have no native command bridge, direct manuscript access, local file access, or network connection API. The resource policy blocks remote scripts, images, connections, forms, and nested frames. Native navigation handling rejects remote destinations. Components emit events for external backends to perform authorized work.

These boundaries use [iframe sandboxing](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/iframe#sandbox) and the current [Tauri IPC origin protections](https://github.com/tauri-apps/tauri/security/advisories/GHSA-57fm-592m-34r7).

Annotation format 3 reads formats 1 and 2. Earlier app versions do not preserve component instances.
