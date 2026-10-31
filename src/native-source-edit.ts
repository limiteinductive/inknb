import type { Node as DocumentNode } from "prosemirror-model";
import { ChangeSet, Text } from "@codemirror/state";
import { importDocument, projectDocument } from "./native-document";
import { semanticSignature } from "./native-schema";
import type { SourceFormat } from "./native-schema";
import { sourcePosition } from "./native-source";
import type { SourceProjection } from "./native-source";
import type { TextChange } from "./domain";

export function projectSourceChanges(
  document: DocumentNode,
  projection: SourceProjection,
  edits: TextChange[],
  format?: SourceFormat,
): DocumentNode {
  const changes = ChangeSet.of(edits, projection.text.length);
  const source = changes.apply(Text.of(projection.text.split("\n"))).toString();
  const next = importDocument(source, format ?? document.attrs.format);
  const previous: { node: DocumentNode; from: number }[] = [];
  document.descendants((node, position) => {
    if (!node.isText)
      previous.push({
        node,
        from: changes.mapPos(sourcePosition(projection, position), -1),
      });
  });
  const used = new Set<string>();
  const signatures = new Map<string, typeof previous>();
  for (const entry of previous) {
    const signature = semanticSignature(entry.node);
    const matches = signatures.get(signature) ?? [];
    matches.push(entry);
    signatures.set(signature, matches);
  }
  for (const matches of signatures.values()) matches.reverse();
  const imported = projectDocument(next);
  const rebuild = (node: DocumentNode, position: number): DocumentNode => {
    if (node.isText) return node;
    const from = sourcePosition(imported, position);
    const matches = signatures.get(semanticSignature(node));
    while (
      matches?.length &&
      used.has(String(matches.at(-1)!.node.attrs.identity))
    )
      matches.pop();
    const match =
      matches?.pop() ??
      previous.find(
        (entry) =>
          entry.node.type === node.type &&
          !used.has(String(entry.node.attrs.identity)) &&
          Math.abs(entry.from - from) <= 1,
      );
    const identity = match?.node.attrs.identity ?? node.attrs.identity;
    used.add(String(identity));
    if (
      match &&
      semanticSignature(match.node) === semanticSignature(node) &&
      JSON.stringify({
        ...match.node.attrs,
        identity: null,
        signature: null,
      }) === JSON.stringify({ ...node.attrs, identity: null, signature: null })
    ) {
      match.node.descendants((child) => {
        if (!child.isText) used.add(String(child.attrs.identity));
      });
      return match.node;
    }
    const children: DocumentNode[] = [];
    node.forEach((child, offset) =>
      children.push(
        rebuild(child, position + offset + (node.type.name === "doc" ? 0 : 1)),
      ),
    );
    return node.type.create({ ...node.attrs, identity }, children, node.marks);
  };
  return rebuild(next, 0);
}
