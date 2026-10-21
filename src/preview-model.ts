import { z } from "zod";

import { relativeRectangleSchema } from "./geometry";
import { pageDefinitionSchema } from "./document-page";

export const previewTargetSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("html"),
    elementId: z.string().nullable(),
    endElementId: z.string().nullable(),
    rectangle: relativeRectangleSchema,
  }),
  z.object({
    kind: z.literal("pdf"),
    regions: z
      .array(
        z.object({
          page: z.number().int().positive(),
          rectangle: relativeRectangleSchema,
        }),
      )
      .min(1)
      .max(512),
  }),
]);

export const previewAnchorSchema = z.object({
  artifactId: z.string().regex(/^[a-f0-9]{64}$/),
  sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
  quote: z.string().max(100000),
  target: previewTargetSchema,
  capture: z
    .object({
      id: z.string().regex(/^[a-f0-9]{64}$/),
      width: z.number().int().positive(),
      height: z.number().int().positive(),
    })
    .nullable()
    .default(null),
});
export type PreviewAnchor = z.infer<typeof previewAnchorSchema>;

export const previewReferenceSchema = z.object({
  artifactId: z.string().regex(/^[a-f0-9]{64}$/),
  sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
  kind: z.enum(["html", "pdf"]),
  title: z.string(),
  publishedAt: z.string(),
});
export type PreviewReference = z.infer<typeof previewReferenceSchema>;

export const previewBuildSchema = z.object({
  sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
  status: z.enum(["building", "failed"]),
  message: z.string().max(2000).nullable(),
});

export const previewInfoSchema = z.object({
  artifactId: z.string().regex(/^[a-f0-9]{64}$/),
  sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
  sourceText: z.string(),
  manifest: z.object({
    version: z.literal(1),
    documentId: z.string().uuid(),
    kind: z.enum(["html", "pdf"]),
    title: z.string(),
    entry: z.string(),
    source: z.string(),
    page: pageDefinitionSchema.nullable().optional(),
    sourceMap: z.array(
      z.object({
        id: z.string(),
        source: z.object({
          from: z.number().int().nonnegative(),
          to: z.number().int().nonnegative(),
          expectedText: z.string(),
        }),
        target: z.discriminatedUnion("kind", [
          z.object({ kind: z.literal("element"), elementId: z.string() }),
          z.object({
            kind: z.literal("page"),
            page: z.number().int().positive(),
            rectangle: relativeRectangleSchema,
          }),
        ]),
      }),
    ),
  }),
});
export type PreviewInfo = z.infer<typeof previewInfoSchema>;

export const previewActionSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("aside-width"),
    width: z.number().finite().min(280),
  }),
  z.object({ kind: z.literal("loading"), artifactId: z.string() }),
  z.object({ kind: z.literal("ready"), information: previewInfoSchema }),
  z.object({
    kind: z.literal("failed"),
    artifactId: z.string(),
    error: z.string(),
  }),
  z.object({
    kind: z.literal("selected"),
    information: previewInfoSchema,
    anchor: previewAnchorSchema,
    bounds: z.object({
      left: z.number().finite(),
      top: z.number().finite(),
      right: z.number().finite(),
      bottom: z.number().finite(),
    }),
  }),
  z.object({
    kind: z.literal("aside"),
    anchor: previewAnchorSchema,
    information: previewInfoSchema,
  }),
  z.object({ kind: z.literal("error"), error: z.string() }),
  z.object({
    kind: z.enum([
      "clear",
      "latest",
      "fullscreen",
      "close",
      "detach",
      "dock",
      "connected",
      "closed",
    ]),
  }),
]);
export type PreviewAction = z.infer<typeof previewActionSchema>;

export async function textFingerprint(text: string): Promise<string> {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return [...new Uint8Array(bytes)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

export function previewLocation(anchor: PreviewAnchor): string {
  if (anchor.target.kind === "html")
    return anchor.quote ? "Preview passage" : "Preview region";
  const pages = [
    ...new Set(anchor.target.regions.map((region) => region.page)),
  ];
  return pages.length === 1
    ? `Preview · page ${pages[0]}`
    : `Preview · pages ${pages[0]}–${pages.at(-1)}`;
}
