import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { EditorState, Plugin, TextSelection } from "prosemirror-state";
import { EditorView, DecorationSet } from "prosemirror-view";
import { Fragment, Slice } from "prosemirror-model";
import { StepMap } from "prosemirror-transform";
import { baseKeymap, toggleMark } from "prosemirror-commands";
import { keymap } from "prosemirror-keymap";
import { Button } from "react-aria-components";
import { useDocumentSession, useSession } from "./use-session";
import { nativeObject, nativeSchema } from "./native-schema";
import { pageDraftSchema } from "./document-page";
import type { PageNodeBounds } from "./document-page";
import { LinkGesture, linkMarkView } from "./link-gesture";
import { suggestionMarkers, openSuggestion } from "./suggestion-markers";

export default function PageText({ bounds, assets }: { bounds: PageNodeBounds; assets: Record<string, string> }) {
  const session = useDocumentSession();
  const state = useSession();
  const host = useRef<HTMLDivElement>(null);
  const editor = useRef<EditorView | null>(null);
  const currentAssets = useRef(assets);
  currentAssets.current = assets;
  const [error, setError] = useState<string | null>(null);
  const identity = bounds.identity;
  useLayoutEffect(() => {
    if (!host.current || !session.model) return;
    const model = session.model;
    const target = model.node(identity);
    const saved = session.getWorkingSnapshot().pageDrafts[identity];
    const initial = saved
      ? nativeSchema.nodeFromJSON(saved.content)
      : nativeSchema.nodes.doc.create(null, target.node);
    initial.check();
    const links = new LinkGesture(() => session.getWorkingSnapshot().path, (reference) => session.openAside(reference), (error) => session.fail(error));
    let receiving = false;
    const view = new EditorView(host.current, {
      state: EditorState.create({
        schema: nativeSchema,
        doc: initial,
        plugins: [keymap({
          ...baseKeymap,
          "Mod-z": () => { void session.undoNative().catch((error) => session.fail(error)); return true; },
          "Mod-Shift-z": () => { void session.redoNative().catch((error) => session.fail(error)); return true; },
          "Mod-b": toggleMark(nativeSchema.marks.strong),
          "Mod-i": toggleMark(nativeSchema.marks.em),
          "Mod-Shift-a": () => { session.startComment(); return true; },
          Enter: (state, dispatch) => {
            const transaction = state.selection.$from.parent.type.spec.code
              ? state.tr.insertText("\n")
              : state.tr.replaceSelectionWith(nativeSchema.nodes.hard_break.create());
            dispatch?.(transaction);
            return true;
          },
        }), new Plugin({ props: { decorations: (local) => DecorationSet.create(local.doc, suggestionMarkers(session.getWorkingSnapshot(), model.projection, local.doc, model.node(identity).position)) } })],
      }),
      attributes: { class: "page-region-content", "aria-label": target.node.textContent ? `Edit ${target.node.textContent.slice(0, 80)}` : "New note", spellcheck: "true" },
      markViews: { link: linkMarkView },
      nodeViews: {
        image: (node) => {
          const image = document.createElement("img");
          image.dataset.pageImage = String(node.attrs.src);
          image.alt = String(node.attrs.alt ?? "");
          if (currentAssets.current[String(node.attrs.src)]) image.src = currentAssets.current[String(node.attrs.src)];
          return { dom: image };
        },
      },
      handleDOMEvents: {
        pointerdown: (_view, event) => { links.pointerDown(event); return false; },
        pointermove: (_view, event) => { links.pointerMove(event); return false; },
        click: (_view, event) => links.click(event) || openSuggestion(event, session),
      },
      handlePaste: (view, event) => {
        const text = event.clipboardData?.getData("text/plain");
        if (text === undefined) return false;
        event.preventDefault();
        if (view.state.selection.$from.parent.type.spec.code) {
          view.dispatch(view.state.tr.insertText(text));
          return true;
        }
        const content = text.split("\n").flatMap((line, index) => [
          ...(index ? [nativeSchema.nodes.hard_break.create()] : []),
          ...(line ? [nativeSchema.text(line)] : []),
        ]);
        view.dispatch(view.state.tr.replaceSelection(new Slice(Fragment.fromArray(content), 0, 0)));
        return true;
      },
      dispatchTransaction: (transaction) => {
        if (receiving) return;
        const next = view.state.apply(transaction);
        const pending = session.getWorkingSnapshot().pageDrafts[identity];
        const expected = pending?.expectedContent ?? nativeObject(view.state.doc.firstChild!);
        try {
          const current = model.node(identity);
          if (JSON.stringify(nativeObject(current.node)) !== JSON.stringify(expected))
            throw Error("This note changed elsewhere. Your draft is saved.");
          const full = pending
            ? model.objectTransaction(identity, nativeObject(next.doc.firstChild!))
            : model.state.tr;
          if (!pending)
            for (const step of transaction.steps) {
              const mapped = step.map(StepMap.offset(current.position));
              if (!mapped) throw Error("The note changed before this edit.");
              full.step(mapped);
            }
          full.setSelection(transaction.selection.map(full.doc, StepMap.offset(current.position)));
          model.commit(full);
          const drafts = { ...session.getWorkingSnapshot().pageDrafts };
          delete drafts[identity];
          if (pending) session.update({ pageDrafts: drafts });
          setError(null);
          synchronize();
        } catch (error) {
          view.updateState(next);
          session.update({ pageDrafts: { ...session.getWorkingSnapshot().pageDrafts, [identity]: pageDraftSchema.parse({ content: next.doc.toJSON(), expectedContent: expected }) } });
          setError(String(error));
          session.fail(error);
        }
      },
    });
    editor.current = view;
    const synchronize = () => {
      if (session.getWorkingSnapshot().pageDrafts[identity]) return;
      let present = false;
      model.state.doc.descendants((node) => { if (node.attrs.identity === identity) present = true; });
      if (!present) return;
      const current = model.node(identity);
      const document = nativeSchema.nodes.doc.create(null, current.node);
      const source = model.state.selection;
      const selection = TextSelection.between(
        document.resolve(Math.max(1, Math.min(current.node.nodeSize - 1, source.from - current.position))),
        document.resolve(Math.max(1, Math.min(current.node.nodeSize - 1, source.to - current.position))),
      );
      if (view.state.doc.eq(document) && view.state.selection.eq(selection)) {
        view.updateState(view.state);
        return;
      }
      receiving = true;
      view.updateState(EditorState.create({ schema: nativeSchema, doc: document, selection, plugins: view.state.plugins }));
      receiving = false;
    };
    const unsubscribe = session.subscribe(synchronize);
    return () => { unsubscribe(); editor.current = null; view.destroy(); };
  }, [identity, session, state.epoch]);
  useEffect(() => {
    for (const image of host.current?.querySelectorAll<HTMLImageElement>("img") ?? []) {
      const source = image.dataset.pageImage ?? image.getAttribute("src") ?? "";
      image.dataset.pageImage = source;
      if (assets[source]) image.src = assets[source];
    }
  }, [assets, state.text]);
  return <div className="page-text" data-page-identity={identity} style={{ left: bounds.left, top: bounds.top, width: bounds.width, minHeight: bounds.height, fontFamily: bounds.fontFamily, fontSize: bounds.fontSize, fontWeight: bounds.fontWeight, lineHeight: `${bounds.lineHeight}px` }}>
    <div ref={host} />
    {(error || state.pageDrafts[identity]) && <div className="page-draft-controls">
      <p>{error ?? "Your draft is saved."}</p>
      <Button className="text-button" onPress={() => {
        const drafts = { ...session.getWorkingSnapshot().pageDrafts };
        delete drafts[identity];
        session.update({ pageDrafts: drafts });
        setError(null);
      }}>Use current text</Button>
    </div>}
  </div>;
}
