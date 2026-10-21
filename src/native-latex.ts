import { z } from "zod";
import { parse } from "@unified-latex/unified-latex-util-parse";
import {
  parseTabularSpec,
  printRaw as printColumn,
} from "@unified-latex/unified-latex-ctan/package/tabularx/index.js";
import type { TabularColumn } from "@unified-latex/unified-latex-ctan/package/tabularx/index.js";
import type {
  Node as LatexNode,
  Macro,
  Argument,
} from "@unified-latex/unified-latex-types";
import type { Mark, Node as DocumentNode } from "prosemirror-model";
import { nativeSchema } from "./native-schema";
import { sourceDocument, sourceNode, sourceText } from "./native-source";
import type { SourcePart } from "./native-source";

const environmentNameSchema = z
  .union([
    z.string(),
    z.object({ type: z.literal("string"), content: z.string() }),
  ])
  .transform((value) => (typeof value === "string" ? value : value.content));

export function importLatex(source: string): DocumentNode {
  let root: ReturnType<typeof parse>;
  try {
    root = parse(source);
  } catch {
    return sourceDocument(
      [
        sourceNode(
          "source_object",
          { label: "LaTeX source", original: source },
          [],
          source,
          0,
          source.length,
        ),
      ],
      source,
      "latex",
    );
  }
  const environment = root.content.find(
    (node) =>
      node.type === "environment" &&
      environmentNameSchema.parse(node.env) === "document",
  );
  const content =
    environment?.type === "environment" ? environment.content : root.content;
  const regionFrom = environment?.position
    ? source.indexOf("}", environment.position.start.offset) + 1
    : 0;
  const regionTo = environment?.position
    ? source.lastIndexOf("\\end{document}", environment.position.end.offset)
    : source.length;
  const argument = (
    node: Macro,
    from: number,
    to: number,
  ): { value: Argument | null; from: number; to: number } => {
    const value =
      node.args?.filter((candidate) => candidate.openMark === "{").at(-1) ??
      null;
    const start =
      value?.content[0]?.position?.start.offset ??
      source.indexOf("{", node.position?.end.offset ?? from) + 1;
    const end = source.lastIndexOf("}", to - 1);
    return { value, from: Math.max(from, start), to: Math.max(start, end) };
  };
  const build = (
    nodes: LatexNode[],
    from: number,
    to: number,
    inline = false,
    marks: readonly Mark[] = [],
  ): SourcePart[] => {
    const result: SourcePart[] = [];
    let paragraph: SourcePart[] = [];
    const append = (parts: SourcePart[], block = false) => {
      if (inline) {
        result.push(...parts);
        return;
      }
      if (!block) {
        paragraph.push(...parts);
        return;
      }
      if (paragraph.length) {
        result.push(
          sourceNode(
            "paragraph",
            {},
            paragraph,
            source,
            paragraph[0].from,
            paragraph.at(-1)!.to,
          ),
        );
        paragraph = [];
      }
      result.push(...parts);
    };
    for (const [index, node] of nodes.entries()) {
      const start = node.position?.start.offset ?? from;
      const end = nodes[index + 1]?.position?.start.offset ?? to;
      if (node.type === "verbatim") {
        const raw = source.slice(start, end);
        const opening = raw.indexOf("}") + 1;
        const closing = raw.lastIndexOf("\\end{");
        append(
          [
            sourceNode(
              "code_block",
              {},
              sourceText(
                node.content,
                source,
                start + opening,
                start + closing,
              ),
              source,
              start,
              end,
              raw.slice(0, opening),
              raw.slice(closing),
            ),
          ],
          true,
        );
        continue;
      }
      if (node.type === "parbreak") {
        append([], true);
        continue;
      }
      if (node.type === "whitespace") {
        if (inline || paragraph.length)
          append(sourceText(" ", source, start, end, marks));
        continue;
      }
      if (node.type === "string") {
        append(sourceText(node.content, source, start, end, marks));
        continue;
      }
      if (node.type === "inlinemath" || node.type === "displaymath") {
        const raw = source.slice(start, end);
        const delimiter =
          node.type === "inlinemath"
            ? raw.startsWith("\\(")
              ? "\\("
              : "$"
            : raw.startsWith("\\[")
              ? "\\["
              : "$$";
        const closing =
          delimiter === "\\(" ? "\\)" : delimiter === "\\[" ? "\\]" : delimiter;
        const close = raw.lastIndexOf(closing);
        append(
          [
            sourceNode(
              node.type === "inlinemath" ? "math" : "math_block",
              {
                value: raw.slice(
                  delimiter.length,
                  close < delimiter.length ? raw.length : close,
                ),
              },
              [],
              source,
              start,
              end,
              delimiter,
              closing,
              marks,
            ),
          ],
          node.type === "displaymath",
        );
        continue;
      }
      if (node.type === "group") {
        const mark = nativeSchema.marks.source_span.create({
          prefix: "{",
          suffix: "}",
        });
        append(
          build(
            node.content,
            start + 1,
            (node.position?.end.offset ?? end) - 1,
            true,
            [...marks, mark],
          ),
        );
        continue;
      }
      if (node.type === "macro") {
        const name = node.content;
        const literalCommands: Record<string, string> = {
          textbackslash: "\\",
          textasciitilde: "~",
          textasciicircum: "^",
          space: " ",
        };
        if (literalCommands[name]) {
          append(sourceText(literalCommands[name], source, start, end, marks));
          continue;
        }
        if (name === "par") {
          append([], true);
          continue;
        }
        if (["&", "%", "$", "#", "_", "{", "}", " "].includes(name)) {
          append(sourceText(name, source, start, end, marks));
          continue;
        }
        if (name === "\\") {
          append([
            sourceNode("hard_break", {}, [], source, start, end, "", "", marks),
          ]);
          continue;
        }
        if (
          [
            "section",
            "subsection",
            "subsubsection",
            "paragraph",
            "title",
          ].includes(name)
        ) {
          const selected = argument(node, start, end);
          const children = selected.value
            ? build(selected.value.content, selected.from, selected.to, true)
            : [];
          const level =
            name === "subsection"
              ? 2
              : name === "subsubsection"
                ? 3
                : name === "paragraph"
                  ? 4
                  : 1;
          append(
            [
              sourceNode(
                "heading",
                { level },
                children,
                source,
                start,
                end,
                source.slice(start, selected.from),
                source.slice(selected.to, end),
              ),
            ],
            true,
          );
          continue;
        }
        if (
          [
            "textbf",
            "emph",
            "textit",
            "texttt",
            "underline",
            "textcolor",
            "textrm",
            "textsf",
            "textnormal",
          ].includes(name)
        ) {
          const selected = argument(node, start, end);
          const type =
            name === "textbf"
              ? "strong"
              : name === "emph" || name === "textit"
                ? "em"
                : name === "texttt"
                  ? "code"
                  : name === "underline"
                    ? "underline"
                    : "source_span";
          const mark = nativeSchema.marks[type].create({
            prefix: source.slice(start, selected.from),
            suffix: source.slice(selected.to, end),
          });
          if (selected.value)
            append(
              build(selected.value.content, selected.from, selected.to, true, [
                ...marks,
                mark,
              ]),
            );
          continue;
        }
        if (name === "href" || name === "url") {
          const selected = argument(node, start, end);
          const destination = node.args?.find(
            (candidate) => candidate.openMark === "{",
          );
          const href =
            destination?.content
              .map((child) => (child.type === "string" ? child.content : ""))
              .join("") ?? "";
          const mark = nativeSchema.marks.link.create({
            href,
            title: null,
            prefix: source.slice(start, selected.from),
            suffix: source.slice(selected.to, end),
          });
          if (selected.value)
            append(
              build(selected.value.content, selected.from, selected.to, true, [
                ...marks,
                mark,
              ]),
            );
          continue;
        }
        if (name === "includegraphics") {
          const selected = argument(node, start, end);
          append([
            sourceNode(
              "image",
              {
                src: source.slice(selected.from, selected.to),
                alt: "Figure",
                title: null,
              },
              [],
              source,
              start,
              end,
            ),
          ]);
          continue;
        }
        if (name === "caption") {
          const selected = argument(node, start, end);
          const children = selected.value
            ? build(selected.value.content, selected.from, selected.to, true)
            : [];
          append(
            [
              sourceNode(
                "paragraph",
                {},
                children,
                source,
                start,
                end,
                source.slice(start, selected.from),
                source.slice(selected.to, end),
              ),
            ],
            true,
          );
          continue;
        }
        const silent = [
          "label",
          "maketitle",
          "centering",
          "small",
          "footnotesize",
          "hline",
          "toprule",
          "midrule",
          "bottomrule",
        ].includes(name);
        const selected = argument(node, start, end);
        const label = /^(?:cite|ref|eqref)/.test(name)
          ? `[${source.slice(selected.from, selected.to)}]`
          : silent
            ? ""
            : "Embedded content";
        append([
          sourceNode(
            "source_inline",
            { original: source.slice(start, end), label },
            [],
            source,
            start,
            end,
            "",
            "",
            marks,
          ),
        ]);
        continue;
      }
      if (node.type === "environment" || node.type === "mathenv") {
        const name = environmentNameSchema.parse(node.env);
        const openingEnd = source.indexOf("}", start) + 1;
        const closingStart = source.lastIndexOf(
          `\\end{${name}}`,
          node.position?.end.offset ?? end,
        );
        if (
          [
            "equation",
            "equation*",
            "align",
            "align*",
            "gather",
            "gather*",
            "displaymath",
          ].includes(name)
        ) {
          append(
            [
              sourceNode(
                "math_block",
                { value: source.slice(openingEnd, closingStart).trim() },
                [],
                source,
                start,
                end,
                source.slice(start, openingEnd),
                source.slice(closingStart, end),
              ),
            ],
            true,
          );
          continue;
        }
        if (name === "itemize" || name === "enumerate") {
          const entries: SourcePart[] = [];
          const items = node.content.flatMap((child, childIndex) =>
            child.type === "macro" && child.content === "item"
              ? [childIndex]
              : [],
          );
          for (const [itemIndex, childIndex] of items.entries()) {
            const item = node.content[childIndex];
            const itemFrom = item.position?.start.offset ?? openingEnd;
            const itemTo =
              node.content[items[itemIndex + 1]]?.position?.start.offset ??
              closingStart;
            const itemBody =
              item.type === "macro" ? (item.args?.at(-1)?.content ?? []) : [];
            const itemContent = [
              ...itemBody,
              ...node.content.slice(
                childIndex + 1,
                items[itemIndex + 1] ?? node.content.length,
              ),
            ];
            const children = build(
              itemContent,
              item.position?.end.offset ?? itemFrom,
              itemTo,
            );
            if (!children.length || children[0].node.type.name !== "paragraph")
              children.unshift(
                sourceNode(
                  "paragraph",
                  {},
                  [],
                  source,
                  item.position?.end.offset ?? itemFrom,
                  item.position?.end.offset ?? itemFrom,
                ),
              );
            entries.push(
              sourceNode(
                "list_item",
                {},
                children,
                source,
                itemFrom,
                itemTo,
                source.slice(itemFrom, children[0].from),
                source.slice(children.at(-1)!.to, itemTo),
              ),
            );
          }
          append(
            [
              sourceNode(
                name === "enumerate" ? "ordered_list" : "bullet_list",
                name === "enumerate" ? { order: 1 } : {},
                entries,
                source,
                start,
                end,
                source.slice(start, entries[0]?.from ?? closingStart),
                source.slice(entries.at(-1)?.to ?? closingStart, end),
              ),
            ],
            true,
          );
          continue;
        }
        if (name === "tabular" || name === "tabular*" || name === "tabularx") {
          const specification = node.args
            ?.filter((argument) => argument.openMark === "{")
            .at(-1);
          let columns: TabularColumn[] = [];
          try {
            columns = parseTabularSpec(specification?.content ?? []);
          } catch {
            columns = [];
          }
          const specificationFrom =
            specification?.content[0]?.position?.start.offset;
          const specificationTo = source.lastIndexOf(
            "}",
            (node.content[0]?.position?.start.offset ?? closingStart) - 1,
          );
          if (
            !columns.length ||
            specificationFrom === undefined ||
            specificationTo < specificationFrom
          ) {
            append(
              [
                sourceNode(
                  "source_object",
                  { label: "Table", original: source.slice(start, end) },
                  [],
                  source,
                  start,
                  end,
                ),
              ],
              true,
            );
            continue;
          }
          const rows: SourcePart[] = [];
          let cells: SourcePart[] = [];
          let cellNodes: LatexNode[] = [];
          let cellStart =
            node.content[0]?.position?.start.offset ?? specificationTo + 1;
          const flushCell = (boundary: number) => {
            while (
              ["whitespace", "parbreak"].includes(cellNodes[0]?.type ?? "")
            )
              cellNodes.shift();
            while (
              ["whitespace", "parbreak"].includes(cellNodes.at(-1)?.type ?? "")
            )
              cellNodes.pop();
            const cellFrom = cellNodes[0]?.position?.start.offset ?? cellStart;
            const cellTo = Math.max(
              cellFrom,
              boundary -
                (source.slice(cellFrom, boundary).match(/\s*$/)?.[0].length ??
                  0),
            );
            const children = build(cellNodes, cellFrom, cellTo, true);
            const paragraph = sourceNode(
              "paragraph",
              {},
              children,
              source,
              cellFrom,
              cellTo,
            );
            cells.push(
              sourceNode(
                rows.length === 0 ? "table_header" : "table_cell",
                {
                  sourceColumn: columns[cells.length]
                    ? {
                        source: printColumn(columns[cells.length]),
                        alignment: ["left", "right", "center"].includes(
                          columns[cells.length].alignment.alignment,
                        )
                          ? columns[cells.length].alignment.alignment
                          : null,
                      }
                    : null,
                  alignment:
                    columns[cells.length] &&
                    ["left", "right", "center"].includes(
                      columns[cells.length].alignment.alignment,
                    )
                      ? columns[cells.length].alignment.alignment
                      : null,
                },
                [paragraph],
                source,
                cellFrom,
                cellTo,
              ),
            );
            cellNodes = [];
          };
          for (const child of node.content) {
            if (
              child.type === "macro" &&
              ["hline", "toprule", "midrule", "bottomrule"].includes(
                child.content,
              )
            )
              continue;
            if (child.type === "string" && child.content === "&") {
              flushCell(child.position?.start.offset ?? closingStart);
              cellStart = child.position?.end.offset ?? closingStart;
              continue;
            }
            if (child.type === "macro" && child.content === "\\") {
              flushCell(child.position?.start.offset ?? closingStart);
              rows.push(
                sourceNode(
                  "table_row",
                  {},
                  cells,
                  source,
                  cells[0].from,
                  cells.at(-1)!.to,
                ),
              );
              cells = [];
              cellStart = child.position?.end.offset ?? closingStart;
              continue;
            }
            cellNodes.push(child);
          }
          if (cellNodes.some((child) => child.type !== "whitespace"))
            flushCell(closingStart);
          if (cells.length)
            rows.push(
              sourceNode(
                "table_row",
                {},
                cells,
                source,
                cells[0].from,
                cells.at(-1)!.to,
              ),
            );
          if (
            rows.length &&
            rows.every((row) => row.node.childCount === columns.length)
          ) {
            append(
              [
                sourceNode(
                  "table",
                  {
                    sourceColumns: columns.map((column) => printColumn(column)),
                    columnRange: {
                      from: specificationFrom - start,
                      to: specificationTo - start,
                    },
                  },
                  rows,
                  source,
                  start,
                  end,
                  source.slice(start, rows[0].from),
                  source.slice(rows.at(-1)!.to, end),
                ),
              ],
              true,
            );
            continue;
          }
          append(
            [
              sourceNode(
                "source_object",
                { label: "Table", original: source.slice(start, end) },
                [],
                source,
                start,
                end,
              ),
            ],
            true,
          );
          continue;
        }
        if (
          [
            "figure",
            "figure*",
            "table",
            "table*",
            "center",
            "quote",
            "quotation",
            "abstract",
            "document",
          ].includes(name)
        ) {
          const children = build(node.content, openingEnd, closingStart);
          if (!children.length)
            children.push(
              sourceNode("paragraph", {}, [], source, openingEnd, openingEnd),
            );
          append(
            [
              sourceNode(
                name === "quote" || name === "quotation"
                  ? "blockquote"
                  : "section",
                {},
                children,
                source,
                start,
                end,
                source.slice(start, children[0].from),
                source.slice(children.at(-1)!.to, end),
              ),
            ],
            true,
          );
          continue;
        }
        append(
          [
            sourceNode(
              "source_object",
              {
                original: source.slice(start, end),
                label: name.includes("tikz") ? "Figure" : "Embedded content",
              },
              [],
              source,
              start,
              end,
            ),
          ],
          true,
        );
        continue;
      }
      append([
        sourceNode(
          "source_inline",
          {
            original: source.slice(start, end),
            label: node.type === "comment" ? "" : "Embedded content",
          },
          [],
          source,
          start,
          end,
          "",
          "",
          marks,
        ),
      ]);
    }
    if (paragraph.length)
      result.push(
        sourceNode(
          "paragraph",
          {},
          paragraph,
          source,
          paragraph[0].from,
          paragraph.at(-1)!.to,
        ),
      );
    return result;
  };
  const document = sourceDocument(
    build(content, regionFrom, regionTo),
    source,
    "latex",
    regionFrom,
  );
  const loadedPackages = root.content.flatMap((node) => {
    if (
      node.type !== "macro" ||
      !["usepackage", "RequirePackage"].includes(node.content)
    )
      return [];
    const argument = node.args
      ?.filter((argument) => argument.openMark === "{")
      .at(-1);
    return (
      argument?.content
        .filter((node) => node.type === "string")
        .map((node) => node.content)
        .join("")
        .split(",")
        .map((name) => name.trim())
        .filter(Boolean) ?? []
    );
  });
  return document.type.createChecked(
    {
      ...document.attrs,
      loadedPackages,
      documentStart: environment?.position?.start.offset ?? null,
    },
    document.content,
  );
}
