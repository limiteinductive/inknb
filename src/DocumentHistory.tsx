import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Button, DialogTrigger } from "react-aria-components";
import { ArrowLeft, History, X } from "lucide-react";
import { Conversation } from "./Asides";
import { asideOutdated } from "./aside-state";
import type { AsideReference } from "./domain";
import { useAsideSession, useAsideState } from "./use-session";
import {
  historyPageSchema,
  historyRevisionSchema,
  textDifference,
} from "./history";
import type { HistoryEntry, HistoryRevision } from "./history";
import IconButton from "./IconButton";
import { importDocument } from "./native-document";
import PanelPopover, { PanelBody, PanelEmpty } from "./PanelPopover";

interface RevisionGroup {
  kind: "revision";
  id: string;
  createdAt: string;
  actor: string;
  entries: HistoryEntry[];
}

export default function DocumentHistory({
  active,
  open,
  onOpenChange,
}: {
  active: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const session = useAsideSession();
  const state = useAsideState();
  const [filter, setFilter] = useState("all");
  const [history, setHistory] = useState<{
    entries: HistoryEntry[];
    hasMore: boolean;
  }>({ entries: [], hasMore: false });
  const { entries, hasMore } = history;
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [revision, setRevision] = useState<HistoryRevision | null>(null);
  const navigation = useRef<HTMLButtonElement>(null);
  const request = useRef(0);
  const detail = useRef(0);
  const selectedGroup = useRef<RevisionGroup | null>(null);
  useEffect(() => {
    const openAside = (event: Event) => {
      const reference = (event as CustomEvent<AsideReference>).detail;
      if (reference.documentId !== state.metadata.documentId) return;
      selectedGroup.current = null;
      setSelected(reference.threadId);
      setRevision(null);
      onOpenChange(true);
    };
    window.addEventListener("inknb-history-aside", openAside);
    return () => window.removeEventListener("inknb-history-aside", openAside);
  }, [state.metadata.documentId, onOpenChange]);
  useLayoutEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() =>
      navigation.current?.focus({ preventScroll: true }),
    );
    return () => cancelAnimationFrame(frame);
  }, [open, selected]);
  useEffect(() => {
    if (!open) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      onOpenChange(false);
    };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, [open, onOpenChange]);
  useEffect(() => {
    if (!active) onOpenChange(false);
  }, [active]);
  useEffect(() => {
    if (!open) return;
    const identity = ++request.current;
    let cancelled = false;
    setLoading(true);
    void session
      .control("history_read", {})
      .then((result) => {
        if (cancelled || request.current !== identity) return;
        const page = historyPageSchema.parse(result);
        setHistory((current) => {
          const overlaps = page.entries.some((entry) =>
            current.entries.some(
              (previous) => previous.cursor === entry.cursor,
            ),
          );
          return {
            entries: overlaps
              ? [
                  ...page.entries,
                  ...current.entries.filter(
                    (entry) => entry.cursor < page.entries.at(-1)!.cursor,
                  ),
                ]
              : page.entries,
            hasMore:
              overlaps && current.entries.length > page.entries.length
                ? current.hasMore
                : page.hasMore,
          };
        });
        setError(null);
      })
      .catch((error) => {
        if (!cancelled) setError(String(error));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, state.metadata.documentId, state.metadata.revision, session]);
  useEffect(() => {
    if (open) return;
    detail.current += 1;
    selectedGroup.current = null;
    setSelected(null);
    setRevision(null);
  }, [open]);
  const groups: RevisionGroup[] = [];
  for (const entry of entries) {
    if (
      !entry.removed &&
      !entry.inserted &&
      entry.beforeFormat === entry.format
    )
      continue;
    const previous = groups.at(-1);
    const oldest = previous?.entries.at(-1);
    if (
      previous &&
      oldest &&
      previous.actor === entry.actor &&
      entry.actor === "You" &&
      !entry.threadId &&
      !oldest.threadId &&
      Date.parse(oldest.createdAt) - Date.parse(entry.createdAt) <= 2000 &&
      Date.parse(previous.createdAt) - Date.parse(entry.createdAt) <= 30000
    ) {
      previous.entries.push(entry);
    } else
      groups.push({
        kind: "revision",
        id: entry.id,
        createdAt: entry.createdAt,
        actor: entry.actor,
        entries: [entry],
      });
  }
  const discussions = state.metadata.threads.map((thread) => ({
    kind: "aside" as const,
    id: thread.id,
    createdAt:
      thread.updatedAt ??
      thread.resolution?.createdAt ??
      thread.messages.at(-1)?.createdAt ??
      thread.createdAt,
    thread,
  }));
  const items = [
    ...(filter === "changes" ? [] : discussions),
    ...(filter === "asides" ? [] : groups),
  ].sort((first, second) => second.createdAt.localeCompare(first.createdAt));
  const current =
    selectedGroup.current?.id === selected
      ? selectedGroup.current
      : discussions.find((item) => item.id === selected);
  const rendered = useMemo(() => {
    if (!revision) return null;
    const versions = [
      { text: revision.before, format: revision.beforeFormat },
      { text: revision.after, format: revision.format },
    ].map(({ text, format }) => {
      const document = importDocument(text, format);
      return document.textBetween(0, document.content.size, "\n", (node) =>
        node.type.name === "image"
          ? "[Image]"
          : ["math", "math_block"].includes(node.type.name)
            ? String(node.attrs.value)
            : "[Object]",
      );
    });
    const before = versions[0] === versions[1] ? revision.before : versions[0];
    const after = versions[0] === versions[1] ? revision.after : versions[1];
    return { before, after, difference: textDifference(before, after) };
  }, [revision]);
  const difference = rendered?.difference;
  return (
    <DialogTrigger isOpen={open} onOpenChange={onOpenChange}>
      <Button
        className="icon-button"
        aria-label="Document history"
        data-inknb-control="history.open"
      >
        <History size={17} strokeWidth={1.6} aria-hidden="true" />
      </Button>
      <PanelPopover
        className="history-drawer"
        title="History"
        label="Document history"
        size="wide"
        leading={
          selected ? (
            <Button
              ref={navigation}
              className="icon-button"
              aria-label="Back to history"
              onPress={() => {
                detail.current += 1;
                selectedGroup.current = null;
                setSelected(null);
                setRevision(null);
              }}
            >
              <ArrowLeft size={17} strokeWidth={1.6} aria-hidden="true" />
            </Button>
          ) : null
        }
        actions={
          <IconButton
            icon={X}
            label="Close history"
            onPress={() => onOpenChange(false)}
          />
        }
      >
        {error && (
          <p className="history-error" role="alert">
            {error}
          </p>
        )}
        {selected ? (
          <PanelBody className="history-detail">
            {current?.kind === "aside" ? (
              <Conversation
                identity={current.id}
                onClose={() => onOpenChange(false)}
              />
            ) : (
              <>
                {current?.kind === "revision" && (
                  <p className="history-detail-heading">
                    {current.actor} ·{" "}
                    {new Date(current.createdAt).toLocaleString()}
                  </p>
                )}
                {revision && rendered && difference ? (
                  <>
                    {revision.beforeFormat !== revision.format && (
                      <p className="quiet-note">
                        Format: {revision.beforeFormat} → {revision.format}
                      </p>
                    )}
                    <div className="history-diff" aria-label="Revision changes">
                      <span>
                        {rendered.before.slice(
                          Math.max(0, difference.from - 100),
                          difference.from,
                        )}
                      </span>
                      {difference.removed && <del>{difference.removed}</del>}
                      {difference.inserted && <ins>{difference.inserted}</ins>}
                      <span>
                        {rendered.after.slice(
                          difference.from + difference.inserted.length,
                          difference.from + difference.inserted.length + 100,
                        )}
                      </span>
                    </div>
                    <details className="history-full-revision">
                      <summary>Full source</summary>
                      <pre>{revision.after}</pre>
                    </details>
                  </>
                ) : (
                  !error && (
                    <p className="quiet-note" role="status">
                      Loading revision…
                    </p>
                  )
                )}
                {current?.kind === "revision" &&
                  current.entries[0].threadId && (
                    <Button
                      className="text-button"
                      onPress={() => {
                        const identity = current.entries[0].threadId!;
                        detail.current += 1;
                        setSelected(identity);
                        setRevision(null);
                        session.selectThread(identity);
                      }}
                    >
                      Open discussion
                    </Button>
                  )}
              </>
            )}
          </PanelBody>
        ) : (
          <>
            <nav
              className="history-filters panel-filters"
              aria-label="History filter"
            >
              {[
                { id: "all", label: "All" },
                { id: "asides", label: "Asides" },
                { id: "changes", label: "Changes" },
              ].map((choice) => (
                <Button
                  key={choice.id}
                  ref={choice.id === "all" ? navigation : undefined}
                  className="text-button"
                  aria-pressed={filter === choice.id}
                  onPress={() => setFilter(choice.id)}
                >
                  {choice.label}
                </Button>
              ))}
            </nav>
            <PanelBody className="history-list" layout="list">
              {items.map((item) => (
                <Button
                  key={item.id}
                  className="history-entry"
                  onPress={() => {
                    const identity = ++detail.current;
                    selectedGroup.current =
                      item.kind === "revision" ? item : null;
                    setSelected(item.id);
                    setRevision(null);
                    setError(null);
                    if (item.kind === "aside") {
                      session.selectThread(item.id);
                      return;
                    }
                    session.selectThread(null);
                    void session
                      .control("revision_read", {
                        fromCursor: item.entries.at(-1)!.cursor,
                        toCursor: item.entries[0].cursor,
                      })
                      .then((result) => {
                        if (detail.current === identity)
                          setRevision(historyRevisionSchema.parse(result));
                      })
                      .catch((error) => {
                        if (detail.current === identity)
                          setError(String(error));
                      });
                  }}
                >
                  <span className="history-entry-title">
                    {item.kind === "aside"
                      ? item.thread.originalQuote ||
                        item.thread.messages.at(-1)?.content ||
                        "Aside"
                      : `${item.actor} edited the document`}
                  </span>
                  <span className="history-entry-meta">
                    {item.kind === "aside"
                      ? `${item.thread.resolved ? "Resolved" : asideOutdated(state.metadata, item.thread) ? "Outdated" : "Open"} · `
                      : ""}
                    {new Date(item.createdAt).toLocaleString()}
                  </span>
                </Button>
              ))}
              {!items.length && (
                <PanelEmpty>
                  {loading ? "Loading history…" : "No history yet."}
                </PanelEmpty>
              )}
              {hasMore && (
                <Button
                  className="text-button history-more"
                  isDisabled={loading}
                  onPress={() => {
                    const identity = ++request.current;
                    setLoading(true);
                    void session
                      .control("history_read", {
                        before: entries.at(-1)!.cursor,
                      })
                      .then((result) => {
                        if (request.current !== identity) return;
                        const page = historyPageSchema.parse(result);
                        setHistory((current) => ({
                          entries: [...current.entries, ...page.entries],
                          hasMore: page.hasMore,
                        }));
                      })
                      .catch((error) => {
                        if (request.current === identity)
                          setError(String(error));
                      })
                      .finally(() => {
                        if (request.current === identity) setLoading(false);
                      });
                  }}
                >
                  {loading ? "Loading…" : "Earlier changes"}
                </Button>
              )}
              <p className="history-coverage">
                Text revisions are recorded from this update onward.
              </p>
            </PanelBody>
          </>
        )}
      </PanelPopover>
    </DialogTrigger>
  );
}
