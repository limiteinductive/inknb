import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { Button } from "react-aria-components";
import {
  ExternalLink,
  Maximize2,
  MessageSquarePlus,
  Minimize2,
  PanelRight,
  SquareDashedMousePointer,
  X,
} from "lucide-react";
import IconButton from "./IconButton";
import MarkdownPreview from "./MarkdownPreview";
import PreviewArtifact from "./PreviewArtifact";
import type { PreviewBounds } from "./PreviewArtifact";
import { textFingerprint } from "./preview-model";
import type {
  PreviewAction,
  PreviewAnchor,
  PreviewInfo,
} from "./preview-model";
import type { PreviewState } from "./preview-window";
import { showContextMenu } from "./context-menu";
import { captureAnchor } from "./domain";
import { renderChange } from "./change-display";
import { sourceFormat } from "./native-schema";
import { visibleSuggestions } from "./suggestions";
import type { PreviewSuggestion } from "./suggestions";
import { asidePassages, previewAsideLocations } from "./aside-locations";

export default function Preview({
  active,
  state,
  onAction,
  detached = false,
  windowFullscreen = false,
  toolbarHost,
  documentActions,
}: {
  active: boolean;
  state: PreviewState;
  onAction: (action: PreviewAction) => void;
  detached?: boolean;
  windowFullscreen?: boolean;
  toolbarHost?: HTMLElement | null;
  documentActions?: ReactNode;
}) {
  const passageSignature = JSON.stringify(asidePassages(state));
  const passages = useMemo(() => asidePassages(state), [passageSignature]);
  const fullscreen = windowFullscreen;
  const [regionSelecting, setRegionSelecting] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const [readingProgress, setReadingProgress] = useState(0);
  const capturePending = useRef(false);
  const contextSelection = useRef<{
    information: PreviewInfo;
    anchor: PreviewAnchor;
  } | null>(null);
  const currentActive = useRef(active);
  currentActive.current = active;
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const currentState = useRef(state);
  currentState.current = state;
  const desired =
    state.previewArtifactId ?? state.metadata.preview?.artifactId ?? null;
  const [displayed, setDisplayed] = useState<string | null>(
    state.previewInformation?.artifactId ??
      state.metadata.previewLastGood?.artifactId ??
      null,
  );
  const [sourceHash, setSourceHash] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<PreviewSuggestion[]>([]);
  const openSuggestions = visibleSuggestions(state);
  const suggestionSignature = JSON.stringify(openSuggestions);
  const [asideLocation, setAsideLocation] = useState<PreviewAnchor | null>(
    null,
  );
  const locatedAside = useRef<string | null>(null);
  const lastDesired = useRef(desired);
  useEffect(() => {
    if (lastDesired.current !== desired) locatedAside.current = null;
    lastDesired.current = desired;
    if (!active || !state.activeThread) {
      locatedAside.current = null;
      setAsideLocation(null);
      return;
    }
    const information = state.previewInformation;
    if (!information || locatedAside.current === state.activeThread) return;
    const location = previewAsideLocations(
      information,
      asidePassages(state),
    ).find((location) => location.id === state.activeThread);
    if (!location) return;
    locatedAside.current = location.id;
    setAsideLocation({
      artifactId: information.artifactId,
      sourceHash: information.sourceHash,
      quote: "",
      capture: null,
      target: location.target,
    });
  }, [
    active,
    desired,
    state.activeThread,
    state.previewInformation?.artifactId,
  ]);
  useEffect(() => {
    let current = true;
    if (!openSuggestions.length) {
      setSuggestions([]);
      return;
    }
    const rendered = openSuggestions.map((proposal) => ({
      proposal,
      fragment: renderChange(
        proposal.expectedText,
        proposal.replacement,
        sourceFormat(state.path, state.text, state.metadata.nativeDocument?.format),
      ),
    }));
    const references = [...new Set(rendered.flatMap(({ fragment }) =>
      [...fragment.querySelectorAll<HTMLImageElement>("img[data-native-image]")]
        .map((image) => image.dataset.nativeImage ?? ""),
    ))];
    void invoke<Record<string, string>>("preview_assets", {
      documentPath: state.path,
      references,
    })
      .then((assets) => {
        if (!current) return;
        setSuggestions(
          rendered.map(({ proposal, fragment }) => {
            for (const image of fragment.querySelectorAll<HTMLImageElement>("img[data-native-image]"))
              image.src = assets[image.dataset.nativeImage ?? ""] ?? "";
            const template = document.createElement("template");
            template.content.append(fragment);
            return { id: proposal.id, anchor: captureAnchor(state.text, proposal), html: template.innerHTML };
          }),
        );
      })
      .catch((error) => onAction({ kind: "error", error: String(error) }));
    return () => {
      current = false;
    };
  }, [desired, state.path, state.text, suggestionSignature]);
  const desiredRef = useRef(desired);
  desiredRef.current = desired;
  const displayedRef = useRef(displayed);
  displayedRef.current = displayed;
  const panel = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const element = panel.current;
    if (!element || !active) return;
    const observer = new ResizeObserver(() => {
      if (!element.clientWidth || !element.clientHeight) return;
      element.style.setProperty("--preview-width", `${element.clientWidth}px`);
      element.style.setProperty(
        "--preview-height",
        `${element.clientHeight}px`,
      );
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [active]);
  useEffect(() => {
    let current = true;
    void textFingerprint(state.text).then((hash) => {
      if (current) setSourceHash(hash);
    });
    return () => {
      current = false;
    };
  }, [state.text]);
  useEffect(() => {
    if (desired) onAction({ kind: "loading", artifactId: desired });
  }, [desired]);
  const ready = useCallback(
    (info: PreviewInfo) => {
      if (info.manifest.documentId !== currentState.current.metadata.documentId)
        return;
      if (
        desiredRef.current &&
        info.artifactId !== desiredRef.current &&
        info.artifactId !== displayedRef.current
      )
        return;
      if (!desiredRef.current || info.artifactId === desiredRef.current) {
        setDisplayed(info.artifactId);
        displayedRef.current = info.artifactId;
        onAction({ kind: "ready", information: info });
      } else if (!currentState.current.previewInformation)
        onAction({ kind: "ready", information: info });
    },
    [onAction],
  );
  const progressed = useCallback(
    (information: PreviewInfo, progress: number) => {
      if (information.artifactId === displayedRef.current)
        setReadingProgress(progress);
    },
    [],
  );
  const failed = useCallback(
    (identity: string, error: string) => {
      if (desiredRef.current && identity !== desiredRef.current) return;
      if (!desiredRef.current) onAction({ kind: "error", error });
      else onAction({ kind: "failed", artifactId: identity, error });
    },
    [onAction],
  );
  const selected = useCallback(
    async (info: PreviewInfo, anchor: PreviewAnchor, bounds: PreviewBounds) => {
      if (info.artifactId !== displayedRef.current || capturePending.current)
        return;
      if (anchor.quote) {
        contextSelection.current = { information: info, anchor };
        onAction({ kind: "selected", information: info, anchor, bounds });
        return;
      }
      capturePending.current = true;
      setRegionSelecting(false);
      setCapturing(true);
      onAction({ kind: "clear" });
      try {
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => resolve()),
        );
        const viewport = panel.current
          ?.querySelector(".preview-content")
          ?.getBoundingClientRect();
        if (!viewport) return;
        const left = Math.max(0, viewport.left, bounds.left);
        const top = Math.max(0, viewport.top, bounds.top);
        const right = Math.min(innerWidth, viewport.right, bounds.right);
        const bottom = Math.min(innerHeight, viewport.bottom, bounds.bottom);
        if (right - left < 3 || bottom - top < 3) return;
        const capture = await invoke<NonNullable<PreviewAnchor["capture"]>>(
          "preview_capture",
          {
            artifactId: info.artifactId,
            rectangle: { left, top, width: right - left, height: bottom - top },
          },
        );
        if (
          !mounted.current ||
          !currentActive.current ||
          info.artifactId !== displayedRef.current
        )
          return;
        onAction({
          kind: "aside",
          information: info,
          anchor: { ...anchor, capture },
        });
      } catch (error) {
        if (mounted.current) onAction({ kind: "error", error: String(error) });
      } finally {
        capturePending.current = false;
        if (mounted.current) setCapturing(false);
      }
    },
    [onAction],
  );
  const clear = useCallback(() => {
    contextSelection.current = null;
    if (currentState.current.previewSelection) onAction({ kind: "clear" });
  }, [onAction]);
  const contextMenu = useCallback(
    (information: PreviewInfo, point: { left: number; top: number }) => {
      if (
        !currentActive.current ||
        information.artifactId !== displayedRef.current
      )
        return;
      const selection = contextSelection.current;
      const selected =
        selection?.information.artifactId === information.artifactId
          ? selection
          : null;
      void showContextMenu({
        ...point,
        copy: Boolean(selected),
        aside: selected
          ? () => {
              if (
                currentActive.current &&
                displayedRef.current === information.artifactId
              )
                onAction({ kind: "aside", ...selected });
            }
          : undefined,
        region: () => {
          if (
            !currentActive.current ||
            displayedRef.current !== information.artifactId
          )
            return;
          clear();
          setRegionSelecting(true);
        },
      }).catch((error) => onAction({ kind: "error", error: String(error) }));
    },
    [onAction, clear],
  );
  const escape = useCallback(() => {
    if (regionSelecting) {
      setRegionSelecting(false);
      return;
    }
    if (currentState.current.previewSelection) onAction({ kind: "clear" });
    else onAction({ kind: fullscreen ? "fullscreen" : "close" });
  }, [onAction, fullscreen, regionSelecting]);
  const reference = useCallback(
    (reference: string) => {
      void invoke("open_reference", {
        documentPath: currentState.current.path,
        reference,
      }).catch((error) => onAction({ kind: "error", error: String(error) }));
    },
    [onAction],
  );
  const artifacts = desired
    ? [
        ...new Set(
          [displayed, desired].filter(
            (identity): identity is string => identity !== null,
          ),
        ),
      ]
    : [];
  const selection = state.previewSelection;
  const bounds = panel.current?.getBoundingClientRect();
  const older = desired && desired !== state.metadata.preview?.artifactId;
  const source = state.metadata.preview ?? state.previewInformation;
  const behind =
    source && sourceHash !== null && sourceHash !== source.sourceHash;
  const runtimeError =
    state.previewRuntime?.artifactId === desired &&
    state.previewRuntime.status === "error";
  const updating =
    state.metadata.previewBuild?.status === "building" ||
    (desired && displayed !== desired && !runtimeError);
  const heading = (
    <div className="preview-heading" data-tauri-drag-region>
      {detached && (
        <span className="preview-document-title" data-tauri-drag-region>
          {state.title}
        </span>
      )}
      <div className="preview-status" role="status">
        {capturing ? (
          <span>Capturing region…</span>
        ) : regionSelecting ? (
          <span>Drag a region · Esc to cancel</span>
        ) : older ? (
          <>
            <span>
              {displayed === desired
                ? "Earlier preview"
                : "Loading earlier preview…"}
            </span>
            <Button
              className="text-button"
              data-inknb-control="preview.latest"
              onPress={() => onAction({ kind: "latest" })}
            >
              Latest
            </Button>
          </>
        ) : runtimeError || state.metadata.previewBuild?.status === "failed" ? (
          <span
            title={
              state.previewRuntime?.error ??
              state.metadata.previewBuild?.message ??
              undefined
            }
          >
            Preview update failed
          </span>
        ) : updating ? (
          "Updating…"
        ) : behind ? (
          "Earlier text"
        ) : null}
      </div>
      <div className="preview-actions">
        {documentActions}
        <IconButton
          icon={SquareDashedMousePointer}
          label={
            regionSelecting ? "Cancel region comment" : "Comment on region"
          }
          active={regionSelecting}
          disabled={!displayed || capturing}
          agentControl="preview.region"
          onPress={() => {
            clear();
            setRegionSelecting(!regionSelecting);
          }}
        />
        <IconButton
          icon={detached ? PanelRight : ExternalLink}
          label={detached ? "Return to document" : "Open output window"}
          agentControl={detached ? "preview.dock" : "preview.detach"}
          onPress={() => onAction({ kind: detached ? "dock" : "detach" })}
        />
        <IconButton
          icon={fullscreen ? Minimize2 : Maximize2}
          label={fullscreen ? "Exit fullscreen" : "Fullscreen"}
          agentControl="preview.fullscreen"
          onPress={() => onAction({ kind: "fullscreen" })}
        />
        <IconButton
          icon={X}
          label="Close preview"
          agentControl="preview.close"
          onPress={() => onAction({ kind: "close" })}
        />
      </div>
    </div>
  );
  return (
    <aside
      ref={panel}
      id={`preview-${state.metadata.documentId}`}
      className={`preview-panel ${toolbarHost ? "preview-toolbar-external" : ""} ${regionSelecting ? "selecting-region" : ""}`}
      aria-label="Reading preview"
      onKeyDown={(event) => {
        if (event.key !== "Escape" || event.defaultPrevented) return;
        event.preventDefault();
        event.stopPropagation();
        escape();
      }}
    >
      {toolbarHost ? createPortal(heading, toolbarHost) : heading}
      <div
        className="preview-reading-progress"
        role="progressbar"
        aria-label="Reading progress"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(readingProgress * 100)}
      >
        <span style={{ transform: `scaleX(${readingProgress})` }} />
      </div>
      <div
        className={`preview-content ${desired ? "has-artifact" : ""}`}
        data-inknb-control="preview.content"
        data-inknb-scroll="true"
        aria-label="Rendered manuscript"
        tabIndex={desired ? undefined : 0}
      >
        {!desired && (
          <MarkdownPreview
            suggestions={suggestions}
            suggestionFocus={state.reviewOpen ? state.reviewProposalId : null}
            passages={passages}
            activeAside={
              state.reviewOpen ? state.reviewProposalId : state.asidesOpen && !state.focus
                ? state.composer
                  ? "new"
                  : state.activeThread
                : null
            }
            state={state}
            active={active}
            location={state.previewLocation ?? asideLocation}
            regionSelecting={regionSelecting}
            onReady={ready}
            onProgress={progressed}
            onError={failed}
            onSelection={selected}
            onClear={clear}
            onEscape={escape}
            onReference={reference}
            onContextMenu={contextMenu}
          />
        )}
        {artifacts.map((artifactId) => (
          <div
            key={artifactId}
            className={`artifact-view ${artifactId === displayed ? "is-displayed" : "is-pending"}`}
            inert={artifactId !== displayed}
            aria-hidden={artifactId !== displayed}
          >
            <PreviewArtifact
              passages={passages}
              activeAside={
                state.reviewOpen ? state.reviewProposalId : state.asidesOpen && !state.focus
                  ? state.composer
                    ? "new"
                    : state.activeThread
                  : null
              }
              artifactId={artifactId}
              suggestions={suggestions}
              suggestionFocus={state.reviewOpen ? state.reviewProposalId : null}
              active={active}
              regionSelecting={regionSelecting && artifactId === displayed}
              onReference={reference}
              location={
                state.previewLocation?.artifactId === artifactId
                  ? state.previewLocation
                  : asideLocation?.artifactId === artifactId
                    ? asideLocation
                    : null
              }
              onReady={ready}
              onProgress={progressed}
              onError={failed}
              onSelection={selected}
              onClear={clear}
              onEscape={escape}
              onContextMenu={contextMenu}
            />
          </div>
        ))}
        {desired && !displayed && (
          <p className="preview-placeholder">
            {runtimeError
              ? "Your agent can inspect the preview error."
              : "Loading preview…"}
          </p>
        )}
      </div>
      {selection &&
        bounds &&
        state.previewInformation &&
        !capturing &&
        !regionSelecting && (
          <Button
            className="preview-aside-action"
            aria-label="Add aside on preview"
            onMouseDown={(event) => event.preventDefault()}
            style={{
              left: Math.max(
                bounds.left + 8,
                Math.min(bounds.right - 40, selection.bounds.right + 6),
              ),
              top: Math.max(
                52,
                Math.min(window.innerHeight - 40, selection.bounds.bottom + 6),
              ),
            }}
            onPress={() => {
              onAction({
                kind: "aside",
                anchor: selection.anchor,
                information: state.previewInformation!,
              });
            }}
          >
            <MessageSquarePlus size={17} strokeWidth={1.6} aria-hidden="true" />
          </Button>
        )}
    </aside>
  );
}
