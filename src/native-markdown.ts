import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { mathFromMarkdown } from "mdast-util-math";
import { gfm } from "micromark-extension-gfm";
import { math } from "micromark-extension-math";
import type { Nodes, Definition } from "mdast";
import type { Mark, Node as DocumentNode } from "prosemirror-model";
import { nativeSchema } from "./native-schema";
import { sourceDocument, sourceNode, sourceText } from "./native-source";
import type { SourcePart } from "./native-source";

export function importMarkdown(source: string): DocumentNode {
  const root = fromMarkdown(source, {
    extensions: [gfm(), math()],
    mdastExtensions: [gfmFromMarkdown(), mathFromMarkdown()],
  });
  const definitions = new Map<string, Definition>();
  for (const node of root.children)
    if (node.type === "definition") definitions.set(node.identifier, node);
  const build = (
    node: Nodes,
    inline = false,
    marks: readonly Mark[] = [],
  ): SourcePart[] => {
    const from = node.position?.start.offset ?? 0;
    const to = node.position?.end.offset ?? from;
    if (
      node.type === "paragraph" &&
      node.children.some(
        (child) =>
          child.type === "html" && /^<\/?[a-z][\w-]*\b/i.test(child.value),
      )
    )
      return [
        sourceNode(
          "source_object",
          { original: source.slice(from, to), label: "Embedded content" },
          [],
          source,
          from,
          to,
        ),
      ];
    if (node.type === "definition" || node.type === "footnoteDefinition")
      return [];
    if (node.type === "text")
      return sourceText(node.value, source, from, to, marks);
    if (node.type === "root")
      return node.children.flatMap((child) => build(child));
    if (
      node.type === "emphasis" ||
      node.type === "strong" ||
      node.type === "delete" ||
      node.type === "link" ||
      node.type === "linkReference"
    ) {
      const contentFrom = node.children[0]?.position?.start.offset ?? from;
      const contentTo = node.children.at(-1)?.position?.end.offset ?? to;
      const name =
        node.type === "emphasis"
          ? "em"
          : node.type === "delete"
            ? "strike"
            : node.type === "strong"
              ? "strong"
              : "link";
      const reference =
        node.type === "linkReference" ? definitions.get(node.identifier) : null;
      const attributes = {
        prefix: source.slice(from, contentFrom),
        suffix: source.slice(contentTo, to),
        ...(node.type === "link"
          ? { href: node.url, title: node.title }
          : reference
            ? { href: reference.url, title: reference.title }
            : name === "link"
              ? { href: "", title: null }
              : {}),
      };
      const mark = nativeSchema.marks[name].create(attributes);
      return node.children.flatMap((child) =>
        build(child, true, [...marks, mark]),
      );
    }
    if (node.type === "inlineCode") {
      const delimiter = /^`+/.exec(source.slice(from, to))?.[0] ?? "`";
      return sourceText(node.value, source, from, to, [
        ...marks,
        nativeSchema.marks.code.create({
          prefix: delimiter,
          suffix: delimiter,
        }),
      ]);
    }
    if (node.type === "inlineMath" || node.type === "math")
      return [
        sourceNode(
          node.type === "inlineMath" ? "math" : "math_block",
          { value: node.value },
          [],
          source,
          from,
          to,
          node.type === "inlineMath" ? "$" : "$$\n",
          node.type === "inlineMath" ? "$" : "\n$$",
          marks,
        ),
      ];
    if (node.type === "image" || node.type === "imageReference") {
      const reference =
        node.type === "imageReference"
          ? definitions.get(node.identifier)
          : null;
      return [
        sourceNode(
          "image",
          {
            src: node.type === "image" ? node.url : (reference?.url ?? ""),
            alt: node.alt ?? "",
            title:
              node.type === "image" ? node.title : (reference?.title ?? null),
          },
          [],
          source,
          from,
          to,
          "",
          "",
          marks,
        ),
      ];
    }
    if (node.type === "break")
      return [
        sourceNode("hard_break", {}, [], source, from, to, "", "", marks),
      ];
    if (node.type === "code") {
      const children = sourceText(node.value, source, from, to);
      return [
        sourceNode(
          "code_block",
          { params: node.lang ?? "" },
          children,
          source,
          from,
          to,
        ),
      ];
    }
    if (node.type === "thematicBreak")
      return [sourceNode("horizontal_rule", {}, [], source, from, to)];
    if (node.type === "table") {
      const rows = node.children.map((row, rowIndex) => {
        const cells = row.children.map((cell, columnIndex) => {
          const cellFrom = cell.position?.start.offset ?? from;
          const cellTo = cell.position?.end.offset ?? cellFrom;
          const content = cell.children.flatMap((child) => build(child, true));
          const paragraph = sourceNode(
            "paragraph",
            {},
            content,
            source,
            cellFrom,
            cellTo,
          );
          return sourceNode(
            rowIndex === 0 ? "table_header" : "table_cell",
            { alignment: node.align?.[columnIndex] ?? null },
            [paragraph],
            source,
            cellFrom,
            cellTo,
          );
        });
        return sourceNode(
          "table_row",
          {},
          cells,
          source,
          row.position?.start.offset ?? from,
          row.position?.end.offset ?? to,
        );
      });
      return [sourceNode("table", {}, rows, source, from, to)];
    }
    if (
      node.type === "paragraph" ||
      node.type === "heading" ||
      node.type === "blockquote" ||
      node.type === "list" ||
      node.type === "listItem"
    ) {
      const content = node.children.flatMap((child) =>
        build(child, node.type === "paragraph" || node.type === "heading"),
      );
      if (
        node.type === "listItem" &&
        content[0]?.node.type.name !== "paragraph"
      ) {
        const insertion = content[0]?.from ?? to;
        content.unshift(
          sourceNode("paragraph", {}, [], source, insertion, insertion),
        );
      }
      const type =
        node.type === "list"
          ? node.ordered
            ? "ordered_list"
            : "bullet_list"
          : node.type === "listItem"
            ? "list_item"
            : node.type;
      const attributes =
        node.type === "heading"
          ? { level: node.depth }
          : node.type === "list" && node.ordered
            ? { order: node.start ?? 1 }
            : node.type === "listItem"
              ? { checked: node.checked ?? null }
              : {};
      return [
        sourceNode(
          type,
          attributes,
          content,
          source,
          from,
          to,
          source.slice(from, content[0]?.from ?? to),
          source.slice(content.at(-1)?.to ?? to, to),
        ),
      ];
    }
    return [
      sourceNode(
        inline ? "source_inline" : "source_object",
        {
          original: source.slice(from, to),
          label: node.type === "html" ? "Embedded content" : "Reference",
        },
        [],
        source,
        from,
        to,
        "",
        "",
        marks,
      ),
    ];
  };
  return sourceDocument(build(root), source, "markdown");
}
