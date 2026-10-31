import type { Node as DocumentNode } from "prosemirror-model";
import type { Mark } from "prosemirror-model";
import { z } from "zod";
import { nativeSchema, semanticSignature } from "./native-schema";

export const sourceSpanSchema = z.object({
  from: z.number().int().nonnegative(),
  to: z.number().int().nonnegative(),
  documentFrom: z.number().int().nonnegative(),
  documentTo: z.number().int().nonnegative(),
  boundaries: z.array(z.number().int().nonnegative()).optional(),
});
export type SourceSpan = z.infer<typeof sourceSpanSchema>;

export interface SourcePart {
  node: DocumentNode;
  from: number;
  to: number;
  spans: SourceSpan[];
}

export interface SourceProjection {
  text: string;
  spans: SourceSpan[];
}

export function sourceText(
  value: string,
  source: string,
  from: number,
  to: number,
  marks: readonly Mark[] = [],
): SourcePart[] {
  if (!value) return [];
  const raw = source.slice(from, to);
  const boundaries = [0];
  let sourceOffset = 0;
  for (let offset = 0; offset < value.length; offset += 1) {
    const character = value[offset];
    if (raw[sourceOffset] === "\\" && raw[sourceOffset + 1] === character)
      sourceOffset += 1;
    if (raw[sourceOffset] === "&") {
      const entity = /^&(?:#[0-9]+|#x[0-9a-f]+|[a-z][a-z0-9]+);/i.exec(
        raw.slice(sourceOffset),
      );
      if (entity) sourceOffset += entity[0].length;
      else sourceOffset += 1;
    } else if (/\s/.test(character) && /\s/.test(raw[sourceOffset] ?? "")) {
      sourceOffset += 1;
      if (value[offset + 1] && !/\s/.test(value[offset + 1]))
        while (/\s/.test(raw[sourceOffset] ?? "")) sourceOffset += 1;
    } else {
      const next = raw.indexOf(character, sourceOffset);
      sourceOffset = next < 0 ? sourceOffset + 1 : next + 1;
    }
    boundaries.push(Math.min(raw.length, sourceOffset));
  }
  boundaries[boundaries.length - 1] = raw.length;
  return [
    {
      node: nativeSchema.text(value, marks),
      from,
      to,
      spans: [
        {
          from,
          to,
          documentFrom: 0,
          documentTo: value.length,
          ...(raw === value ? {} : { boundaries }),
        },
      ],
    },
  ];
}

export function sourceNode(
  type: string,
  attributes: Record<string, unknown>,
  children: SourcePart[],
  source: string,
  from: number,
  to: number,
  prefix = "",
  suffix = "",
  marks: readonly Mark[] = [],
): SourcePart {
  const spans: SourceSpan[] = [];
  let position = 1;
  for (const child of children) {
    for (const span of child.spans)
      spans.push({
        ...span,
        documentFrom: span.documentFrom + position,
        documentTo: span.documentTo + position,
      });
    position += child.node.nodeSize;
  }
  const specification = nativeSchema.nodes[type];
  if (!specification) throw Error(`Unsupported document object: ${type}`);
  if (specification.isLeaf)
    spans.push({ from, to, documentFrom: 0, documentTo: 1 });
  const nodeAttributes = {
    ...attributes,
    identity: crypto.randomUUID(),
    source: source.slice(from, to),
    prefix,
    suffix,
    spans: spans.map((span) => ({
      ...span,
      from: span.from - from,
      to: span.to - from,
    })),
  };
  let previous = from + prefix.length;
  const content = children.map((child) => {
    const node = child.node.isText
      ? child.node
      : child.node.type.createChecked(
          { ...child.node.attrs, before: source.slice(previous, child.from) },
          child.node.content,
          child.node.marks,
        );
    previous = child.to;
    return node;
  });
  const node = specification.createChecked(nodeAttributes, content, marks);
  return {
    node: specification.createChecked(
      { ...nodeAttributes, signature: semanticSignature(node) },
      node.content,
      marks,
    ),
    from,
    to,
    spans,
  };
}

export function sourceDocument(
  parts: SourcePart[],
  source: string,
  format: string,
  insertion = 0,
): DocumentNode {
  const children = parts.length
    ? parts
    : [sourceNode("paragraph", {}, [], source, insertion, insertion)];
  if (!parts.length) {
    const empty = children[0].node;
    children[0].node = empty.type.createChecked(
      { ...empty.attrs, prefix: null, suffix: null },
      empty.content,
    );
  }
  const spans: SourceSpan[] = [];
  let position = 0;
  for (const part of children) {
    for (const span of part.spans)
      spans.push({
        ...span,
        documentFrom: span.documentFrom + position,
        documentTo: span.documentTo + position,
      });
    position += part.node.nodeSize;
  }
  let previous = children[0].from;
  const nodes = children.map((part) => {
    const node = part.node.type.createChecked(
      { ...part.node.attrs, before: source.slice(previous, part.from) },
      part.node.content,
      part.node.marks,
    );
    previous = part.to;
    return node;
  });
  const node = nativeSchema.nodes.doc.createChecked(
    {
      source,
      identity: crypto.randomUUID(),
      syntax: format,
      format,
      spans,
      prefix: source.slice(0, children[0].from),
      suffix: source.slice(children.at(-1)!.to),
    },
    nodes,
  );
  return nativeSchema.nodes.doc.createChecked(
    { ...node.attrs, signature: semanticSignature(node) },
    nodes,
  );
}

export function documentPosition(
  projection: SourceProjection,
  position: number,
  association = 1,
): number {
  const spans = projection.spans;
  const span =
    spans.find(
      (candidate) => position >= candidate.from && position <= candidate.to,
    ) ??
    (association < 0
      ? [...spans].reverse().find((candidate) => candidate.to <= position)
      : spans.find((candidate) => candidate.from >= position));
  if (!span) return association < 0 ? 0 : (spans.at(-1)?.documentTo ?? 0);
  if (span.boundaries) {
    const relative = position - span.from;
    const index = span.boundaries.findIndex((boundary) => boundary >= relative);
    return span.documentFrom + (index < 0 ? span.boundaries.length - 1 : index);
  }
  if (span.to - span.from === span.documentTo - span.documentFrom)
    return Math.max(
      span.documentFrom,
      Math.min(span.documentTo, span.documentFrom + position - span.from),
    );
  return position <= span.from ? span.documentFrom : span.documentTo;
}

export function sourcePosition(
  projection: SourceProjection,
  position: number,
  association = 1,
): number {
  const spans = projection.spans;
  let lower = 0;
  let upper = spans.length;
  while (lower < upper) {
    const middle = Math.floor((lower + upper) / 2);
    if (spans[middle].documentTo < position) lower = middle + 1;
    else upper = middle;
  }
  const candidate = spans[lower];
  const span = candidate && candidate.documentFrom <= position
    ? candidate
    : association < 0 ? spans[lower - 1] : candidate;
  if (!span) return association < 0 ? 0 : projection.text.length;
  if (span.boundaries)
    return (
      span.from +
      span.boundaries[
        Math.max(
          0,
          Math.min(span.boundaries.length - 1, position - span.documentFrom),
        )
      ]
    );
  if (span.to - span.from === span.documentTo - span.documentFrom)
    return Math.max(
      span.from,
      Math.min(span.to, span.from + position - span.documentFrom),
    );
  return position <= span.documentFrom ? span.from : span.to;
}
