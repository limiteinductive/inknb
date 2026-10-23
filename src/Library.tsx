import SpaceMenu from "./SpaceMenu";
import { ActivityButton } from "./ActivityCenter";
import IconButton from "./IconButton";
import LibrarySelection from "./LibrarySelection";
import { useRef, useState, useSyncExternalStore } from "react";
import type { MouseEvent } from "react";
import {
  Button,
  DropIndicator,
  Tree,
  TreeItem,
  TreeItemContent,
  Input,
  TextField,
  useDragAndDrop,
} from "react-aria-components";
import { ChevronRight, Command, FileText, Folder, Plus } from "lucide-react";
import { workspace } from "./window-workspace";
import DocumentNavigation from "./DocumentNavigation";
import type { LibraryEntry, LibraryNode } from "./workspace";
import { showContextMenu } from "./context-menu";

function documentContextMenu(
  event: MouseEvent<HTMLElement>,
  entry: LibraryEntry,
) {
  if (event.currentTarget.querySelector("input")) return;
  event.preventDefault();
  event.stopPropagation();
  const bounds = event.currentTarget.getBoundingClientRect();
  const keyboard = event.clientX === 0 && event.clientY === 0;
  void showContextMenu({
    left: keyboard ? bounds.left : event.clientX,
    top: keyboard ? bounds.bottom : event.clientY,
    copy: false,
    actions: [
      {
        text: entry.pinned ? "Unpin" : "Pin",
        action: () => workspace.pin(entry.id, !entry.pinned),
      },
    ],
  }).catch((error) => workspace.fail(error));
}

function DocumentRow({
  entry,
  onNavigate,
  shortcut = false,
}: {
  entry: LibraryEntry;
  onNavigate?: () => void;
  shortcut?: boolean;
}) {
  const [renaming, setRenaming] = useState(false);
  const [title, setTitle] = useState(entry.title);
  const cancelRename = useRef(false);
  const documentLink = useRef<HTMLButtonElement>(null);
  function startRenaming() {
    cancelRename.current = false;
    setTitle(entry.title);
    setRenaming(true);
  }
  const documentIcon = (
    <span className="document-symbol" aria-hidden="true">
      <FileText size={15} strokeWidth={1.5} />
    </span>
  );
  return (
    <>
      {shortcut ? (
        <span className="document-drag" aria-hidden="true">
          {documentIcon}
        </span>
      ) : (
        <Button
          slot="drag"
          className="document-drag"
          aria-label={`Move ${entry.title}`}
        >
          {documentIcon}
        </Button>
      )}
      {renaming ? (
        <TextField
          className="document-rename"
          aria-label="Document name"
          value={title}
          onChange={setTitle}
        >
          <Input
            autoFocus
            onFocus={(event) => event.currentTarget.select()}
            onBlur={() => {
              if (!cancelRename.current) workspace.rename(entry.id, title);
              setRenaming(false);
            }}
            onKeyDown={(event) => {
              event.stopPropagation();
              if (event.key !== "Enter" && event.key !== "Escape") return;
              event.preventDefault();
              cancelRename.current = event.key === "Escape";
              event.currentTarget.blur();
              requestAnimationFrame(() =>
                documentLink.current
                  ?.closest<HTMLElement>('[role="row"]')
                  ?.focus(),
              );
            }}
          />
        </TextField>
      ) : (
        <Button
          ref={documentLink}
          className="document-link"
          data-inknb-control={`library:${shortcut ? "pinned" : "document"}:${entry.id}`}
          aria-label={`Open ${entry.title}`}
          onDoubleClick={startRenaming}
          onKeyDown={(event) => {
            if (event.key !== "F2") return;
            event.preventDefault();
            event.stopPropagation();
            startRenaming();
          }}
          onPress={() => {
            workspace.activate(entry.id);
            onNavigate?.();
          }}
        >
          <span>
            <span className="document-label">{entry.title}</span>
          </span>
        </Button>
      )}
    </>
  );
}

export default function Library({
  onNavigate,
  width = 232,
  maximumWidth = 480,
  onWidthChange,
}: {
  onNavigate?: () => void;
  width?: number;
  maximumWidth?: number;
  onWidthChange?: (width: number) => void;
}) {
  const library = useSyncExternalStore(
    workspace.subscribe,
    workspace.getSnapshot,
  );
  const draggedIds = useRef<string[]>([]);
  const resize = useRef<{ start: number; width: number } | null>(null);
  const available = library.documents.filter((entry) =>
    workspace.sessions.has(entry.id),
  );
  const documentCounts = new Map<string, number>();
  const parents = new Map(
    workspace.nodes.map((node) => [node.id, node.parentId]),
  );
  for (const entry of library.documents) {
    let parent = entry.parentId;
    while (parent) {
      documentCounts.set(parent, (documentCounts.get(parent) ?? 0) + 1);
      parent = parents.get(parent) ?? null;
    }
  }
  const preferences = workspace.active?.getSnapshot().preferences;
  const flat = preferences?.library_depth === 0;
  const documents = available.map(entry => ({ entry }));
  function navigateDocument(identity: string | number) {
    if (!available.some(entry => entry.id === identity)) return;
    workspace.activate(String(identity));
    onNavigate?.();
  }
  const nodes = flat
    ? documents.map((result) => result.entry)
    : workspace.nodes;
  const children = new Map<string | null, LibraryNode[]>();
  for (const node of nodes) {
    const parentId = flat ? null : node.parentId;
    children.set(parentId, [...(children.get(parentId) ?? []), node]);
  }
  const activity = new Map<string, number>();
  function latestActivity(node: LibraryNode): number {
    const cached = activity.get(node.id);
    if (cached !== undefined) return cached;
    const latest = Math.max(
      node.modifiedAt,
      ...(children.get(node.id) ?? []).map(latestActivity),
    );
    activity.set(node.id, latest);
    return latest;
  }
  function compareNodes(left: LibraryNode, right: LibraryNode): number {
    if (left.priority !== right.priority) return right.priority - left.priority;
    if (preferences?.library_sort === "alphabetical")
      return left.title.localeCompare(right.title) || left.order - right.order;
    if (preferences?.library_sort === "manual") return left.order - right.order;
    return (
      latestActivity(right) - latestActivity(left) || left.order - right.order
    );
  }
  for (const siblings of children.values()) {
    siblings.sort(compareNodes);
  }
  const pinned = documents.filter(result => result.entry.pinned).sort((left, right) => compareNodes(left.entry, right.entry));
  const { dragAndDropHooks } = useDragAndDrop({
    isDisabled: flat,
    getItems: (keys) => {
      draggedIds.current = [...keys].map(String);
      return draggedIds.current.map((identity) => ({
        "application/x-inknb-document": identity,
      }));
    },
    getAllowedDropOperations: () => ["move"],
    getDropOperation: (target, types) => {
      if (!types.has("application/x-inknb-document")) return "cancel";
      if (
        target.type === "item" &&
        target.dropPosition !== "on" &&
        (preferences?.library_sort !== "manual" ||
          draggedIds.current.some(
            (identity) =>
              nodes.find((node) => node.id === identity)?.priority !==
              nodes.find((node) => node.id === target.key)?.priority,
          ))
      )
        return "cancel";
      const parentId =
        target.type === "root"
          ? null
          : target.dropPosition === "on"
            ? String(target.key)
            : (nodes.find((node) => node.id === target.key)?.parentId ?? null);
      try {
        for (const identity of draggedIds.current)
          workspace.validateParent(identity, parentId);
      } catch {
        return "cancel";
      }
      return "move";
    },
    onMove: (event) => {
      const identity = event.keys.values().next().value;
      if (identity === undefined) return;
      try {
        if (event.target.dropPosition === "on")
          workspace.organize(String(identity), String(event.target.key));
        else
          workspace.reorder(
            String(identity),
            String(event.target.key),
            event.target.dropPosition,
          );
      } catch (error) {
        workspace.fail(error);
      }
    },
    onRootDrop: async (event) => {
      for (const item of event.items) {
        if (
          item.kind === "text" &&
          item.types.has("application/x-inknb-document")
        ) {
          try {
            workspace.organize(
              await item.getText("application/x-inknb-document"),
              null,
            );
          } catch (error) {
            workspace.fail(error);
          }
        }
      }
    },
    renderDropIndicator: (target) => (
      <DropIndicator target={target} className="library-drop-indicator" />
    ),
  });
  function renderNode(node: LibraryNode): React.ReactElement {
    const result = documents.find(
      (candidate) => candidate.entry.id === node.id,
    );
    const group = library.collections.some(
      (collection) => collection.id === node.id,
    );
    const descendants = children.get(node.id) ?? [];
    const documentCount = documentCounts.get(node.id) ?? 0;
    return (
      <TreeItem
        key={node.id}
        id={node.id}
        textValue={node.title}
        aria-label={
          group
            ? `${node.title}, ${documentCount} document${documentCount === 1 ? "" : "s"}`
            : undefined
        }
        className={`library-row ${group ? "library-folder" : "library-document"}`}
        onContextMenu={
          result
            ? (event) => documentContextMenu(event, result.entry)
            : undefined
        }
      >
        <TreeItemContent>
          {({ isExpanded }) => (
            <>
              {descendants.length > 0 ? (
                <Button
                  slot="chevron"
                  className="library-disclosure"
                  aria-label={`${isExpanded ? "Collapse" : "Expand"} ${node.title}`}
                  data-inknb-control={`library:toggle:${node.id}`}
                >
                  <ChevronRight size={12} />
                </Button>
              ) : group ? (
                <span className="library-disclosure-space" />
              ) : null}
              {group ? (
                <>
                  <Button
                    slot="drag"
                    className="document-drag"
                    aria-label={`Move ${node.title}`}
                  >
                    <Folder size={15} strokeWidth={1.5} />
                  </Button>
                  <Button
                    className="document-link"
                    onPress={() =>
                      workspace.update({
                        collapsedIds: isExpanded
                          ? [...library.collapsedIds, node.id]
                          : library.collapsedIds.filter(
                              (identity) => identity !== node.id,
                            ),
                      })
                    }
                  >
                    <span className="document-label">{node.title}</span>
                    <span className="document-count" aria-hidden="true">
                      {documentCount}
                    </span>
                  </Button>
                </>
              ) : result ? (
                <DocumentRow {...result} onNavigate={onNavigate} />
              ) : (
                <span className="document-link">{node.title}</span>
              )}
            </>
          )}
        </TreeItemContent>
        {descendants.map(renderNode)}
      </TreeItem>
    );
  }
  return (
    <aside className="library-sidebar" aria-label="Document library">
      {onWidthChange && (
        <div
          className="library-resizer"
          role="separator"
          aria-label="Resize library"
          aria-orientation="vertical"
          aria-valuemin={200}
          aria-valuemax={maximumWidth}
          aria-valuenow={Math.round(width)}
          tabIndex={0}
          data-inknb-control="library.resize"
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            event.preventDefault();
            resize.current = { start: event.clientX, width };
            event.currentTarget.setPointerCapture(event.pointerId);
          }}
          onPointerMove={(event) => {
            if (!resize.current) return;
            onWidthChange(
              Math.min(
                maximumWidth,
                Math.max(
                  200,
                  resize.current.width + event.clientX - resize.current.start,
                ),
              ),
            );
          }}
          onPointerUp={() => {
            resize.current = null;
          }}
          onPointerCancel={() => {
            resize.current = null;
          }}
          onLostPointerCapture={() => {
            resize.current = null;
          }}
          onDoubleClick={() => onWidthChange(232)}
          onKeyDown={(event) => {
            if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key))
              return;
            event.preventDefault();
            const next =
              event.key === "Home"
                ? 200
                : event.key === "End"
                  ? maximumWidth
                  : width + (event.key === "ArrowRight" ? 24 : -24);
            onWidthChange(Math.min(maximumWidth, Math.max(200, next)));
          }}
        />
      )}
      <header className="library-heading" data-tauri-drag-region>
        <DocumentNavigation />
        <IconButton icon={Command} label="Commands (⌘P)" agentControl="commands.open" onPress={() => void workspace.command("commands")} />
        <ActivityButton />
      </header>
      <div
        className="library-content"
        data-inknb-control="library.content"
        data-inknb-scroll="true"
      >
        {pinned.length > 0 && (
          <section aria-label="Pinned writing">
            <div className="library-section-label">Pinned</div>
            <div className="library-document-list">
              <LibrarySelection />
              <Tree
                aria-label="Pinned writing"
                className="library-items"
                selectionMode="single"
                selectionBehavior="replace"
                selectedKeys={
                  pinned.some((result) => result.entry.id === library.activeId)
                    ? [library.activeId!]
                    : []
                }
                onAction={navigateDocument}
                onSelectionChange={(keys) => {
                  if (keys === "all") return;
                  const identity = keys.values().next().value;
                  if (identity !== undefined) navigateDocument(identity);
                }}
              >
                {pinned.map((result) => (
                  <TreeItem
                    key={result.entry.id}
                    id={result.entry.id}
                    textValue={result.entry.title}
                    className="library-row library-document"
                    onContextMenu={(event) =>
                      documentContextMenu(event, result.entry)
                    }
                  >
                    <TreeItemContent>
                      <DocumentRow {...result} onNavigate={onNavigate} shortcut />
                    </TreeItemContent>
                  </TreeItem>
                ))}
              </Tree>
            </div>
          </section>
        )}
        <section aria-label="Saved writing">
          <div className="library-section-label">
            <SpaceMenu />
            <Button
                className="icon-button"
                aria-label="New document"
                data-inknb-control="document.new"
                onPress={() =>
                  void workspace
                    .newDocument()
                    .then(() => {
                      onNavigate?.();
                    })
                    .catch((error) => workspace.fail(error))
                }
              >
                <Plus size={13} />
              </Button>
          </div>
          <div className="library-document-list">
            <LibrarySelection />
            <Tree
              aria-label="Writing"
              className="library-items"
              dragAndDropHooks={dragAndDropHooks}
              selectionMode="single"
              selectionBehavior="replace"
              selectedKeys={library.activeId ? [library.activeId] : []}
              expandedKeys={nodes
                .filter((node) => !library.collapsedIds.includes(node.id))
                .map((node) => node.id)}
              onExpandedChange={(keys) =>
                workspace.update({
                  collapsedIds: nodes
                    .filter((node) => !keys.has(node.id))
                    .map((node) => node.id),
                })
              }
              onAction={navigateDocument}
              onSelectionChange={(keys) => {
                if (keys === "all") return;
                const identity = keys.values().next().value;
                if (identity !== undefined) navigateDocument(identity);
              }}
            >
              {(children.get(null) ?? []).map(renderNode)}
            </Tree>
          </div>
          {!documents.length && (
            <p className="library-empty">
              No documents here yet.
            </p>
          )}
        </section>
      </div>
    </aside>
  );
}
