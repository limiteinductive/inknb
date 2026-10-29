import { ChangeSet, Text } from "@codemirror/state";
import { z } from "zod";
import { anchorSchema, selectionSchema, captureAnchor, validateSelection, mapAnchor } from "./anchors";
export { anchorSchema, selectionSchema, captureAnchor, validateSelection, mapAnchor } from "./anchors";
import { nativeDocumentSchema } from "./native-schema";
import { linkedResourceSchema } from "./resources";
import { documentPageSchema } from "./document-page";
import { imageSchema } from "./images";
import type { AsideDraft, ImageAsset } from "./images";
import type { MessageAnnotation } from "./passage-reference";
import { passageReferenceSchema, messageAnnotationSchema, passageSourceSchema, mapPassageSource } from "./passage-reference";
import {
  previewAnchorSchema,
  previewBuildSchema,
  previewReferenceSchema,
} from "./preview-model";
import type { PreviewAnchor } from "./preview-model";

export const sourceSchema = z.object({
  id: z.string().uuid(),
  path: z.string(),
  label: z.string(),
  hash: z.string(),
  status: z.enum(["current", "changed", "missing"]),
  observedHash: z.string().nullable().default(null),
  review: z.string().nullable().default(null),
});

export function responseWords(content: string): RegExpMatchArray[] {
  return [...content.matchAll(/\S+/gu)];
}

export const agentAnswerSchema = z
  .string()
  .trim()
  .min(1)
  .refine(
    (content) => responseWords(content).length <= 100,
    "Keep the aside answer to 100 words. Put longer explanations in details.",
  );

export const agentIdentitySchema = z.object({
  provider: z.enum(["codex", "claude", "automation"]),
  sessionId: z.string(),
  label: z.string(),
  name: z.string().min(1).max(120).optional(),
  role: z.string().max(120).optional(),
  sessionUrl: z.string().url().optional(),
});

export const asideReferenceSchema = z.object({
  documentId: z.string().uuid(),
  threadId: z.string().uuid(),
});

export const messageSchema = z.object({
  id: z.string().uuid(),
  author: z.enum(["human", "agent"]),
  content: z.string(),
  details: z.string().optional(),
  createdAt: z.string(),
  sources: z.array(sourceSchema),
  images: z.array(imageSchema).default([]),
  references: z.array(passageReferenceSchema).optional(),
  annotations: z.array(messageAnnotationSchema).optional(),
  requestId: z.string().uuid().optional(),
  awaitingHuman: z.boolean().optional(),
  status: z.enum(["working", "complete"]).optional(),
  continuedIn: asideReferenceSchema.optional(),
  agent: agentIdentitySchema.optional(),
});

export const componentSchema = z.object({
  id: z.string().uuid(),
  bundleId: z.string().regex(/^[a-f0-9]{64}$/),
  title: z.string(),
  revision: z.number().int().nonnegative(),
  data: z.json(),
  state: z.json(),
  hidden: z.boolean(),
});

export type ComponentInstance = z.infer<typeof componentSchema>;

export const threadSchema = z.object({
  id: z.string().uuid(),
  kind: z.enum(["discussion", "suggestion"]).default("discussion"),
  anchor: anchorSchema.nullable(),
  previewAnchor: previewAnchorSchema.nullable().default(null),
  originalQuote: z.string(),
  updatedAt: z.string().optional(),
  createdRevision: z.number().int().nonnegative(),
  createdAt: z.string(),
  resolved: z.boolean(),
  reopenedMessageId: z.string().uuid().optional(),
  resolution: z
    .object({
      reason: z.string(),
      outcome: z.enum(["done", "superseded"]),
      actor: z.string(),
      createdAt: z.string(),
      lastMessageId: z.string().uuid().nullable(),
    })
    .nullable()
    .default(null),
  links: z
    .array(
      asideReferenceSchema.extend({
        relation: z.enum([
          "related",
          "suggestion_for",
          "supersedes",
          "superseded_by",
        ]),
      }),
    )
    .default([]),
  messages: z.array(messageSchema),
  components: z.array(componentSchema).default([]),
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
  name: z.string().min(1).max(120).optional(),
  role: z.string().max(120).optional(),
  sessionUrl: z.string().url().optional(),
});

export const agentConnectionSchema = bindingSchema.extend({ id: z.string().min(1) });
export const decisionOptionSchema = z.object({
  label: z.string().trim().min(1).max(80),
  detail: z.string().max(240),
});
export const decisionSchema = z.object({
  id: z.string().uuid(),
  question: z.string().trim().min(1).max(100),
  options: z.array(decisionOptionSchema).min(1).max(3),
  recommended: z.number().int().nonnegative(),
  context: z.string().default(""),
  anchor: anchorSchema.nullable(),
  creator: agentIdentitySchema,
  originalAnchor: anchorSchema.nullable(),
  sourceRevision: z.number().int().nonnegative().nullable(),
  createdAt: z.string(),
  status: z.enum(["open", "answered", "acknowledged", "withdrawn", "superseded"]),
  answer: z.object({
    text: z.string(),
    option: z.number().int().nonnegative().nullable(),
    createdAt: z.string(),
    origin: z.literal("human"),
    recordedIn: z.literal("inknb"),
  }).nullable(),
  acknowledgement: z.object({ agent: agentIdentitySchema, createdAt: z.string() }).nullable(),
  supersededBy: z.string().uuid().nullable(),
  reason: z.string().nullable(),
}).refine((decision) => decision.recommended < decision.options.length, "Choose an existing recommended option.");

export const requestSchema = z.object({
  id: z.string().uuid(),
  threadId: z.string().uuid().nullable(),
  messageId: z.string().uuid().nullable(),
  revision: z.number().int().nonnegative(),
  trigger: z
    .discriminatedUnion("kind", [
      z.object({ kind: z.literal("human") }),
      z.object({ kind: z.literal("annotation"), annotationId: z.string().uuid() }),
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
      z.object({ kind: z.literal("completion_review") }),
    ])
    .default({ kind: "human" }),
  permission: z.enum(["read", "edit"]),
  state: z.enum(["pending", "sending", "delivered", "answered", "failed"]),
  binding: bindingSchema.nullable(),
  createdAt: z.string(),
  deliveredAt: z.string().nullable(),
  error: z.string().nullable(),
});

export const annotationWorkSchema = z.object({
  id: z.string().uuid(),
  source: passageSourceSchema,
  comment: z.string(),
  createdAt: z.string(),
  status: z.enum(["open", "waiting", "resolved"]),
  continuedIn: asideReferenceSchema.nullable(),
  reason: z.string().nullable(),
  resolvedBy: agentIdentitySchema.optional(),
});
export type AnnotationWork = z.infer<typeof annotationWorkSchema>;

export const proposalSchema = z.object({
  id: z.string().uuid(),
  turnId: z.string().uuid().nullable().optional(),
  annotationId: z.string().uuid().optional(),
  threadId: z.string().uuid().nullable().default(null),
  requestId: z.string().uuid().nullable().default(null),
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
  creator: agentIdentitySchema.optional(),
});

export const metadataSchema = z
  .object({
    version: z.union([
      z.literal(1),
      z.literal(2),
      z.literal(3),
      z.literal(4),
      z.literal(5),
      z.literal(6),
      z.literal(7),
      z.literal(8),
      z.literal(9),
      z.literal(10),
      z.literal(11),
      z.literal(12),
      z.literal(13),
      z.literal(14),
    ]),
    documentId: z.string().uuid(),
    revision: z.number().int().nonnegative(),
    documentHash: z.string(),
    nativeDocument: nativeDocumentSchema.nullable().optional(),
    threads: z.array(threadSchema),
    annotations: z.array(annotationWorkSchema).default([]),
    requests: z.array(requestSchema),
    proposals: z.array(proposalSchema),
    resources: z.array(linkedResourceSchema).default([]),
    page: documentPageSchema.nullable().default(null),
    binding: bindingSchema.nullable().optional(),
    agents: z.array(agentConnectionSchema).optional(),
    defaultAgentId: z.string().nullable().optional(),
    decisions: z.array(decisionSchema).default([]),
    agentAccess: z.enum(["read", "edit"]).nullable().default(null),
    preview: previewReferenceSchema.nullable().default(null),
    previewLastGood: previewReferenceSchema.nullable().default(null),
    previewBuild: previewBuildSchema.nullable().default(null),
  })
  .refine(
    (metadata) => metadata.version !== 10 || Boolean(metadata.nativeDocument),
    "A native document is required for metadata version 10.",
  )
  .transform((metadata) => {
    const { binding, ...current } = metadata;
    const agents = metadata.agents ?? (binding ? [{ ...binding, id: agentId(binding) }] : []);
    if (new Set(agents.map((agent) => agent.id)).size !== agents.length || agents.some((agent) => agent.id !== agentId(agent)))
      throw Error("Agent connection identities must be unique and match their sessions.");
    const defaultAgentId: string | null = metadata.defaultAgentId !== undefined ? metadata.defaultAgentId : (agents.length ? agents[0].id : null);
    if (defaultAgentId && !agents.some((agent) => agent.id === defaultAgentId))
      throw Error("The default agent must be connected.");
    const threads = [...metadata.threads];
    const proposals = metadata.proposals.map((proposal) => {
      const origin = threads.find((thread) => thread.id === proposal.threadId);
      if (
        !origin ||
        origin.kind === "suggestion" ||
        !["pending", "conflict", "superseded"].includes(proposal.status)
      )
        return proposal;
      threads.push({
        ...origin,
        id: proposal.id,
        kind: "suggestion",
        anchor: {
          from: proposal.from,
          to: proposal.to,
          quote: proposal.expectedText,
          before: "",
          after: "",
          status: proposal.status === "pending" ? "attached" : "changed",
        },
        previewAnchor: null,
        originalQuote: proposal.expectedText,
        createdAt: proposal.createdAt,
        resolved: false,
        resolution: null,
        messages: [],
        components: [],
        anchorSuggestions: [],
        links: [
          {
            documentId: metadata.documentId,
            threadId: origin.id,
            relation: "suggestion_for",
          },
        ],
      });
      return { ...proposal, threadId: proposal.id };
    });
    return {
      ...current,
      agents,
      defaultAgentId,
      threads,
      proposals,
      requests: metadata.requests.map((request) => {
        if (request.trigger.kind !== "proposal_stale") return request;
        const proposalId = request.trigger.proposalId;
        return {
          ...request,
          threadId:
            proposals.find((proposal) => proposal.id === proposalId)
              ?.threadId ?? request.threadId,
        };
      }),
      version: 14 as const,
      agentAccess:
        metadata.version < 5
          ? ("read" as const)
          : (metadata.agentAccess ??
            (metadata.version < 9 ? ("read" as const) : null)),
    };
  });

const outlineSchema = z.object({
  presentation: z.enum(["panel", "rail"]).default("panel"),
  side: z.enum(["left", "right"]).default("left"),
  width: z.number().int().min(160).max(360).default(200),
  min_level: z.number().int().min(1).max(6).default(1),
  max_level: z.number().int().min(1).max(6).default(6),
  indent: z.number().int().min(0).max(24).default(10),
  follow: z.boolean().default(true),
}).refine((outline) => outline.min_level <= outline.max_level, {
  message: "min_level must not exceed max_level",
});

export const preferencesSchema = z.object({
  version: z.literal(1),
  placement: z.enum(["margin", "inline"]),
  appearance: z.enum(["system", "light", "dark"]),
  typeface: z.enum(["editorial", "system", "monospace"]),
  font_size: z.number().min(14).max(28),
  line_width: z.number().min(440).max(820),
  reduce_motion: z.boolean(),
  autosave: z.boolean(),
  agent_edits: z.boolean().default(true),
  comment_recipients: z.enum(["default", "choose"]).default("choose"),
  detached_preview: z.enum(["document", "active_document"]).default("document"),
  library_depth: z.number().int().min(-1).default(1),
  library_sort: z.enum(["recent", "alphabetical", "manual"]).default("recent"),
  document_outline: z.boolean().default(true),
  decision_notifications: z.boolean().default(true),
  outline: outlineSchema.prefault({}),
  shortcuts: z.record(z.string(), z.array(z.string())).default({}),
  shortcut_timeout_ms: z.number().int().min(200).max(5000).default(1500),
});

export const configurationSchema = z.object({
  revision: z.number().int().nonnegative(),
  effective: preferencesSchema,
});
export type ConfigurationSnapshot = z.infer<typeof configurationSchema>;

export type Selection = z.infer<typeof selectionSchema>;
export type Anchor = z.infer<typeof anchorSchema>;
export type Source = z.infer<typeof sourceSchema>;
export type Message = z.infer<typeof messageSchema>;
export function messageSummary(message: Message | undefined): string {
  return message?.content || message?.annotations?.[0]?.comment || message?.annotations?.[0]?.source.quote || message?.images[0]?.name || "";
}
export type Thread = z.infer<typeof threadSchema>;
export type AsideReference = z.infer<typeof asideReferenceSchema>;
export type AgentConnection = z.infer<typeof agentConnectionSchema>;
export type AgentIdentity = z.infer<typeof agentIdentitySchema>;
export type Decision = z.infer<typeof decisionSchema>;
export type Binding = z.infer<typeof bindingSchema>;
export type AgentRequest = z.infer<typeof requestSchema>;
export type Proposal = z.infer<typeof proposalSchema>;
export type Metadata = z.infer<typeof metadataSchema>;
export type Preferences = z.infer<typeof preferencesSchema>;

export function threadActivity(
  metadata: Metadata,
  thread: Thread,
): string | null {
  const messages = thread.messages
    .filter((message) => message.author === "agent")
    .map((message) => message.id);
  const components = thread.components.map((component) => ({
    id: component.id,
    revision: component.revision,
  }));
  const sources = thread.messages.flatMap((message) =>
    message.sources.map((source) => ({
      id: source.id,
      hash: source.status === "current" ? source.hash : source.observedHash,
      status: source.status,
    })),
  );
  const proposals = metadata.proposals
    .filter((proposal) => proposal.threadId === thread.id)
    .map((proposal) => proposal.id);
  const suggestions = thread.anchorSuggestions.map(
    (suggestion) => suggestion.id,
  );
  if (
    !messages.length &&
    !components.length &&
    !sources.length &&
    !proposals.length &&
    !suggestions.length &&
    !thread.links.length &&
    !thread.resolution
  )
    return null;
  return JSON.stringify({
    messages,
    components,
    sources,
    proposals,
    suggestions,
    ...(thread.links.length ? { links: thread.links } : {}),
    ...(thread.resolution ? { resolution: thread.resolution } : {}),
  });
}

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
  font_size: 17,
  line_width: 620,
  reduce_motion: false,
  autosave: true,
  agent_edits: true,
  comment_recipients: "choose",
  detached_preview: "document",
  library_depth: 1,
  library_sort: "recent",
  document_outline: true,
  decision_notifications: true,
  outline: outlineSchema.parse({}),
  shortcuts: {},
  shortcut_timeout_ms: 1500,
};

export function createMetadata(): Metadata {
  return {
    version: 14,
    documentId: crypto.randomUUID(),
    revision: 0,
    documentHash: "",
    threads: [],
    annotations: [],
    requests: [],
    proposals: [],
    resources: [],
    page: null,
    agents: [],
    defaultAgentId: null,
    decisions: [],
    agentAccess: null,
    preview: null,
    previewLastGood: null,
    previewBuild: null,
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
    messages: thread.messages.map(message => ({ ...message, ...(message.references ? { references: message.references.map(reference => ({ ...reference, source: mapPassageSource(reference.source, metadata.documentId, nextText, changes) })) } : {}), ...(message.annotations ? { annotations: message.annotations.map(annotation => ({ ...annotation, source: mapPassageSource(annotation.source, metadata.documentId, nextText, changes) })) } : {}) })),
    anchor: thread.anchor ? mapAnchor(nextText, thread.anchor, changes) : null,
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
    metadata: { ...metadata, revision, annotations: metadata.annotations.map(annotation => ({ ...annotation, source: mapPassageSource(annotation.source, metadata.documentId, nextText, changes) })), threads, proposals, decisions: metadata.decisions.map((decision) => ({ ...decision, anchor: decision.anchor ? mapAnchor(nextText, decision.anchor, changes) : null })) },
  };
}

export function createConversation(
  text: string,
  metadata: Metadata,
  selection: Selection | null,
  content: string,
  permission: AgentRequest["permission"],
  previewAnchor: PreviewAnchor | null = null,
  images: ImageAsset[] = [],
  annotations: MessageAnnotation[] = [],
): NewConversation {
  if (content.trim().length === 0 && images.length === 0 && annotations.length === 0)
    throw new Error("Write a question or request first.");
  const anchor = selection ? captureAnchor(text, selection) : null;
  const createdAt = new Date().toISOString();
  const message: Message = {
    id: crypto.randomUUID(),
    author: "human",
    content: content.trim(),
    annotations,
    createdAt,
    sources: [],
    images,
  };
  const thread: Thread = {
    id: crypto.randomUUID(),
    kind: "discussion",
    anchor,
    previewAnchor,
    originalQuote: previewAnchor?.quote || anchor?.quote || "",
    createdRevision: metadata.revision,
    createdAt,
    resolved: false,
    resolution: null,
    links: [],
    messages: [message],
    components: [],
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
    binding: defaultAgent(metadata),
    createdAt,
    deliveredAt: null,
    error: null,
  };
  return { thread, request };
}

export function proposalTurnId(
  metadata: Metadata,
  proposal: Pick<Proposal, "requestId" | "createdAt" | "turnId">,
  thread: Thread,
): string | null {
  const request = metadata.requests.find(
    (request) => request.id === proposal.requestId,
  );
  const explicit = proposal.turnId ?? request?.messageId;
  if (explicit) return explicit;
  const origin =
    metadata.threads.find((candidate) =>
      thread.links.some(
        (link) =>
          link.relation === "suggestion_for" &&
          link.documentId === metadata.documentId &&
          link.threadId === candidate.id,
      ),
    ) ?? thread;
  const preceding = origin.messages.filter(
    (message) => message.createdAt <= proposal.createdAt,
  );
  return (
    preceding.filter((message) => message.author === "human").at(-1)?.id ??
    preceding[0]?.id ??
    null
  );
}

export function createProposal(
  text: string,
  metadata: Metadata,
  requestId: string | null,
  revision: number,
  selection: Selection,
  expectedText: string,
  replacement: string,
  explanation: string,
  threadId: string | null = null,
): Proposal {
  validateSelection(text, selection);
  const request = metadata.requests.find(
    (candidate) => candidate.id === requestId,
  );
  if (requestId && !request) throw new Error("The request no longer exists.");
  if (request && threadId && request.threadId !== threadId)
    throw Error("The request belongs to another aside.");
  const contextThreadId = threadId ?? request?.threadId ?? null;
  const thread = metadata.threads.find(
    (thread) => thread.id === contextThreadId,
  );
  if (contextThreadId && !thread) throw Error("The aside no longer exists.");
  if (revision !== metadata.revision)
    throw new Error(
      "The document changed. Read the current revision before proposing an edit.",
    );
  if (text.slice(selection.from, selection.to) !== expectedText)
    throw new Error("The passage no longer matches the expected text.");
  const createdAt = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    turnId: thread ? proposalTurnId(metadata, { requestId, createdAt }, thread) : null,
    threadId: contextThreadId,
    requestId,
    revision,
    from: selection.from,
    to: selection.to,
    replaces:
      request?.trigger.kind === "proposal_stale"
        ? request.trigger.proposalId
        : null,
    expectedText,
    replacement,
    explanation,
    status: "pending",
    createdAt,
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

export function agentId(agent: Pick<AgentIdentity, "provider" | "sessionId">): string {
  return `${agent.provider}:${agent.sessionId}`;
}

export function agentAttribution(agent?: AgentIdentity | null): string {
  if (!agent) return "Your agent";
  const name = agent.provider === "automation"
    ? agent.name ?? agent.label
    : agent.name && agent.name !== agent.label
    ? agent.name
    : `${agent.label} · ${agent.sessionId.slice(-8)}`;
  return agent.role ? `${name} · ${agent.role}` : name;
}

export function defaultAgent(metadata: Metadata): AgentConnection | null {
  return metadata.agents.find((agent) => agent.id === metadata.defaultAgentId) ?? null;
}

export function requestAgentIds(metadata: Metadata, threadId?: string, draft?: Pick<AsideDraft, "recipientAgentIds" | "recipientAgentId">, mode: Preferences["comment_recipients"] = "choose"): string[] {
  if (mode === "default") return metadata.defaultAgentId ? [metadata.defaultAgentId] : [];
  if (draft?.recipientAgentIds?.length) return [...new Set(draft.recipientAgentIds)];
  if (draft?.recipientAgentId) return [draft.recipientAgentId];
  const previous = threadId ? metadata.requests.filter(request => request.threadId === threadId && request.trigger.kind === "human").at(-1) : null;
  const recipients = previous?.messageId
    ? metadata.requests.filter(request => request.messageId === previous.messageId && request.binding).map(request => agentId(request.binding!))
    : [];
  return recipients.length ? [...new Set(recipients)] : metadata.defaultAgentId ? [metadata.defaultAgentId] : [];
}
