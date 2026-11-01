import type { Metadata, Message, Thread } from "./domain";
import type { SessionState } from "./session";
import { shareValue } from "./snapshot-sharing";

export type DocumentState = Pick<SessionState,
  | "profile" | "ready" | "epoch" | "text" | "asideReferences" | "path"
  | "preferences" | "saving" | "status" | "error" | "externalChange"
  | "threadReads" | "previewInformation" | "previewSelection" | "previewRuntime"
  | "previewArtifactId" | "previewLocation" | "previewHost"
  | "commandPath" | "codexPath" | "socketPath"
> & { metadata: Omit<Metadata, "nativeDocument"> };

type DocumentFields = Omit<DocumentState, "text" | "metadata">;
type MetadataFields = Omit<Metadata, "nativeDocument" | "threads" | "requests" | "proposals" | "decisions" | "annotations" | "agents">;
type ThreadFields = Omit<Thread, "messages">;

interface FieldChanges<Value> {
  set: Partial<Value>;
  removed: (keyof Value)[];
}
interface RecordChanges<Value> {
  upsert: Value[];
  removed: string[];
  order: string[] | null;
}
interface DocumentChanges {
  fields: FieldChanges<DocumentFields>;
  text: { from: number; to: number; insert: string } | null;
  metadata: {
    fields: FieldChanges<MetadataFields>;
    threads: RecordChanges<ThreadFields> | null;
    messages: Record<string, RecordChanges<Message>>;
    requests: RecordChanges<Metadata["requests"][number]> | null;
    proposals: RecordChanges<Metadata["proposals"][number]> | null;
    decisions: RecordChanges<Metadata["decisions"][number]> | null;
    annotations: RecordChanges<Metadata["annotations"][number]> | null;
    agents: RecordChanges<Metadata["agents"][number]> | null;
  };
}
export type DocumentPublication =
  | { kind: "snapshot"; state: DocumentState }
  | { kind: "changes"; from: number; changes: DocumentChanges };

export function documentState(state: SessionState): DocumentState {
  const { nativeDocument, ...metadata } = state.metadata;
  return {
    profile: state.profile, ready: state.ready, epoch: state.epoch,
    text: state.text, metadata, asideReferences: state.asideReferences, path: state.path,
    preferences: state.preferences, saving: state.saving, status: state.status,
    error: state.error, externalChange: state.externalChange, threadReads: state.threadReads,
    previewInformation: state.previewInformation, previewSelection: state.previewSelection,
    previewRuntime: state.previewRuntime, previewArtifactId: state.previewArtifactId,
    previewLocation: state.previewLocation, previewHost: state.previewHost,
    commandPath: state.commandPath, codexPath: state.codexPath, socketPath: state.socketPath,
  };
}

function fieldChanges<Value extends object>(previous: Value, next: Value): FieldChanges<Value> {
  const set: Partial<Value> = {};
  const removed: (keyof Value)[] = [];
  for (const key of Object.keys(next) as (keyof Value)[])
    if (next[key] !== undefined && shareValue(previous[key], next[key]) !== previous[key]) set[key] = next[key];
  for (const key of Object.keys(previous) as (keyof Value)[])
    if (!Object.hasOwn(next, key) || next[key] === undefined) removed.push(key);
  return { set, removed };
}

function applyFields<Value extends object>(previous: Value, changes: FieldChanges<Value>): Value {
  if (!changes.removed.length && !Object.keys(changes.set).length) return previous;
  const next = { ...previous, ...changes.set };
  for (const key of changes.removed) delete next[key];
  return next;
}

function recordChanges<Value extends { id: string }>(previous: Value[], next: Value[]): RecordChanges<Value> | null {
  if (previous === next) return null;
  const saved = new Map(previous.map(record => [record.id, record]));
  const identities = new Set(next.map(record => record.id));
  const upsert = next.filter(record => !saved.has(record.id) || shareValue(saved.get(record.id), record) !== saved.get(record.id));
  const removed = previous.filter(record => !identities.has(record.id)).map(record => record.id);
  const order = previous.length === next.length && previous.every((record, index) => record.id === next[index].id) ? null : next.map(record => record.id);
  return upsert.length || removed.length || order ? { upsert, removed, order } : null;
}

function applyRecords<Value extends { id: string }>(previous: Value[], changes: RecordChanges<Value> | null): Value[] {
  if (!changes) return previous;
  const records = new Map(previous.map(record => [record.id, record]));
  for (const identity of changes.removed) records.delete(identity);
  for (const record of changes.upsert) records.set(record.id, record);
  return (changes.order ?? [...records.keys()]).map(identity => {
    const record = records.get(identity);
    if (!record) throw Error("A document publication references an unavailable record.");
    return record;
  });
}

export function publishDocument(previous: DocumentState, next: DocumentState, publication: number): DocumentPublication {
  if (previous.metadata.documentId !== next.metadata.documentId) throw Error("The document publication identity changed.");
  const { text: previousText, metadata: previousMetadata, ...previousFields } = previous;
  const { text: nextText, metadata: nextMetadata, ...nextFields } = next;
  const { threads: previousThreads, requests: previousRequests, proposals: previousProposals, decisions: previousDecisions, annotations: previousAnnotations, agents: previousAgents, ...previousMetadataFields } = previousMetadata;
  const { threads, requests, proposals, decisions, annotations, agents, ...metadataFields } = nextMetadata;
  let text: DocumentChanges["text"] = null;
  if (previousText !== nextText) {
    let from = 0;
    while (from < previousText.length && from < nextText.length && previousText[from] === nextText[from]) from += 1;
    let previousEnd = previousText.length;
    let nextEnd = nextText.length;
    while (previousEnd > from && nextEnd > from && previousText[previousEnd - 1] === nextText[nextEnd - 1]) {
      previousEnd -= 1;
      nextEnd -= 1;
    }
    text = { from, to: previousEnd, insert: nextText.slice(from, nextEnd) };
  }
  const savedThreads = new Map(previousThreads.map(thread => [thread.id, thread]));
  const messages: DocumentChanges["metadata"]["messages"] = {};
  for (const thread of threads) {
    const changes = recordChanges(savedThreads.get(thread.id)?.messages ?? [], thread.messages);
    if (changes) messages[thread.id] = changes;
  }
  return { kind: "changes", from: publication, changes: {
    fields: fieldChanges(previousFields, nextFields), text,
    metadata: {
      fields: fieldChanges(previousMetadataFields, metadataFields),
      threads: recordChanges(previousThreads.map(({ messages, ...thread }) => thread), threads.map(({ messages, ...thread }) => thread)),
      messages,
      requests: recordChanges(previousRequests, requests),
      proposals: recordChanges(previousProposals, proposals),
      decisions: recordChanges(previousDecisions, decisions),
      annotations: recordChanges(previousAnnotations, annotations),
      agents: recordChanges(previousAgents, agents),
    },
  } };
}

export function receiveDocument(previous: DocumentState, publication: number, update: DocumentPublication): DocumentState {
  if (update.kind === "snapshot") {
    if (update.state.metadata.documentId !== previous.metadata.documentId) throw Error("The document publication identity changed.");
    return update.state;
  }
  if (update.from !== publication) throw Error("The document publication is out of order.");
  const changes = update.changes;
  const savedThreads = new Map(previous.metadata.threads.map(thread => [thread.id, thread]));
  const threadFields = changes.metadata.threads
    ? applyRecords(previous.metadata.threads.map(({ messages, ...thread }) => thread), changes.metadata.threads)
    : previous.metadata.threads;
  const changedThreads = new Set(changes.metadata.threads?.upsert.map(thread => thread.id));
  const threads = !changes.metadata.threads && !Object.keys(changes.metadata.messages).length
    ? previous.metadata.threads
    : threadFields.map(thread => {
      const saved = savedThreads.get(thread.id);
      const messages = applyRecords(saved?.messages ?? [], changes.metadata.messages[thread.id] ?? null);
      return saved && !changedThreads.has(thread.id) && messages === saved.messages ? saved : { ...thread, messages };
    });
  const { metadata, text, ...fields } = previous;
  const { threads: previousThreads, requests, proposals, decisions, annotations, agents, ...metadataFields } = metadata;
  return {
    ...applyFields(fields, changes.fields),
    text: changes.text ? text.slice(0, changes.text.from) + changes.text.insert + text.slice(changes.text.to) : text,
    metadata: {
      ...applyFields(metadataFields, changes.metadata.fields), threads,
      requests: applyRecords(requests, changes.metadata.requests),
      proposals: applyRecords(proposals, changes.metadata.proposals),
      decisions: applyRecords(decisions, changes.metadata.decisions),
      annotations: applyRecords(annotations, changes.metadata.annotations),
      agents: applyRecords(agents, changes.metadata.agents),
    },
  };
}
