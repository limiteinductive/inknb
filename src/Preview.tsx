import { useEffect, useState } from "react";
import { Maximize2, Minimize2, X } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import MarkdownIt from "markdown-it";
import DOMPurify from "dompurify";
import IconButton from "./IconButton";
import { useDocumentSession, useSession } from "./use-session";

export default function Preview() {
  const session = useDocumentSession();
  const state = useSession();
  const fullscreen = state.previewMode === "fullscreen";
  const [html, setHtml] = useState("");
  useEffect(() => {
    let current = true;
    const renderer = new MarkdownIt({
      html: false,
      linkify: false,
      typographer: false,
    });
    const tokens = renderer.parse(state.text, {});
    const images = tokens
      .flatMap((token) => token.children ?? [])
      .filter((token) => token.type === "image");
    const references = [
      ...new Set(
        images
          .map((token) => String(token.attrGet("src") ?? ""))
          .filter((reference) => reference.length > 0),
      ),
    ];
    void invoke<Record<string, string>>("preview_assets", {
      documentPath: state.path,
      references,
    })
      .then((assets) => {
        const image = renderer.renderer.rules.image!;
        renderer.renderer.rules.image = (
          tokens,
          index,
          options,
          environment,
          self,
        ) => {
          const token = tokens[index];
          const reference = String(token.attrGet("src") ?? "");
          if (assets[reference]) {
            token.attrSet("src", assets[reference]);
            return image(tokens, index, options, environment, self);
          }
          return `<a href="${renderer.utils.escapeHtml(reference)}">${renderer.utils.escapeHtml(token.content || "Open figure")}</a>`;
        };
        if (current)
          setHtml(
            DOMPurify.sanitize(
              renderer.renderer.render(tokens, renderer.options, {}),
            ),
          );
      })
      .catch((error) => session.fail(error));
    return () => {
      current = false;
    };
  }, [state.text, state.path]);
  return (
    <aside
      className="preview-panel"
      aria-label="Reading preview"
      onKeyDown={(event) => {
        if (event.key !== "Escape" || event.defaultPrevented) return;
        event.preventDefault();
        event.stopPropagation();
        void session.command(
          fullscreen ? "preview-fullscreen" : "preview-close",
        );
      }}
    >
      <div className="preview-heading" data-tauri-drag-region>
        <div className="preview-actions">
          <IconButton
            icon={fullscreen ? Minimize2 : Maximize2}
            label={fullscreen ? "Exit fullscreen" : "Fullscreen"}
            agentControl="preview.fullscreen"
            onPress={() => void session.command("preview-fullscreen")}
          />
          <IconButton
            icon={X}
            label="Close preview"
            agentControl="preview.close"
            onPress={() => void session.command("preview-close")}
          />
        </div>
      </div>
      <div
        className="preview-content"
        data-inknb-control="preview.content"
        data-inknb-scroll="true"
        aria-label="Rendered manuscript"
        tabIndex={0}
      >
        <article
          className="rendered-markdown"
          onClick={(event) => {
            const target = event.target as HTMLElement;
            const link = target.closest<HTMLAnchorElement>("a");
            if (!link) return;
            event.preventDefault();
            const reference = link.getAttribute("href");
            if (reference)
              void invoke("open_reference", {
                documentPath: state.path,
                reference,
              }).catch((error) => session.fail(error));
          }}
          dangerouslySetInnerHTML={{ __html: html }}
        />
      </div>
    </aside>
  );
}
