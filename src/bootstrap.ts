import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";

const prepared =
  getCurrentWindow().label === "host"
    ? invoke("host_lifecycle", {
        status: { phase: "loadingCode", message: null },
      })
    : Promise.resolve();
void prepared
  .then(() => import("./main"))
  .catch(async (error) => {
    const message = error instanceof Error ? error.message : String(error);
    document.getElementById("root")!.textContent =
      `Ink and Butter could not start: ${message}`;
    if (getCurrentWindow().label === "host")
      await invoke("host_lifecycle", { status: { phase: "failed", message } });
  });
