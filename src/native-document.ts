import { z } from "zod";
import type { Node as DocumentNode } from "prosemirror-model";
import { importMarkdown } from "./native-markdown";
import { importHtml } from "./native-html";
import { importLatex } from "./native-latex";
import {
  nativeDocumentSchema,
  nativeSchema,
  sourceFormatSchema,
  sourceFormat,
} from "./native-schema";
import type { NativeDocument, SourceFormat } from "./native-schema";
import {
  originalProjection,
  plainProjection,
  serializeDocument,
  unchangedSource,
} from "./native-export";
import {
  sourceDocument,
  sourceNode,
  sourceText,
  sourceSpanSchema,
} from "./native-source";
import type { SourceProjection, SourceSpan } from "./native-source";

interface ContentRange {
  from: number;
  to: number;
  documentFrom: number;
  documentTo: number;
}

export function contentRanges(document: DocumentNode): {
  text: string;
  ranges: ContentRange[];
} {
  let text = "";
  const ranges: ContentRange[] = [];
  document.descendants((node, position) => {
    if (!node.isLeaf) return;
    const from = text.length;
    text += node.isText ? node.text : "\ufffc";
    ranges.push({
      from,
      to: text.length,
      documentFrom: position,
      documentTo: position + node.nodeSize,
    });
  });
  return { text, ranges };
}

export function importDocument(
  source: string,
  format: SourceFormat,
): DocumentNode {
  if (format === "markdown") return importMarkdown(source);
  if (format === "html") return importHtml(source);
  if (format === "latex") return importLatex(source);
  const parts = [...source.matchAll(/[^\n]+(?:\n(?!\n)[^\n]+)*/g)].map(
    (match) => {
      const from = match.index;
      const to = from + match[0].length;
      return sourceNode(
        "paragraph",
        {},
        sourceText(match[0], source, from, to),
        source,
        from,
        to,
      );
    },
  );
  return sourceDocument(parts, source, "text");
}

export function projectDocument(document: DocumentNode): SourceProjection {
  if (unchangedSource(document) !== null) return originalProjection(document);
  const format = sourceFormatSchema.parse(document.attrs.format);
  if (format === "text") return plainProjection(document);
  const text = serializeDocument(document, format);
  const parsed = importDocument(text, format);
  const previous = contentRanges(document);
  const current = contentRanges(parsed);
  if (previous.text !== current.text)
    throw Error(
      "This change cannot preserve the document content in its source format.",
    );
  const importedSpans = sourceSpanSchema.array().parse(parsed.attrs.spans);
  const indexed: { span: SourceSpan; from: number; to: number }[] = [];
  let index = 0;
  for (const span of importedSpans) {
    while (
      current.ranges[index] &&
      current.ranges[index].documentTo <= span.documentFrom
    )
      index += 1;
    const range = current.ranges[index];
    if (
      !range ||
      span.documentFrom < range.documentFrom ||
      span.documentTo > range.documentTo
    )
      throw Error("The source mapping does not match the document content.");
    indexed.push({
      span,
      from: range.from + span.documentFrom - range.documentFrom,
      to: range.from + span.documentTo - range.documentFrom,
    });
  }
  const spans: SourceSpan[] = [];
  index = 0;
  for (const range of previous.ranges) {
    while (indexed[index] && indexed[index].to <= range.from) index += 1;
    for (
      let currentIndex = index;
      indexed[currentIndex] && indexed[currentIndex].from < range.to;
      currentIndex += 1
    ) {
      const entry = indexed[currentIndex];
      const from = Math.max(range.from, entry.from);
      const to = Math.min(range.to, entry.to);
      const start = from - entry.from;
      const end = to - entry.from;
      const sourceStart =
        entry.span.boundaries?.[start] ??
        (entry.span.to - entry.span.from === entry.to - entry.from
          ? start
          : start
            ? entry.span.to - entry.span.from
            : 0);
      const sourceEnd =
        entry.span.boundaries?.[end] ??
        (entry.span.to - entry.span.from === entry.to - entry.from
          ? end
          : end
            ? entry.span.to - entry.span.from
            : 0);
      spans.push({
        from: entry.span.from + sourceStart,
        to: entry.span.from + sourceEnd,
        documentFrom: range.documentFrom + from - range.from,
        documentTo: range.documentFrom + to - range.from,
        ...(entry.span.boundaries
          ? {
              boundaries: entry.span.boundaries
                .slice(start, end + 1)
                .map((boundary) => boundary - sourceStart),
            }
          : {}),
      });
    }
  }
  return { text, spans };
}

export function restoreDocument(
  source: string,
  path: string | null,
  stored: unknown,
): DocumentNode {
  const saved = nativeDocumentSchema.safeParse(stored);
  const format = sourceFormat(path, source, saved.data?.format);
  if (!saved.success || saved.data.source !== source)
    return importDocument(source, format);
  let document = nativeSchema.nodeFromJSON(saved.data.content);
  document.check();
  if (document.attrs.format !== format)
    throw Error("The saved document format does not match its native content.");
  if (projectDocument(document).text !== source)
    throw Error(
      "The saved native document does not match its source projection.",
    );
  if (format === "html" && saved.data.version === 1) {
    const imported = importDocument(source, format);
    if (contentRanges(document).text !== contentRanges(imported).text)
      throw Error(
        "The imported HTML does not match the saved document content.",
      );
    const previous: DocumentNode[] = [];
    document.descendants((node) => {
      if (!node.isText) previous.push(node);
    });
    const identities = new Set<string>();
    const rebuild = (node: DocumentNode): DocumentNode => {
      if (node.isText) return node;
      const match = previous.find(
        (candidate) =>
          candidate.type === node.type &&
          candidate.attrs.source === node.attrs.source &&
          !identities.has(String(candidate.attrs.identity)),
      );
      const identity = match?.attrs.identity ?? node.attrs.identity;
      identities.add(String(identity));
      const children: DocumentNode[] = [];
      node.forEach((child) => children.push(rebuild(child)));
      return node.type.create(
        { ...node.attrs, identity },
        children,
        node.marks,
      );
    };
    const children: DocumentNode[] = [];
    imported.forEach((node) => children.push(rebuild(node)));
    document = imported.type.create(
      {
        ...imported.attrs,
        identity: document.attrs.identity,
        operations: document.attrs.operations,
      },
      children,
    );
  }
  return document;
}

export function captureDocument(
  document: DocumentNode,
  source: string,
): NativeDocument {
  if (projectDocument(document).text !== source)
    throw Error("The native document does not match its source projection.");
  return nativeDocumentSchema.parse({
    version: 2,
    format: sourceFormatSchema.parse(document.attrs.format),
    source,
    content: z.json().parse(document.toJSON()),
  });
}
