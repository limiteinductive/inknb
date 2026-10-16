import { useState, useSyncExternalStore } from "react";
import {
  Button,
  Dialog,
  Heading,
  Input,
  Menu,
  MenuItem,
  MenuTrigger,
  Modal,
  ModalOverlay,
  Popover,
  TextField,
} from "react-aria-components";
import {
  FileText,
  Folder,
  MoreHorizontal,
  Plus,
  Search,
  X,
} from "lucide-react";
import { workspace } from "./workspace";
import DocumentNavigation from "./DocumentNavigation";
import type { LibraryEntry } from "./workspace";

function DocumentRow({
  entry,
  context,
  snippet,
  from,
  length,
  onNavigate,
}: {
  entry: LibraryEntry;
  context: "open" | "library";
  snippet?: string;
  from?: number;
  length?: number;
  onNavigate?: () => void;
}) {
  const library = useSyncExternalStore(
    workspace.subscribe,
    workspace.getSnapshot,
  );
  const [renaming, setRenaming] = useState(false);
  const [title, setTitle] = useState(entry.title);
  return (
    <div
      className={`library-row ${entry.id === library.activeId ? "selected" : ""}`}
    >
      <Button
        className="document-link"
        data-inknb-control={`${context}:document:${entry.id}`}
        aria-label={`Open ${entry.title}`}
        onPress={() => {
          if (from === undefined) workspace.activate(entry.id);
          else workspace.reveal(entry.id, from, from + (length ?? 0));
          onNavigate?.();
        }}
      >
        <FileText size={15} strokeWidth={1.5} aria-hidden="true" />
        <span>
          <span className="document-label">{entry.title}</span>
          {snippet && <small>{snippet}</small>}
        </span>
      </Button>
      <MenuTrigger>
        <Button
          className="icon-button document-more"
          aria-label={`Actions for ${entry.title}`}
        >
          <MoreHorizontal size={15} />
        </Button>
        <Popover className="document-menu" placement="bottom end">
          <Menu
            aria-label={`Actions for ${entry.title}`}
            onAction={(action) => {
              if (action === "rename") {
                setTitle(entry.title);
                setRenaming(true);
              }
              if (action === "close") workspace.closeDocument(entry.id);
              if (action === "unfiled") workspace.move(entry.id, null);
              if (String(action).startsWith("collection:"))
                workspace.move(entry.id, String(action).slice(11));
            }}
          >
            <MenuItem id="rename">Rename</MenuItem>
            <MenuItem id="close">Close document</MenuItem>
            <MenuItem id="unfiled">Remove from collection</MenuItem>
            {library.collections.map((collection) => (
              <MenuItem id={`collection:${collection.id}`} key={collection.id}>
                Move to {collection.title}
              </MenuItem>
            ))}
          </Menu>
        </Popover>
      </MenuTrigger>
      <ModalOverlay
        isOpen={renaming}
        onOpenChange={setRenaming}
        isDismissable
        className="modal-overlay"
      >
        <Modal className="small-modal">
          <Dialog aria-label="Rename document">
            <form
              onSubmit={(event) => {
                event.preventDefault();
                workspace.rename(entry.id, title);
                setRenaming(false);
              }}
            >
              <Heading slot="title">Document name</Heading>
              <TextField
                className="field"
                aria-label="Document name"
                value={title}
                onChange={setTitle}
              >
                <Input autoFocus />
              </TextField>
              <div className="modal-actions">
                <Button
                  className="text-button"
                  onPress={() => setRenaming(false)}
                >
                  Cancel
                </Button>
                <Button
                  className="primary-button"
                  type="submit"
                  isDisabled={!title.trim()}
                >
                  Save
                </Button>
              </div>
            </form>
          </Dialog>
        </Modal>
      </ModalOverlay>
    </div>
  );
}

export default function Library({ onNavigate }: { onNavigate?: () => void }) {
  const library = useSyncExternalStore(
    workspace.subscribe,
    workspace.getSnapshot,
  );
  const [query, setQuery] = useState("");
  const [collectionId, setCollectionId] = useState<string | null>(null);
  const [namingCollection, setNamingCollection] = useState(false);
  const [title, setTitle] = useState("");
  const search = query.trim();
  const expression = search
    ? new RegExp(search.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "iu")
    : null;
  const available = library.documents.filter((entry) =>
    workspace.sessions.has(entry.id),
  );
  const documents = available
    .filter(
      (entry) =>
        Boolean(search) || !collectionId || entry.collectionId === collectionId,
    )
    .flatMap((entry) => {
      const text = workspace.sessions.get(entry.id)!.getSnapshot().text;
      const match = expression?.exec(text);
      if (expression && !expression.test(entry.title) && !match) return [];
      return [
        {
          entry,
          from: match?.index,
          length: match?.[0].length,
          snippet: match
            ? text
                .slice(match.index, match.index + Math.max(search.length, 72))
                .split("\n")
                .join(" ")
            : undefined,
        },
      ];
    });
  return (
    <aside className="library-sidebar" aria-label="Document library">
      <header className="library-heading" data-tauri-drag-region>
        <DocumentNavigation onNavigate={onNavigate} />
      </header>
      <div className="library-actions">
        <Button
          className="new-document"
          data-inknb-control="document.new"
          onPress={() =>
            void workspace
              .newDocument()
              .then(() => onNavigate?.())
              .catch((error) => workspace.fail(error))
          }
        >
          <Plus size={16} />
          New document
        </Button>
        <Button
          className="icon-button"
          aria-label="Open a local document"
          data-inknb-control="document.open"
          onPress={() =>
            void workspace
              .openDocument()
              .then(() => onNavigate?.())
              .catch((error) => workspace.fail(error))
          }
        >
          <Folder size={16} />
        </Button>
      </div>
      <TextField
        className="library-search"
        aria-label="Search all writing"
        value={query}
        onChange={setQuery}
      >
        <Search size={14} aria-hidden="true" />
        <Input placeholder="Search your writing" />
        {query && (
          <Button
            className="icon-button"
            aria-label="Clear search"
            onPress={() => setQuery("")}
          >
            <X size={12} />
          </Button>
        )}
      </TextField>
      <div
        className="library-content"
        data-inknb-control="library.content"
        data-inknb-scroll="true"
      >
        {!search && (
          <section aria-label="Open documents">
            <div className="library-section-label">Open</div>
            {available
              .filter((entry) => entry.open)
              .map((entry) => (
                <DocumentRow
                  key={entry.id}
                  entry={entry}
                  context="open"
                  onNavigate={onNavigate}
                />
              ))}
          </section>
        )}
        <section aria-label="Collections">
          <div className="library-section-label">
            Collections
            <Button
              className="icon-button"
              aria-label="New collection"
              onPress={() => {
                setTitle("");
                setNamingCollection(true);
              }}
            >
              <Plus size={13} />
            </Button>
          </div>
          <Button
            className={`collection-link ${collectionId === null ? "active" : ""}`}
            onPress={() => {
              setQuery("");
              setCollectionId(null);
            }}
          >
            All writing<span>{available.length}</span>
          </Button>
          {library.collections.map((collection) => (
            <Button
              key={collection.id}
              className={`collection-link ${collectionId === collection.id ? "active" : ""}`}
              onPress={() => {
                setQuery("");
                setCollectionId(collection.id);
              }}
            >
              <Folder size={14} />
              {collection.title}
              <span>
                {
                  available.filter(
                    (entry) => entry.collectionId === collection.id,
                  ).length
                }
              </span>
            </Button>
          ))}
        </section>
        <section aria-label={search ? "Search results" : "Saved writing"}>
          <div className="library-section-label">
            {search
              ? "Results"
              : (library.collections.find(
                  (collection) => collection.id === collectionId,
                )?.title ?? "All writing")}
          </div>
          {documents.map((result) => (
            <DocumentRow
              key={result.entry.id}
              {...result}
              context="library"
              onNavigate={onNavigate}
            />
          ))}
          {!documents.length && (
            <p className="library-empty">
              {search ? "No matching writing." : "No documents here yet."}
            </p>
          )}
        </section>
      </div>
      <ModalOverlay
        isOpen={namingCollection}
        onOpenChange={setNamingCollection}
        isDismissable
        className="modal-overlay"
      >
        <Modal className="small-modal">
          <Dialog aria-label="New collection">
            <form
              onSubmit={(event) => {
                event.preventDefault();
                workspace.collection(title);
                setNamingCollection(false);
              }}
            >
              <Heading slot="title">New collection</Heading>
              <TextField
                className="field"
                aria-label="Collection name"
                value={title}
                onChange={setTitle}
              >
                <Input autoFocus />
              </TextField>
              <div className="modal-actions">
                <Button
                  className="text-button"
                  onPress={() => setNamingCollection(false)}
                >
                  Cancel
                </Button>
                <Button
                  className="primary-button"
                  type="submit"
                  isDisabled={!title.trim()}
                >
                  Create
                </Button>
              </div>
            </form>
          </Dialog>
        </Modal>
      </ModalOverlay>
    </aside>
  );
}
