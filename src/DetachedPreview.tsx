import { ActivityButton } from "./ActivityCenter";
import { activity } from "./activity";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useSyncExternalStore } from "react";
import AsideLayout, { DocumentNotesButton } from "./AsideLayout";
import DocumentHistory from "./DocumentHistory";
import DocumentToolbar from "./DocumentToolbar";
import DocumentReview, { ReviewButton } from "./DocumentReview";
import { captureAnchor } from "./domain";
import { previewAsideLocations } from "./aside-locations";
import IconButton from "./IconButton";
import { MessageSquarePlus } from "lucide-react";
import { AsideContext } from "./use-session";
import { PreviewAsides } from "./preview-asides";
import type { AsideResult } from "./aside-actions";
import Preview from "./Preview";
import type { PreviewAction } from "./preview-model";
import type { PreviewWindowSnapshot } from "./preview-window";
import { readWindowChrome, windowChromeSchema } from "./window-chrome";
import { useContextMenus } from "./context-menu";

export default function DetachedPreview() {
  const [snapshot, setSnapshot] = useState<PreviewWindowSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  useContextMenus(undefined, (error) => setError(String(error)));
  useEffect(() => {
    if (error) activity.report(documentId, "error", error);
  }, [error]);
  const [fullscreen, setFullscreen] = useState(false);
  const sequence = useRef(0);
  const documentId = snapshot?.state.metadata.documentId ?? null;
  const onAction = useCallback(
    (action: PreviewAction) => {
      if (action.kind === "fullscreen") {
        const window = getCurrentWindow();
        void window
          .isFullscreen()
          .then((value) => window.setFullscreen(!value))
          .then(() => window.isFullscreen())
          .then(setFullscreen)
          .catch((error) => setError(String(error)));
        return;
      }
      void invoke("preview_window_action", { documentId, action }).catch(
        (error) => setError(String(error)),
      );
    },
    [documentId],
  );
  useEffect(() => {
    const subscription = getCurrentWindow().listen<PreviewWindowSnapshot>(
      "inknb-preview-state",
      (event) => {
        if (event.payload.sequence <= sequence.current) return;
        sequence.current = event.payload.sequence;
        setSnapshot(event.payload);
      },
    );
    void subscription
      .then(() =>
        invoke("preview_window_action", {
          documentId: null,
          action: { kind: "connected" },
        }),
      )
      .catch((error) => setError(String(error)));
    const updateChrome = (value: unknown) => {
      const chrome = windowChromeSchema.parse(value);
      document.documentElement.style.setProperty(
        "--toolbar-height",
        `${chrome.toolbarHeight}px`,
      );
      document.documentElement.style.setProperty(
        "--window-controls-inset",
        `${chrome.leadingInset}px`,
      );
      setFullscreen(chrome.mode === "fullscreen");
    };
    const chromeSubscription = getCurrentWindow().listen(
      "inknb-window-chrome",
      (event) => updateChrome(event.payload),
    );
    void chromeSubscription
      .then(() => readWindowChrome())
      .then(updateChrome)
      .catch((error) => setError(String(error)));
    const menu = getCurrentWindow().listen<string>(
      "inknb-preview-menu",
      (event) => {
        if (event.payload === "undo" || event.payload === "redo")
          document.execCommand(event.payload);
        if (event.payload === "comment-document" || event.payload === "resolve-asides")
          void invoke("preview_window_action", {
            documentId: snapshotRef.current?.state.metadata.documentId,
            action: {
              kind: "aside-action",
              requestId: crypto.randomUUID(),
              action: { kind: event.payload === "resolve-asides" ? "resolve-all" : "start" },
            },
          }).catch((error) => setError(String(error)));
        if (event.payload === "comment") {
          const selection = snapshotRef.current?.state.previewSelection;
          const information = snapshotRef.current?.state.previewInformation;
          if (selection && information)
            void invoke("preview_window_action", {
              documentId: snapshotRef.current?.state.metadata.documentId,
              action: { kind: "aside", anchor: selection.anchor, information },
            }).catch((error) => setError(String(error)));
        }
      },
    );
    const shortcut = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "w")
        return;
      event.preventDefault();
      void invoke("preview_window_action", {
        documentId: snapshotRef.current?.state.metadata.documentId,
        action: { kind: "close" },
      }).catch((error) => setError(String(error)));
    };
    window.addEventListener("keydown", shortcut);
    return () => {
      window.removeEventListener("keydown", shortcut);
      for (const pending of [subscription, chromeSubscription, menu])
        void pending.then((unlisten) => unlisten());
    };
  }, []);
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;
  const preferences = snapshot?.state.preferences;
  useEffect(() => {
    if (!preferences) return;
    const media = matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      document.documentElement.dataset.theme =
        preferences.appearance === "system"
          ? media.matches
            ? "dark"
            : "light"
          : preferences.appearance;
    };
    apply();
    void getCurrentWindow()
      .setTheme(
        preferences.appearance === "system" ? null : preferences.appearance,
      )
      .catch((error) => setError(String(error)));
    media.addEventListener("change", apply);
    document.documentElement.dataset.motion = preferences.reduce_motion
      ? "reduced"
      : "system";
    document.documentElement.dataset.typeface = preferences.typeface;
    document.documentElement.style.setProperty(
      "--writing-size",
      `${preferences.font_size}px`,
    );
    document.documentElement.style.setProperty(
      "--writing-width",
      `${preferences.line_width}px`,
    );
    return () => media.removeEventListener("change", apply);
  }, [preferences]);
  useEffect(() => {
    if (snapshot)
      void getCurrentWindow().setTitle(
        `${snapshot.state.title}${snapshot.state.profile ? ` · ${snapshot.state.profile}` : ""}`,
      );
  }, [snapshot?.state.title, snapshot?.state.profile]);
  return (
    <main className="detached-preview" data-fullscreen={fullscreen}>
      {error && (
        <p className="notice" role="alert">
          {error}
        </p>
      )}
      {snapshot ? (
        <DetachedDocument
          key={snapshot.state.metadata.documentId}
          snapshot={snapshot}
          onAction={onAction}
          fullscreen={fullscreen}
        />
      ) : (
        <p className="quiet-note">Opening preview…</p>
      )}
    </main>
  );
}

function DetachedDocument({
  snapshot,
  onAction,
  fullscreen,
}: {
  snapshot: PreviewWindowSnapshot;
  onAction: (action: PreviewAction) => void;
  fullscreen: boolean;
}) {
  const [session] = useState(() => new PreviewAsides(snapshot.state));
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const [toolbarHost, setToolbarHost] = useState<HTMLDivElement | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  useLayoutEffect(() => session.receive(snapshot.state), [session, snapshot]);
  useEffect(() => {
    const subscription = getCurrentWindow().listen<AsideResult>(
      "inknb-aside-result",
      (event) => session.result(event.payload),
    );
    return () => {
      void subscription.then((unlisten) => unlisten());
      session.destroy();
    };
  }, [session]);
  const action = useCallback(
    (action: PreviewAction) => {
      if (action.kind === "aside") session.update({ asidesOpen: true });
      onAction(action);
    },
    [session, onAction],
  );
  return (
    <AsideContext value={session}>
      <DocumentToolbar className="detached-document-toolbar">
        <div className="window-inset" />
        <div ref={setToolbarHost} className="preview-toolbar-host" />
      </DocumentToolbar>
      <AsideLayout
        active
        historyOpen={historyOpen}
        preferredWidth={snapshot.asideWidth}
        onWidthChange={(width) => onAction({ kind: "aside-width", width })}
      >
        <Preview
          active
          state={{ ...snapshot.state, ...state }}
          onAction={action}
          detached
          windowFullscreen={fullscreen}
          toolbarHost={toolbarHost}
          documentActions={
            <>
              <ActivityButton remote />
              <ReviewButton />
              <DocumentHistory
                active
                open={historyOpen}
                onOpenChange={setHistoryOpen}
              />
              <DocumentNotesButton compact />
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
          }
        />
      </AsideLayout>
      <DocumentReview active onReveal={(proposal) => {
        const information = state.previewInformation;
        if (!information) return;
        const location = previewAsideLocations(information, [{ id: proposal.id, anchor: captureAnchor(state.text, proposal), preview: null, expanded: true, suggestionId: null }])[0];
        if (location) session.update({ previewLocation: { artifactId: information.artifactId, sourceHash: information.sourceHash, quote: location.quote, target: location.target, capture: null } });
      }} />
    </AsideContext>
  );
}
