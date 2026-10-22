import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Button } from "react-aria-components";
import { GripVertical, MessageSquarePlus, Plus } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { z } from "zod";
import { useDocumentSession, useSession } from "./use-session";
import { nativeObject, nativeRange, nativeSchema } from "./native-schema";
import { documentPosition, sourcePosition } from "./native-source";
import { captureAnchor } from "./domain";
import { documentScroll } from "./document-scroll";
import { previewInfoSchema } from "./preview-model";
import type { PreviewInfo } from "./preview-model";
import type { PageNodeBounds } from "./document-page";
import type { WritingSurface } from "./document-surface";
import { showContextMenu } from "./context-menu";
import PreviewArtifact from "./PreviewArtifact";
import PageText from "./PageText";
import "./document-page.css";

export default function DocumentPage() {
  const session = useDocumentSession();
  const state = useSession();
  const root = useRef<HTMLDivElement>(null);
  const [information, setInformation] = useState<PreviewInfo | null>(null);
  const [geometry, setGeometry] = useState<PageNodeBounds[]>([]);
  const [assets, setAssets] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [focusIdentity, setFocusIdentity] = useState<string | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [destination, setDestination] = useState<string | null>(null);
  const drag = useRef<{ identity: string; left: number; top: number; moved: boolean } | null>(null);
  const suppressClick = useRef(false);
  const selected = useRef(false);
  const model = session.model;
  const document = model?.state.doc;
  const snapshot = useMemo(() => document ? { document: nativeObject(document), version: crypto.randomUUID() } : null, [document]);
  const nodes = new Map<string, { node: NonNullable<typeof document>; position: number }>();
  document?.descendants((node, position) => { if (node.attrs.identity) nodes.set(String(node.attrs.identity), { node, position }); });
  if (document) nodes.set(String(document.attrs.identity), { node: document, position: -1 });
  const entries = geometry.filter((bounds) => {
    const target = nodes.get(bounds.identity);
    return target && (bounds.role !== "text" || target.node.isTextblock) && (bounds.role !== "item" || target.node.isBlock);
  });
  const containers = entries.filter((bounds) => bounds.role === "container");
  const items = entries.filter((bounds) => bounds.role === "item");
  const images: string[] = [];
  document?.descendants((node) => { if (node.type.name === "image") images.push(String(node.attrs.src)); });
  const imageSignature = JSON.stringify(images);
  const latest = useRef({ entries, containers, items });
  latest.current = { entries, containers, items };
  useEffect(() => {
    const artifactId = state.metadata.page?.artifactId;
    if (!artifactId) return;
    let current = true;
    setError(null);
    void invoke("preview_info", { artifactId }).then((value) => {
      const page = previewInfoSchema.parse(value);
      if (page.manifest.documentId !== state.metadata.documentId || !page.manifest.page) throw Error("The page belongs to another document.");
      if (current) setInformation(page);
    }).catch((error) => { if (current) setError(String(error)); });
    return () => { current = false; };
  }, [state.metadata.documentId, state.metadata.page?.artifactId]);
  useEffect(() => {
    let current = true;
    void invoke<Record<string, string>>("preview_assets", { documentPath: state.path, references: images }).then((assets) => { if (current) setAssets(assets); }).catch((error) => { if (current) setError(String(error)); });
    return () => { current = false; };
  }, [state.path, imageSignature]);
  const receiveLayout = useCallback((nodes: PageNodeBounds[]) => {
    setGeometry((previous) => JSON.stringify(previous) === JSON.stringify(nodes) ? previous : nodes);
  }, []);
  useLayoutEffect(() => {
    const element = root.current;
    if (!element || !session.model) return;
    const surface: WritingSurface = {
      dom: element,
      coordsAtPos(position) {
        const model = session.model!;
        const resolved = model.state.doc.resolve(documentPosition(model.projection, position));
        for (let depth = resolved.depth; depth >= 0; depth -= 1) {
          const identity = String(resolved.node(depth).attrs.identity);
          const target = element.querySelector<HTMLElement>(`[data-page-identity="${identity}"]`);
          if (target) return target.getBoundingClientRect();
        }
        return element.getBoundingClientRect();
      },
      passageElement(anchor) {
        const resolved = session.model!.state.doc.resolve(documentPosition(session.model!.projection, anchor.from));
        for (let depth = resolved.depth; depth > 0; depth -= 1) {
          const identity = String(resolved.node(depth).attrs.identity);
          const target = element.querySelector<HTMLElement>(`[data-page-identity="${identity}"]`);
          if (target) return target;
        }
        return element;
      },
      anchorBounds(anchor) {
        const region = anchor.native?.region;
        if (!region) return this.coordsAtPos(anchor.from);
        const target = element.querySelector<HTMLElement>(`[data-page-identity="${region.identity}"]`);
        const bounds = target?.getBoundingClientRect() ?? this.coordsAtPos(anchor.from);
        const left = bounds.left + region.rectangle.left * (bounds.right - bounds.left);
        const top = bounds.top + region.rectangle.top * (bounds.bottom - bounds.top);
        return { left, top, right: left + region.rectangle.width * (bounds.right - bounds.left), bottom: top + region.rectangle.height * (bounds.bottom - bounds.top) };
      },
      scrollToSource(position, anchor) {
        const bounds = anchor ? this.anchorBounds(anchor) : this.coordsAtPos(position);
        const viewport = documentScroll(element);
        const visible = viewport.getBoundingClientRect();
        if (bounds.top < visible.top || bounds.bottom > visible.bottom)
          viewport.scrollBy({ top: bounds.top - visible.top - viewport.clientHeight / 3, behavior: "instant" });
      },
      requestMeasure() { element.dispatchEvent(new Event("inknb-source-layout", { bubbles: true })); },
      focus() {
        const model = session.model!;
        const resolved = model.state.doc.resolve(documentPosition(model.projection, session.getWorkingSnapshot().selection.from));
        let target: HTMLElement | null = null;
        for (let depth = resolved.depth; depth >= 0 && !target; depth -= 1)
          target = element.querySelector<HTMLElement>(`[data-page-identity="${resolved.node(depth).attrs.identity}"] .page-region-content`);
        (target ?? element).focus({ preventScroll: true });
      },
    };
    session.writingSurface = surface;
    surface.requestMeasure();
    return () => { if (session.writingSurface === surface) session.writingSurface = null; };
  }, [session, information?.artifactId]);
  useLayoutEffect(() => {
    session.surface?.requestMeasure();
    if (!focusIdentity) return;
    const target = root.current?.querySelector<HTMLElement>(`[data-page-identity="${focusIdentity}"] .page-region-content`);
    if (target) { target.focus({ preventScroll: true }); setFocusIdentity(null); }
  }, [geometry, focusIdentity, session]);
  const move = async (identity: string, container: string, beforeIdentity: string | null) => {
    try {
      await session.flush();
      await session.request({ kind: "move-node", documentId: state.metadata.documentId, revision: session.getWorkingSnapshot().metadata.revision, identity, parentIdentity: container, beforeIdentity });
      await session.refreshHost();
    } catch (error) { setError(String(error)); session.fail(error); }
  };
  const dropTarget = (left: number, top: number, identity: string) => {
    if (!root.current || !session.model) return null;
    const origin = root.current.getBoundingClientRect();
    const moving = session.model.node(identity);
    return latest.current.containers.filter((container) => {
      if (left < origin.left + container.left || left > origin.left + container.left + container.width || top < origin.top + container.top || top > origin.top + container.top + container.height) return false;
      const parent = session.model!.node(container.identity);
      return !(parent.position >= moving.position && parent.position < moving.position + moving.node.nodeSize) && parent.node.canReplaceWith(parent.node.childCount, parent.node.childCount, moving.node.type);
    }).sort((first, second) => first.width * first.height - second.width * second.height)[0] ?? null;
  };
  return <div ref={root} className={`document-page ${dragging ? "page-dragging" : ""} ${geometry.length ? "" : "page-loading"}`} tabIndex={-1} aria-busy={!geometry.length && !error} aria-label={information?.manifest.title ?? "Document page"}>
    {!geometry.length && !error && <p className="preview-placeholder">Opening page…</p>}
    {error && <p className="page-error" role="alert">{error}</p>}
    {information && snapshot && <PreviewArtifact
      artifactId={information.artifactId}
      information={information}
      active
      pageDocument={snapshot.document}
      pageVersion={snapshot.version}
      pageAssets={assets}
      onPageLayout={receiveLayout}
      regionSelecting={false}
      location={null}
      onReady={() => undefined}
      onError={(_identity, error) => setError(error)}
      onReference={(reference) => { void invoke("open_reference", { documentPath: state.path, reference }).catch((error) => session.fail(error)); }}
      onProgress={() => undefined}
      onSelection={() => { selected.current = true; }}
      onClear={() => { selected.current = false; }}
      onEscape={() => undefined}
      onContextMenu={(_information, point) => { void showContextMenu({ ...point, copy: selected.current }).catch((error) => session.fail(error)); }}
    />}
    {entries.map((bounds) => {
      const target = nodes.get(bounds.identity)!;
      if (target.node.isTextblock) return <PageText key={bounds.identity} bounds={bounds} assets={assets} />;
      return <div key={bounds.identity} data-page-identity={bounds.identity} className={`page-bound-region ${destination === bounds.identity ? "page-drop-target" : ""}`} style={{ left: bounds.left, top: bounds.top, width: bounds.width, height: bounds.height }} />;
    })}
    {containers.map((container) => <Button className="page-add-note text-button" key={container.identity} aria-label={`Add note to ${container.label || "container"}`} style={{ left: container.left, top: container.top + container.height + 6 }} onPress={() => {
      void session.flush().then(() => session.request({ kind: "insert-note", documentId: state.metadata.documentId, revision: session.getWorkingSnapshot().metadata.revision, parentIdentity: container.identity })).then((result) => {
        setFocusIdentity(z.object({ textIdentity: z.string().uuid() }).passthrough().parse(result).textIdentity);
        return session.refreshHost();
      }).catch((error) => { setError(String(error)); session.fail(error); });
    }}><Plus size={14} aria-hidden="true" />Add note</Button>)}
    {items.map((item) => <button key={item.identity} type="button" className="page-move-handle icon-button" aria-label={`Move ${nodes.get(item.identity)?.node.textContent.slice(0, 80) || "note"}`} style={{ left: item.left - 20, top: item.top }}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        suppressClick.current = false;
        drag.current = { identity: item.identity, left: event.clientX, top: event.clientY, moved: false };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        const moving = drag.current;
        if (!moving || !root.current) return;
        moving.moved ||= Math.hypot(event.clientX - moving.left, event.clientY - moving.top) > 4;
        if (!moving.moved) return;
        setDragging(moving.identity);
        const container = dropTarget(event.clientX, event.clientY, moving.identity);
        setDestination(container?.identity ?? null);
      }}
      onPointerUp={(event) => {
        const moving = drag.current;
        drag.current = null;
        setDragging(null);
        setDestination(null);
        if (!moving?.moved || !root.current) return;
        suppressClick.current = true;
        const origin = root.current.getBoundingClientRect();
        const container = dropTarget(event.clientX, event.clientY, moving.identity);
        if (!container) return;
        const parent = session.model!.node(container.identity);
        const children = new Set<string>();
        parent.node.forEach((child) => children.add(String(child.attrs.identity)));
        const before = latest.current.items.filter((item) => item.identity !== moving.identity && item.top + item.height / 2 > event.clientY - origin.top).sort((first, second) => first.top - second.top).find((item) => {
          return children.has(item.identity);
        });
        void move(moving.identity, container.identity, before?.identity ?? null);
      }}
      onPointerCancel={() => { drag.current = null; setDragging(null); setDestination(null); }}
      onLostPointerCapture={() => { drag.current = null; setDragging(null); setDestination(null); }}
      onClick={(event) => {
        if (suppressClick.current) { suppressClick.current = false; return; }
        const bounds = event.currentTarget.getBoundingClientRect();
        const target = session.model!.node(item.identity);
        const valid = latest.current.containers.filter((container) => {
          const parent = session.model!.node(container.identity);
          return !(parent.position >= target.position && parent.position < target.position + target.node.nodeSize) && parent.node.canReplaceWith(parent.node.childCount, parent.node.childCount, target.node.type);
        });
        void showContextMenu({ left: bounds.left, top: bounds.bottom, copy: false, actions: valid.map((container) => ({ text: `Move to ${container.label || "container"}`, action: () => move(item.identity, container.identity, null) })) }).catch((error) => session.fail(error));
      }}
    ><GripVertical size={14} aria-hidden="true" /></button>)}
    {entries.filter((bounds) => bounds.role === "text" || bounds.role === "item").map((bounds) => <Button className="page-aside-action icon-button" key={bounds.identity} aria-label="Add aside to this note" style={{ left: bounds.left + bounds.width + 3, top: bounds.top }} onPress={() => {
      const target = session.model!.node(bounds.identity);
      const range = nativeRange(target.node, target.position);
      const from = sourcePosition(session.model!.projection, range.from);
      const to = sourcePosition(session.model!.projection, range.to, -1);
      const anchor = session.model!.capture(captureAnchor(session.getWorkingSnapshot().text, { from, to }));
      session.update({ selection: { from: anchor.from, to: anchor.to } });
      session.startComment();
    }}><MessageSquarePlus size={14} aria-hidden="true" /></Button>)}
    {Object.entries(state.pageDrafts).filter(([identity]) => !entries.some((bounds) => bounds.identity === identity)).map(([identity, draft]) => <section key={identity} className="page-orphan-draft">
      <p>This note is no longer shown. Your draft is saved.</p>
      <pre>{nativeSchema.nodeFromJSON(draft.content).textContent}</pre>
    </section>)}
  </div>;
}
