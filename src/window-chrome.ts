import { invoke } from "@tauri-apps/api/core";
import { z } from "zod";

export const windowChromeSchema = z.object({
  mode: z.enum([
    "windowed",
    "enteringFullscreen",
    "fullscreen",
    "exitingFullscreen",
  ]),
  toolbarHeight: z.number().positive(),
  leadingInset: z.number().nonnegative(),
  windowedControls: z.array(
    z.object({
      left: z.number(),
      top: z.number(),
      width: z.number().positive(),
      height: z.number().positive(),
    }),
  ),
});

export async function readWindowChrome() {
  return windowChromeSchema.parse(await invoke("window_chrome"));
}
