import { focusAside } from "./aside-focus";
import { documentScroll } from "./document-scroll";
import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { z } from "zod";
import {
  getDocument,
  GlobalWorkerOptions,
} from "pdfjs-dist/legacy/build/pdf.mjs";
import type {
  PDFDocumentLoadingTask,
  PDFDocumentProxy,
} from "pdfjs-dist/legacy/build/pdf.mjs";
import workerUrl from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";
import {
  EventBus,
  PDFLinkService,
  PDFViewer,
} from "pdfjs-dist/legacy/web/pdf_viewer.mjs";
import "pdfjs-dist/legacy/web/pdf_viewer.css";
import {
  previewAnchorSchema,
  previewInfoSchema,
  previewTargetSchema,
} from "./preview-model";
import type { PreviewAnchor, PreviewInfo } from "./preview-model";
import { locateSuggestions } from "./suggestions";
import type { PreviewSuggestion } from "./suggestions";
import suggestionStyles from "./preview-suggestions.css?raw";
import "./preview-suggestions.css";
import { previewAsideLocations } from "./aside-locations";
import { reviewSuggestion } from "./suggestions";
import type { AsidePassage } from "./aside-locations";
import { useAsideSession } from "./use-session";
import { scrollbarTheme } from "./scrollbars";
import { pointerPositionSchema, reportFramePointer } from "./geometry";
import { pageNodeBoundsSchema } from "./document-page";
import type { PageNodeBounds } from "./document-page";
import type { NativeObject } from "./native-schema";

GlobalWorkerOptions.workerSrc = workerUrl;

export interface PreviewBounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
}
export interface ArtifactProps {
  pageDocument?: NativeObject;
  pageVersion?: string;
  pageAssets?: Record<string, string>;
  onPageLayout?: (nodes: PageNodeBounds[]) => void;
  passages?: AsidePassage[];
  activeAside?: string | null;
  info: PreviewInfo;
  suggestions?: PreviewSuggestion[];
  suggestionFocus?: string | null;
  regionSelecting: boolean;
  onReference: (reference: string) => void;
  onProgress: (information: PreviewInfo, progress: number) => void;
  location: PreviewAnchor | null;
  onReady: (info: PreviewInfo) => void;
  onError: (identity: string, error: string) => void;
  onSelection: (
    info: PreviewInfo,
    anchor: PreviewAnchor,
    bounds: PreviewBounds,
  ) => void;
  onClear: () => void;
  onEscape: () => void;
  onContextMenu: (
    info: PreviewInfo,
    point: { left: number; top: number },
  ) => void;
}

const htmlMessage = z.discriminatedUnion("type", [
  pointerPositionSchema,
  z.object({ type: z.literal("asideActivated"), id: z.string().uuid() }),
  z.object({
    type: z.literal("asideHovered"),
    id: z.union([z.string().uuid(), z.literal("new")]).nullable(),
  }),
  z.object({ type: z.literal("locate"), top: z.number().finite() }),
  z.object({
    type: z.literal("layout"),
    height: z.number().finite().positive(),
    nodes: z.array(pageNodeBoundsSchema).max(10000).default([]),
    pageVersion: z.string().uuid().nullable().default(null),
    positions: z.array(
      z.object({
        id: z.union([z.string().uuid(), z.literal("new")]),
        top: z.number().finite(),
        bottom: z.number().finite(),
      }),
    ),
  }),
  z.object({ type: z.literal("loaded") }),
  z.object({ type: z.literal("ready"), text: z.string().max(100000) }),
  z.object({ type: z.literal("error"), error: z.string().max(2000) }),
  z.object({
    type: z.literal("selection"),
    quote: z.string().max(100000),
    target: previewTargetSchema,
    bounds: z.object({
      left: z.number().finite(),
      top: z.number().finite(),
      right: z.number().finite(),
      bottom: z.number().finite(),
    }),
  }),
  z.object({ type: z.literal("selectionCleared") }),
  z.object({ type: z.literal("escape") }),
  z.object({
    type: z.literal("contextmenu"),
    left: z.number().finite(),
    top: z.number().finite(),
  }),
  z.object({ type: z.literal("reference"), reference: z.string().max(10000) }),
]);

function HtmlArtifact(props: ArtifactProps) {
  const session = useAsideSession();
  const frame = useRef<HTMLIFrameElement>(null);
  const callbacks = useRef(props);
  callbacks.current = props;
  const locate = useCallback(() => {
    const target = callbacks.current.location?.target;
    if (target?.kind !== "html") return;
    frame.current?.contentWindow?.postMessage(
      { inknbPreview: 1, type: "locate", target },
      "*",
    );
  }, []);
  useEffect(() => {
    const current = frame.current;
    if (!current) return;
    const receive = (event: MessageEvent) => {
      if (
        event.source !== current.contentWindow ||
        event.data?.inknbPreview !== 1
      )
        return;
      const result = htmlMessage.safeParse(event.data);
      if (!result.success) {
        if (event.data.type === "layout") callbacks.current.onError(props.info.artifactId, `Invalid page geometry: ${result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`);
        return;
      }
      const message = result.data;
      if (message.type === "loaded") {
        current.contentWindow?.postMessage(
          {
            inknbPreview: 1,
            type: "context",
            pageDocument: callbacks.current.pageDocument,
            pageVersion: callbacks.current.pageVersion,
            pageAssets: callbacks.current.pageAssets,
            pageBindings: props.info.manifest.page?.bindings,
            artifactId: props.info.artifactId,
            regionSelecting: callbacks.current.regionSelecting,
            elementIds: props.info.manifest.sourceMap.flatMap((mapping) =>
              mapping.target.kind === "element"
                ? [mapping.target.elementId]
                : [],
            ),
            suggestions: locateSuggestions(
              props.info,
              callbacks.current.suggestions ?? [],
            ),
            suggestionStyles,
            suggestionFocus: callbacks.current.suggestionFocus,
            asides: previewAsideLocations(
              props.info,
              callbacks.current.passages ?? [],
            ),
            activeAside: callbacks.current.activeAside,
            scrollbars: scrollbarTheme(),
          },
          "*",
        );
        return;
      }
      if (event.data.artifactId !== props.info.artifactId) return;
      if (message.type === "pointerPosition")
        reportFramePointer(current, message.top);
      if (message.type === "asideActivated" && !reviewSuggestion(message.id, session)) session.toggleThread(message.id);
      if (message.type === "asideHovered") focusAside(current, message.id);
      if (
        message.type === "locate" &&
        !current.closest('[aria-hidden="true"]')
      ) {
        const viewport = documentScroll(current);
        viewport.scrollTo({
          top:
            viewport.scrollTop +
            current.getBoundingClientRect().top -
            viewport.getBoundingClientRect().top +
            message.top -
            viewport.clientHeight / 3,
          behavior: "instant",
        });
      }
      if (message.type === "layout") {
        if (message.pageVersion === callbacks.current.pageVersion)
          callbacks.current.onPageLayout?.(message.nodes);
        current.style.height = `${message.height}px`;
        if (!current.closest('[aria-hidden="true"]')) {
          const viewport = documentScroll(current);
          const offset =
            current.getBoundingClientRect().top -
            viewport.getBoundingClientRect().top +
            viewport.scrollTop;
          current.dispatchEvent(
            new CustomEvent("inknb-aside-geometry", {
              bubbles: true,
              detail: {
                positions: message.positions.map((position) => ({
                  ...position,
                  top: position.top + offset,
                  bottom: position.bottom + offset,
                })),
              },
            }),
          );
        }
      }
      if (message.type === "ready") {
        callbacks.current.onReady(props.info);
        locate();
      }
      if (message.type === "error")
        callbacks.current.onError(props.info.artifactId, message.error);
      if (message.type === "selectionCleared") callbacks.current.onClear();
      if (message.type === "escape") callbacks.current.onEscape();
      if (message.type === "contextmenu") {
        const bounds = current.getBoundingClientRect();
        callbacks.current.onContextMenu(props.info, {
          left: bounds.left + message.left,
          top: bounds.top + message.top,
        });
      }
      if (message.type === "reference")
        callbacks.current.onReference(message.reference);
      if (message.type === "selection") {
        const bounds = current.getBoundingClientRect();
        callbacks.current.onSelection(
          props.info,
          previewAnchorSchema.parse({
            artifactId: props.info.artifactId,
            sourceHash: props.info.sourceHash,
            quote: message.quote,
            target: message.target,
          }),
          {
            left: bounds.left + message.bounds.left,
            top: bounds.top + message.bounds.top,
            right: bounds.left + message.bounds.right,
            bottom: bounds.top + message.bounds.bottom,
          },
        );
      }
    };
    const viewport = documentScroll(current);
    const progress = () => {
      if (current.closest('[aria-hidden="true"]')) return;
      callbacks.current.onClear();
      const top =
        current.getBoundingClientRect().top -
        viewport.getBoundingClientRect().top +
        viewport.scrollTop;
      const distance = Math.max(
        0,
        current.offsetHeight - viewport.clientHeight,
      );
      callbacks.current.onProgress(
        props.info,
        distance
          ? Math.max(0, Math.min(1, (viewport.scrollTop - top) / distance))
          : 1,
      );
    };
    const emphasize = (event: Event) =>
      current.contentWindow?.postMessage(
        {
          inknbPreview: 1,
          type: "emphasize",
          id: (event as CustomEvent<{ id: string | null }>).detail.id,
        },
        "*",
      );
    const host = current.closest(".document-body");
    host?.addEventListener("inknb-aside-focus", emphasize);
    viewport.addEventListener("scroll", progress, { passive: true });
    const resize = new ResizeObserver(progress);
    resize.observe(current);
    window.addEventListener("message", receive);
    current.src = `inknb-preview://localhost/${props.info.artifactId}/${props.info.manifest.entry.split("/").map(encodeURIComponent).join("/")}?build=${encodeURIComponent(__INKNB_BUILD__)}`;
    return () => {
      window.removeEventListener("message", receive);
      viewport.removeEventListener("scroll", progress);
      host?.removeEventListener("inknb-aside-focus", emphasize);
      resize.disconnect();
    };
  }, [props.info.artifactId]);
  useEffect(() => {
    if (!props.pageDocument) return;
    frame.current?.contentWindow?.postMessage({ inknbPreview: 1, type: "pageDocument", document: props.pageDocument, version: props.pageVersion, assets: props.pageAssets, bindings: props.info.manifest.page?.bindings }, "*");
  }, [props.pageDocument, props.pageVersion, props.pageAssets, props.info.artifactId]);
  useEffect(() => {
    locate();
  }, [props.location, locate]);
  useEffect(() => {
    const update = () =>
      frame.current?.contentWindow?.postMessage(
        { inknbPreview: 1, type: "scrollbars", scrollbars: scrollbarTheme() },
        "*",
      );
    const observer = new MutationObserver(update);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme", "style"],
    });
    update();
    return () => observer.disconnect();
  }, [props.info.artifactId]);
  useEffect(() => {
    frame.current?.contentWindow?.postMessage(
      {
        inknbPreview: 1,
        type: "asides",
        asides: previewAsideLocations(props.info, props.passages ?? []),
        activeAside: props.activeAside,
      },
      "*",
    );
  }, [props.passages, props.activeAside, props.info.artifactId]);
  useEffect(() => {
    frame.current?.contentWindow?.postMessage(
      {
        inknbPreview: 1,
        type: "suggestions",
        suggestions: locateSuggestions(props.info, props.suggestions ?? []),
        suggestionStyles,
        suggestionFocus: props.suggestionFocus,
      },
      "*",
    );
  }, [props.suggestions, props.suggestionFocus, props.info.artifactId]);
  useEffect(() => {
    frame.current?.contentWindow?.postMessage(
      { inknbPreview: 1, type: "regionMode", active: props.regionSelecting },
      "*",
    );
  }, [props.regionSelecting]);
  return (
    <iframe
      ref={frame}
      className="html-preview"
      aria-label={props.info.manifest.title}
      sandbox="allow-scripts"
    />
  );
}

function PdfArtifact(props: ArtifactProps) {
  const session = useAsideSession();
  const passageRanges = useRef<{ id: string; range: Range }[]>([]);
  const asideAtPoint = useCallback(
    (left: number, top: number) =>
      passageRanges.current.find(({ range }) =>
        [...range.getClientRects()].some(
          (bounds) =>
            left >= bounds.left &&
            left <= bounds.right &&
            top >= bounds.top &&
            top <= bounds.bottom,
        ),
      )?.id ?? null,
    [],
  );
  const container = useRef<HTMLDivElement>(null);
  const viewerElement = useRef<HTMLDivElement>(null);
  const viewer = useRef<PDFViewer | null>(null);
  const callbacks = useRef(props);
  callbacks.current = props;
  const region = useRef<{
    page: HTMLElement;
    left: number;
    top: number;
  } | null>(null);
  const [rectangle, setRectangle] = useState<PreviewBounds | null>(null);
  const lastSuggestion = useRef<string | null>(null);
  const drawSuggestions = useCallback(() => {
    const host = viewerElement.current;
    if (!host) return;
    for (const element of host.querySelectorAll("[data-inknb-suggestion]"))
      element.remove();
    const current = callbacks.current;
    let focused = false;
    for (const suggestion of locateSuggestions(
      current.info,
      current.suggestions ?? [],
    ).reverse()) {
      if (suggestion.target.kind !== "page") continue;
      const page = host.querySelector(
        `[data-page-number="${suggestion.target.page}"]`,
      );
      if (!page) continue;
      const card = document.createElement("section");
      card.className = "preview-suggestion";
      card.dataset.inknbSuggestion = suggestion.id;
      const label = document.createElement("span");
      label.className = "suggestion-label";
      label.textContent = `Suggested edit · page ${suggestion.target.page}`;
      const content = document.createElement("div");
      content.innerHTML = suggestion.html;
      for (const element of content.querySelectorAll("[id]"))
        element.removeAttribute("id");
      card.append(label, content);
      card.addEventListener("click", (event) => {
        if (!(event.target instanceof Element)) return;
        const link = event.target.closest<HTMLAnchorElement>(
          "a[data-inknb-reference]",
        );
        if (!link) return;
        event.preventDefault();
        current.onReference(link.getAttribute("href") ?? "");
      });
      page.after(card);
      if (current.suggestionFocus === suggestion.id) focused = true;
      if (
        current.suggestionFocus === suggestion.id &&
        lastSuggestion.current !== suggestion.id
      )
        card.scrollIntoView({ block: "center", behavior: "instant" });
    }
    if (!current.suggestionFocus || focused)
      lastSuggestion.current = current.suggestionFocus ?? null;
  }, []);
  const reportProgress = useCallback(() => {
    const element = container.current;
    if (!element) return;
    const current = callbacks.current;
    for (const marker of element.querySelectorAll(".pdf-aside-highlight"))
      marker.remove();
    passageRanges.current = [];
    const quietRanges: Range[] = [];
    const focusedRanges: Range[] = [];
    const emphasis =
      element.closest<HTMLElement>(".document-body")?.dataset.focusedAside ||
      current.activeAside;
    const positions = previewAsideLocations(
      current.info,
      current.passages ?? [],
    ).flatMap((aside) => {
      if (aside.target.kind !== "pdf") return [];
      const region = aside.target.regions[0];
      const page = element.querySelector<HTMLElement>(
        `[data-page-number="${region.page}"]`,
      );
      if (!page) return [];
      const bounds = page.getBoundingClientRect();
      const suggestion = aside.suggestionId
        ? element.querySelector<HTMLElement>(
            `[data-inknb-suggestion="${aside.suggestionId}"]`,
          )
        : null;
      const suggestedBounds = suggestion?.getBoundingClientRect();
      const regions = aside.target.regions.flatMap((region) => {
        const page = element.querySelector<HTMLElement>(
          `[data-page-number="${region.page}"]`,
        );
        if (!page) return [];
        const bounds = page.getBoundingClientRect();
        return [
          {
            top: bounds.top + region.rectangle.top * bounds.height,
            bottom:
              bounds.top +
              (region.rectangle.top + region.rectangle.height) * bounds.height,
          },
        ];
      });
      let passageBounds: DOMRect | null = null;
      if (aside.quote) {
        const nodes: { node: Node; offset: number }[] = [];
        let text = "";
        const walker = document.createTreeWalker(
          page.querySelector(".textLayer") ?? page,
          NodeFilter.SHOW_TEXT,
        );
        while (walker.nextNode()) {
          const node = walker.currentNode;
          for (
            let offset = 0;
            offset < (node.textContent?.length ?? 0);
            offset++
          ) {
            const character = node.textContent![offset];
            if (/\s/.test(character)) continue;
            nodes.push({ node, offset });
            text += character;
          }
        }
        const quote = aside.quote.replace(/\s/g, "");
        const start = text.indexOf(quote);
        if (start >= 0 && quote.length) {
          const range = document.createRange();
          range.setStart(nodes[start].node, nodes[start].offset);
          range.setEnd(
            nodes[start + quote.length - 1].node,
            nodes[start + quote.length - 1].offset + 1,
          );
          passageBounds = range.getBoundingClientRect();
          if (aside.expanded) quietRanges.push(range);
          passageRanges.current.push({ id: aside.id, range });
          if (aside.id === emphasis) focusedRanges.push(range);
        }
      }
      if (!aside.quote && aside.id === emphasis) {
        const marker = document.createElement("div");
        marker.className = "pdf-aside-highlight";
        marker.style.left = `${region.rectangle.left * 100}%`;
        marker.style.top = `${region.rectangle.top * 100}%`;
        marker.style.width = `${region.rectangle.width * 100}%`;
        marker.style.height = `${region.rectangle.height * 100}%`;
        page.append(marker);
      }
      return [
        {
          id: aside.id,
          top:
            suggestedBounds?.top ??
            passageBounds?.top ??
            Math.min(...regions.map((region) => region.top)),
          bottom:
            suggestedBounds?.bottom ??
            passageBounds?.bottom ??
            Math.max(...regions.map((region) => region.bottom)),
          right:
            suggestedBounds?.right ??
            bounds.left +
              (region.rectangle.left + region.rectangle.width) * bounds.width,
        },
      ];
    });
    if (
      !element.closest('[aria-hidden="true"]') &&
      globalThis.CSS?.highlights
    ) {
      CSS.highlights.set("inknb-pdf-asides", new Highlight(...quietRanges));
      CSS.highlights.set("inknb-pdf-focus", new Highlight(...focusedRanges));
    }
    if (!element.closest('[aria-hidden="true"]'))
      element.dispatchEvent(
        new CustomEvent("inknb-aside-geometry", {
          bubbles: true,
          detail: {
            positions: positions.map((position) => ({
              id: position.id,
              top:
                position.top -
                documentScroll(element).getBoundingClientRect().top +
                documentScroll(element).scrollTop,
              bottom:
                position.bottom -
                documentScroll(element).getBoundingClientRect().top +
                documentScroll(element).scrollTop,
            })),
          },
        }),
      );
    const viewport = documentScroll(element);
    const top =
      element.getBoundingClientRect().top -
      viewport.getBoundingClientRect().top +
      viewport.scrollTop;
    const distance = Math.max(0, element.offsetHeight - viewport.clientHeight);
    callbacks.current.onProgress(
      current.info,
      distance
        ? Math.max(0, Math.min(1, (viewport.scrollTop - top) / distance))
        : 1,
    );
  }, []);
  useEffect(reportProgress, [
    props.passages,
    props.activeAside,
    reportProgress,
  ]);
  const locate = useCallback(() => {
    const target = callbacks.current.location?.target;
    const controller = viewer.current;
    if (target?.kind !== "pdf" || !controller?.pagesPromise) return;
    const location = target.regions[0];
    void controller.pagesPromise.then(() => {
      if (viewer.current !== controller || !container.current) return;
      controller.currentPageNumber = location.page;
      const page = container.current.querySelector<HTMLElement>(
        `[data-page-number="${location.page}"]`,
      );
      if (page)
        documentScroll(container.current).scrollTo({
          top:
            documentScroll(container.current).scrollTop +
            page.getBoundingClientRect().top -
            documentScroll(container.current).getBoundingClientRect().top +
            location.rectangle.top * page.offsetHeight -
            40,
          behavior: "instant",
        });
    });
  }, []);
  useEffect(() => {
    const element = container.current!;
    let cancelled = false;
    let ready = false;
    let loaded: PDFDocumentProxy | null = null;
    let loading: PDFDocumentLoadingTask | null = null;
    const viewport = element.closest<HTMLDivElement>(".document-scroll")!;
    const events = new EventBus();
    const links = new PDFLinkService({ eventBus: events });
    links.externalLinkEnabled = false;
    const lifecycle = new AbortController();
    const options = {
      abortSignal: lifecycle.signal,
      container: viewport,
      viewer: viewerElement.current!,
      eventBus: events,
      linkService: links,
      textLayerMode: 1,
      annotationMode: 1,
      annotationEditorMode: -1,
    };
    const rendered = new PDFViewer(options);
    viewer.current = rendered;
    links.setViewer(rendered);
    const resizePages = () => {
      if (!rendered.pagesCount) return;
      const page = rendered.getPageView(0);
      const width = page.viewport.width / rendered.currentScale;
      const height = page.viewport.height / rendered.currentScale;
      rendered.currentScale =
        element.clientWidth > viewport.clientHeight
          ? Math.min(
              (element.clientWidth - 16) / width,
              (viewport.clientHeight - 32) / height,
            )
          : (element.clientWidth - 16) / width;
    };
    events.on("pagesinit", () => {
      resizePages();
      locate();
    });
    events.on("pagerendered", (event: { error?: unknown }) => {
      reportProgress();
      if (cancelled || ready) return;
      if (event.error) {
        callbacks.current.onError(props.info.artifactId, String(event.error));
        return;
      }
      ready = true;
      callbacks.current.onReady(props.info);
      reportProgress();
    });
    events.on("pagesloaded", drawSuggestions);
    events.on("pagesloaded", reportProgress);
    let width = 0;
    let height = 0;
    const resize = new ResizeObserver(() => {
      if (
        cancelled ||
        !loaded ||
        (width === element.clientWidth && height === viewport.clientHeight)
      )
        return;
      width = element.clientWidth;
      height = viewport.clientHeight;
      resizePages();
      rendered.update();
      reportProgress();
    });
    resize.observe(element);
    resize.observe(viewport);
    const progress = () => {
      callbacks.current.onClear();
      const top =
        element.getBoundingClientRect().top -
        viewport.getBoundingClientRect().top +
        viewport.scrollTop;
      const distance = Math.max(
        0,
        element.offsetHeight - viewport.clientHeight,
      );
      callbacks.current.onProgress(
        callbacks.current.info,
        distance
          ? Math.max(0, Math.min(1, (viewport.scrollTop - top) / distance))
          : 1,
      );
    };
    viewport.addEventListener("scroll", progress, { passive: true });
    const host = element.closest(".document-body");
    host?.addEventListener("inknb-aside-focus", reportProgress);
    events.on("textlayerrendered", reportProgress);
    void invoke<string>("preview_file", {
      artifactId: props.info.artifactId,
      name: props.info.manifest.entry,
    })
      .then(async (encoded) => {
        if (cancelled) return;
        loading = getDocument({
          data: Uint8Array.from(atob(encoded), (value) => value.charCodeAt(0)),
          enableXfa: false,
          standardFontDataUrl: new URL(
            "pdfjs/standard_fonts/",
            document.baseURI,
          ).href,
          cMapUrl: new URL("pdfjs/cmaps/", document.baseURI).href,
          cMapPacked: true,
          iccUrl: new URL("pdfjs/iccs/", document.baseURI).href,
          wasmUrl: new URL("pdfjs/wasm/", document.baseURI).href,
          verbosity: 0,
        });
        const pdfDocument = await loading.promise;
        if (cancelled) return;
        if (
          props.info.manifest.sourceMap.some(
            (mapping) =>
              mapping.target.kind === "page" &&
              mapping.target.page > pdfDocument.numPages,
          )
        )
          throw Error("A source mapping refers to a missing PDF page.");
        loaded = pdfDocument;
        links.setDocument(pdfDocument);
        rendered.setDocument(pdfDocument);
      })
      .catch((error) => {
        void loading?.destroy();
        if (!cancelled)
          callbacks.current.onError(props.info.artifactId, String(error));
      });
    return () => {
      cancelled = true;
      resize.disconnect();
      viewport.removeEventListener("scroll", progress);
      host?.removeEventListener("inknb-aside-focus", reportProgress);
      rendered.setDocument(null);
      lifecycle.abort();
      links.setDocument(null);
      if (viewer.current === rendered) viewer.current = null;
      void loading?.destroy();
    };
  }, [props.info.artifactId]);
  useEffect(() => {
    locate();
  }, [props.location, locate]);
  useEffect(drawSuggestions, [
    props.suggestions,
    props.suggestionFocus,
    drawSuggestions,
  ]);
  const reportSelection = (point?: { left: number; top: number }) => {
    const drawing = point ? region.current : null;
    region.current = null;
    setRectangle(null);
    const selection = getSelection();
    const regions: {
      page: number;
      rectangle: {
        left: number;
        top: number;
        width: number;
        height: number;
      };
    }[] = [];
    let bounds: PreviewBounds | null = null;
    let quote = "";
    if (drawing) {
      const page = drawing.page.getBoundingClientRect();
      const left = Math.max(page.left, Math.min(drawing.left, point!.left));
      const top = Math.max(page.top, Math.min(drawing.top, point!.top));
      const right = Math.min(page.right, Math.max(drawing.left, point!.left));
      const bottom = Math.min(page.bottom, Math.max(drawing.top, point!.top));
      if (right - left < 3 || bottom - top < 3) return;
      bounds = { left, top, right, bottom };
      regions.push({
        page: Number(drawing.page.dataset.pageNumber),
        rectangle: {
          left: (left - page.left) / page.width,
          top: (top - page.top) / page.height,
          width: (right - left) / page.width,
          height: (bottom - top) / page.height,
        },
      });
    } else if (selection && !selection.isCollapsed && selection.rangeCount) {
      const range = selection.getRangeAt(0);
      if (!container.current!.contains(range.commonAncestorContainer)) return;
      quote = selection.toString().slice(0, 100000);
      for (const pageElement of container.current!.querySelectorAll<HTMLElement>(
        "[data-page-number]",
      )) {
        const page = pageElement.getBoundingClientRect();
        const rectangles: DOMRect[] = [];
        const walker = document.createTreeWalker(
          pageElement,
          NodeFilter.SHOW_TEXT,
        );
        while (walker.nextNode()) {
          const node = walker.currentNode;
          if (!node.textContent || !range.intersectsNode(node)) continue;
          const fragment = document.createRange();
          fragment.setStart(
            node,
            node === range.startContainer ? range.startOffset : 0,
          );
          fragment.setEnd(
            node,
            node === range.endContainer
              ? range.endOffset
              : node.textContent.length,
          );
          rectangles.push(
            ...[...fragment.getClientRects()].filter(
              (rectangle) =>
                rectangle.width > 0 &&
                rectangle.height > 0 &&
                rectangle.top < page.bottom &&
                rectangle.bottom > page.top &&
                rectangle.left < page.right &&
                rectangle.right > page.left,
            ),
          );
        }
        if (!rectangles.length) continue;
        const left = Math.max(
          page.left,
          Math.min(...rectangles.map((rectangle) => rectangle.left)),
        );
        const top = Math.max(
          page.top,
          Math.min(...rectangles.map((rectangle) => rectangle.top)),
        );
        const right = Math.min(
          page.right,
          Math.max(...rectangles.map((rectangle) => rectangle.right)),
        );
        const bottom = Math.min(
          page.bottom,
          Math.max(...rectangles.map((rectangle) => rectangle.bottom)),
        );
        bounds = bounds
          ? {
              left: Math.min(bounds.left, left),
              top: Math.min(bounds.top, top),
              right: Math.max(bounds.right, right),
              bottom: Math.max(bounds.bottom, bottom),
            }
          : { left, top, right, bottom };
        regions.push({
          page: Number(pageElement.dataset.pageNumber),
          rectangle: {
            left: (left - page.left) / page.width,
            top: (top - page.top) / page.height,
            width: (right - left) / page.width,
            height: (bottom - top) / page.height,
          },
        });
      }
    }
    if (!bounds || !regions.length) return;
    const target = previewAnchorSchema.safeParse({
      artifactId: props.info.artifactId,
      sourceHash: props.info.sourceHash,
      quote,
      target: { kind: "pdf", regions },
    });
    if (target.success) props.onSelection(props.info, target.data, bounds);
  };
  return (
    <div
      ref={container}
      className="pdf-preview"
      tabIndex={0}
      aria-label="PDF pages"
      data-inknb-control="preview.pdf"
      data-inknb-scroll="true"
      onContextMenu={(event) => {
        event.preventDefault();
        reportSelection();
        props.onContextMenu(props.info, {
          left: event.clientX,
          top: event.clientY,
        });
      }}
      onKeyUp={(event) => {
        if (event.shiftKey || event.key === "Shift") reportSelection();
      }}
      onMouseDownCapture={(event) => {
        if (props.regionSelecting || region.current || event.altKey) {
          event.preventDefault();
          event.stopPropagation();
        }
      }}
      onPointerDownCapture={(event) => {
        if ((!event.altKey && !props.regionSelecting) || event.button !== 0)
          return;
        const page = (event.target as HTMLElement).closest<HTMLElement>(
          "[data-page-number]",
        );
        if (!page) return;
        event.preventDefault();
        event.stopPropagation();
        getSelection()?.removeAllRanges();
        event.currentTarget.setPointerCapture(event.pointerId);
        region.current = { page, left: event.clientX, top: event.clientY };
        props.onClear();
      }}
      onPointerLeave={(event) => {
        event.currentTarget.removeAttribute("data-aside-pointer");
        focusAside(event.currentTarget, null);
      }}
      onClick={(event) => {
        if (
          props.regionSelecting ||
          event.button !== 0 ||
          event.detail !== 1 ||
          event.shiftKey ||
          event.altKey ||
          event.metaKey ||
          event.ctrlKey ||
          !getSelection()?.isCollapsed ||
          (event.target as HTMLElement).closest(
            "a,button,input,textarea,summary",
          )
        )
          return;
        const identity = asideAtPoint(event.clientX, event.clientY);
        if (identity && identity !== "new" && !reviewSuggestion(identity, session)) session.toggleThread(identity);
      }}
      onPointerMove={(event) => {
        if (!region.current) {
          const identity =
            !props.regionSelecting &&
            event.buttons === 0 &&
            getSelection()?.isCollapsed
              ? asideAtPoint(event.clientX, event.clientY)
              : null;
          event.currentTarget.toggleAttribute(
            "data-aside-pointer",
            Boolean(identity && identity !== "new"),
          );
          focusAside(event.currentTarget, identity);
          return;
        }
        const viewport = documentScroll(event.currentTarget);
        const base = viewport.getBoundingClientRect();
        setRectangle({
          left:
            Math.min(region.current.left, event.clientX) -
            base.left +
            viewport.scrollLeft,
          top:
            Math.min(region.current.top, event.clientY) -
            base.top +
            viewport.scrollTop,
          right:
            Math.max(region.current.left, event.clientX) -
            base.left +
            viewport.scrollLeft,
          bottom:
            Math.max(region.current.top, event.clientY) -
            base.top +
            viewport.scrollTop,
        });
      }}
      onPointerCancel={() => {
        region.current = null;
        setRectangle(null);
      }}
      onPointerUp={(event) => {
        reportSelection({ left: event.clientX, top: event.clientY });
      }}
    >
      <div ref={viewerElement} className="pdfViewer" />
      {rectangle && (
        <div
          className="preview-region"
          style={{
            left: rectangle.left,
            top: rectangle.top,
            width: rectangle.right - rectangle.left,
            height: rectangle.bottom - rectangle.top,
          }}
        />
      )}
    </div>
  );
}

export default function PreviewArtifact({
  artifactId,
  active,
  information,
  ...props
}: Omit<ArtifactProps, "info"> & { artifactId: string; active: boolean; information?: PreviewInfo }) {
  const [info, setInfo] = useState<PreviewInfo | null>(information ?? null);
  const callbacks = useRef(props);
  callbacks.current = props;
  const timeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const finished = useRef(false);
  useEffect(() => {
    let cancelled = false;
    finished.current = false;
    if (information) {
      setInfo(information);
      return;
    }
    void invoke("preview_info", { artifactId })
      .then((value) => {
        if (!cancelled) setInfo(previewInfoSchema.parse(value));
      })
      .catch((error) => {
        if (!cancelled) callbacks.current.onError(artifactId, String(error));
      });
    return () => {
      cancelled = true;
    };
  }, [artifactId, information]);
  useEffect(() => {
    const watch = () => {
      if (timeout.current) clearTimeout(timeout.current);
      if (!active || document.visibilityState === "hidden" || finished.current)
        return;
      timeout.current = setTimeout(
        () =>
          callbacks.current.onError(
            artifactId,
            "The preview has not finished rendering.",
          ),
        15000,
      );
    };
    document.addEventListener("visibilitychange", watch);
    watch();
    return () => {
      document.removeEventListener("visibilitychange", watch);
      if (timeout.current) clearTimeout(timeout.current);
    };
  }, [artifactId, active]);
  if (!info) return null;
  const Renderer = info.manifest.kind === "html" ? HtmlArtifact : PdfArtifact;
  return (
    <Renderer
      {...props}
      info={info}
      onReady={(information) => {
        finished.current = true;
        if (timeout.current) clearTimeout(timeout.current);
        props.onReady(information);
      }}
      onError={(identity, error) => {
        finished.current = true;
        if (timeout.current) clearTimeout(timeout.current);
        props.onError(identity, error);
      }}
    />
  );
}
