import { Text, ChangeSet } from "@codemirror/state";
import { projectSourceChanges } from "./native-source-edit";
import { EditorState, Plugin, TextSelection, NodeSelection, Selection } from "prosemirror-state";
import type { Transaction } from "prosemirror-state";
import type { Node as DocumentNode } from "prosemirror-model";
import { history, undo, redo, closeHistory } from "prosemirror-history";
import { CellSelection } from "prosemirror-tables";
import { Mapping } from "prosemirror-transform";
import { z } from "zod";
import {
  nativeSchema,
  sourceFormatSchema,
  nativeObject,
  semanticSignature,
  sourceAttributes,
  nativeText,
  nativeRange,
} from "./native-schema";
import type { NativeDocument, SourceFormat } from "./native-schema";
import {
  restoreDocument,
  projectDocument,
  captureDocument,
} from "./native-document";
import { documentPosition, sourcePosition } from "./native-source";
import type { SourceProjection } from "./native-source";
import type {
  Anchor,
  Selection as SourceSelection,
  TextChange,
} from "./domain";
import { captureAnchor, mapAnchor } from "./domain";
import type { DocumentSession } from "./session";

const operationSchema = z.record(z.string(), z.literal("applied"));

export function selectionForRange(
  document: DocumentNode,
  from: number,
  to: number,
): Selection {
  const start = document.resolve(from);
  for (let depth = start.depth; from < to && depth > 0; depth -= 1) {
    const node = start.node(depth);
    if (node.type.spec.tableRole !== "table") continue;
    const position = start.before(depth);
    const first = Selection.findFrom(document.resolve(position + 1), 1, true);
    const last = Selection.findFrom(
      document.resolve(position + node.nodeSize - 1),
      -1,
      true,
    );
    if (first?.from === from && last?.to === to)
      return NodeSelection.create(document, position);
  }
  return TextSelection.between(start, document.resolve(to));
}

function sourceSelection(selection: Selection, projection: SourceProjection): SourceSelection {
  let selectionFrom = selection.from;
  let selectionTo = selection.to;
  if (selection instanceof CellSelection && selection.isRowSelection() && selection.isColSelection()) {
    const depth = selection.$anchorCell.depth - 1;
    selectionFrom = selection.$anchorCell.before(depth);
    selectionTo = selectionFrom + selection.$anchorCell.node(depth).nodeSize;
  }
  const from = sourcePosition(projection, selectionFrom);
  return {
    from,
    to: selection.empty
      ? from
      : Math.max(from, sourcePosition(projection, selectionTo, -1)),
  };
}

export interface NativeUpdate {
  before: Text;
  source: Text;
  changes: ChangeSet;
  document: NativeDocument;
  anchors: Record<string, Anchor>;
  statuses: Record<string, "applied" | "undone">;
  selection: SourceSelection;
  docChanged: boolean;
  beforeFormat: SourceFormat;
  actor: string;
}

export class NativeDocumentModel {
  readonly documentId: string;
  readonly epoch = crypto.randomUUID();
  readonly steps: { step: unknown; clientId: string }[] = [];
  state: EditorState;
  source: Text;
  projection: SourceProjection;
  anchors: Record<string, Anchor> = {};
  modelPlugins: Plugin[];

  constructor(
    readonly session: Pick<
      DocumentSession,
      "getWorkingSnapshot" | "onEditorUpdate"
    >,
    plugins: Plugin[] = [history()],
  ) {
    const snapshot = session.getWorkingSnapshot();
    this.documentId = snapshot.metadata.documentId;
    let document = restoreDocument(
      snapshot.text,
      snapshot.path,
      snapshot.metadata.nativeDocument,
    );
    const operations = Object.fromEntries(
      snapshot.metadata.proposals
        .filter((proposal) => proposal.status === "applied")
        .map((proposal) => [proposal.id, "applied"]),
    );
    document = document.type.create(
      { ...document.attrs, operations },
      document.content,
    );
    this.projection = projectDocument(document);
    this.source = Text.of(snapshot.text.split("\n"));
    const identities = new Plugin({
      appendTransaction(transactions, _previous, state) {
        if (!transactions.some((transaction) => transaction.docChanged))
          return null;
        const used = new Set<string>();
        const transaction = state.tr;
        state.doc.descendants((node, position) => {
          if (node.isText) return;
          const identity =
            typeof node.attrs.identity === "string" &&
            !used.has(node.attrs.identity)
              ? node.attrs.identity
              : crypto.randomUUID();
          used.add(identity);
          if (identity !== node.attrs.identity)
            transaction.setNodeAttribute(position, "identity", identity);
        });
        return transaction.steps.length ? transaction : null;
      },
    });
    const selectionFrom = documentPosition(
      this.projection,
      snapshot.selection.from,
    );
    const selectionTo =
      snapshot.selection.to <= snapshot.selection.from
        ? selectionFrom
        : documentPosition(this.projection, snapshot.selection.to, -1);
    this.modelPlugins = [...plugins, identities];
    this.state = EditorState.create({
      doc: document,
      selection: selectionForRange(document, selectionFrom, selectionTo),
      plugins: this.modelPlugins,
    });
    for (const thread of [...snapshot.metadata.threads, ...snapshot.metadata.decisions])
      if (thread.anchor) this.anchors[thread.id] = this.capture(thread.anchor);
  }

  get selection(): SourceSelection {
    return sourceSelection(this.state.selection, this.projection);
  }

  capture(anchor: Anchor): Anchor {
    const region = anchor.native?.region;
    if (region) {
      let node = this.state.doc;
      let position = -1;
      this.state.doc.descendants((candidate, offset) => {
        if (candidate.attrs.identity === region.identity) {
          node = candidate;
          position = offset;
        }
      });
      if (node.attrs.identity !== region.identity)
        return { ...anchor, status: "detached" };
      const range = nativeRange(node, position);
      const source = captureAnchor(this.source.toString(), {
        from: sourcePosition(this.projection, range.from),
        to: sourcePosition(this.projection, range.to, -1),
      });
      return {
        ...source,
        status: anchor.status,
        native: {
          region,
          from: { identity: region.identity, offset: 0 },
          to: { identity: region.identity, offset: range.to - range.from },
          quote: anchor.native?.quote ?? semanticSignature(node),
        },
      };
    }
    const from = documentPosition(this.projection, anchor.from);
    const to = Math.max(from, documentPosition(this.projection, anchor.to, -1));
    const selection = selectionForRange(this.state.doc, from, to);
    const points = selection instanceof NodeSelection
      ? [
          { identity: String(selection.node.attrs.identity), offset: 0 },
          { identity: String(selection.node.attrs.identity), offset: selection.node.content.size },
        ]
      : [anchor.from, anchor.to].map((offset, index) => {
      const position = documentPosition(
        this.projection,
        offset,
        index ? -1 : 1,
      );
      const resolved = this.state.doc.resolve(position);
      for (let depth = resolved.depth; depth > 0; depth -= 1) {
        const node = resolved.node(depth);
        if (node.attrs.identity)
          return {
            identity: String(node.attrs.identity),
            offset: position - resolved.start(depth),
          };
      }
      return {
        identity: String(this.state.doc.attrs.identity),
        offset: position,
      };
    });
    const quote = nativeText(this.state.doc, from, to);
    return {
      ...anchor,
      native: {
        ...anchor.native,
        from: points[0],
        to: points[1],
        quote: anchor.native?.quote ?? quote,
      },
    };
  }

  commit(transaction: Transaction): NativeUpdate {
    if (this.source.toString() !== this.session.getWorkingSnapshot().text)
      throw Error("The editor source changed before this transaction.");
    const previousFormat = this.state.doc.attrs.format;
    const applied = this.state.applyTransaction(transaction);
    const next = applied.state;
    const mapping = new Mapping();
    for (const appliedTransaction of applied.transactions)
      mapping.appendMapping(appliedTransaction.mapping);
    const docChanged = applied.transactions.some(
      (appliedTransaction) => appliedTransaction.docChanged,
    );
    const projection = docChanged ? projectDocument(next.doc) : this.projection;
    const before = this.source;
    let start = 0;
    const previous = before.toString();
    while (
      start < previous.length &&
      start < projection.text.length &&
      previous[start] === projection.text[start]
    )
      start += 1;
    let previousEnd = previous.length;
    let nextEnd = projection.text.length;
    while (
      previousEnd > start &&
      nextEnd > start &&
      previous[previousEnd - 1] === projection.text[nextEnd - 1]
    ) {
      previousEnd -= 1;
      nextEnd -= 1;
    }
    const edits: TextChange[] =
      transaction.getMeta("sourceChanges") ??
      (previousEnd === start && nextEnd === start
        ? []
        : [
            {
              from: start,
              to: previousEnd,
              insert: projection.text.slice(start, nextEnd),
            },
          ]);
    const changes = ChangeSet.of(edits, before.length);
    const source = changes.empty ? before : changes.apply(before);
    if (source.toString() !== projection.text)
      throw Error("The source edit does not match the native document.");
    const anchors: Record<string, Anchor> = {};
    const objects = new Map<string, { node: DocumentNode; position: number }>();
    objects.set(String(next.doc.attrs.identity), {
      node: next.doc,
      position: -1,
    });
    next.doc.descendants((node, position) => {
      if (node.attrs.identity)
        objects.set(String(node.attrs.identity), { node, position });
    });
    const replacedRanges: { from: number; to: number }[] = [];
    for (const map of mapping.maps)
      map.forEach((from, to) => {
        if (to > from) replacedRanges.push({ from, to });
      });
    for (const [identity, anchor] of Object.entries(this.anchors)) {
      const mapped = mapAnchor(projection.text, anchor, changes);
      if (
        !anchor.native ||
        (previousFormat !== next.doc.attrs.format && !anchor.native.region)
      ) {
        anchors[identity] = { ...mapped, native: undefined };
        continue;
      }
      const positions = [anchor.native.from, anchor.native.to].map(
        (point, index) => {
          const object = objects.get(point.identity);
          if (!object) return null;
          const bounds = nativeRange(object.node, object.position);
          const native = anchor.native!;
          if (
            native.region?.identity === point.identity ||
            (native.from.identity === native.to.identity &&
              native.from.offset === 0 &&
              object.node.type.spec.tableRole === "table")
          )
            return index ? bounds.to : bounds.from;
          if (
            native.quote.length > 0 &&
            native.from.identity === native.to.identity &&
            object.node.isTextblock &&
            native.to.offset <= object.node.content.size &&
            nativeText(object.node, native.from.offset, native.to.offset) ===
              native.quote
          )
            return object.position + 1 + point.offset;
          if (anchor.status === "detached")
            return Math.min(bounds.to, bounds.from + point.offset);
          const oldObjectPosition =
            this.state.doc === next.doc ? object.position : null;
          let oldPosition: number | null = oldObjectPosition;
          let oldSize = 0;
          this.state.doc.descendants((node, position) => {
            if (node.attrs.identity === point.identity) {
              oldPosition = position;
              oldSize = node.nodeSize;
            }
          });
          if (
            transaction.getMeta("sourceChanges") ||
            (oldPosition !== null &&
              replacedRanges.some(
                (range) =>
                  range.from <= oldPosition! &&
                  range.to >= oldPosition! + oldSize,
              ))
          )
            return documentPosition(
              projection,
              index ? mapped.to : mapped.from,
              index ? -1 : 1,
            );
          const position =
            oldPosition === null
              ? object.position + 1 + point.offset
              : mapping.map(oldPosition + 1 + point.offset, 1);
          return Math.max(bounds.from, Math.min(bounds.to, position));
        },
      );
      if (positions[0] === null || positions[1] === null) {
        anchors[identity] = {
          ...mapped,
          native: anchor.native,
          status: "detached",
        };
        continue;
      }
      const from = sourcePosition(projection, positions[0]);
      const to = Math.max(from, sourcePosition(projection, positions[1], -1));
      anchors[identity] = {
        ...captureAnchor(projection.text, { from, to }),
        native: anchor.native,
        status:
          from === to && anchor.native.quote
            ? "detached"
            : (anchor.native.region
                  ? semanticSignature(
                      objects.get(anchor.native.region.identity)!.node,
                    )
                  : nativeText(
                      next.doc,
                      positions[0],
                      Math.max(positions[0], positions[1]),
                    )) === anchor.native.quote
              ? "attached"
              : "changed",
      };
    }
    const operations = operationSchema.parse(next.doc.attrs.operations);
    const statuses: NativeUpdate["statuses"] = {};
    for (const proposal of this.session.getWorkingSnapshot().metadata.proposals)
      if (
        ["applied", "undone"].includes(proposal.status) ||
        operations[proposal.id]
      )
        statuses[proposal.id] = operations[proposal.id] ? "applied" : "undone";
    const update: NativeUpdate = {
      before,
      source,
      beforeFormat: sourceFormatSchema.parse(previousFormat),
      actor: z.string().parse(transaction.getMeta("historyActor") ?? "You"),
      changes,
      document: captureDocument(next.doc, projection.text),
      anchors,
      statuses,
      selection: sourceSelection(next.selection, projection),
      docChanged,
    };
    this.session.onEditorUpdate(update);
    this.projection = projection;
    this.source = source;
    this.anchors = anchors;
    this.state = next;
    for (const appliedTransaction of applied.transactions)
      for (const step of appliedTransaction.steps)
        this.steps.push({
          step: step.toJSON(),
          clientId:
            appliedTransaction === transaction
              ? (transaction.getMeta("clientId") ?? "host")
              : "host",
        });
    for (const [identity, anchor] of Object.entries(anchors))
      if (anchor.status !== "detached")
        this.anchors[identity] = this.capture(anchor);
    return update;
  }

  restoreAnchors(anchors: Record<string, Anchor>): void {
    for (const [identity, anchor] of Object.entries(anchors))
      this.anchors[identity] = this.capture(anchor);
  }

  passageText(anchor: Anchor): string {
    const from = documentPosition(this.projection, anchor.from);
    const to = Math.max(from, documentPosition(this.projection, anchor.to, -1));
    return this.state.doc.textBetween(from, to, "\n", (node) =>
      String(
        node.attrs.alt || node.attrs.value || node.attrs.label || "Figure",
      ),
    );
  }

  applySource(
    edits: TextChange[],
    operation?: string,
    format?: SourceFormat,
    actor = "You",
  ): void {
    this.applyAtomic(this.sourceTransaction(edits, operation, format, actor));
  }

  sourceTransaction(
    edits: TextChange[],
    operation?: string,
    format?: SourceFormat,
    actor = "You",
  ): Transaction {
    const changes = ChangeSet.of(edits, this.source.length);
    const next = projectSourceChanges(this.state.doc, this.projection, edits, format);
    const transaction = this.state.tr;
    transaction.replaceWith(0, transaction.doc.content.size, next.content);
    const operations = {
      ...operationSchema.parse(this.state.doc.attrs.operations),
    };
    if (operation) operations[operation] = "applied";
    for (const [name, value] of Object.entries({
      ...next.attrs,
      identity: this.state.doc.attrs.identity,
      operations,
    }))
      transaction.setDocAttribute(name, value);
    transaction.setMeta("sourceChanges", edits);
    transaction.setMeta("historyActor", actor);
    const selection = this.selection;
    const projected = projectDocument(transaction.doc);
    transaction.setSelection(
      selectionForRange(
        transaction.doc,
        documentPosition(projected, changes.mapPos(selection.from)),
        documentPosition(projected, changes.mapPos(selection.to), -1),
      ),
    );
    return transaction;
  }

  applyAtomic(transaction: Transaction): void {
    this.commit(closeHistory(transaction));
    this.commit(closeHistory(this.state.tr));
  }

  node(identity: string): { node: DocumentNode; position: number } {
    if (this.state.doc.attrs.identity === identity) return { node: this.state.doc, position: -1 };
    const targets: { node: DocumentNode; position: number }[] = [];
    this.state.doc.descendants((node, position) => {
      if (node.attrs.identity === identity) targets.push({ node, position });
    });
    const found = targets[0];
    if (!found) throw Error("This object is no longer in the document.");
    return found;
  }

  moveTransaction(identity: string, parentIdentity: string, beforeIdentity: string | null): Transaction {
    const moving = this.node(identity);
    const parent = this.node(parentIdentity);
    if (moving.position < 0 || (parent.position >= moving.position && parent.position < moving.position + moving.node.nodeSize))
      throw Error("An object cannot move inside itself.");
    if (beforeIdentity === identity) return this.state.tr;
    let insertion = parent.position + 1 + parent.node.content.size;
    let childIndex = parent.node.childCount;
    if (beforeIdentity) {
      let found = false;
      parent.node.forEach((node, offset, index) => {
        if (node.attrs.identity !== beforeIdentity) return;
        insertion = parent.position + 1 + offset;
        childIndex = index;
        found = true;
      });
      if (!found) throw Error("The destination object changed.");
    }
    if (!parent.node.canReplaceWith(childIndex, childIndex, moving.node.type))
      throw Error("This container cannot contain that object.");
    const transaction = this.state.tr.delete(moving.position, moving.position + moving.node.nodeSize);
    transaction.insert(transaction.mapping.map(insertion, -1), moving.node);
    transaction.doc.check();
    return transaction;
  }

  objectTransaction(identity: string, content: unknown): Transaction {
    const found = this.node(identity);
    if (found.position < 0) throw Error("Replace a document object instead of the document root.");
    const originals = new Map<string, DocumentNode>();
    this.state.doc.descendants((node) => {
      if (node.attrs.identity) originals.set(String(node.attrs.identity), node);
    });
    const decode = (value: unknown): DocumentNode => {
      const parsed = z
        .object({
          type: z.string(),
          identity: z.string().optional(),
          attributes: z.record(z.string(), z.json()).optional(),
          text: z.string().optional(),
          content: z.array(z.json()).optional(),
          marks: z
            .array(
              z.object({
                type: z.string(),
                attributes: z.record(z.string(), z.json()),
              }),
            )
            .optional(),
        })
        .strict()
        .parse(value);
      if (
        Object.keys(parsed.attributes ?? {}).some(
          (name) => name in sourceAttributes || name === "operations",
        )
      )
        throw Error("Source metadata is managed by the document editor.");
      if (
        parsed.marks?.some(
          (mark) => "prefix" in mark.attributes || "suffix" in mark.attributes,
        )
      )
        throw Error("Source delimiters are managed by the document editor.");
      const marks = parsed.marks?.map((mark) =>
        nativeSchema.mark(mark.type, mark.attributes),
      );
      if (parsed.type === "text")
        return nativeSchema.text(parsed.text ?? "", marks);
      const type = nativeSchema.nodes[parsed.type];
      if (!type || type === nativeSchema.nodes.doc)
        throw Error("Supply a native document object.");
      const previous = parsed.identity
        ? originals.get(parsed.identity)
        : undefined;
      const attributes = previous?.type === type ? previous.attrs : {};
      return type.createChecked(
        { ...attributes, ...parsed.attributes, identity: parsed.identity },
        parsed.content?.map(decode),
        marks,
      );
    };
    const replacement = decode(content);
    replacement.check();
    if (replacement.isText)
      throw Error("Replace the paragraph or object that contains this text.");
    const current = nativeObject(found.node);
    const retained =
      found.node.type === replacement.type &&
      JSON.stringify(current.attributes) ===
        JSON.stringify(nativeObject(replacement).attributes)
        ? found.node.attrs
        : {};
    const next = replacement.type.createChecked(
      { ...replacement.attrs, ...retained, identity },
      replacement.content,
      replacement.marks,
    );
    return this.state.tr.replaceWith(
      found.position,
      found.position + found.node.nodeSize,
      next,
    );
  }

  undo(): void {
    undo(this.state, (transaction) => this.commit(transaction));
  }
  redo(): void {
    redo(this.state, (transaction) => this.commit(transaction));
  }
}
