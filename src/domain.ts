import { ChangeSet, Text } from "@codemirror/state";
import { z } from "zod";

export const selectionSchema = z.object({
  from: z.number().int().nonnegative(),
  to: z.number().int().nonnegative(),
});

export const anchorSchema = selectionSchema.extend({
  quote: z.string(),
  before: z.string(),
  after: z.string(),
  status: z.enum(["attached", "changed", "detached"]),
});

export const sourceSchema = z.object({
  id: z.string().uuid(),
  path: z.string(),
  label: z.string(),
  hash: z.string(),
  status: z.enum(["current", "changed", "missing"]),
  observedHash: z.string().nullable().default(null),
  review: z.string().nullable().default(null),
});

export const messageSchema = z.object({
  id: z.string().uuid(),
  author: z.enum(["human", "agent"]),
  content: z.string(),
  createdAt: z.string(),
  sources: z.array(sourceSchema),
  requestId: z.string().uuid().optional(),
  agent: z
    .object({
      provider: z.enum(["codex", "claude", "automation"]),
      sessionId: z.string(),
      label: z.string(),
    })
    .optional(),
});

export const threadSchema = z.object({
  id: z.string().uuid(),
  anchor: anchorSchema,
  originalQuote: z.string(),
  createdRevision: z.number().int().nonnegative(),
  createdAt: z.string(),
  resolved: z.boolean(),
  messages: z.array(messageSchema),
  anchorSuggestions: z
    .array(
      z.object({
        id: z.string().uuid(),
        label: z.string(),
        anchor: anchorSchema,
      }),
    )
    .default([]),
});

export const bindingSchema = z.object({
  provider: z.enum(["codex", "claude"]),
  sessionId: z.string().min(1),
  label: z.string(),
  commandPath: z.string(),
});

export const requestSchema = z.object({
  id: z.string().uuid(),
  threadId: z.string().uuid(),
  messageId: z.string().uuid().nullable(),
  revision: z.number().int().nonnegative(),
  trigger: z
    .discriminatedUnion("kind", [
      z.object({ kind: z.literal("human") }),
      z.object({
        kind: z.literal("source_changed"),
        sourceId: z.string().uuid(),
        hash: z.string().nullable(),
      }),
      z.object({
        kind: z.literal("proposal_stale"),
        proposalId: z.string().uuid(),
      }),
      z.object({ kind: z.literal("anchor_detached") }),
    ])
    .default({ kind: "human" }),
  permission: z.enum(["read", "edit"]),
  state: z.enum(["pending", "sending", "delivered", "answered", "failed"]),
  binding: bindingSchema.nullable(),
  createdAt: z.string(),
  deliveredAt: z.string().nullable(),
  error: z.string().nullable(),
});

export const proposalSchema = z.object({
  id: z.string().uuid(),
  threadId: z.string().uuid(),
  requestId: z.string().uuid(),
  revision: z.number().int().nonnegative(),
  from: z.number().int().nonnegative(),
  to: z.number().int().nonnegative(),
  expectedText: z.string(),
  replacement: z.string(),
  explanation: z.string(),
  status: z.enum([
    "pending",
    "applied",
    "undone",
    "rejected",
    "conflict",
    "superseded",
  ]),
  createdAt: z.string(),
  replaces: z.string().uuid().nullable().default(null),
});

export const metadataSchema = z.object({
  version: z.union([z.literal(1), z.literal(2)]).transform(() => 2 as const),
  documentId: z.string().uuid(),
  revision: z.number().int().nonnegative(),
  documentHash: z.string(),
  threads: z.array(threadSchema),
  requests: z.array(requestSchema),
  proposals: z.array(proposalSchema),
  binding: bindingSchema.nullable(),
});

export const preferencesSchema = z.object({
  version: z.literal(1),
  placement: z.enum(["margin", "inline"]),
  appearance: z.enum(["system", "light", "dark"]),
  typeface: z.enum(["editorial", "system", "monospace"]),
  fontSize: z.number().min(14).max(28),
  lineWidth: z.number().min(440).max(820),
  reduceMotion: z.boolean(),
  autosave: z.boolean(),
});

export type Selection = z.infer<typeof selectionSchema>;
export type Anchor = z.infer<typeof anchorSchema>;
export type Source = z.infer<typeof sourceSchema>;
export type Message = z.infer<typeof messageSchema>;
export type Thread = z.infer<typeof threadSchema>;
export type Binding = z.infer<typeof bindingSchema>;
export type AgentRequest = z.infer<typeof requestSchema>;
export type Proposal = z.infer<typeof proposalSchema>;
export type Metadata = z.infer<typeof metadataSchema>;
export type Preferences = z.infer<typeof preferencesSchema>;

export interface TextChange {
  from: number;
  to: number;
  insert: string;
}

export interface DocumentUpdate {
  text: string;
  metadata: Metadata;
}

export interface NewConversation {
  thread: Thread;
  request: AgentRequest;
}

export const defaultPreferences: Preferences = {
  version: 1,
  placement: "margin",
  appearance: "system",
  typeface: "editorial",
  fontSize: 19,
  lineWidth: 620,
  reduceMotion: false,
  autosave: true,
};

export function createMetadata(): Metadata {
  return {
    version: 2,
    documentId: crypto.randomUUID(),
    revision: 0,
    documentHash: "",
    threads: [],
    requests: [],
    proposals: [],
    binding: null,
  };
}

export function threadHasStaleSources(thread: Thread): boolean {
  return (
    !thread.resolved &&
    thread.messages.some((message) =>
      message.sources.some((source) => source.status !== "current"),
    )
  );
}

export function validateSelection(text: string, selection: Selection): void {
  selectionSchema.parse(selection);
  if (selection.from > selection.to || selection.to > text.length) {
    throw new Error("The passage is outside the document.");
  }
  for (const position of [selection.from, selection.to]) {
    const previous = text.charCodeAt(position - 1);
    const current = text.charCodeAt(position);
    if (
      previous >= 0xd800 &&
      previous <= 0xdbff &&
      current >= 0xdc00 &&
      current <= 0xdfff
    ) {
      throw new Error("The passage splits a Unicode character.");
    }
  }
}

export function captureAnchor(text: string, selection: Selection): Anchor {
  validateSelection(text, selection);
  return {
    from: selection.from,
    to: selection.to,
    quote: text.slice(selection.from, selection.to),
    before: text.slice(Math.max(0, selection.from - 48), selection.from),
    after: text.slice(selection.to, selection.to + 48),
    status: "attached",
  };
}

export function relocateAnchor(text: string, anchor: Anchor): Anchor {
  const positions: number[] = [];
  if (anchor.quote.length === 0) {
    const context = anchor.before + anchor.after;
    if (context.length === 0 && text.length === 0)
      return { ...anchor, from: 0, to: 0 };
    let offset = text.indexOf(context);
    while (context.length > 0 && offset !== -1) {
      positions.push(offset + anchor.before.length);
      offset = text.indexOf(context, offset + 1);
    }
  } else {
    let offset = text.indexOf(anchor.quote);
    while (offset !== -1) {
      positions.push(offset);
      offset = text.indexOf(anchor.quote, offset + 1);
    }
  }
  let candidates = positions;
  if (candidates.length > 1) {
    candidates = candidates.filter(
      (position) =>
        text.slice(Math.max(0, position - anchor.before.length), position) ===
          anchor.before &&
        text.slice(
          position + anchor.quote.length,
          position + anchor.quote.length + anchor.after.length,
        ) === anchor.after,
    );
  }
  if (candidates.length !== 1) return { ...anchor, status: "detached" };
  return {
    ...captureAnchor(text, {
      from: candidates[0],
      to: candidates[0] + anchor.quote.length,
    }),
    status: anchor.status,
  };
}

export function applyChanges(
  text: string,
  metadata: Metadata,
  edits: TextChange[],
): DocumentUpdate {
  const ordered = [...edits].sort((first, second) => first.from - second.from);
  let previousEnd = 0;
  for (const edit of ordered) {
    validateSelection(text, edit);
    if (edit.from < previousEnd) throw new Error("Document changes overlap.");
    previousEnd = edit.to;
  }
  const changes = ChangeSet.of(ordered, text.length);
  const nextText = changes.apply(Text.of(text.split("\n"))).toString();
  const threads = metadata.threads.map((thread) => ({
    ...thread,
    anchor: mapAnchor(nextText, thread.anchor, changes),
    anchorSuggestions: thread.anchorSuggestions
      .map((candidate) => ({
        ...candidate,
        anchor: mapAnchor(nextText, candidate.anchor, changes),
      }))
      .filter((candidate) => candidate.anchor.status === "attached"),
  }));
  const revision = metadata.revision + 1;
  const proposals = metadata.proposals.map((proposal) => {
    if (proposal.status !== "pending") return proposal;
    const mapped = mapAnchor(nextText, captureAnchor(text, proposal), changes);
    const valid =
      mapped.status === "attached" &&
      nextText.slice(mapped.from, mapped.to) === proposal.expectedText;
    return {
      ...proposal,
      from: mapped.from,
      to: mapped.to,
      revision,
      status: valid ? ("pending" as const) : ("conflict" as const),
    };
  });
  return {
    text: nextText,
    metadata: { ...metadata, revision, threads, proposals },
  };
}

export function mapAnchor(
  nextText: string,
  anchor: Anchor,
  changes: ChangeSet,
): Anchor {
  if (anchor.status === "detached") return anchor;
  const isCaret = anchor.from === anchor.to;
  let touched = false;
  let fromAssociation = 1;
  let toAssociation = isCaret ? 1 : -1;
  changes.iterChangedRanges((start, end) => {
    if (end > start && start === anchor.from) fromAssociation = -1;
    if (end > start && end === anchor.to) toAssociation = 1;
    if (
      (start < anchor.to && end > anchor.from) ||
      (start === end && start > anchor.from && start < anchor.to)
    )
      touched = true;
  });
  const from = changes.mapPos(anchor.from, fromAssociation);
  const to = Math.max(from, changes.mapPos(anchor.to, toAssociation));
  const status =
    !isCaret && from === to ? "detached" : touched ? "changed" : anchor.status;
  return { ...captureAnchor(nextText, { from, to }), status };
}

export function createConversation(
  text: string,
  metadata: Metadata,
  selection: Selection,
  content: string,
  permission: AgentRequest["permission"],
): NewConversation {
  if (content.trim().length === 0)
    throw new Error("Write a question or request first.");
  const anchor = captureAnchor(text, selection);
  const createdAt = new Date().toISOString();
  const message: Message = {
    id: crypto.randomUUID(),
    author: "human",
    content: content.trim(),
    createdAt,
    sources: [],
  };
  const thread: Thread = {
    id: crypto.randomUUID(),
    anchor,
    originalQuote: anchor.quote,
    createdRevision: metadata.revision,
    createdAt,
    resolved: false,
    messages: [message],
    anchorSuggestions: [],
  };
  const request: AgentRequest = {
    id: crypto.randomUUID(),
    threadId: thread.id,
    messageId: message.id,
    revision: metadata.revision,
    permission,
    trigger: { kind: "human" },
    state: "pending",
    binding: metadata.binding,
    createdAt,
    deliveredAt: null,
    error: null,
  };
  return { thread, request };
}

export function createProposal(
  text: string,
  metadata: Metadata,
  requestId: string,
  revision: number,
  selection: Selection,
  expectedText: string,
  replacement: string,
  explanation: string,
): Proposal {
  validateSelection(text, selection);
  const request = metadata.requests.find(
    (candidate) => candidate.id === requestId,
  );
  if (!request) throw new Error("The request no longer exists.");
  const thread = metadata.threads.find(
    (thread) => thread.id === request.threadId,
  );
  if (thread?.resolved) throw new Error("This conversation is resolved.");
  if (!thread || thread.anchor.status === "detached")
    throw new Error(
      "Attach this conversation to a passage before proposing an edit.",
    );
  if (selection.from < thread.anchor.from || selection.to > thread.anchor.to)
    throw new Error(
      "This edit is outside the passage attached to the human request.",
    );
  if (revision !== metadata.revision)
    throw new Error(
      "The document changed. Read the current revision before proposing an edit.",
    );
  if (text.slice(selection.from, selection.to) !== expectedText)
    throw new Error("The passage no longer matches the expected text.");
  return {
    id: crypto.randomUUID(),
    threadId: request.threadId,
    requestId,
    revision,
    from: selection.from,
    to: selection.to,
    replaces:
      request.trigger.kind === "proposal_stale"
        ? request.trigger.proposalId
        : null,
    expectedText,
    replacement,
    explanation,
    status: "pending",
    createdAt: new Date().toISOString(),
  };
}

export function figureMarkdown(label: string, reference: string): string {
  const escaped = label
    .replaceAll("\\", "\\\\")
    .replaceAll("[", "\\[")
    .replaceAll("]", "\\]");
  const encoded = encodeURI(reference)
    .replaceAll("#", "%23")
    .replaceAll("?", "%3F")
    .replaceAll("(", "%28")
    .replaceAll(")", "%29");
  return `![${escaped}](${encoded})`;
}

export function tableMarkdown(columns: string[], rows: string[][]): string {
  if (columns.length === 0 || rows.some((row) => row.length !== columns.length))
    throw new Error("Every table row must match its columns.");
  const cells = [columns, ...rows].map((row) =>
    row.map((cell) => cell.replaceAll("|", "\\|").replaceAll("\n", "<br>")),
  );
  return `\n| ${cells[0].join(" | ")} |\n| ${columns.map(() => "---").join(" | ")} |\n${cells
    .slice(1)
    .map((row) => `| ${row.join(" | ")} |`)
    .join("\n")}\n`;
}
