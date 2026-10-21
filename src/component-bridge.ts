import { z } from "zod";
import { pointerPositionSchema } from "./geometry";

export const componentMessage = z.discriminatedUnion("type", [
  pointerPositionSchema.extend({ inknb: z.literal(1) }),
  z.object({ inknb: z.literal(1), type: z.literal("ready") }),
  z.object({
    inknb: z.literal(1),
    type: z.literal("contextmenu"),
    left: z.number().finite(),
    top: z.number().finite(),
    editable: z.boolean(),
    copy: z.boolean(),
  }),
  z.object({
    inknb: z.literal(1),
    type: z.literal("height"),
    height: z.number().finite().min(0).max(100000),
  }),
  z.object({
    inknb: z.literal(1),
    type: z.literal("error"),
    error: z.string().max(2000),
  }),
  z.object({
    inknb: z.literal(1),
    type: z.literal("event"),
    requestId: z.string(),
    name: z.string().min(1).max(100),
    payload: z.json(),
  }),
  z.object({
    inknb: z.literal(1),
    type: z.literal("state"),
    requestId: z.string(),
    revision: z.number().int().nonnegative(),
    state: z.json(),
  }),
  z.object({
    inknb: z.literal(1),
    type: z.literal("response"),
    requestId: z.string(),
    result: z.json().optional(),
    error: z.string().max(2000).optional(),
  }),
]);

interface ComponentRuntime {
  status: "loading" | "ready" | "error";
  error: string | null;
  request: (
    type: "inspect" | "action",
    payload: Record<string, unknown>,
  ) => Promise<unknown>;
}

export const componentRuntimes = new Map<string, ComponentRuntime>();

export function checkComponentValue(value: unknown): void {
  if (new TextEncoder().encode(JSON.stringify(value)).length > 256 * 1024)
    throw new Error("Component data and state must each stay below 256 KiB.");
}
