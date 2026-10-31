import { EditorState, EditorSelection, Transaction } from "@codemirror/state";
import { EditorView, keymap, lineNumbers, highlightActiveLine } from "@codemirror/view";
import { search, searchKeymap, openSearchPanel } from "@codemirror/search";
import { defaultKeymap, indentWithTab } from "@codemirror/commands";
import type { Anchor } from "./domain";
import type { WritingSurface } from "./document-surface";
import type { WindowDocument } from "./window-document";
import "./source-editor.css";

export class SourceEditor implements WritingSurface {
  readonly editor: EditorView;
  private unsubscribe: () => void;
  private destroyed = false;

  constructor(host: HTMLElement, readonly session: WindowDocument) {
    const snapshot = session.getWorkingSnapshot();
    this.editor = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: snapshot.text,
        selection: EditorSelection.range(snapshot.selection.from, snapshot.selection.to),
        extensions: [
          EditorState.lineSeparator.of("\n"),
          lineNumbers(),
          highlightActiveLine(),
          search(),
          EditorView.lineWrapping,
          keymap.of([
            { key: "Mod-z", run: () => this.command("undo") },
            { key: "Mod-Shift-z", run: () => this.command("redo") },
            ...searchKeymap,
            ...defaultKeymap,
            indentWithTab,
          ]),
          EditorView.contentAttributes.of({
            "aria-label": "Document source",
            "data-inknb-control": "manuscript-source",
            "data-shortcut-scope": "editor",
            spellcheck: "false",
          }),
        ],
      }),
      dispatchTransactions: transactions => {
        try {
          for (const transaction of transactions) {
            if (transaction.docChanged) {
              session.requireEditMode();
              const model = session.model;
              if (!model) throw Error("The document source is not ready.");
              if (model.source.toString() !== transaction.startState.doc.toString())
                throw Error("The document changed before this source edit could be applied.");
              const edits: { from: number; to: number; insert: string }[] = [];
              transaction.changes.iterChanges((from, to, _newFrom, _newTo, inserted) => {
                edits.push({ from, to, insert: inserted.toString() });
              });
              model.commit(model.sourceTransaction(edits));
            }
            this.editor.update([transaction]);
          }
          this.publishSelection();
        } catch (error) {
          session.fail(error);
        }
      },
    });
    this.unsubscribe = session.subscribe(() => queueMicrotask(() => this.refresh()));
  }

  get dom(): HTMLElement {
    return this.editor.dom;
  }

  get selection(): { from: number; to: number } {
    const { from, to } = this.editor.state.selection.main;
    return { from, to };
  }

  private command(command: string): boolean {
    void this.session.command(command).catch(error => this.session.fail(error));
    return true;
  }

  private publishSelection(): void {
    if (this.session.getWorkingSnapshot().editorMode !== "edit") return;
    const current = this.session.getWorkingSnapshot().selection;
    const next = this.selection;
    if (current.from !== next.from || current.to !== next.to)
      this.session.update({ selection: next });
  }

  refresh(): void {
    if (this.destroyed) return;
    const text = this.session.getWorkingSnapshot().text;
    const previous = this.editor.state.doc.toString();
    if (text !== previous) {
      let from = 0;
      while (from < Math.min(previous.length, text.length) && previous[from] === text[from]) from++;
      let beforeTo = previous.length;
      let afterTo = text.length;
      while (beforeTo > from && afterTo > from && previous[beforeTo - 1] === text[afterTo - 1]) {
        beforeTo--;
        afterTo--;
      }
      this.editor.update([this.editor.state.update({
        changes: { from, to: beforeTo, insert: text.slice(from, afterTo) },
        annotations: Transaction.addToHistory.of(false),
      })]);
    }
    this.publishSelection();
  }

  selectSource(from: number, to = from, scroll = false): void {
    this.editor.dispatch({ selection: { anchor: from, head: to }, scrollIntoView: scroll });
  }

  coordsAtPos(position: number): { left: number; top: number; right: number; bottom: number } {
    const bounded = Math.max(0, Math.min(position, this.editor.state.doc.length));
    const coordinates = this.editor.coordsAtPos(bounded);
    if (coordinates) return coordinates;
    const line = this.editor.lineBlockAt(bounded);
    const bounds = this.editor.contentDOM.getBoundingClientRect();
    return { left: bounds.left, right: bounds.right, top: this.editor.documentTop + line.top, bottom: this.editor.documentTop + line.bottom };
  }

  anchorBounds(anchor: Anchor): { left: number; top: number; right: number; bottom: number } {
    const start = this.coordsAtPos(anchor.from);
    const end = this.coordsAtPos(anchor.to);
    return { left: Math.min(start.left, end.left), right: Math.max(start.right, end.right), top: start.top, bottom: end.bottom };
  }

  passageElement(anchor: Anchor): HTMLElement {
    const bounded = Math.max(0, Math.min(anchor.from, this.editor.state.doc.length));
    const node = this.editor.domAtPos(bounded).node;
    const element = node instanceof HTMLElement ? node : node.parentElement;
    return element?.closest<HTMLElement>(".cm-line") ?? this.editor.contentDOM;
  }

  openFind(): void {
    openSearchPanel(this.editor);
  }

  scrollToSource(position: number): void {
    this.editor.dispatch({ effects: EditorView.scrollIntoView(position, { y: "center" }) });
  }

  requestMeasure(): void {
    this.editor.requestMeasure();
  }

  focus(): void {
    this.refresh();
    this.editor.focus();
    this.publishSelection();
  }

  destroy(): void {
    this.destroyed = true;
    this.unsubscribe();
    this.editor.destroy();
  }
}
