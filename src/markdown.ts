import MarkdownIt from "markdown-it";
import DOMPurify from "dompurify";
import type { PreviewInfo } from "./preview-model";

export function renderMarkdown(
  text: string,
  assets: Record<string, string> = {},
  inline = false,
) {
  const renderer = new MarkdownIt({
    html: false,
    linkify: false,
    typographer: false,
  });
  let tableCount = 0;
  renderer.renderer.rules.table_open = (
    tokens,
    index,
    options,
    _environment,
    self,
  ) => {
    tableCount += 1;
    return `<div class="markdown-table" role="region" aria-label="Table ${tableCount}" tabindex="0">${self.renderToken(tokens, index, options)}`;
  };
  renderer.renderer.rules.table_close = (
    tokens,
    index,
    options,
    _environment,
    self,
  ) => `${self.renderToken(tokens, index, options)}</div>`;
  for (const tag of ["th", "td"]) {
    renderer.renderer.rules[`${tag}_open`] = (
      tokens,
      index,
      options,
      _environment,
      self,
    ) =>
      `${self.renderToken(tokens, index, options)}<div class="markdown-table-cell">`;
    renderer.renderer.rules[`${tag}_close`] = (
      tokens,
      index,
      options,
      _environment,
      self,
    ) => `</div>${self.renderToken(tokens, index, options)}`;
  }
  const tokens = inline
    ? renderer.parseInline(text, {})
    : renderer.parse(text, {});
  const offsets = [0];
  for (const line of text.split("\n"))
    offsets.push(offsets.at(-1)! + line.length + 1);
  const sourceMap: PreviewInfo["manifest"]["sourceMap"] = [];
  for (const token of tokens) {
    if (
      !token.map ||
      token.hidden ||
      !(
        token.nesting === 1 ||
        ["fence", "code_block", "hr"].includes(token.type)
      )
    )
      continue;
    const identity = `source-${sourceMap.length}`;
    token.attrSet("id", identity);
    const from = Math.min(text.length, offsets[token.map[0]]);
    const to = Math.min(text.length, offsets[token.map[1]]);
    sourceMap.push({
      id: identity,
      source: { from, to, expectedText: text.slice(from, to) },
      target: { kind: "element", elementId: identity },
    });
  }
  const references = [
    ...new Set(
      tokens
        .flatMap((token) => token.children ?? [])
        .filter((token) => token.type === "image")
        .map((token) => String(token.attrGet("src") ?? ""))
        .filter(Boolean),
    ),
  ];
  const image = renderer.renderer.rules.image!;
  renderer.renderer.rules.image = (
    tokens,
    index,
    options,
    environment,
    self,
  ) => {
    const token = tokens[index];
    const reference = String(token.attrGet("src") ?? "");
    if (assets[reference]) {
      token.attrSet("src", assets[reference]);
      return image(tokens, index, options, environment, self);
    }
    return `<a data-inknb-reference href="${renderer.utils.escapeHtml(reference)}">${renderer.utils.escapeHtml(token.content || "Open figure")}</a>`;
  };
  const link = renderer.renderer.rules.link_open;
  renderer.renderer.rules.link_open = (
    tokens,
    index,
    options,
    environment,
    self,
  ) => {
    tokens[index].attrSet("data-inknb-reference", "");
    return link
      ? link(tokens, index, options, environment, self)
      : self.renderToken(tokens, index, options);
  };
  return {
    html: DOMPurify.sanitize(
      renderer.renderer.render(tokens, renderer.options, {}),
      {
        ALLOWED_URI_REGEXP:
          /^(?:inknb:\/\/aside\/[\da-f-]{36}\/[\da-f-]{36}$|(?:(?:f|ht)tps?|mailto|tel|callto|sms|cid|xmpp|matrix):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i,
      },
    ),
    references,
    sourceMap,
  };
}
