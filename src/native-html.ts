import { parse, parseFragment } from "parse5";
import type { DefaultTreeAdapterMap } from "parse5";
import type { Mark, Node as DocumentNode } from "prosemirror-model";
import { nativeSchema, cellAlignmentSchema } from "./native-schema";
import { sourceDocument, sourceNode, sourceText } from "./native-source";
import type { SourcePart } from "./native-source";

type HtmlNode = DefaultTreeAdapterMap["childNode"];

export function importHtml(source: string): DocumentNode {
  const document = parse(source, { sourceCodeLocationInfo: true });
  const html = document.childNodes.find(
    (node) => "tagName" in node && node.tagName === "html",
  );
  const body =
    html && "childNodes" in html
      ? html.childNodes.find(
          (node) => "tagName" in node && node.tagName === "body",
        )
      : null;
  const blocks = (parts: SourcePart[]): SourcePart[] => {
    const result: SourcePart[] = [];
    let inline: SourcePart[] = [];
    for (const part of parts) {
      if (part.node.isInline) {
        inline.push(part);
        continue;
      }
      if (inline.length) {
        result.push(
          sourceNode(
            "paragraph",
            {},
            inline,
            source,
            inline[0].from,
            inline.at(-1)!.to,
          ),
        );
        inline = [];
      }
      result.push(part);
    }
    if (inline.length)
      result.push(
        sourceNode(
          "paragraph",
          {},
          inline,
          source,
          inline[0].from,
          inline.at(-1)!.to,
        ),
      );
    return result;
  };
  const build = (
    node: HtmlNode,
    inline = false,
    marks: readonly Mark[] = [],
    literal = false,
  ): SourcePart[] => {
    const location = node.sourceCodeLocation;
    const from = location?.startOffset ?? 0;
    const to = location?.endOffset ?? from;
    if ("value" in node) {
      if (!literal && !inline && !node.value.trim()) return [];
      const fragment = parseFragment(
        source.slice(from, to).replace(/[ \t\r\n\f]+/g, " "),
      );
      const value = fragment.childNodes
        .map((child) => ("value" in child ? child.value : ""))
        .join("");
      return sourceText(literal ? node.value : value, source, from, to, marks);
    }
    if (!("tagName" in node)) {
      if (inline && node.nodeName === "#comment")
        return [
          sourceNode(
            "source_inline",
            { original: source.slice(from, to), label: "" },
            [],
            source,
            from,
            to,
          ),
        ];
      return [];
    }
    const tag = node.tagName;
    if (!location && !node.childNodes.length) return [];
    const equation = node.attrs.find(
      (entry) => entry.name === "data-inknb-equation",
    )?.value;
    if (equation !== undefined)
      return [
        sourceNode(
          inline ? "math" : "math_block",
          { value: equation },
          [],
          source,
          from,
          to,
        ),
      ];
    const elementLocation = node.sourceCodeLocation;
    if (tag === "code" && literal)
      return node.childNodes.flatMap((child) =>
        build(child, true, marks, true),
      );
    const attribute = (name: string) =>
      node.attrs.find((entry) => entry.name === name)?.value;
    if (["thead", "tbody", "tfoot"].includes(tag))
      return node.childNodes.flatMap((child) => build(child));
    if (
      [
        "strong",
        "b",
        "em",
        "i",
        "s",
        "del",
        "u",
        "a",
        "code",
        "span",
        "sub",
        "sup",
      ].includes(tag)
    ) {
      const name =
        tag === "strong" || tag === "b"
          ? "strong"
          : tag === "em" || tag === "i"
            ? "em"
            : tag === "s" || tag === "del"
              ? "strike"
              : tag === "u"
                ? "underline"
                : tag === "a"
                  ? "link"
                  : tag === "code"
                    ? "code"
                    : "source_span";
      const prefix = source.slice(
        from,
        elementLocation?.startTag?.endOffset ?? from,
      );
      const suffix = source.slice(
        elementLocation?.endTag?.startOffset ?? to,
        to,
      );
      const mark = nativeSchema.marks[name].create({
        prefix,
        suffix,
        ...(name === "link"
          ? { href: attribute("href") ?? "", title: attribute("title") ?? null }
          : {}),
      });
      return node.childNodes.flatMap((child) =>
        build(child, true, [...marks, mark], literal || tag === "code"),
      );
    }
    if (tag === "br")
      return [
        sourceNode("hard_break", {}, [], source, from, to, "", "", marks),
      ];
    if (tag === "img")
      return [
        sourceNode(
          "image",
          {
            src: attribute("src") ?? "",
            alt: attribute("alt") ?? "",
            title: attribute("title") ?? null,
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
    if (tag === "hr")
      return [sourceNode("horizontal_rule", {}, [], source, from, to)];
    const names: Record<string, string> = {
      p: "paragraph",
      h1: "heading",
      h2: "heading",
      h3: "heading",
      h4: "heading",
      h5: "heading",
      h6: "heading",
      blockquote: "blockquote",
      ul: "bullet_list",
      ol: "ordered_list",
      li: "list_item",
      pre: "code_block",
      table: "table",
      tr: "table_row",
      td: "table_cell",
      th: "table_header",
      div: "section",
      section: "section",
      article: "section",
      main: "section",
      header: "section",
      footer: "section",
      aside: "section",
      figure: "section",
      figcaption: "paragraph",
    };
    const type = names[tag];
    if (!type)
      return [
        sourceNode(
          inline ? "source_inline" : "source_object",
          {
            original: source.slice(from, to),
            label: ["style", "script", "template"].includes(tag)
              ? ""
              : tag === "svg" || tag === "canvas"
                ? "Figure"
                : "Embedded content",
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
    const textblock = ["paragraph", "heading", "code_block"].includes(type);
    let children = node.childNodes.flatMap((child) =>
      build(child, textblock, marks, type === "code_block"),
    );
    if (
      [
        "section",
        "blockquote",
        "list_item",
        "table_cell",
        "table_header",
      ].includes(type)
    ) {
      children = blocks(children);
      if (!children.length)
        children = [
          sourceNode(
            "paragraph",
            {},
            [],
            source,
            elementLocation?.startTag?.endOffset ?? from,
            elementLocation?.startTag?.endOffset ?? from,
          ),
        ];
    }
    if (type === "list_item" && children[0]?.node.type.name !== "paragraph")
      children.unshift(
        sourceNode(
          "paragraph",
          {},
          [],
          source,
          elementLocation?.startTag?.endOffset ?? from,
          elementLocation?.startTag?.endOffset ?? from,
        ),
      );
    if (
      (type === "table" &&
        (!children.length ||
          children.some((child) => child.node.type.name !== "table_row"))) ||
      ((type === "ordered_list" || type === "bullet_list") && !children.length)
    )
      return [
        sourceNode(
          "source_object",
          {
            label: type === "table" ? "Table" : "List",
            original: source.slice(from, to),
          },
          [],
          source,
          from,
          to,
        ),
      ];
    const attributes =
      type === "heading"
        ? { level: Number(tag.slice(1)) }
        : type === "ordered_list"
          ? { order: Number(attribute("start") ?? 1) }
          : type === "table_cell" || type === "table_header"
            ? {
                colspan: Math.max(
                  1,
                  Number.parseInt(attribute("colspan") ?? "1", 10) || 1,
                ),
                rowspan: Math.max(
                  1,
                  Number.parseInt(attribute("rowspan") ?? "1", 10) || 1,
                ),
                alignment:
                  cellAlignmentSchema.safeParse(attribute("align")).data ??
                  null,
              }
            : {};
    return [
      sourceNode(
        type,
        attributes,
        children,
        source,
        from,
        to,
        source.slice(
          from,
          textblock
            ? (elementLocation?.startTag?.endOffset ?? from)
            : (children[0]?.from ?? elementLocation?.startTag?.endOffset ?? to),
        ),
        source.slice(
          textblock
            ? (elementLocation?.endTag?.startOffset ?? to)
            : (children.at(-1)?.to ??
                elementLocation?.endTag?.startOffset ??
                to),
          to,
        ),
      ),
    ];
  };
  const children = body && "childNodes" in body ? body.childNodes : [];
  return sourceDocument(
    blocks(children.flatMap((node) => build(node))),
    source,
    "html",
    body && "tagName" in body
      ? (body.sourceCodeLocation?.startTag?.endOffset ?? 0)
      : 0,
  );
}
