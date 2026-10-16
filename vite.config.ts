import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import packageMetadata from "./package.json" with { type: "json" };
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const fingerprint = createHash("sha256");
const sources = [
  "package.json",
  "package-lock.json",
  "Cargo.toml",
  "Cargo.lock",
  "src-tauri/Cargo.toml",
  "src-tauri/build.rs",
  "src-tauri/tauri.conf.json",
  "app-icon.svg",
  "vite.config.ts",
  ...[
    "src",
    "crates",
    "src-tauri/src",
    "src-tauri/capabilities",
    "component-runtime",
  ].flatMap((directory) =>
    readdirSync(directory, { recursive: true }).map((entry) =>
      path.join(directory, String(entry)),
    ),
  ),
].sort();
for (const source of sources) {
  if (statSync(source).isFile())
    fingerprint.update(source).update(readFileSync(source));
}
const build = `${packageMetadata.version}+${fingerprint.digest("hex").slice(0, 12)}`;

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  define: { __INKNB_BUILD__: JSON.stringify(build) },
  server: { host: "127.0.0.1", port: 1420, strictPort: true },
});
