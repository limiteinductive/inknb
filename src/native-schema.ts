import { Schema } from "prosemirror-model";
import type {
  DOMOutputSpec,
  Node as DocumentNode,
  NodeSpec,
} from "prosemirror-model";
import { schema as markdownSchema } from "prosemirror-markdown";
import { tableNodes } from "prosemirror-tables";
import { z } from "zod";

export const sourceFormatSchema = z.enum(["text", "markdown", "html", "latex"]);
export type SourceFormat = z.infer<typeof sourceFormatSchema>;
export const cellAlignmentSchema = z
  .enum(["left", "center", "right"])
  .nullable();

export const nativeDocumentSchema = z.object({
  version: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  format: sourceFormatSchema,
  source: z.string(),
  content: z.json(),
});
export type NativeDocument = z.infer<typeof nativeDocumentSchema>;

export const sourceAttributes = {
  identity: { default: null },
  source: { default: null },
  syntax: { default: null },
  loadedPackages: { default: [] },
  documentStart: { default: null },
  sourceColumn: { default: null },
  sourceColumns: { default: [] },
  columnRange: { default: null },
  signature: { default: null },
  prefix: { default: null },
  suffix: { default: null },
  before: { default: "" },
  spans: { default: [] },
};

const nodes: Record<string, NodeSpec> = {};
markdownSchema.spec.nodes.forEach((name, specification) => {
  nodes[name] =
    name === "text"
      ? specification
      : {
          ...specification,
          attrs: { ...specification.attrs, ...sourceAttributes },
        };
});
nodes.bullet_list = { ...nodes.bullet_list, content: "list_item*" };
nodes.ordered_list = { ...nodes.ordered_list, content: "list_item*" };
nodes.paragraph.whitespace = "pre";
nodes.heading.whitespace = "pre";
for (const [name, specification] of Object.entries(
  tableNodes({
    tableGroup: "block",
    cellContent: "block+",
    cellAttributes: {
      alignment: {
        default: null,
        validate: (value) => {
          cellAlignmentSchema.parse(value);
        },
        getFromDOM: (element) =>
          cellAlignmentSchema.safeParse(element.style.textAlign).data ?? null,
        setDOMAttr: (value, attributes) => {
          const alignment = cellAlignmentSchema.parse(value);
          if (alignment) attributes.style = `text-align: ${alignment}`;
        },
      },
    },
  }),
))
  nodes[name] = {
    ...specification,
    attrs: { ...specification.attrs, ...sourceAttributes },
  };
nodes.list_item = {
  ...nodes.list_item,
  attrs: { ...nodes.list_item.attrs, checked: { default: null } },
};
nodes.doc = {
  ...nodes.doc,
  attrs: {
    ...sourceAttributes,
    format: { default: "markdown" },
    operations: { default: {} },
  },
};
nodes.math = {
  group: "inline",
  inline: true,
  atom: true,
  attrs: { ...sourceAttributes, value: { default: "" } },
  toDOM: (node) => [
    "span",
    { "data-native-math": "inline" },
    String(node.attrs.value),
  ],
};
nodes.math_block = {
  group: "block",
  atom: true,
  attrs: { ...sourceAttributes, value: { default: "" } },
  toDOM: (node) => [
    "div",
    { "data-native-math": "block" },
    String(node.attrs.value),
  ],
};
nodes.source_object = {
  group: "block",
  atom: true,
  selectable: true,
  attrs: {
    ...sourceAttributes,
    label: { default: "Embedded content" },
    original: { default: "" },
  },
  toDOM: (node) => [
    "figure",
    {
      "data-native-source": "block",
      hidden: !node.attrs.label ? "" : null,
      "data-native-identity": node.attrs.identity,
    },
    ["figcaption", String(node.attrs.label)],
  ],
};
nodes.source_inline = {
  group: "inline",
  inline: true,
  atom: true,
  attrs: {
    ...sourceAttributes,
    label: { default: "Embedded content" },
    original: { default: "" },
  },
  toDOM: (node) => [
    "span",
    { "data-native-source": "inline" },
    String(node.attrs.label),
  ],
};
nodes.title_block = {
  group: "block",
  atom: true,
  attrs: {
    ...sourceAttributes,
    title: { default: "" },
    author: { default: "" },
    date: { default: "" },
    original: { default: "" },
  },
  toDOM: (node) => {
    const fields: DOMOutputSpec[] = [];
    if (node.attrs.title) fields.push(["h1", String(node.attrs.title)]);
    if (node.attrs.author) fields.push(["p", String(node.attrs.author)]);
    if (node.attrs.date) fields.push(["p", String(node.attrs.date)]);
    return [
      "header",
      { "data-native-title": "", contenteditable: "false" },
      ...fields,
    ];
  },
};
nodes.section = {
  group: "block",
  content: "block+",
  attrs: { ...sourceAttributes },
  toDOM: () => ["section", 0],
};
nodes.abstract = {
  group: "block",
  content: "block+",
  attrs: sourceAttributes,
  toDOM: () => [
    "section",
    { "aria-label": "Abstract" },
    ["h2", { contenteditable: "false" }, "Abstract"],
    ["div", 0],
  ],
};

let marks = markdownSchema.spec.marks;
marks.forEach((name, specification) => {
  marks = marks.update(name, {
    ...specification,
    attrs: {
      ...specification.attrs,
      prefix: { default: null },
      suffix: { default: null },
    },
  });
});

export const nativeSchema = new Schema({
  nodes,
  marks: marks
    .addToEnd("strike", {
      toDOM: () => ["s", 0],
      parseDOM: [{ tag: "s" }, { tag: "del" }],
    })
    .addToEnd("underline", { toDOM: () => ["u", 0], parseDOM: [{ tag: "u" }] })
    .addToEnd("source_span", {
      attrs: { prefix: { default: "" }, suffix: { default: "" } },
      toDOM: () => ["span", 0],
    }),
});

const semanticSignatures = new WeakMap<DocumentNode, string>();

export function semanticSignature(node: DocumentNode): string {
  const saved = semanticSignatures.get(node);
  if (saved !== undefined) return saved;
  const signature = JSON.stringify(nativeObject(node), (name, value) =>
    name === "identity" ? undefined : value,
  );
  semanticSignatures.set(node, signature);
  return signature;
}

export function sourceFormat(
  path: string | null,
  text: string,
  saved?: SourceFormat,
): SourceFormat {
  if (saved) return saved;
  const extension = path?.split(".").at(-1)?.toLowerCase();
  if (extension === "html" || extension === "htm") return "html";
  if (extension === "tex" || extension === "latex") return "latex";
  if (extension === "txt") return "text";
  if (!extension && /^\s*(?:<!doctype\s+html|<html\b)/i.test(text))
    return "html";
  if (!extension && /\\(?:documentclass|begin\{document\})/.test(text))
    return "latex";
  return "markdown";
}

export interface NativeObject {
  type: string;
  identity?: string;
  attributes?: Record<string, unknown>;
  text?: string;
  marks?: { type: string; attributes: Record<string, unknown> }[];
  content?: NativeObject[];
}

export function nativeObject(node: DocumentNode): NativeObject {
  const attributes = Object.fromEntries(
    Object.entries(node.attrs).filter(
      ([name]) => !(name in sourceAttributes) && name !== "operations",
    ),
  );
  const content: NativeObject[] = [];
  node.forEach((child) => content.push(nativeObject(child)));
  return {
    type: node.type.name,
    ...(node.attrs.identity ? { identity: String(node.attrs.identity) } : {}),
    ...(Object.keys(attributes).length ? { attributes } : {}),
    ...(node.isText ? { text: node.text } : {}),
    ...(node.marks.length
      ? {
          marks: node.marks.map((mark) => ({
            type: mark.type.name,
            attributes: Object.fromEntries(
              Object.entries(mark.attrs).filter(
                ([name]) => name !== "prefix" && name !== "suffix",
              ),
            ),
          })),
        }
      : {}),
    ...(content.length ? { content } : {}),
  };
}

export function nativeText(
  node: DocumentNode,
  from: number,
  to: number,
): string {
  return node.textBetween(
    from,
    to,
    "\n",
    (leaf) => `\ufffc${semanticSignature(leaf)}`,
  );
}

export function nativeRange(
  node: DocumentNode,
  position: number,
): { from: number; to: number } {
  return node.isLeaf
    ? { from: position, to: position + node.nodeSize }
    : { from: position + 1, to: position + node.nodeSize - 1 };
}
