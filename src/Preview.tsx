import { useEffect, useState } from "react";
import {
  Button,
  Dialog,
  Heading,
  Modal,
  ModalOverlay,
} from "react-aria-components";
import { X } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import MarkdownIt from "markdown-it";
import DOMPurify from "dompurify";
import { session } from "./session";
import { useSession } from "./use-session";

export default function Preview({ close }: { close: () => void }) {
  const state = useSession();
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
    <ModalOverlay
      isOpen
      onOpenChange={(open) => {
        if (!open) close();
      }}
      isDismissable
      className="modal-overlay"
    >
      <Modal className="preview-modal">
        <Dialog aria-label="Reading preview">
          <div className="modal-heading">
            <Heading slot="title">Reading preview</Heading>
            <Button
              className="icon-button"
              aria-label="Close preview"
              onPress={close}
            >
              <X size={17} />
            </Button>
          </div>
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
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}
