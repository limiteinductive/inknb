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
  "src-tauri/Info.plist",
  "app-icon.png",
  "vite.config.ts",
  "docs/previews.md",
  "docs/components.md",
  ...[
    "src",
    "crates",
    "src-tauri/src",
    "src-tauri/capabilities",
    "component-runtime",
    "preview-runtime",
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
const pdfAssets = new Map<string, string>(
  ["cmaps", "standard_fonts", "wasm", "iccs"].flatMap((directory) =>
    readdirSync(`node_modules/pdfjs-dist/${directory}`, {
      recursive: true,
    }).flatMap((entry) => {
      const source = `node_modules/pdfjs-dist/${directory}/${entry}`;
      return statSync(source).isFile()
        ? [[`pdfjs/${directory}/${entry}`, source] as const]
        : [];
    }),
  ),
);

pdfAssets.set("pdfjs/LICENSE", "node_modules/pdfjs-dist/LICENSE");

export default defineConfig({
  plugins: [
    react(),
    {
      name: "pdf-assets",
      configureServer(server) {
        server.middlewares.use((request, response, next) => {
          const source = pdfAssets.get(
            (request.url ?? "").split("?")[0].slice(1),
          );
          if (!source) return next();
          response.setHeader(
            "Content-Type",
            source.endsWith(".wasm")
              ? "application/wasm"
              : "application/octet-stream",
          );
          response.end(readFileSync(source));
        });
      },
      generateBundle() {
        for (const [fileName, source] of pdfAssets)
          this.emitFile({
            type: "asset",
            fileName,
            source: readFileSync(source),
          });
      },
    },
  ],
  clearScreen: false,
  define: { __INKNB_BUILD__: JSON.stringify(build) },
  server: { host: "127.0.0.1", port: 1420, strictPort: true },
});
