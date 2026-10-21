import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import PreviewArtifact from "./PreviewArtifact";
import type { ArtifactProps } from "./PreviewArtifact";
import { previewInfoSchema } from "./preview-model";
import type { PreviewInfo } from "./preview-model";
import type { PreviewState } from "./preview-window";
import { renderMarkdown } from "./markdown";
import stylesheet from "./markdown-preview.css?raw";

export default function MarkdownPreview({
  state,
  active,
  ...props
}: Omit<ArtifactProps, "info"> & { state: PreviewState; active: boolean }) {
  const [information, setInformation] = useState<PreviewInfo | null>(null);
  const [theme, setTheme] = useState(document.documentElement.dataset.theme);
  useEffect(() => {
    const observer = new MutationObserver(() => setTheme(document.documentElement.dataset.theme));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    let current = true;
    const references = renderMarkdown(state.text).references;
    const pending = setTimeout(() => {
      void invoke<Record<string, string>>("preview_assets", { documentPath: state.path, references })
        .then(async (assets) => {
          if (!current) return;
          const rendered = renderMarkdown(state.text, assets);
          const style = getComputedStyle(document.documentElement);
          const variables = ["--surface", "--paper-grain", "--paper-reading-texture", "--material-reading", "--ink", "--muted", "--danger", "--writing-font", "--mono-font", "--hover", "--line", "--accent", "--suggestion", "--passage-highlight", "--passage-focus"]
            .map((name) => `${name}:${style.getPropertyValue(name)};`).join("");
          const article = document.createElement("article");
          article.className = "rendered-markdown";
          article.innerHTML = rendered.html;
          const html = `<!doctype html><html><head><meta charset="utf-8"><style>:root{${variables}}${stylesheet}</style></head><body>${article.outerHTML}</body></html>`;
          const result = previewInfoSchema.parse(await invoke("register_markdown_preview", {
            documentId: state.metadata.documentId,
            title: state.title,
            sourceText: state.text,
            html,
            sourceMap: rendered.sourceMap,
          }));
          if (current) setInformation(result);
        }).catch((error) => { if (current) props.onError("markdown", String(error)); });
    }, 180);
    return () => { current = false; clearTimeout(pending); };
  }, [state.text, state.path, state.metadata.documentId, state.title, state.preferences.typeface, theme]);
  return information ? <PreviewArtifact {...props} artifactId={information.artifactId} information={information} active={active} />
    : <p className="preview-placeholder">Loading preview…</p>;
}
