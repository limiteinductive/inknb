import { ShortcutResolver, shortcutTooltip } from "./shortcuts";
import AgentConnections from "./AgentConnections";
import { DecisionsPanel } from "./Decisions";
import ActivityCenter from "./ActivityCenter";
import { activity } from "./activity";
import {
  lazy,
  Suspense,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { createRoot } from "react-dom/client";
import {
  Button,
  Dialog,
  Modal,
  ModalOverlay,
} from "react-aria-components";
import { PanelLeft } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import AsideLayout from "./AsideLayout";
import DocumentHistory from "./DocumentHistory";
import { NativeEditor } from "./native-editor";
import { SessionContext, useDocumentSession, useSession } from "./use-session";
import { appHost } from "./app-host";
import { compactLibraryWidth, workspace } from "./window-workspace";
import Library from "./Library";
import DocumentOutline from "./DocumentOutline";
import DocumentReview from "./DocumentReview";
import LinkedResources from "./LinkedResources";
import IconButton from "./IconButton";
import CommandPalette from "./CommandPalette";
import PassageAnnotations from "./PassageAnnotations";
import LinkPreview from "./LinkPreview";
import ImageViewer from "./ImageViewer";
import { useContextMenus } from "./context-menu";
import { captureAnchor } from "./domain";
import { readWindowChrome, windowChromeSchema } from "./window-chrome";
import "./style.css";
import "./document-review.css";

const DetachedPreview = lazy(() => import("./DetachedPreview"));
const DocumentPage = lazy(() => import("./DocumentPage"));

function DocumentApp({ active }: { active: boolean }) {
  const library = useSyncExternalStore(
    workspace.subscribe,
    workspace.getSnapshot,
  );
  const session = useDocumentSession();
  const state = useSession();
  const historyOpen = active && library.commandSurface === "history";
  const editorHost = useRef<HTMLDivElement>(null);
  const modeFocus = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    if (!state.ready || !editorHost.current) return;
    let view: NativeEditor;
    try {
      view = new NativeEditor(editorHost.current, session);
    } catch (error) {
      session.fail(error);
      return;
    }
    return () => {
      session.view = null;
      view.destroy();
    };
  }, [state.ready, state.epoch]);
  useLayoutEffect(() => {
    if (!active || !state.ready || !session.view) return;
    const entry = workspace
      .getSnapshot()
      .documents.find(
        (candidate) => candidate.id === state.metadata.documentId,
      );
    const selection = session.model?.state.selection;
    const frame = requestAnimationFrame(() => {
      if (session.model?.state.selection !== selection) return;
      session.view?.requestMeasure();
      session.restoreSourceScroll(entry?.scrollTop ?? 0);
    });
    return () => cancelAnimationFrame(frame);
  }, [state.ready, state.epoch]);
  useLayoutEffect(() => {
    if (active && state.ready) session.restoreFocus();
  }, [active, state.ready, state.epoch, state.composer]);
  useEffect(() => {
    if (!active) return;
    const name =
      library.documents.find((entry) => entry.id === state.metadata.documentId)
        ?.title ?? "Untitled";
    void getCurrentWindow().setTitle(
      `${library.spaceTitle} · ${name}${state.dirty ? " •" : ""} · ink and butter${state.profile ? ` · ${state.profile}` : ""}`,
    );
  }, [
    state.path,
    state.dirty,
    active,
    library.documents,
    library.spaceTitle,
    state.metadata.documentId,
    state.profile,
  ]);
  return (
    <div
      className={`app ${state.focus ? "focus-mode" : ""} placement-${state.preferences.placement}`}
    >
      {active && <>
        <AgentConnections open={library.commandSurface === "agents"} onOpenChange={open => workspace.update({ commandSurface: open ? "agents" : null })} />
        <LinkedResources open={library.commandSurface === "resources"} onOpenChange={open => workspace.update({ commandSurface: open ? "resources" : null })} />
      </>}
      {active && <div className="manuscript-mode">
        <Button className="text-button" aria-label={shortcutTooltip(`Switch to ${state.editorMode === "edit" ? "Render" : "Edit"} mode`, "editor-mode", state.preferences)} aria-pressed={state.editorMode === "edit"} data-inknb-control="document.mode" onPointerDown={() => {
          const target = document.activeElement;
          modeFocus.current = target instanceof HTMLElement && session.surface?.dom.contains(target) ? target : null;
        }} onPress={() => void session.command("editor-mode").then(() => {
          const target = modeFocus.current;
          modeFocus.current = null;
          if (target?.isConnected) target.focus({ preventScroll: true });
          else session.surface?.focus();
        }).catch(error => session.fail(error))}>
          {state.editorMode === "edit" ? "Edit" : "Render"}
        </Button>
      </div>}
      {active && <DocumentHistory active open={historyOpen} presentation="modal" onOpenChange={open => workspace.update({ commandSurface: open ? "history" : null })} />}
      <AsideLayout
        active={active}
        historyOpen={historyOpen}
        preferredWidth={library.asideWidth}
        onWidthChange={(asideWidth) => workspace.update({ asideWidth })}
      >
        <main className="workspace">
          <DocumentOutline active={active} />
          <div className="writing-region">
            <div className="editor-host" ref={editorHost} hidden={state.pageVisible && Boolean(state.metadata.page)} />
            {state.pageVisible && state.metadata.page && <Suspense fallback={<p className="preview-placeholder">Opening page…</p>}><DocumentPage /></Suspense>}
          </div>
        </main>
      </AsideLayout>
      <DocumentReview active={active} onReveal={(proposal) => session.surface?.scrollToSource(proposal.from, captureAnchor(state.text, proposal))} />
      <PassageAnnotations active={active} />
    </div>
  );
}

function App() {
  useContextMenus(
    () => {
      const session = workspace.active;
      if (!session) return;
      return () => {
        if (workspace.active === session) session.startComment();
      };
    },
    (error) => workspace.fail(error),
    () => {
      const view = workspace.active?.view;
      return view
        ? {
            undo: () => view.undo(),
            redo: () => view.redo(),
            actions: view.contextActions(),
            region: () => view.region.start(),
            image: (target) => view.imageActions(target),
            table: (target) => view.tableActions(target),
          }
        : undefined;
    },
  );
  const restoreWritingFocus = useRef(false);
  const [windowWidth, setWindowWidth] = useState(() => window.innerWidth);
  const library = useSyncExternalStore(
    workspace.subscribe,
    workspace.getSnapshot,
  );
  useEffect(() => {
    const media = matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      document.documentElement.dataset.theme =
        library.preferences.appearance === "system"
          ? media.matches
            ? "dark"
            : "light"
          : library.preferences.appearance;
    };
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [library.preferences.appearance]);
  useEffect(() => {
    document.documentElement.dataset.motion = library.preferences.reduce_motion
      ? "reduced"
      : "system";
    document.documentElement.dataset.typeface = library.preferences.typeface;
    document.documentElement.style.setProperty(
      "--writing-size",
      `${library.preferences.font_size}px`,
    );
    document.documentElement.style.setProperty(
      "--writing-width",
      `${library.preferences.line_width}px`,
    );
    workspace.active?.view?.requestMeasure();
  }, [library.preferences]);
  useEffect(() => {
    if (library.sidebarOpen || !restoreWritingFocus.current) return;
    restoreWritingFocus.current = false;
    workspace.active?.restoreFocus();
  }, [library.sidebarOpen]);
  useEffect(() => {
    void workspace.initialize().catch((error) => workspace.fail(error));
  }, []);
  useEffect(() => {
    const resize = () => setWindowWidth(window.innerWidth);
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);
  useEffect(() => {
    const updateChrome = (value: unknown) => {
      const chrome = windowChromeSchema.parse(value);
      document.documentElement.dataset.windowMode = chrome.mode;
      document.documentElement.style.setProperty(
        "--toolbar-height",
        `${chrome.toolbarHeight}px`,
      );
      document.documentElement.style.setProperty(
        "--window-controls-inset",
        `${chrome.leadingInset}px`,
      );
    };
    const chromeSubscription = getCurrentWindow().listen(
      "inknb-window-chrome",
      (event) => updateChrome(event.payload),
    );
    void chromeSubscription
      .then(() => readWindowChrome())
      .then(updateChrome)
      .catch((error) => workspace.fail(error));
    const subscriptions = [
      chromeSubscription,
      getCurrentWindow().listen<string>(
        "inknb-menu",
        (event) =>
          void workspace
            .command(event.payload)
            .catch((error) => workspace.fail(error)),
      ),
      getCurrentWindow().listen<{
        id: string;
        method: string;
        params: unknown;
      }>("inknb-control", (event) => {
        void workspace.control(event.payload.method, event.payload.params).then(
          (result) =>
            invoke("complete_control", {
              requestId: event.payload.id,
              result: result ?? null,
              error: null,
            }),
          (error) =>
            invoke("complete_control", {
              requestId: event.payload.id,
              result: null,
              error: error instanceof Error ? error.message : String(error),
            }),
        );
      }),
    ];
    const shortcuts = new ShortcutResolver();
    const shortcut = (event: KeyboardEvent) => {
      if (event.key === "Escape" && activity.getSnapshot().open) {
        event.preventDefault();
        event.stopPropagation();
        activity.update({ open: false });
        return;
      }
      shortcuts.handle(event, workspace.getSnapshot().preferences, "application", command => {
        void workspace.command(command).catch(error => workspace.fail(error));
      });
    };
    window.addEventListener("keydown", shortcut, true);
    return () => {
      window.removeEventListener("keydown", shortcut, true);
      for (const subscription of subscriptions)
        void subscription.then((unlisten) => unlisten());
    };
  }, []);
  if (!library.ready)
    return (
      <div className="startup-state">
        {library.error ?? "Opening your writing…"}
      </div>
    );
  const active = workspace.active?.getSnapshot();
  const sidebar = library.sidebarOpen && !active?.focus;
  const compact = windowWidth <= compactLibraryWidth;
  const maximumSidebarWidth = Math.min(480, Math.floor(windowWidth * 0.4));
  const sidebarWidth = Math.min(library.sidebarWidth, maximumSidebarWidth);
  return (
    <div
      className="library-shell"
      style={{
        gridTemplateColumns:
          sidebar && !compact ? `${sidebarWidth}px minmax(0, 1fr)` : undefined,
      }}
    >
      {sidebar && !compact && (
        <Library
          width={sidebarWidth}
          maximumWidth={maximumSidebarWidth}
          onWidthChange={(sidebarWidth) => workspace.update({ sidebarWidth })}
        />
      )}
      <ModalOverlay
        isOpen={sidebar && compact}
        onOpenChange={(open) => workspace.update({ sidebarOpen: open })}
        isDismissable
        className="modal-overlay library-overlay"
      >
        <Modal className="library-modal">
          <Dialog aria-label="Document library">
            <Library
              onNavigate={() => {
                restoreWritingFocus.current = true;
                workspace.update({ sidebarOpen: false });
              }}
            />
          </Dialog>
        </Modal>
      </ModalOverlay>
      <div className="document-stack">
        <div className="writing-window-drag" data-tauri-drag-region />
        {!sidebar && <div className="library-reveal">
          <IconButton icon={PanelLeft} label={shortcutTooltip("Show library", "sidebar", library.preferences)} agentControl="library.toggle" onPress={() => { workspace.active?.update({ focus: false }); workspace.update({ sidebarOpen: true }); }} />
        </div>}
        <CommandPalette session={workspace.active} />
        <DecisionsPanel open={library.commandSurface === "decisions"} onOpenChange={open => workspace.update({ commandSurface: open ? "decisions" : null })} />
        <ActivityCenter />
        {!library.activeId && (
          <div className="app">
            <div className="startup-state">
              <p>This space has no documents.</p>
              <Button
                className="text-button"
                onPress={() => void workspace.newDocument()}
              >
                New document
              </Button>
            </div>
          </div>
        )}
        {[...workspace.sessions]
          .filter(([identity]) =>
            library.documents.some((entry) => entry.id === identity),
          )
          .map(([identity, session]) => (
            <div
              className="document-container"
              key={identity}
              hidden={identity !== library.activeId}
            >
              <SessionContext value={session}>
                <DocumentApp active={identity === library.activeId} />
              </SessionContext>
            </div>
          ))}
      </div>
    </div>
  );
}

const windowLabel = getCurrentWindow().label;
createRoot(document.getElementById("root")!).render(
  windowLabel === "host" ? null : (
    <>
      <LinkPreview />
      <ImageViewer />
      {windowLabel === "preview" ? (
        <Suspense fallback={<p className="quiet-note">Opening preview…</p>}>
          <DetachedPreview />
        </Suspense>
      ) : (
        <App />
      )}
    </>
  ),
);

if (windowLabel === "host")
  void appHost.start().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    document.getElementById("root")!.textContent =
      `Ink and Butter could not open your library: ${message}`;
    void invoke("host_lifecycle", { status: { phase: "failed", message } });
  });
