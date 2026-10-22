import { useLayoutEffect, useRef } from "react";
import type { ClipboardEvent, RefObject } from "react";
import { Schema, Fragment } from "prosemirror-model";
import type { Node as DocumentNode } from "prosemirror-model";
import { EditorState } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { history, undo, redo, closeHistory } from "prosemirror-history";
import { keymap } from "prosemirror-keymap";
import {
  annotationTransferSchema,
  annotationTransferType,
  passageReferenceSchema,
} from "./passage-reference";
import type { PassageReference, MessageAnnotation } from "./passage-reference";

const schema = new Schema({
  nodes: {
    doc: { content: "paragraph", attrs: { annotations: { default: [] } } },
    paragraph: {
      content: "inline*",
      toDOM: () => ["p", 0],
      parseDOM: [{ tag: "p" }],
    },
    text: { group: "inline" },
    hard_break: {
      inline: true,
      group: "inline",
      selectable: false,
      toDOM: () => ["br"],
      parseDOM: [{ tag: "br" }],
    },
  },
  marks: {
    reference: {
      attrs: { value: {} },
      inclusive: false,
      toDOM: (mark) => [
        "span",
        {
          class: "passage-citation",
          "data-passage-reference": JSON.stringify(mark.attrs.value),
        },
        0,
      ],
      parseDOM: [
        {
          tag: "span[data-passage-reference]",
          getAttrs: (element) => {
            try {
              const reference = passageReferenceSchema.parse({
                ...JSON.parse(element.getAttribute("data-passage-reference")!),
                from: 0,
                to: 1,
              });
              return { value: { id: reference.id, source: reference.source } };
            } catch {
              return false;
            }
          },
        },
      ],
    },
  },
});

function documentFor(
  content: string,
  references: PassageReference[],
  annotations: MessageAnnotation[],
): DocumentNode {
  const nodes: DocumentNode[] = [];
  const boundaries = [
    ...new Set([
      0,
      content.length,
      ...references.flatMap((reference) => [reference.from, reference.to]),
    ]),
  ].sort((first, second) => first - second);
  for (let index = 0; index < boundaries.length - 1; index++) {
    const from = boundaries[index];
    const to = boundaries[index + 1];
    const reference = references.find(
      (reference) => reference.from <= from && reference.to >= to,
    );
    const marks = reference
      ? [
          schema.marks.reference.create({
            value: { id: reference.id, source: reference.source },
          }),
        ]
      : [];
    for (const [lineIndex, line] of content
      .slice(from, to)
      .split("\n")
      .entries()) {
      if (lineIndex)
        nodes.push(schema.nodes.hard_break.create(null, null, marks));
      if (line) nodes.push(schema.text(line, marks));
    }
  }
  return schema.nodes.doc.create(
    { annotations },
    schema.nodes.paragraph.create(null, nodes),
  );
}

export default function ReferenceEditor({
  content,
  references = [],
  annotations = [],
  label,
  placeholder,
  control,
  elementRef,
  onChange,
  onSend,
  onClose,
  onPaste,
}: {
  content: string;
  references?: PassageReference[];
  annotations?: MessageAnnotation[];
  label: string;
  placeholder: string;
  control: string;
  elementRef: RefObject<HTMLElement | null>;
  onChange: (
    content: string,
    references: PassageReference[],
    annotations: MessageAnnotation[],
  ) => void;
  onSend: () => void;
  onClose: () => void;
  onPaste: (event: ClipboardEvent<HTMLDivElement>) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const editor = useRef<EditorView | null>(null);
  const current = useRef({ onChange, onSend, onClose });
  current.current = { onChange, onSend, onClose };
  useLayoutEffect(() => {
    if (!host.current) return;
    const insertAnnotation = (value: unknown) => {
      const annotation = annotationTransferSchema.parse(value);
      if (annotation.annotationId && view.state.doc.attrs.annotations.some((current: MessageAnnotation) => current.annotationId === annotation.annotationId)) { view.focus(); return; }
      view.dispatch(
        closeHistory(view.state.tr).setDocAttribute("annotations", [
          ...view.state.doc.attrs.annotations,
          { ...annotation, id: crypto.randomUUID() },
        ]),
      );
      view.focus();
    };
    const view = new EditorView(host.current, {
      state: EditorState.create({
        doc: documentFor(content, references, annotations),
        plugins: [
          history(),
          keymap({ "Mod-z": undo, "Mod-Shift-z": redo, "Mod-y": redo }),
        ],
      }),
      attributes: {
        class: "reference-editor",
        role: "textbox",
        "aria-label": label,
        "aria-multiline": "true",
        "data-placeholder": placeholder,
        "data-inknb-control": control,
      },
      dispatchTransaction: (transaction) => {
        view.updateState(view.state.apply(transaction));
        if (!transaction.docChanged) return;
        let text = "";
        const nextReferences: PassageReference[] = [];
        view.state.doc.firstChild!.forEach((node) => {
          const from = text.length;
          text += node.isText ? node.text! : "\n";
          const mark = node.marks.find(
            (mark) => mark.type === schema.marks.reference,
          );
          if (!mark) return;
          const previous = nextReferences.at(-1);
          const reference: PassageReference = mark.attrs.value;
          if (previous?.id === reference.id && previous.to === from)
            previous.to = text.length;
          else nextReferences.push({ ...reference, from, to: text.length });
        });
        current.current.onChange(
          text,
          nextReferences,
          view.state.doc.attrs.annotations,
        );
      },
      handleKeyDown: (view, event) => {
        if (event.isComposing || event.keyCode === 229) return false;
        if (event.key === "Escape") {
          event.preventDefault();
          current.current.onClose();
          return true;
        }
        if (event.key !== "Enter") return false;
        event.preventDefault();
        if (event.shiftKey || event.metaKey || event.ctrlKey || event.altKey)
          view.dispatch(
            view.state.tr
              .replaceSelectionWith(schema.nodes.hard_break.create())
              .scrollIntoView(),
          );
        else if (!event.repeat) current.current.onSend();
        return true;
      },
      handleDrop: (_view, event) => {
        const encoded = event.dataTransfer?.getData(annotationTransferType);
        if (!encoded) return false;
        event.preventDefault();
        try {
          insertAnnotation(JSON.parse(encoded));
        } catch {
          return true;
        }
        return true;
      },
      handleDOMEvents: {
        dragover: (view, event) => {
          if (!event.dataTransfer?.types.includes(annotationTransferType))
            return false;
          event.preventDefault();
          event.dataTransfer.dropEffect = "copy";
          view.dom
            .closest(".composer")
            ?.setAttribute("data-annotation-drop", "true");
          return true;
        },
        dragleave: (view) => {
          view.dom
            .closest(".composer")
            ?.removeAttribute("data-annotation-drop");
          return false;
        },
        drop: (view) => {
          view.dom
            .closest(".composer")
            ?.removeAttribute("data-annotation-drop");
          return false;
        },
      },
      clipboardTextSerializer: (slice) =>
        slice.content.textBetween(0, slice.content.size, "\n", "\n"),
    });
    editor.current = view;
    elementRef.current = view.dom;
    const insert = (event: Event) =>
      insertAnnotation((event as CustomEvent<unknown>).detail);
    const remove = (event: Event) => {
      const identity = (event as CustomEvent<string>).detail;
      view.dispatch(
        closeHistory(view.state.tr).setDocAttribute(
          "annotations",
          view.state.doc.attrs.annotations.filter(
            (annotation: MessageAnnotation) => annotation.id !== identity,
          ),
        ),
      );
    };
    const edit = (event: Event) => {
      const command = (event as CustomEvent<string>).detail;
      if (command === "undo") undo(view.state, view.dispatch, view);
      if (command === "redo") redo(view.state, view.dispatch, view);
    };
    view.dom.addEventListener("inknb-insert-annotation", insert);
    view.dom.addEventListener("inknb-editor-command", edit);
    view.dom.addEventListener("inknb-remove-annotation", remove);
    return () => {
      view.dom.removeEventListener("inknb-insert-annotation", insert);
      view.dom.removeEventListener("inknb-editor-command", edit);
      view.dom.removeEventListener("inknb-remove-annotation", remove);
      editor.current = null;
      elementRef.current = null;
      view.destroy();
    };
  }, []);
  useLayoutEffect(() => {
    const view = editor.current;
    if (!view) return;
    const next = documentFor(content, references, annotations);
    if (view.state.doc.eq(next)) return;
    let transaction = view.state.tr.setDocAttribute("annotations", annotations);
    if (!view.state.doc.content.eq(next.content))
      transaction = transaction.replaceWith(
        0,
        view.state.doc.content.size,
        Fragment.from(next.firstChild!),
      );
    view.dispatch(transaction.setMeta("addToHistory", false));
  }, [content, references, annotations]);
  return <div ref={host} onPaste={onPaste} />;
}
