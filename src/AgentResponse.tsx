import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Button,
  Dialog,
  DialogTrigger,
  Modal,
  ModalOverlay,
} from "react-aria-components";
import { X } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { agentAttribution, responseWords } from "./domain";
import type { Message } from "./domain";
import { renderMarkdown } from "./markdown";
import { parseAsideLink } from "./aside-reference";
import { useAsideSession, useAsideState } from "./use-session";
import "./agent-response.css";
import type { PassageReference } from "./passage-reference";

export function ResponseBody({
  content,
  assets,
  onReference,
  references = [],
  field = "content",
  messageId,
}: {
  content: string;
  assets: Record<string, string>;
  onReference: (reference: string) => void;
  references?: PassageReference[];
  field?: "content" | "details";
  messageId?: string;
}) {
  const session = useAsideSession();
  const identity = useId();
  const html = useMemo(
    () => {
      const element = document.createElement("div");
      element.innerHTML = renderMarkdown(content, assets).html.replaceAll(
        'id="source-',
        `id="${identity}-source-`,
      );
      const text = element.textContent ?? "";
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      const nodes: Text[] = [];
      let node;
      while (node = walker.nextNode()) nodes.push(node as Text);
      let offset = 0;
      for (const node of nodes) {
        const start = offset;
        offset += node.length;
        const fragment = document.createDocumentFragment();
        let from = 0;
        for (const reference of references) {
          const label = content.slice(reference.from, reference.to);
          const position = text.indexOf(label);
          const begin = Math.max(from, position - start);
          const end = Math.min(node.length, position + label.length - start);
          if (position < 0 || end <= begin) continue;
          fragment.append(node.textContent!.slice(from, begin));
          const citation = document.createElement("button");
          citation.type = "button";
          citation.className = "passage-citation";
          citation.dataset.passageCitation = reference.id;
          citation.textContent = node.textContent!.slice(begin, end);
          fragment.append(citation);
          from = end;
        }
        fragment.append(node.textContent!.slice(from));
        node.replaceWith(fragment);
      }
      return element.innerHTML;
    },
    [content, assets, identity, references],
  );
  return (
    <div
      className="response-content"
      data-message-content={field}
      data-source-message-id={messageId}
      onClick={(event) => {
        if (!(event.target instanceof Element)) return;
        if (!window.getSelection()?.isCollapsed) { event.preventDefault(); return; }
        const citation = event.target.closest<HTMLElement>("[data-passage-citation]");
        const reference = references.find(reference => reference.id === citation?.dataset.passageCitation);
        if (reference) { event.preventDefault(); void session.control("passage_reveal", reference.source).catch(error => session.fail(error)); return; }
        const link = event.target.closest<HTMLAnchorElement>(
          "a[data-inknb-reference]",
        );
        if (!link) return;
        event.preventDefault();
        onReference(link.getAttribute("href") ?? "");
      }}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

export default function AgentResponse({ message }: { message: Message }) {
  const session = useAsideSession();
  const state = useAsideState();
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const previousOpen = useRef(false);
  useLayoutEffect(() => {
    if (previousOpen.current && !open)
      trigger.current?.focus({ preventScroll: true });
    previousOpen.current = open;
  }, [open]);
  const [assets, setAssets] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const words = responseWords(message.content);
  const legacy = words.length > 100;
  const preview = legacy
    ? `${message.content.slice(0, words[99].index! + words[99][0].length)}…`
    : message.content;
  const complete = [message.content, message.details]
    .filter(Boolean)
    .join("\n\n");
  const openReference = (reference: string) => {
    const aside = parseAsideLink(reference);
    if (aside) {
      setOpen(false);
      try {
        session.openAside(aside);
      } catch (error) {
        session.fail(error);
      }
      return;
    }
    void invoke("open_reference", {
      documentPath: state.path,
      reference,
    }).catch((error) => session.fail(error));
  };
  useEffect(() => {
    if (!open) return;
    let current = true;
    setError(null);
    void invoke<Record<string, string>>("preview_assets", {
      documentPath: state.path,
      references: renderMarkdown(complete).references,
    })
      .then((result) => {
        if (current) setAssets(result);
      })
      .catch((error) => {
        if (current) setError(String(error));
      });
    return () => {
      current = false;
    };
  }, [open, complete, state.path]);
  return (
    <>
      {legacy && <span className="response-preview-label">Preview</span>}
      <ResponseBody
        messageId={message.id}
        content={preview}
        references={message.references}
        assets={assets}
        onReference={openReference}
      />
      {(message.details || legacy) && (
        <DialogTrigger isOpen={open} onOpenChange={setOpen}>
          <Button
            ref={trigger}
            className="text-button response-open"
            data-inknb-control={`response:${message.id}`}
          >
            {legacy ? "Read full response" : "Read details"}
          </Button>
          <ModalOverlay className="response-overlay" isDismissable>
            <Modal className="response-reader">
              <Dialog aria-label="Full agent response">
                {({ close }) => (
                  <>
                    <header className="response-heading">
                      <div>
                        <span>{agentAttribution(message.agent)}</span>
                        <h2>Full response</h2>
                      </div>
                      <Button
                        className="icon-button"
                        aria-label="Close full response"
                        data-inknb-control="response.close"
                        onPress={close}
                      >
                        <X size={18} aria-hidden="true" />
                      </Button>
                    </header>
                    <div
                      className="response-scroll"
                      data-inknb-control="response.body"
                      data-inknb-scroll="true"
                    >
                      <ResponseBody
                        messageId={message.id}
                        content={message.content}
                        references={message.references}
                        assets={assets}
                        onReference={openReference}
                      />
                      {message.details && <ResponseBody messageId={message.id} content={message.details} field="details" assets={assets} onReference={openReference} />}
                      {error && (
                        <p className="quiet-note" role="alert">
                          {error}
                        </p>
                      )}
                      {message.sources.length > 0 && (
                        <nav
                          className="response-sources"
                          aria-label="Response sources"
                        >
                          <h3>Sources</h3>
                          {message.sources.map((source) => (
                            <Button
                              className="text-button"
                              key={source.id}
                              onPress={() =>
                                void invoke("open_reference", {
                                  documentPath: state.path,
                                  reference: source.path,
                                }).catch((error) => session.fail(error))
                              }
                            >
                              {source.label}
                            </Button>
                          ))}
                        </nav>
                      )}
                    </div>
                  </>
                )}
              </Dialog>
            </Modal>
          </ModalOverlay>
        </DialogTrigger>
      )}
    </>
  );
}
