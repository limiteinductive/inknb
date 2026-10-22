import { z } from "zod";
import type { ChangeDesc } from "@codemirror/state";
import { relativeRectangleSchema } from "./geometry";

export const selectionSchema = z.object({
  from: z.number().int().nonnegative(),
  to: z.number().int().nonnegative(),
});

export const anchorSchema = selectionSchema.extend({
  quote: z.string(),
  before: z.string(),
  after: z.string(),
  status: z.enum(["attached", "changed", "detached"]),
  native: z
    .object({
      quote: z.string(),
      region: z
        .object({ identity: z.string(), rectangle: relativeRectangleSchema })
        .optional(),
      from: z.object({
        identity: z.string(),
        offset: z.number().int().nonnegative(),
      }),
      to: z.object({
        identity: z.string(),
        offset: z.number().int().nonnegative(),
      }),
    })
    .optional(),
});

export type Anchor = z.infer<typeof anchorSchema>;
export type Selection = z.infer<typeof selectionSchema>;

export function validateSelection(text: string, selection: Selection): void {
  selectionSchema.parse(selection);
  if (selection.from > selection.to || selection.to > text.length) {
    throw new Error("The passage is outside the document.");
  }
  for (const position of [selection.from, selection.to]) {
    const previous = text.charCodeAt(position - 1);
    const current = text.charCodeAt(position);
    if (
      previous >= 0xd800 &&
      previous <= 0xdbff &&
      current >= 0xdc00 &&
      current <= 0xdfff
    ) {
      throw new Error("The passage splits a Unicode character.");
    }
  }
}

export function captureAnchor(text: string, selection: Selection): Anchor {
  validateSelection(text, selection);
  return {
    from: selection.from,
    to: selection.to,
    quote: text.slice(selection.from, selection.to),
    before: text.slice(Math.max(0, selection.from - 48), selection.from),
    after: text.slice(selection.to, selection.to + 48),
    status: "attached",
  };
}

export function mapAnchor(
  nextText: string,
  anchor: Anchor,
  changes: ChangeDesc,
): Anchor {
  if (anchor.status === "detached") return anchor;
  const isCaret = anchor.from === anchor.to;
  let touched = false;
  let fromAssociation = 1;
  let toAssociation = isCaret ? 1 : -1;
  changes.iterChangedRanges((start, end) => {
    if (end > start && start === anchor.from) fromAssociation = -1;
    if (end > start && end === anchor.to) toAssociation = 1;
    if (
      (start < anchor.to && end > anchor.from) ||
      (start === end && start > anchor.from && start < anchor.to)
    )
      touched = true;
  });
  const from = changes.mapPos(anchor.from, fromAssociation);
  const to = Math.max(from, changes.mapPos(anchor.to, toAssociation));
  const status =
    !isCaret && from === to ? "detached" : touched ? "changed" : anchor.status;
  return { ...anchor, ...captureAnchor(nextText, { from, to }), status };
}
