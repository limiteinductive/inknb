import { z } from "zod";

export const pointerPositionSchema = z.object({
  type: z.literal("pointerPosition"),
  top: z.number().finite().nullable(),
});

export function reportFramePointer(
  frame: HTMLIFrameElement,
  top: number | null,
): void {
  frame.dispatchEvent(
    new CustomEvent("inknb-frame-pointer", {
      bubbles: true,
      detail: top === null ? null : frame.getBoundingClientRect().top + top,
    }),
  );
}

export const relativeRectangleSchema = z
  .object({
    left: z.number().finite().min(0).max(1),
    top: z.number().finite().min(0).max(1),
    width: z.number().finite().positive().max(1),
    height: z.number().finite().positive().max(1),
  })
  .refine(
    (value) =>
      value.left + value.width <= 1.000001 &&
      value.top + value.height <= 1.000001,
  );
