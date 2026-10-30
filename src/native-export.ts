import {
  MarkdownSerializer,
  defaultMarkdownSerializer,
} from "prosemirror-markdown";
import type { Mark, Node as DocumentNode } from "prosemirror-model";
import {
  nativeSchema,
  semanticSignature,
  sourceFormatSchema,
} from "./native-schema";
import type { SourceFormat } from "./native-schema";
import { sourceSpanSchema } from "./native-source";
import type { SourceProjection, SourceSpan } from "./native-source";
import { z } from "zod";
import { parse, parseMinimal } from "@unified-latex/unified-latex-util-parse";
import {
  parseTabularSpec,
  printRaw as printColumn,
} from "@unified-latex/unified-latex-ctan/package/tabularx/index.js";

const sourceColumnSchema = z.object({
  source: z.string(),
  alignment: z.enum(["left", "right", "center"]).nullable(),
});
const columnRangeSchema = z.object({
  from: z.number().int().nonnegative(),
  to: z.number().int().nonnegative(),
});

function tableSeparator(
  source: string,
  separator: "&" | "\\\\",
  first: boolean,
): string {
  const delimiter = parse(source).content.find((node) =>
    separator === "&"
      ? node.type === "string" && node.content === "&"
      : node.type === "macro" && node.content === "\\",
  );
  if (!delimiter)
    return first ? source : `${separator === "&" ? " & " : " \\\\\n"}${source}`;
  if (!first) return source;
  let end = delimiter.position!.end.offset;
  if (delimiter.type === "macro")
    for (const argument of delimiter.args ?? [])
      for (const child of argument.content)
        if (child.position)
          end = Math.max(
            end,
            child.position.end.offset + argument.closeMark.length,
          );
  return source.slice(0, delimiter.position!.start.offset) + source.slice(end);
}

export function unchangedSource(node: DocumentNode): string | null {
  return typeof node.attrs.source === "string" &&
    node.attrs.signature === semanticSignature(node)
    ? node.attrs.source
    : null;
}

export function escapedText(value: string, format: SourceFormat): string {
  if (format === "html")
    return value
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/ {2,}/g, (spaces) => " " + "&#32;".repeat(spaces.length - 1));
  if (format === "latex")
    return value
      .replace(/[\\{}$&#%_^~]/g, (character) => {
        if (character === "\\") return "\\textbackslash{}";
        if (character === "~") return "\\textasciitilde{}";
        if (character === "^") return "\\textasciicircum{}";
        return `\\${character}`;
      })
      .replace(
        / {2,}/g,
        (spaces) => " " + "\\space{}".repeat(spaces.length - 1),
      );
  return value;
}

export function markDelimiters(
  mark: Mark,
  format: SourceFormat,
  originalFormat: SourceFormat,
): [string, string] {
  if (
    format === originalFormat &&
    typeof mark.attrs.prefix === "string" &&
    typeof mark.attrs.suffix === "string"
  )
    return [mark.attrs.prefix, mark.attrs.suffix];
  const type = mark.type.name;
  if (format === "html") {
    const tag =
      type === "em"
        ? "em"
        : type === "strong"
          ? "strong"
          : type === "code"
            ? "code"
            : type === "strike"
              ? "s"
              : type === "underline"
                ? "u"
                : null;
    if (tag) return [`<${tag}>`, `</${tag}>`];
    if (type === "link")
      return [
        `<a href="${escapedText(String(mark.attrs.href), "html")}">`,
        "</a>",
      ];
  }
  if (format === "latex") {
    const command =
      type === "em"
        ? "emph"
        : type === "strong"
          ? "textbf"
          : type === "code"
            ? "texttt"
            : type === "underline"
              ? "underline"
              : type === "strike"
                ? "sout"
                : null;
    if (command) return [`\\${command}{`, "}"];
    if (type === "link")
      return [`\\href{${escapedText(String(mark.attrs.href), "latex")}}{`, "}"];
  }
  return ["", ""];
}

export function serializeDocument(
  document: DocumentNode,
  format: SourceFormat,
): string {
  const originalFormat = sourceFormatSchema.parse(
    document.attrs.syntax ?? document.attrs.format,
  );
  if (format === originalFormat) {
    const original = unchangedSource(document);
    if (original !== null) return original;
  }
  const markdown = new MarkdownSerializer(
    {
      ...defaultMarkdownSerializer.nodes,
      image(state, node, parent, index) {
        if (!/\s/.test(String(node.attrs.src))) {
          defaultMarkdownSerializer.nodes.image(state, node, parent, index);
          return;
        }
        const destination = String(node.attrs.src)
          .replace(/[<>\\]/g, "\\$&")
          .replace(/\r/g, "%0D")
          .replace(/\n/g, "%0A");
        const title = node.attrs.title
          ? ` "${String(node.attrs.title).replace(/["\\]/g, "\\$&")}"`
          : "";
        state.write(
          `![${state.esc(String(node.attrs.alt ?? ""))}](<${destination}>${title})`,
        );
      },
      text(state, node, parent, index) {
        defaultMarkdownSerializer.nodes.text(
          state,
          nativeSchema.text(
            node.text!.replace(/^ +| +$/g, (spaces) =>
              "&#32;".repeat(spaces.length),
            ),
            node.marks,
          ),
          parent,
          index,
        );
      },
      list_item(state, node) {
        if (node.attrs.checked !== null)
          state.write(node.attrs.checked ? "[x] " : "[ ] ");
        state.renderContent(node);
      },
      math(state, node) {
        state.write(`$${String(node.attrs.value)}$`);
      },
      math_block(state, node) {
        state.write(`$$\n${String(node.attrs.value)}\n$$`);
        state.closeBlock(node);
      },
      source_inline(state, node) {
        state.write(String(node.attrs.original));
      },
      source_object(state, node) {
        if (originalFormat !== "markdown")
          throw Error(
            "This embedded content needs conversion before Markdown export.",
          );
        state.write(String(node.attrs.original));
        state.closeBlock(node);
      },
      abstract(state, node) {
        state.write("## Abstract\n\n");
        state.renderContent(node);
      },
      section(state, node) {
        state.renderContent(node);
      },
      table(state, node) {
        const rows: string[] = [];
        node.forEach((row) => {
          const cells: string[] = [];
          row.forEach((cell) => {
            cells.push(
              markdown
                .serialize(nativeSchema.nodes.doc.create(null, cell.content))
                .trim()
                .replace(/\n+/g, "<br>")
                .replace(/(?<!\\)\|/g, "\\|"),
            );
          });
          rows.push(`| ${cells.join(" | ")} |`);
        });
        const alignment: string[] = [];
        node.firstChild?.forEach((cell) =>
          alignment.push(
            cell.attrs.alignment === "right"
              ? "---:"
              : cell.attrs.alignment === "center"
                ? ":---:"
                : "---",
          ),
        );
        if (rows.length) rows.splice(1, 0, `| ${alignment.join(" | ")} |`);
        state.write(rows.join("\n"));
        state.closeBlock(node);
      },
    },
    {
      ...defaultMarkdownSerializer.marks,
      strike: {
        open: "~~",
        close: "~~",
        mixable: true,
        expelEnclosingWhitespace: true,
      },
      underline: { open: "<u>", close: "</u>" },
      source_span: {
        open: (_state, mark) =>
          originalFormat === "markdown" ? String(mark.attrs.prefix ?? "") : "",
        close: (_state, mark) =>
          originalFormat === "markdown" ? String(mark.attrs.suffix ?? "") : "",
      },
    },
  );
  const renderInline = (node: DocumentNode): string => {
    let output = "";
    let active: readonly Mark[] = [];
    node.forEach((child) => {
      let shared = 0;
      while (
        shared < active.length &&
        shared < child.marks.length &&
        active[shared].eq(child.marks[shared])
      )
        shared += 1;
      for (let index = active.length - 1; index >= shared; index -= 1)
        output += markDelimiters(active[index], format, originalFormat)[1];
      for (const mark of child.marks.slice(shared))
        output += markDelimiters(mark, format, originalFormat)[0];
      output += child.isText
        ? escapedText(child.text ?? "", format)
        : render(child);
      active = child.marks;
    });
    for (const mark of [...active].reverse())
      output += markDelimiters(mark, format, originalFormat)[1];
    return output;
  };
  const render = (node: DocumentNode): string => {
    if (format === originalFormat) {
      const original = unchangedSource(node);
      if (original !== null) return original;
    }
    const type = node.type.name;
    if (node.isText) return escapedText(node.text ?? "", format);
    if (
      type === "source_object" ||
      type === "source_inline" ||
      type === "title_block"
    ) {
      if (format !== originalFormat)
        throw Error(
          "This embedded content needs conversion before changing its export format.",
        );
      return String(node.attrs.original);
    }
    if (type === "image") {
      if (format === "html")
        return `<img src="${escapedText(String(node.attrs.src), "html")}" alt="${escapedText(String(node.attrs.alt ?? ""), "html")}">`;
      if (format === "latex")
        return `\\includegraphics{${String(node.attrs.src)}}`;
      return String(node.attrs.alt ?? "Figure");
    }
    if (type === "math" || type === "math_block") {
      if (format === "latex")
        return `${typeof node.attrs.prefix === "string" && originalFormat === "latex" ? node.attrs.prefix : type === "math" ? "$" : "\\["}${String(node.attrs.value)}${typeof node.attrs.suffix === "string" && originalFormat === "latex" ? node.attrs.suffix : type === "math" ? "$" : "\\]"}`;
      if (format === "html")
        return `<${type === "math" ? "span" : "div"} data-inknb-equation="${escapedText(String(node.attrs.value), "html")}">${escapedText(String(node.attrs.value), "html")}</${type === "math" ? "span" : "div"}>`;
      return String(node.attrs.value);
    }
    if (type === "hard_break")
      return format === "html" ? "<br>" : format === "latex" ? "\\\\\n" : "\n";
    if (type === "horizontal_rule")
      return format === "html"
        ? "<hr>"
        : format === "latex"
          ? "\\par\\noindent\\rule{\\linewidth}{0.4pt}\n"
          : "\n";
    if (format === "markdown")
      return markdown.serialize(nativeSchema.nodes.doc.create(null, [node]));
    const inline = node.isTextblock;
    let prefix = "";
    let suffix = "";
    if (format === "html") {
      const tag =
        type === "paragraph"
          ? "p"
          : type === "heading"
            ? `h${String(node.attrs.level)}`
            : type === "bullet_list"
              ? "ul"
              : type === "ordered_list"
                ? "ol"
                : type === "list_item"
                  ? "li"
                  : type === "blockquote"
                    ? "blockquote"
                    : type === "code_block"
                      ? "pre"
                      : type === "table"
                        ? "table"
                        : type === "table_row"
                          ? "tr"
                          : type === "table_header"
                            ? "th"
                            : type === "table_cell"
                              ? "td"
                              : "section";
      prefix = `<${tag}>`;
      suffix = `</${tag}>`;
    } else if (format === "latex") {
      if (type === "heading") {
        const command =
          Number(node.attrs.level) === 1
            ? "section"
            : Number(node.attrs.level) === 2
              ? "subsection"
              : "subsubsection";
        prefix = `\\${command}{`;
        suffix = "}";
      }
      if (
        type === "bullet_list" ||
        type === "ordered_list" ||
        type === "blockquote" ||
        type === "code_block"
      ) {
        const environment =
          type === "bullet_list"
            ? "itemize"
            : type === "ordered_list"
              ? "enumerate"
              : type === "blockquote"
                ? "quote"
                : "verbatim";
        prefix = `\\begin{${environment}}\n`;
        suffix = `\n\\end{${environment}}`;
      }
      if (type === "list_item") prefix = "\\item ";
      if (type === "table") {
        prefix = `\\begin{tabular}{${"l".repeat(node.firstChild?.childCount ?? 1)}}\n`;
        suffix = " \\\\\n\\end{tabular}";
      }
    }
    if (format === originalFormat && typeof node.attrs.prefix === "string")
      prefix = node.attrs.prefix;
    if (format === originalFormat && typeof node.attrs.suffix === "string")
      suffix = node.attrs.suffix;
    if (type === "table" && format === "latex") {
      const columns: string[] = [];
      const count = node.firstChild?.childCount ?? 0;
      for (let columnIndex = 0; columnIndex < count; columnIndex += 1) {
        let specification: z.infer<typeof sourceColumnSchema> | null = null;
        let alignment = node.firstChild!.child(columnIndex).attrs.alignment;
        node.forEach((row) => {
          if (!specification && row.child(columnIndex).attrs.sourceColumn) {
            specification = sourceColumnSchema.parse(
              row.child(columnIndex).attrs.sourceColumn,
            );
            alignment = row.child(columnIndex).attrs.alignment;
          }
        });
        if (!specification) {
          columns.push(
            alignment === "right" ? "r" : alignment === "center" ? "c" : "l",
          );
          continue;
        }
        const stored = sourceColumnSchema.parse(specification);
        let source = stored.source;
        if (alignment && alignment !== stored.alignment) {
          const column = parseTabularSpec(parseMinimal(source).content)[0];
          column.alignment = { type: "alignment", alignment };
          source = printColumn(column);
        }
        columns.push(source);
      }
      if (
        node.attrs.columnRange &&
        JSON.stringify(columns) !== JSON.stringify(node.attrs.sourceColumns)
      ) {
        const range = columnRangeSchema.parse(node.attrs.columnRange);
        prefix =
          prefix.slice(0, range.from) +
          columns.join("") +
          prefix.slice(range.to);
      }
      if (!node.attrs.columnRange)
        prefix = `\\begin{tabular}{${columns.join("")}}\n`;
    }
    if (type === "heading" && format === "html") {
      prefix = prefix.replace(/^<h[1-6]\b/i, `<h${String(node.attrs.level)}`);
      suffix = suffix.replace(/<\/h[1-6]>/i, `</h${String(node.attrs.level)}>`);
    }
    if (type === "heading" && format === "latex") {
      const command = [
        "section",
        "subsection",
        "subsubsection",
        "paragraph",
        "subparagraph",
      ][Math.min(4, Number(node.attrs.level) - 1)];
      prefix = prefix.replace(
        /^\\(?:section|subsection|subsubsection|paragraph|subparagraph)\b/,
        `\\${command}`,
      );
    }
    let content = "";
    if (type === "code_block")
      content =
        format === "html"
          ? escapedText(node.textContent, "html")
          : node.textContent;
    else if (inline) content = renderInline(node);
    else
      node.forEach((child, _offset, index) => {
        let before = index ? "\n\n" : "";
        if (type === "table_row")
          before = index && format === "latex" ? " & " : "";
        if (type === "table")
          before = index && format === "latex" ? " \\\\\n" : "";
        if (
          type === "table_cell" ||
          type === "table_header" ||
          type === "list_item"
        )
          before = index ? "\n\n" : "";
        if (
          format === originalFormat &&
          typeof child.attrs.before === "string" &&
          (child.attrs.before || typeof child.attrs.source === "string")
        )
          before = child.attrs.before;
        if (format === "latex" && type === "table_row")
          before = tableSeparator(before, "&", index === 0);
        if (format === "latex" && type === "table")
          before = tableSeparator(before, "\\\\", index === 0);
        content += before + render(child);
      });
    return prefix + content + suffix;
  };
  let output =
    format === originalFormat
      ? String(document.attrs.prefix ?? "")
      : format === "latex"
        ? "\\documentclass{article}\n\\usepackage{amsmath,amssymb,graphicx,hyperref}\n\\begin{document}\n"
        : format === "html"
          ? '<!doctype html><html><head><meta charset="utf-8"></head><body>\n'
          : "";
  document.forEach((node, _offset, index) => {
    const before =
      format === originalFormat &&
      typeof node.attrs.before === "string" &&
      (node.attrs.before || typeof node.attrs.source === "string")
        ? node.attrs.before
        : index
          ? "\n\n"
          : "";
    output += before + render(node);
  });
  output +=
    format === originalFormat
      ? String(document.attrs.suffix ?? "")
      : format === "latex"
        ? "\n\\end{document}\n"
        : format === "html"
          ? "\n</body></html>\n"
          : "";
  if (format === "latex") {
    const required = new Set<string>();
    document.descendants((node) => {
      if (node.type.name === "image" && node.attrs.source === null)
        required.add("graphicx");
      if (
        (node.type.name === "math" || node.type.name === "math_block") &&
        unchangedSource(node) === null
      ) {
        required.add("amsmath");
        required.add("amssymb");
      }
      for (const mark of node.marks) {
        if (mark.type.name === "link" && mark.attrs.prefix === null)
          required.add("hyperref");
        if (mark.type.name === "strike") required.add("ulem");
      }
    });
    const loaded = new Set<string>(
      format === originalFormat
        ? document.attrs.loadedPackages
        : ["amsmath", "amssymb", "graphicx", "hyperref"],
    );
    const missing = [...required].filter((name) => !loaded.has(name)).sort();
    const start =
      format === originalFormat
        ? document.attrs.documentStart
        : output.indexOf("\\begin{document}");
    if (missing.length && typeof start === "number" && start >= 0)
      output =
        output.slice(0, start) +
        missing
          .map(
            (name) =>
              `\\usepackage${name === "ulem" ? "[normalem]" : ""}{${name}}\n`,
          )
          .join("") +
        output.slice(start);
  }
  return output;
}

export function originalProjection(document: DocumentNode): SourceProjection {
  return {
    text: String(document.attrs.source ?? ""),
    spans: sourceSpanSchema.array().parse(document.attrs.spans),
  };
}

export function plainProjection(document: DocumentNode): SourceProjection {
  let text = "";
  const spans: SourceSpan[] = [];
  const render = (node: DocumentNode, position: number) => {
    if (node.isText) {
      const from = text.length;
      text += node.text;
      spans.push({
        from,
        to: text.length,
        documentFrom: position,
        documentTo: position + node.nodeSize,
      });
      return;
    }
    if (node.isLeaf) {
      const from = text.length;
      text +=
        node.type.name === "hard_break"
          ? "\n"
          : node.type.name === "image"
            ? String(node.attrs.alt ?? "Figure")
            : node.type.name === "math" || node.type.name === "math_block"
              ? String(node.attrs.value)
              : String(node.attrs.label ?? "");
      spans.push({
        from,
        to: text.length,
        documentFrom: position,
        documentTo: position + node.nodeSize,
      });
      return;
    }
    node.forEach((child, offset, index) => {
      if (index && !node.inlineContent)
        text += node.type.name === "table_row" ? "\t" : "\n\n";
      render(child, position + offset + (node.type.name === "doc" ? 0 : 1));
    });
  };
  render(document, 0);
  return { text, spans };
}
