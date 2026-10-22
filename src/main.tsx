import AgentConnections from "./AgentConnections";
import { DecisionsButton } from "./Decisions";
import SpaceMenu from "./SpaceMenu";
import ActivityCenter, { ActivityButton } from "./ActivityCenter";
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
import { BookOpen, Focus, LayoutTemplate, ListTree, MessageSquarePlus } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import AsideLayout, { AsidesButton } from "./AsideLayout";
import DocumentHistory from "./DocumentHistory";
import DocumentToolbar from "./DocumentToolbar";
import { NativeEditor } from "./native-editor";
import { SessionContext, useDocumentSession, useSession } from "./use-session";
import { appHost } from "./app-host";
import { workspace } from "./window-workspace";
import Library from "./Library";
import DocumentNavigation from "./DocumentNavigation";
import DocumentOutline from "./DocumentOutline";
import DocumentReview, { ReviewButton } from "./DocumentReview";
import LinkedResources from "./LinkedResources";
import IconButton from "./IconButton";
import PassageAnnotations from "./PassageAnnotations";
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
  const [historyOpen, setHistoryOpen] = useState(false);
  const editorHost = useRef<HTMLDivElement>(null);
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
  const title =
    library.documents.find((entry) => entry.id === state.metadata.documentId)
      ?.title ?? "Untitled";
  return (
    <div
      className={`app ${state.focus ? "focus-mode" : ""} placement-${state.preferences.placement}`}
    >
      <DocumentToolbar active={active}>
        <div className="window-inset" />
        {!library.sidebarOpen && <DocumentNavigation />}
        {!library.sidebarOpen && <SpaceMenu />}
        <div className="document-name">
          <span className="document-title">
            {title}
            {state.profile ? ` · ${state.profile}` : ""}
          </span>
          {state.dirty && (
            <span className="unsaved-dot" aria-label="Unsaved changes" />
          )}
        </div>
        <div className="header-spacer" data-tauri-drag-region />
        <div className="toolbar">
          {active && <ActivityButton />}
          <AgentConnections />
          <DecisionsButton />

          {!state.focus && (
            <>
              <LinkedResources />
              <ReviewButton />
              {state.metadata.page && <IconButton
                icon={state.pageVisible ? BookOpen : LayoutTemplate}
                label={state.pageVisible ? "Show prose" : "Show document page"}
                agentControl="page.toggle"
                active={state.pageVisible}
                onPress={() => session.update({ pageVisible: !state.pageVisible })}
              />}
              <IconButton
                icon={ListTree}
                label="Toggle document outline"
                agentControl="outline.toggle"
                active={state.outlineOpen ?? state.preferences.document_outline}
                onPress={() => session.update({ outlineOpen: !(state.outlineOpen ?? state.preferences.document_outline) })}
              />
              <DocumentHistory
                active={active}
                open={historyOpen}
                onOpenChange={setHistoryOpen}
              />
              <AsidesButton />
              <IconButton
                icon={MessageSquarePlus}
                label="Add aside"
                agentControl="aside.create"
                onPress={() => {
                  setHistoryOpen(false);
                  session.startComment();
                }}
              />
            </>
          )}
          <IconButton
            icon={Focus}
            label="Toggle focus mode"
            agentControl="focus.toggle"
            active={state.focus}
            onPress={() => void session.command("focus")}
          />
        </div>
      </DocumentToolbar>
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
    const shortcut = (event: KeyboardEvent) => {
      if (event.key === "Escape" && activity.getSnapshot().open) {
        event.preventDefault();
        event.stopPropagation();
        activity.update({ open: false });
        return;
      }
      if (
        event.defaultPrevented ||
        !(event.metaKey || event.ctrlKey) ||
        (event.altKey && (event.code !== "KeyA" || event.shiftKey))
      )
        return;
      const key = event.key.toLowerCase();
      if (key === "enter" && event.shiftKey && !event.altKey) {
        event.preventDefault();
        event.stopPropagation();
        if (!event.repeat) void workspace.command("selection-comment").catch((error) => workspace.fail(error));
        return;
      }
      if (["+", "=", "-", "0"].includes(key)) {
        event.preventDefault();
        event.stopPropagation();
        const command = key === "0" ? "text-reset" : key === "-" ? "text-smaller" : "text-larger";
        void workspace.command(command).catch((error) => workspace.fail(error));
        return;
      }
      const command = event.altKey
        ? "comment-document"
        : key === "["
          ? "back"
          : key === "]"
            ? "forward"
            : key === "s"
              ? event.shiftKey
                ? "save-as"
                : "save"
              : key === "o"
                ? "open"
                : key === "n"
                  ? "new"
                  : key === "a" && event.shiftKey
                    ? "comment"
                    : key === "k" && event.shiftKey
                      ? "activity"
                      : key === "f" && event.shiftKey
                        ? "focus"
                        : null;
      if (!command) return;
      event.preventDefault();
      void workspace.command(command).catch((error) => workspace.fail(error));
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
  const compact = windowWidth <= 980;
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
        <ActivityCenter />
        {!library.activeId && (
          <div className="app">
            <DocumentToolbar>
              <SpaceMenu />
              <div className="header-spacer" />
              <ActivityButton />
            </DocumentToolbar>
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
  windowLabel === "host" ? null : windowLabel === "preview" ? (
    <Suspense fallback={<p className="quiet-note">Opening preview…</p>}>
      <DetachedPreview />
    </Suspense>
  ) : (
    <App />
  ),
);

if (windowLabel === "host")
  void appHost.start().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    document.getElementById("root")!.textContent =
      `Ink and Butter could not open your library: ${message}`;
    void invoke("host_lifecycle", { status: { phase: "failed", message } });
  });
