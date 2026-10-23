import { Plugin, TextSelection, Selection, NodeSelection } from "prosemirror-state";
import type { Transaction } from "prosemirror-state";
import { EditorView, Decoration, DecorationSet } from "prosemirror-view";
import type { DecorationAttrs } from "prosemirror-view";
import { Fragment, Slice } from "prosemirror-model";
import type { Node as DocumentNode } from "prosemirror-model";
import { baseKeymap, toggleMark, setBlockType } from "prosemirror-commands";
import { keymap } from "prosemirror-keymap";
import { gapCursor } from "prosemirror-gapcursor";
import {
  splitListItem,
  liftListItem,
  sinkListItem,
} from "prosemirror-schema-list";
import {
  tableEditing,
  goToNextCell,
  addRowAfter,
  addColumnAfter,
  deleteRow,
  deleteColumn,
  TableView,
} from "prosemirror-tables";
import { NativeDocumentModel, selectionForRange } from "./native-model";
import type { NativeUpdate } from "./native-model";
import { MathfieldElement } from "mathlive";
import { nativeSchema } from "./native-schema";
import { captureDocument } from "./native-document";
import { documentPosition } from "./native-source";
import type { Anchor } from "./domain";
import { captureAnchor, mapAnchor } from "./domain";
import { annotationTransferType } from "./passage-reference";
import type { WindowDocument } from "./window-document";
import { NativeRegionPicker } from "./native-region";
import { documentScroll } from "./document-scroll";
import { asideVisible, asideExpanded } from "./aside-state";
import { SessionContext } from "./use-session";
import { focusAside } from "./aside-focus";
import { LinkGesture, linkMarkView } from "./link-gesture";
import { suggestionMarkers, openSuggestion } from "./suggestion-markers";
import { currentSuggestions, visibleSuggestions } from "./suggestions";
import { InlineSuggestion } from "./DocumentReview";
import TableSuggestion from "./TableSuggestion";
import { tableSuggestionGroups } from "./table-suggestions";
import { clipboardImages, importImages, copyImage } from "./images";
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { MessageSquarePlus } from "lucide-react";
import IconButton from "./IconButton";
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import "mathlive/fonts.css";
import "prosemirror-gapcursor/style/gapcursor.css";
import "./native-editor.css";

interface PasteTarget {
  anchor: Anchor;
  expectedText: string;
}

function suggestionWidget(position: number, identity: string, session: WindowDocument, table: boolean): Decoration {
  return Decoration.widget(position, () => {
    const element = window.document.createElement("div");
    element.className = table ? "native-table table-suggestion-host" : "inline-suggestion-host";
    element.dataset.suggestionHost = identity;
    element.contentEditable = "false";
    const root = createRoot(element);
    root.render(createElement(SessionContext, { value: session }, createElement(table ? TableSuggestion : InlineSuggestion, { identity })));
    element.addEventListener("inknb-inline-destroy", () => queueMicrotask(() => root.unmount()), { once: true });
    return element;
  }, {
    key: `${table ? "table" : "suggestion"}:${identity}`,
    side: -1,
    ignoreSelection: true,
    stopEvent: () => true,
    destroy: element => element.dispatchEvent(new Event("inknb-inline-destroy")),
  });
}

function passageDecorations(
  document: DocumentNode,
  from: number,
  to: number,
  attributes: DecorationAttrs,
): Decoration[] {
  const decorations: Decoration[] = [];
  let cursor = from;
  document.nodesBetween(from, to, (node, position) => {
    if (node.type.spec.tableRole !== "table") return;
    const start = Selection.findFrom(document.resolve(position + 1), 1, true);
    const end = Selection.findFrom(
      document.resolve(position + node.nodeSize - 1),
      -1,
      true,
    );
    if (!start || !end || from > start.from || to < end.to) return;
    if (cursor < position)
      decorations.push(Decoration.inline(cursor, position, attributes));
    decorations.push(
      Decoration.node(position, position + node.nodeSize, {
        ...attributes,
        class: `${attributes.class ?? ""} aside-object-anchor`,
      }),
    );
    cursor = position + node.nodeSize;
    return false;
  });
  if (cursor < to) decorations.push(Decoration.inline(cursor, to, attributes));
  return decorations;
}

export type { NativeUpdate } from "./native-model";

export class NativeEditor extends NativeDocumentModel {
  declare readonly session: WindowDocument;
  readonly editor: EditorView;
  readonly region: NativeRegionPicker;
  private regionHighlight: HTMLDivElement;
  private findDialog: HTMLDivElement;
  private findInput: HTMLInputElement;
  private findCount: HTMLSpanElement;
  private findRanges: { from: number; to: number }[] = [];
  private focusedAside: string | null = null;
  private destroyed = false;
  private pastes = new Set<PasteTarget>();
  pasteQueue = Promise.resolve();
  private links = new LinkGesture(
    () => this.session.getWorkingSnapshot().path,
    (reference) => this.session.openAside(reference),
    (error) => this.session.fail(error),
  );
  private keyboardFocus = false;
  private focusHost: HTMLElement | null;
  private geometryObserver: ResizeObserver;
  private onAsideFocus = (event: Event) => {
    this.focusedAside = (event as CustomEvent<{ id: string | null }>).detail.id;
    this.refresh();
  };
  private onObjectScroll = () => this.positionRegionHighlight();

  constructor(host: HTMLElement, session: WindowDocument) {
    super(session, []);
    const previous = session.model;
    if (previous) {
      this.state = previous.state;
      this.source = previous.source;
      this.projection = previous.projection;
      this.anchors = previous.anchors;
      this.modelPlugins = previous.modelPlugins;
    }
    session.model = this;
    const snapshot = session.getWorkingSnapshot();
    const document = this.state.doc;
    this.region = new NativeRegionPicker(this);
    const decorations = new Plugin({
      props: {
        decorations: (state) => {
          const current = session.getWorkingSnapshot();
          const ranges: Decoration[] = this.findRanges.map((range) =>
            Decoration.inline(range.from, range.to, {
              class: "native-search-match",
            }),
          );
          state.doc.descendants((node, position, parent) => {
            if (
              state.doc.attrs.format !== "text" &&
              node.isText &&
              !parent?.type.spec.code
            )
              for (const match of node.text!.matchAll(
                /[ \t]*(?:\r\n?|\n)[ \t]*/g,
              ))
                ranges.push(
                  Decoration.inline(
                    position + match.index,
                    position + match.index + match[0].length,
                    { class: "native-soft-wrap" },
                  ),
                );
            if (
              !node.isText &&
              node.type.name !== "table" &&
              node.attrs.identity
            )
              ranges.push(
                Decoration.node(position, position + node.nodeSize, {
                  "data-native-identity": String(node.attrs.identity),
                }),
              );
          });
          const draftAnchor = current.composerAnchor;
          if (
            current.composer &&
            current.asidesOpen &&
            !current.focus &&
            draftAnchor?.status === "attached" &&
            !draftAnchor.native?.region
          ) {
            const from = documentPosition(this.projection, draftAnchor.from);
            const to = documentPosition(this.projection, draftAnchor.to, -1);
            if (to > from)
              ranges.push(
                ...passageDecorations(state.doc, from, to, {
                  class: "annotated-passage passage-focused",
                }),
              );
          }
          const threads = current.metadata.threads
            .filter(
              (thread) =>
                !thread.resolved &&
                (asideVisible(current, thread) || current.activeThread === thread.id),
            )
            .sort(
              (first, second) =>
                Number(first.id === current.activeThread) -
                Number(second.id === current.activeThread),
            );
          for (const thread of threads) {
            const anchor = this.anchors[thread.id] ?? thread.anchor;
            if (
              !anchor ||
              anchor.status === "detached" ||
              anchor.native?.region
            )
              continue;
            const from = documentPosition(this.projection, anchor.from);
            const to = documentPosition(this.projection, anchor.to, -1);
            if (to <= from) continue;
            const focused =
              current.activeThread === thread.id ||
              this.focusedAside === thread.id;
            const expanded =
              current.asidesOpen &&
              !current.focus &&
              asideExpanded(current, thread);
            ranges.push(
              ...passageDecorations(state.doc, from, to, {
                class: [
                  asideVisible(current, thread) ? "aside-anchor" : "",
                  expanded || focused ? "annotated-passage" : "",
                  focused ? "passage-focused" : "",
                ].filter(Boolean).join(" "),
                "data-aside-thread": thread.id,
              }),
            );
          }
          if (!current.focus) for (const annotation of current.metadata.annotations) {
            if (annotation.status !== "open" || annotation.source.kind !== "document") continue;
            const anchor = annotation.source.liveAnchor ?? annotation.source.anchor;
            if (anchor.status !== "attached" || anchor.to > this.projection.text.length) continue;
            const from = documentPosition(this.projection, anchor.from);
            const to = documentPosition(this.projection, anchor.to, -1);
            if (to > from) ranges.push(...passageDecorations(state.doc, from, to, { class: "annotated-passage", "data-annotation-id": annotation.id }));
          }
          if (!current.focus) for (const decision of current.metadata.decisions) {
            const anchor = this.anchors[decision.id] ?? decision.anchor;
            if (!["open", "answered"].includes(decision.status) || !anchor || anchor.status === "detached") continue;
            const from = documentPosition(this.projection, anchor.from);
            const to = documentPosition(this.projection, anchor.to, -1);
            if (to > from) ranges.push(...passageDecorations(state.doc, from, to, { class: "aside-anchor", "data-decision-anchor": decision.id }));
          }
          const visible = visibleSuggestions(current);
          const tables = tableSuggestionGroups(this, currentSuggestions(current)).filter(table => table.proposals.some(proposal => visible.some(candidate => candidate.id === proposal.id)));
          const tableProposals = new Set(tables.flatMap(table => table.proposals.map(proposal => proposal.id)));
          for (const table of tables) {
            ranges.push(Decoration.node(table.position, table.position + table.node.nodeSize, { class: "suggestion-replaced" }));
            ranges.push(suggestionWidget(table.position + table.node.nodeSize, table.identity, session, true));
          }
          for (const proposal of visible) {
            if (tableProposals.has(proposal.id)) continue;
            const from = documentPosition(this.projection, proposal.from);
            const to = documentPosition(this.projection, proposal.to, -1);
            const end = state.doc.resolve(to);
            let position = end.pos;
            for (let depth = end.depth; depth > 0; depth -= 1) {
              if (
                end.node(depth).isTextblock ||
                end.node(depth).type.spec.tableRole === "table"
              )
                position = end.after(depth);
            }
            state.doc.nodesBetween(from, to, (node, start) => {
              if (!node.isBlock) return;
              if (from <= start + 1 && to >= start + node.nodeSize - 1) {
                ranges.push(
                  Decoration.node(start, start + node.nodeSize, {
                    class: "suggestion-replaced",
                  }),
                );
                return false;
              }
            });
            ranges.push(suggestionWidget(position, proposal.id, session, false));
          }
          ranges.push(
            ...suggestionMarkers(current, this.projection, state.doc),
          );
          if (this.keyboardFocus) {
            const selected = state.selection.$from;
            for (let depth = selected.depth; depth > 0; depth -= 1) {
              if (
                selected.node(depth).type.spec.tableRole !== "cell" &&
                selected.node(depth).type.spec.tableRole !== "header_cell"
              )
                continue;
              ranges.push(
                Decoration.node(selected.before(depth), selected.after(depth), {
                  class: "native-cell-focused",
                }),
              );
              break;
            }
          }
          return DecorationSet.create(state.doc, ranges);
        },
      },
    });
    MathfieldElement.soundsDirectory = null;
    MathfieldElement.fontsDirectory = null;
    this.editor = new EditorView(host, {
      state: this.state.reconfigure({
        plugins: [
          ...this.state.plugins,
          keymap({
            "Mod-f": () => {
              this.openFind();
              return true;
            },
            "Mod-z": () => {
              this.undo();
              return true;
            },
            "Mod-Shift-z": () => {
              this.redo();
              return true;
            },
            "Mod-b": toggleMark(nativeSchema.marks.strong),
            "Mod-i": toggleMark(nativeSchema.marks.em),
            "Mod-Shift-a": () => {
              session.startComment();
              return true;
            },
            "Mod-Alt-0": setBlockType(nativeSchema.nodes.paragraph),
            "Mod-Alt-1": setBlockType(nativeSchema.nodes.heading, { level: 1 }),
            "Mod-Alt-2": setBlockType(nativeSchema.nodes.heading, { level: 2 }),
            "Mod-Alt-3": setBlockType(nativeSchema.nodes.heading, { level: 3 }),
            Enter: splitListItem(nativeSchema.nodes.list_item),
            Tab: (state, dispatch) =>
              goToNextCell(1)(state, dispatch) ||
              sinkListItem(nativeSchema.nodes.list_item)(state, dispatch),
            "Shift-Tab": (state, dispatch) =>
              goToNextCell(-1)(state, dispatch) ||
              liftListItem(nativeSchema.nodes.list_item)(state, dispatch),
          }),
          keymap(baseKeymap),
          gapCursor(),
          tableEditing({ allowTableNodeSelection: true }),
          decorations,
        ],
      }),
      attributes: (state) => ({
        class: "native-content",
        "aria-label": "Document",
        spellcheck: "true",
        "data-inknb-control": "manuscript",
        "data-native-identity": String(document.attrs.identity),
        "data-inknb-scroll": "true",
        "data-selection-kind": state.selection instanceof TextSelection ? "text" : "object",
      }),
      dispatchTransaction: (transaction) => {
        try {
          this.commit(transaction);
        } catch (error) {
          session.fail(error);
        }
      },
      markViews: { link: linkMarkView },
      nodeViews: {
        table: (node, view, getPosition) => {
          const element = window.document.createElement("div");
          element.className = "native-table";
          const controls = element.appendChild(window.document.createElement("div"));
          controls.className = "native-table-actions";
          controls.contentEditable = "false";
          controls.setAttribute("role", "toolbar");
          controls.setAttribute("aria-label", "Table actions");
          const asideRoot = createRoot(controls);
          const aside = {
            icon: MessageSquarePlus,
            label: "Add aside to table",
            agentControl: `table.aside:${node.attrs.identity}`,
            onPress: () => {
              const position = getPosition();
              if (position === undefined) return;
              view.focus();
              view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, position)));
              session.startComment();
            },
          };
          asideRoot.render(createElement(IconButton, aside));
          controls.addEventListener("mousedown", (event) => event.preventDefault());
          const table = new TableView(node, 25);
          element.appendChild(table.dom);
          table.table.style.minWidth = "";
          table.table.dataset.nativeIdentity = String(node.attrs.identity);
          return {
            dom: element,
            contentDOM: table.contentDOM,
            selectNode: () => {
              element.classList.add("ProseMirror-selectednode");
            },
            deselectNode: () => {
              element.classList.remove("ProseMirror-selectednode");
            },
            stopEvent: (event) => event.target instanceof Node && controls.contains(event.target),
            update: (next) => {
              const updated = table.update(next);
              if (updated) {
                asideRoot.render(createElement(IconButton, {
                  ...aside,
                  agentControl: `table.aside:${next.attrs.identity}`,
                }));
                table.table.style.minWidth = "";
                table.table.dataset.nativeIdentity = String(
                  next.attrs.identity,
                );
              }
              return updated;
            },
            ignoreMutation: (record) =>
              controls.contains(record.target) ||
              (record.type === "attributes" && record.target === element) ||
              table.ignoreMutation(record),
            destroy: () => queueMicrotask(() => asideRoot.unmount()),
          };
        },
        math: (node, view, getPosition) =>
          this.equation(node, view, getPosition),
        math_block: (node, view, getPosition) =>
          this.equation(node, view, getPosition),
        image: (node) => {
          const image = window.document.createElement("img");
          image.alt = String(node.attrs.alt ?? "");
          image.dataset.nativeImage = String(node.attrs.identity);
          image.contentEditable = "false";
          image.draggable = false;
          const reference = String(node.attrs.src);
          this.loadImage(image, reference);
          return { dom: image };
        },
      },
      handleDOMEvents: {
        drop: (_view, event) => {
          if (!event.dataTransfer?.types.includes(annotationTransferType)) return false;
          event.preventDefault();
          return true;
        },
        pointerdown: (_view, event) => {
          this.links.pointerDown(event);
          this.keyboardFocus = false;
          this.dom.dataset.input = "pointer";
          if (event.button === 0 && !event.shiftKey && event.target instanceof HTMLImageElement && this.selectImage(event.target)) {
            event.preventDefault();
            return true;
          }
          this.refresh();
          return false;
        },
        keydown: () => {
          this.keyboardFocus = true;
          this.dom.dataset.input = "keyboard";
          this.refresh();
          return false;
        },
        copy: (view, event) => {
          const selection = view.state.selection;
          if (!(selection instanceof NodeSelection) || selection.node.type.name !== "image") return false;
          const image = view.nodeDOM(selection.from);
          if (!(image instanceof HTMLImageElement)) return false;
          event.preventDefault();
          void copyImage(image).catch((error) => session.fail(error));
          return true;
        },
        paste: (_view, event) => {
          const files = clipboardImages(event.clipboardData);
          if (!files.length) return false;
          event.preventDefault();
          const selection = this.selection;
          const target: PasteTarget = {
            anchor: captureAnchor(this.source.toString(), selection),
            expectedText: this.source.sliceString(selection.from, selection.to),
          };
          this.pastes.add(target);
          this.pasteQueue = this.pasteQueue
            .then(async () => {
              if (this.destroyed)
                throw Error(
                  "The writing surface changed before the image paste finished.",
                );
              const images = await importImages(files);
              if (
                this.destroyed ||
                target.anchor.status === "detached" ||
                this.source.sliceString(
                  target.anchor.from,
                  target.anchor.to,
                ) !== target.expectedText
              )
                throw Error(
                  "The selected passage changed while the image was loading. Paste again at the intended location.",
                );
              const state = this.editor.state;
              const selection = TextSelection.between(
                state.doc.resolve(
                  documentPosition(this.projection, target.anchor.from),
                ),
                state.doc.resolve(
                  documentPosition(this.projection, target.anchor.to, -1),
                ),
              );
              this.applyAtomic(
                state.tr
                  .setSelection(selection)
                  .replaceSelection(
                    new Slice(
                      Fragment.fromArray(
                        images.map((image) =>
                          nativeSchema.nodes.image.create({
                            src: image.path,
                            alt: image.name,
                          }),
                        ),
                      ),
                      0,
                      0,
                    ),
                  )
                  .scrollIntoView(),
              );
            })
            .catch((error) => session.fail(error))
            .finally(() => this.pastes.delete(target));
          return true;
        },
        pointermove: (_view, event) => {
          this.links.pointerMove(event);
          const identity =
            event.buttons === 0 && event.target instanceof Element
              ? (event.target.closest<HTMLElement>("[data-aside-thread]")
                  ?.dataset.asideThread ?? null)
              : null;
          if (identity !== this.focusedAside) {
            this.focusedAside = identity;
            focusAside(this.dom, identity);
            this.refresh();
          }
          return false;
        },
        pointerleave: () => {
          this.focusedAside = null;
          focusAside(this.dom, null);
          this.refresh();
          return false;
        },
        click: (view, event) => {
          if (!(event.target instanceof Element)) return false;
          if (this.links.click(event) || openSuggestion(event, session))
            return true;
          if (
            event.detail !== 1 ||
            event.shiftKey ||
            event.altKey ||
            !window.getSelection()?.isCollapsed
          )
            return false;
          const decisionId = event.target.closest<HTMLElement>("[data-decision-anchor]")?.dataset.decisionAnchor;
          if (decisionId && !event.metaKey && !event.ctrlKey) {
            session.update({ asidesOpen: true });
            requestAnimationFrame(() => window.document.querySelector<HTMLElement>(`[data-decision-id="${decisionId}"]`)?.scrollIntoView({ block: "nearest", behavior: "smooth" }));
            return true;
          }
          const identity = event.target.closest<HTMLElement>(
            "[data-aside-thread]",
          )?.dataset.asideThread;
          if (identity && !event.metaKey && !event.ctrlKey) {
            const position = view.posAtCoords({
              left: event.clientX,
              top: event.clientY,
            });
            if (position)
              view.dispatch(
                view.state.tr.setSelection(
                  Selection.near(view.state.doc.resolve(position.pos)),
                ),
              );
            session.toggleThread(identity);
            return true;
          }
          return false;
        },
      },
    });
    this.regionHighlight = window.document.createElement("div");
    this.regionHighlight.className = "native-region-highlight";
    this.regionHighlight.hidden = true;
    host.append(this.regionHighlight);
    this.findDialog = window.document.createElement("div");
    this.findDialog.className = "native-find";
    this.findDialog.hidden = true;
    this.findDialog.setAttribute("role", "search");
    this.findInput = window.document.createElement("input");
    this.findInput.type = "search";
    this.findInput.setAttribute("aria-label", "Find in document");
    this.findInput.placeholder = "Find";
    this.findCount = window.document.createElement("span");
    this.findCount.setAttribute("aria-live", "polite");
    this.findDialog.append(this.findInput, this.findCount);
    this.findInput.addEventListener("input", () => this.find(0));
    this.findInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        this.find(event.shiftKey ? -1 : 1);
      }
      if (event.key === "Escape") {
        event.preventDefault();
        this.closeFind();
      }
    });
    for (const action of [
      { text: "↑", label: "Previous match", run: () => this.find(-1) },
      { text: "↓", label: "Next match", run: () => this.find(1) },
      { text: "×", label: "Close find", run: () => this.closeFind() },
    ]) {
      const button = window.document.createElement("button");
      button.type = "button";
      button.textContent = action.text;
      button.setAttribute("aria-label", action.label);
      button.addEventListener("click", action.run);
      this.findDialog.append(button);
    }
    host.prepend(this.findDialog);
    this.geometryObserver = new ResizeObserver(() => this.requestMeasure());
    this.geometryObserver.observe(this.dom);
    this.geometryObserver.observe(host);
    this.dom.addEventListener("scroll", this.onObjectScroll, true);
    this.focusHost = this.dom.closest<HTMLElement>(".document-body");
    if (this.focusHost) this.geometryObserver.observe(this.focusHost);
    this.focusHost?.addEventListener("inknb-aside-focus", this.onAsideFocus);
    this.state = this.editor.state;
    session.view = this;
    session.update({
      metadata: {
        ...snapshot.metadata,
        version: 14,
        nativeDocument: captureDocument(document, snapshot.text),
      },
    });
  }

  get dom(): HTMLElement {
    return this.editor.dom;
  }
  loadImage(image: HTMLImageElement, reference: string): void {
    void invoke<Record<string, string>>("preview_assets", {
      documentPath: this.session.getWorkingSnapshot().path,
      references: [reference],
    })
      .then((assets) => {
        if (!this.destroyed && assets[reference]) image.src = assets[reference];
        else image.alt ||= "Figure";
      })
      .catch(() => {
        image.alt ||= "Figure could not be loaded";
      });
  }

  equation(
    node: DocumentNode,
    view: EditorView,
    getPosition: () => number | undefined,
  ) {
    const element = window.document.createElement(
      node.type.name === "math" ? "span" : "div",
    );
    element.contentEditable = "false";
    const field = new MathfieldElement();
    element.append(field);
    field.setAttribute("value", String(node.attrs.value));
    field.mathVirtualKeyboardPolicy = "manual";
    field.setAttribute(
      "aria-label",
      node.type.name === "math" ? "Equation" : "Display equation",
    );
    field.className =
      node.type.name === "math"
        ? "native-equation"
        : "native-equation native-equation-block";
    field.addEventListener("input", () => {
      const position = getPosition();
      if (position === undefined) return;
      const current = view.state.doc.nodeAt(position);
      if (current)
        view.dispatch(
          view.state.tr.setNodeMarkup(position, undefined, {
            ...current.attrs,
            value: field.value,
          }),
        );
    });
    field.addEventListener("keydown", (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") {
        event.preventDefault();
        if (event.shiftKey) this.redo();
        else this.undo();
      }
    });
    field.addEventListener("move-out", (event) => {
      const position = getPosition();
      if (position === undefined) return;
      event.preventDefault();
      const backward =
        event.detail.direction === "backward" ||
        event.detail.direction === "upward";
      const target = backward ? position : position + node.nodeSize;
      view.dispatch(
        view.state.tr.setSelection(
          Selection.near(view.state.doc.resolve(target), backward ? -1 : 1),
        ),
      );
      view.focus();
    });
    return {
      dom: element,
      stopEvent: () => true,
      ignoreMutation: () => true,
      update: (next: DocumentNode) => {
        if (next.type !== node.type) return false;
        if (field.value !== next.attrs.value)
          field.setValue(String(next.attrs.value), {
            silenceNotifications: true,
          });
        return true;
      },
    };
  }

  override undo(): void {
    void this.session.undoNative().catch((error) => this.session.fail(error));
  }
  override redo(): void {
    void this.session.redoNative().catch((error) => this.session.fail(error));
  }

  override commit(transaction: Transaction): NativeUpdate {
    if (this.destroyed) throw Error("This document view is closed.");
    if (transaction.docChanged) this.findRanges = [];
    const update = super.commit(transaction);
    const changes = update.changes;
    for (const target of this.pastes) {
      let overwritten = false;
      changes.iterChangedRanges((from, to) => {
        if (from < target.anchor.from && to > target.anchor.to)
          overwritten = true;
      });
      target.anchor = mapAnchor(this.projection.text, target.anchor, changes);
      if (overwritten && !target.expectedText)
        target.anchor.status = "detached";
    }
    this.editor.updateState(this.state);
    if (update.docChanged) this.requestMeasure();
    this.session.committed();
    return update;
  }

  selectImage(image: HTMLImageElement): boolean {
    if (this.destroyed || !this.dom.contains(image)) return false;
    const position = this.editor.posAtDOM(image, 0);
    if (this.editor.state.doc.nodeAt(position)?.type.name !== "image") return false;
    this.editor.focus();
    this.editor.dispatch(this.editor.state.tr.setSelection(NodeSelection.create(this.editor.state.doc, position)));
    return true;
  }

  imageActions(target: Element) {
    const image = target.closest("img");
    if (!image || !this.selectImage(image)) return;
    const selected = this.editor.state.selection;
    const node = this.editor.state.doc.nodeAt(selected.from)!;
    const identity = String(node.attrs.identity);
    const reference = String(node.attrs.src);
    const documentPath = this.session.getWorkingSnapshot().path;
    const data = image.src;
    const extension = data.match(/^data:image\/(png|jpeg|gif|webp|svg\+xml);/)?.[1]?.replace("svg+xml", "svg") ?? "png";
    const name = decodeURIComponent(reference.split("/").pop() || `Image.${extension}`);
    const select = () => {
      if (this.destroyed) throw Error("The image's document is no longer open.");
      const current = this.node(identity);
      this.editor.dispatch(this.editor.state.tr.setSelection(NodeSelection.create(this.editor.state.doc, current.position)));
    };
    return {
      actions: [
        { text: "Copy Image", action: () => copyImage(image) },
        { text: "Save Image As…", action: async () => {
          const path = await save({ defaultPath: name, filters: [{ name: "Image", extensions: [extension] }] });
          if (path) await invoke("image_export", { data, path });
        } },
        { text: "Open Image", action: () => invoke<void>("open_reference", { documentPath, reference }) },
        { text: "Delete Image", action: () => {
          select();
          this.editor.dispatch(this.editor.state.tr.deleteSelection().scrollIntoView());
          this.editor.focus();
        } },
      ],
      aside: () => { select(); this.session.startComment(); },
      region: () => { select(); this.region.start(); },
    };
  }

  tableActions(target: Element) {
    const table = target.closest("table");
    if (!table || !this.dom.contains(table)) return;
    const identity = table.dataset.nativeIdentity;
    if (!identity) return;
    const select = () => {
      const current = this.node(identity);
      this.editor.focus();
      this.editor.dispatch(this.editor.state.tr.setSelection(NodeSelection.create(this.editor.state.doc, current.position)));
    };
    return {
      actions: [
        { text: "Select table", action: select },
        { text: "Delete table", action: () => {
          select();
          this.editor.dispatch(this.editor.state.tr.deleteSelection().scrollIntoView());
        } },
      ],
      aside: () => { select(); this.session.startComment(); },
    };
  }

  contextActions(): { text: string; action: () => void }[] {
    const state = this.editor.state;
    const commands = [
      { text: "Bold", command: toggleMark(nativeSchema.marks.strong) },
      { text: "Italic", command: toggleMark(nativeSchema.marks.em) },
      {
        text: "Paragraph",
        command: setBlockType(nativeSchema.nodes.paragraph),
      },
      {
        text: "Heading",
        command: setBlockType(nativeSchema.nodes.heading, { level: 2 }),
      },
      { text: "Add row below", command: addRowAfter },
      { text: "Add column after", command: addColumnAfter },
      { text: "Delete row", command: deleteRow },
      { text: "Delete column", command: deleteColumn },
    ];
    const actions = commands
      .filter(({ command }) => command(state))
      .map(({ text, command }) => ({
        text,
        action: () => {
          command(this.editor.state, this.editor.dispatch);
          this.session.surface?.focus();
        },
      }));
    actions.push(
      {
        text: "Insert table",
        action: () => {
          const cell = nativeSchema.nodes.table_cell.createAndFill()!;
          const row = nativeSchema.nodes.table_row.create(null, [cell, cell]);
          this.editor.dispatch(
            this.editor.state.tr
              .replaceSelectionWith(
                nativeSchema.nodes.table.create(null, [row, row]),
              )
              .scrollIntoView(),
          );
          this.focus();
        },
      },
      {
        text: "Insert equation",
        action: () => {
          this.editor.dispatch(
            this.editor.state.tr
              .replaceSelectionWith(
                nativeSchema.nodes.math.create({ value: "" }),
              )
              .scrollIntoView(),
          );
          this.focus();
        },
      },
    );
    return actions;
  }

  openFind(): void {
    this.findDialog.hidden = false;
    const selection = this.editor.state.selection;
    if (!selection.empty)
      this.findInput.value = this.editor.state.doc.textBetween(
        selection.from,
        selection.to,
        " ",
      );
    this.findInput.focus();
    this.findInput.select();
    this.find(0);
  }

  closeFind(): void {
    this.findDialog.hidden = true;
    this.findRanges = [];
    this.refresh();
    this.focus();
  }

  find(direction: number): void {
    const query = this.findInput.value;
    this.findRanges = [];
    if (query)
      this.editor.state.doc.descendants((node, position) => {
        if (!node.isTextblock) return;
        const text = node.textBetween(0, node.content.size, "", "\ufffc");
        const expression = new RegExp(
          query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
          "giu",
        );
        for (const match of text.matchAll(expression))
          this.findRanges.push({
            from: position + 1 + match.index,
            to: position + 1 + match.index + match[0].length,
          });
        return false;
      });
    const current = this.editor.state.selection.from;
    let index = this.findRanges.findIndex((range) =>
      direction < 0 ? range.from >= current : range.from > current,
    );
    if (direction < 0) index = (index < 0 ? this.findRanges.length : index) - 1;
    if (index < 0 || index >= this.findRanges.length)
      index = direction < 0 ? this.findRanges.length - 1 : 0;
    const target = this.findRanges[index];
    if (target) {
      const transaction = this.editor.state.tr
        .setSelection(
          TextSelection.create(this.editor.state.doc, target.from, target.to),
        )
        .scrollIntoView();
      this.editor.dispatch(transaction);
    }
    this.findCount.textContent = this.findRanges.length
      ? `${index + 1} / ${this.findRanges.length}`
      : query
        ? "0"
        : "";
    this.refresh();
  }


  refresh(): void {
    if (!this.destroyed) {
      this.editor.updateState(this.editor.state);
      this.measureTables();
      this.positionRegionHighlight();
    }
  }
  override restoreAnchors(anchors: Record<string, Anchor>): void {
    super.restoreAnchors(anchors);
    this.refresh();
  }
  selectSource(from: number, to = from, scroll = false): void {
    const state = this.editor.state;
    const selection = Selection.near(
      state.doc.resolve(documentPosition(this.projection, from)),
    );
    const transaction = state.tr.setSelection(
      from === to
        ? selection
        : selectionForRange(
            state.doc,
            documentPosition(this.projection, from),
            documentPosition(this.projection, to, -1),
          ),
    );
    if (scroll) transaction.scrollIntoView();
    this.editor.dispatch(transaction);
  }
  scrollToSource(position: number, anchor?: Anchor): void {
    const bounds = anchor
      ? this.anchorBounds(anchor)
      : this.coordsAtPos(position);
    const viewport = documentScroll(this.dom);
    const rectangle = viewport.getBoundingClientRect();
    if (bounds.top < rectangle.top || bounds.bottom > rectangle.bottom)
      viewport.scrollBy({
        top: bounds.top - rectangle.top - viewport.clientHeight / 3,
        behavior: "instant",
      });
  }
  coordsAtPos(position: number): {
    left: number;
    right: number;
    top: number;
    bottom: number;
  } {
    const proposal = visibleSuggestions(this.session.getSnapshot()).find(
      (proposal) => position >= proposal.from && position <= proposal.to,
    );
    const preview =
      proposal &&
      this.dom.querySelector<HTMLElement>(
        `.table-suggestion-content[data-version="suggested"] .change-version:last-child [data-review-proposal="${proposal.id}"], .table-suggestion-content[data-version="current"] .change-version:first-child [data-review-proposal="${proposal.id}"], [data-suggestion-host="${proposal.id}"], [data-table-proposals~="${proposal.id}"]`,
      );
    if (preview) return preview.getBoundingClientRect();
    return this.editor.coordsAtPos(documentPosition(this.projection, position));
  }
  passageElement(anchor: Anchor): HTMLElement {
    const position = documentPosition(this.projection, anchor.from);
    const selection = selectionForRange(
      this.editor.state.doc,
      position,
      Math.max(position, documentPosition(this.projection, anchor.to, -1)),
    );
    if (selection instanceof NodeSelection) {
      const element = this.editor.nodeDOM(selection.from);
      if (element instanceof HTMLElement) return element;
    }
    const resolved = this.editor.state.doc.resolve(position);
    for (let depth = resolved.depth; depth > 0; depth -= 1) {
      const node = this.editor.nodeDOM(resolved.before(depth));
      if (node instanceof HTMLElement) return node;
    }
    return this.dom;
  }

  anchorBounds(anchor: Anchor): {
    left: number;
    right: number;
    top: number;
    bottom: number;
  } {
    const proposal = visibleSuggestions(this.session.getSnapshot()).find(
      (proposal) => anchor.from <= proposal.to && anchor.to >= proposal.from,
    );
    if (proposal) return this.coordsAtPos(proposal.from);

    const region = anchor.native?.region;
    const element = region
      ? this.dom.dataset.nativeIdentity === region.identity
        ? this.dom
        : this.dom.querySelector<HTMLElement>(
            `[data-native-identity="${region.identity}"]`,
          )
      : null;
    if (region && element) {
      const bounds = element.getBoundingClientRect();
      const left = bounds.left + region.rectangle.left * bounds.width;
      const top = bounds.top + region.rectangle.top * bounds.height;
      return {
        left,
        top,
        right: left + region.rectangle.width * bounds.width,
        bottom: top + region.rectangle.height * bounds.height,
      };
    }
    const start = this.coordsAtPos(anchor.from);
    const end = this.coordsAtPos(Math.max(anchor.from, anchor.to - 1));
    const first = this.editor.domAtPos(documentPosition(this.projection, anchor.from));
    const last = this.editor.domAtPos(documentPosition(this.projection, anchor.to, -1));
    const range = document.createRange();
    range.setStart(first.node, first.offset);
    range.setEnd(last.node, last.offset);
    return {
      left: start.left,
      top: start.top,
      right: Math.max(start.right, end.right, range.getBoundingClientRect().right),
      bottom: end.bottom,
    };
  }

  positionRegionHighlight(): void {
    if (!this.regionHighlight) return;
    const state = this.session.getWorkingSnapshot();
    const identity = this.focusedAside ?? state.activeThread;
    const thread = state.metadata.threads.find(
      (candidate) => candidate.id === identity,
    );
    const anchor =
      state.composer && (!identity || identity === "new")
        ? state.composerAnchor
        : identity
          ? this.anchors[identity]
          : null;
    this.regionHighlight.hidden =
      !state.asidesOpen ||
      state.focus ||
      Boolean(thread?.resolved) ||
      Boolean(
        thread &&
        !asideVisible(state, thread) &&
        state.activeThread !== thread.id,
      ) ||
      !anchor?.native?.region ||
      anchor.status === "detached";
    if (this.regionHighlight.hidden || !anchor) return;
    const bounds = this.anchorBounds(anchor);
    const parent =
      this.regionHighlight.offsetParent?.getBoundingClientRect() ??
      this.dom.getBoundingClientRect();
    Object.assign(this.regionHighlight.style, {
      left: `${bounds.left - parent.left}px`,
      top: `${bounds.top - parent.top}px`,
      width: `${bounds.right - bounds.left}px`,
      height: `${bounds.bottom - bounds.top}px`,
    });
  }

  requestMeasure(): void {
    this.measureTables();
    this.positionRegionHighlight();
    this.dom.dispatchEvent(new Event("inknb-source-layout", { bubbles: true }));
  }

  private measureTables(): void {
    const host = this.dom.parentElement;
    const workspace = host?.closest<HTMLElement>(".workspace");
    if (!this.focusHost || !host || !workspace) return;
    const tables = [...this.dom.querySelectorAll<HTMLTableElement>(
      ".native-table:not(:is(td, th, li, blockquote) .native-table) > .tableWrapper > table, .table-suggestion-content .tableWrapper > table",
    )].filter(table => table.getClientRects().length > 0);
    const tableWidth = Math.max(0, ...tables.map(table => table.getBoundingClientRect().width));
    const inset = workspace.getBoundingClientRect().width - host.getBoundingClientRect().width;
    const width = `${tables.length ? Math.ceil(tableWidth + inset) : 0}px`;
    if (this.focusHost.style.getPropertyValue("--table-column-width") !== width)
      this.focusHost.style.setProperty("--table-column-width", width);
  }
  focus(): void {
    this.editor.focus();
  }
  destroy(): void {
    if (this.session.model === this) {
      const model = new NativeDocumentModel(this.session, []);
      model.modelPlugins = this.modelPlugins;
      model.state = this.state.reconfigure({ plugins: this.modelPlugins });
      model.source = this.source;
      model.projection = this.projection;
      model.anchors = this.anchors;
      this.session.model = model;
    }

    this.destroyed = true;
    this.region.stop(false);
    this.geometryObserver.disconnect();
    this.dom.removeEventListener("scroll", this.onObjectScroll, true);
    this.regionHighlight.remove();
    this.focusHost?.removeEventListener("inknb-aside-focus", this.onAsideFocus);
    this.findDialog.remove();
    this.editor.destroy();
  }
}
