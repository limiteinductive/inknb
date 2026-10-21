import { z } from "zod";

export const pageBindingSchema = z.object({
  identity: z.string().uuid(),
  elementId: z.string().min(1).max(200),
  role: z.enum(["text", "item", "container"]),
});
export const pageDefinitionSchema = z.object({ bindings: z.array(pageBindingSchema).min(1).max(10000) });
export const documentPageSchema = z.object({ artifactId: z.string().regex(/^[a-f0-9]{64}$/), title: z.string() });
export const pageDraftSchema = z.object({ content: z.json(), expectedContent: z.json() });
export const pageNodeBoundsSchema = z.object({
  identity: z.string().uuid(),
  role: z.enum(["text", "item", "container"]),
  label: z.string().max(200),
  left: z.number().finite(),
  top: z.number().finite(),
  width: z.number().finite().nonnegative(),
  height: z.number().finite().nonnegative(),
  fontFamily: z.string().max(300),
  fontSize: z.number().finite().min(1).max(300),
  fontWeight: z.string().max(50),
  lineHeight: z.number().finite().min(1).max(600),
});
export type PageBinding = z.infer<typeof pageBindingSchema>;
export type PageNodeBounds = z.infer<typeof pageNodeBoundsSchema>;
export type PageDraft = z.infer<typeof pageDraftSchema>;
