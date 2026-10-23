import { useEffect, useState } from "react";
import { Button } from "react-aria-components";
import { File, FileText, Globe } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useDocumentSession, useSession } from "./use-session";
import { workspace } from "./window-workspace";
import { resourceStateSchema } from "./resources";
import type { ResourceState } from "./resources";
import { showContextMenu } from "./context-menu";
import { PanelModal, PanelBody, PanelEmpty } from "./PanelPopover";

export default function LinkedResources({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const session = useDocumentSession();
  const state = useSession();
  const [resources, setResources] = useState<ResourceState | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    let current = true;
    setError(null);
    const refresh = () =>
      workspace
        .request({
          kind: "resource",
          documentId: state.metadata.documentId,
          action: { kind: "read" },
        })
        .then((result) => {
          if (current) setResources(resourceStateSchema.parse(result));
        })
        .catch((error) => {
          if (current) setError(String(error));
        });
    void refresh();
    const subscription = listen("inknb-host-changed", () => void refresh());
    return () => {
      current = false;
      void subscription.then((unlisten) => unlisten());
    };
  }, [open, state.metadata.documentId]);
  return (
    <PanelModal open={open} onOpenChange={onOpenChange} className="resources-popover" title="Linked resources">
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        <PanelBody className="resources-list" layout="list">
          {resources?.items.map((resource) => {
            const target = resource.target;
            const Icon =
              target.kind === "document"
                ? FileText
                : target.kind === "file"
                  ? File
                  : Globe;
            return (
              <Button
                key={resource.id}
                className="resource-link"
                onPress={() => {
                  onOpenChange(false);
                  const operation =
                    target.kind === "document"
                      ? workspace.request({
                          kind: "open-document",
                          documentId: target.documentId,
                        })
                      : invoke("open_reference", {
                          documentPath: state.path,
                          reference:
                            target.kind === "file" ? target.path : target.url,
                        });
                  void operation.catch((error) => session.fail(error));
                }}
                onContextMenu={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  void showContextMenu({
                    left: event.clientX,
                    top: event.clientY,
                    copy: false,
                    actions: [
                      {
                        text: "Remove link",
                        action: () => {
                          void workspace
                            .request({
                              kind: "resource",
                              documentId: state.metadata.documentId,
                              action: { kind: "remove", id: resource.id },
                            })
                            .catch((error) => session.fail(error));
                        },
                      },
                    ],
                  }).catch((error) => session.fail(error));
                }}
              >
                <Icon size={16} aria-hidden="true" />
                <span>{resource.title}</span>
              </Button>
            );
          })}
          {resources?.items.length === 0 && (
            <PanelEmpty>No linked resources.</PanelEmpty>
          )}
          {Boolean(resources?.backlinks.length) && (
            <>
              <h3>Linked from</h3>
              {resources?.backlinks.map((source) => (
                <Button
                  className="resource-link"
                  key={source.documentId}
                  onPress={() => {
                    onOpenChange(false);
                    void workspace
                      .request({
                        kind: "open-document",
                        documentId: source.documentId,
                      })
                      .catch((error) => session.fail(error));
                  }}
                >
                  <FileText size={16} aria-hidden="true" />
                  <span>{source.title}</span>
                </Button>
              ))}
            </>
          )}
        </PanelBody>
    </PanelModal>
  );
}
