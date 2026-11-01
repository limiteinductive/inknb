import type { Metadata } from "./domain";

function sameValue(previous: unknown, next: unknown): boolean {
  if (previous === next) return true;
  if (previous === null || next === null || typeof previous !== "object" || typeof next !== "object") return false;
  if (Array.isArray(previous))
    return Array.isArray(next) && previous.length === next.length && previous.every((value, index) => sameValue(value, next[index]));
  if (Array.isArray(next)) return false;
  const previousRecord = previous as Record<string, unknown>;
  const nextRecord = next as Record<string, unknown>;
  const keys = Object.keys(previousRecord);
  return keys.length === Object.keys(nextRecord).length && keys.every(key => Object.hasOwn(nextRecord, key) && sameValue(previousRecord[key], nextRecord[key]));
}

export function shareValue<Value>(previous: Value, next: Value): Value {
  return sameValue(previous, next) ? previous : next;
}

function reuseRecords<RecordType extends { id: string }>(previous: RecordType[], next: RecordType[]): RecordType[] {
  const records = new Map(previous.map(record => [record.id, record]));
  const shared = next.map(record => {
    const saved = records.get(record.id);
    return saved ? shareValue(saved, record) : record;
  });
  return shared.length === previous.length && shared.every((record, index) => record === previous[index]) ? previous : shared;
}

export function shareMetadata(previous: Metadata, next: Metadata): Metadata {
  if (previous.documentId !== next.documentId) return next;
  const threads = new Map(previous.threads.map(thread => [thread.id, thread]));
  return {
    ...next,
    threads: reuseRecords(previous.threads, next.threads.map(thread => {
      const saved = threads.get(thread.id);
      return saved ? { ...thread, messages: reuseRecords(saved.messages, thread.messages) } : thread;
    })),
    requests: reuseRecords(previous.requests, next.requests),
    proposals: reuseRecords(previous.proposals, next.proposals),
    decisions: reuseRecords(previous.decisions, next.decisions),
    annotations: reuseRecords(previous.annotations, next.annotations),
    agents: reuseRecords(previous.agents, next.agents),
  };
}
