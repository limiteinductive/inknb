import { afterEach, describe, expect, test, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import {
  createConversation,
  createMetadata,
  defaultPreferences,
} from "./domain";
import type { Binding } from "./domain";
import { DocumentSession } from "./session";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

afterEach(() => {
  vi.useRealTimers();
  vi.resetAllMocks();
});

describe("agent-owned connections", () => {
  test("delivers saved pending asides once and preserves prose permissions", async () => {
    vi.useFakeTimers();
    vi.mocked(invoke).mockResolvedValue(undefined);
    const session = new DocumentSession();
    const text = "The garden study needs more plants.";
    const metadata = createMetadata();
    const conversation = createConversation(
      text,
      metadata,
      { from: 0, to: text.length },
      "What is missing here?",
      "read",
    );
    metadata.threads.push(conversation.thread);
    metadata.requests.push(conversation.request);
    session.update({
      text,
      metadata,
      preferences: { ...defaultPreferences, autosave: false },
    });
    const binding: Binding = {
      provider: "codex",
      sessionId: crypto.randomUUID(),
      label: "Codex",
      commandPath: "/usr/local/bin/codex",
    };

    await session.bind(binding, metadata.documentId);
    await vi.waitFor(() =>
      expect(session.getSnapshot().metadata.requests[0].state).toBe(
        "delivered",
      ),
    );
    await session.bind({ ...binding }, metadata.documentId);
    await session.deliver(conversation.request.id);

    expect(
      vi
        .mocked(invoke)
        .mock.calls.filter(([method]) => method === "deliver_codex"),
    ).toHaveLength(1);
    expect(session.getSnapshot().text).toBe(text);
    expect(session.getSnapshot().metadata.requests[0]).toMatchObject({
      permission: "read",
      binding,
    });
  });

  test("rejects connection to a different document and leaves failed deliveries for explicit retry", async () => {
    vi.useFakeTimers();
    vi.mocked(invoke).mockResolvedValue(undefined);
    const session = new DocumentSession();
    const metadata = createMetadata();
    const conversation = createConversation(
      "A garden.",
      metadata,
      { from: 0, to: 9 },
      "Check this.",
      "read",
    );
    metadata.threads.push(conversation.thread);
    metadata.requests.push({
      ...conversation.request,
      state: "failed",
      error: "Delivery uncertain",
    });
    session.update({ metadata, text: "A garden." });
    const binding: Binding = {
      provider: "codex",
      sessionId: crypto.randomUUID(),
      label: "Codex",
      commandPath: "/usr/local/bin/codex",
    };

    await expect(session.bind(binding, crypto.randomUUID())).rejects.toThrow(
      "open document changed",
    );
    expect(session.getSnapshot().metadata.binding).toBeNull();
    await session.bind(binding, metadata.documentId);
    expect(session.getSnapshot().metadata.requests[0].state).toBe("failed");
    expect(
      vi
        .mocked(invoke)
        .mock.calls.some(([method]) => method === "deliver_codex"),
    ).toBe(false);

    await session.bind(null, metadata.documentId);
    await session.deliver(conversation.request.id);
    expect(session.getSnapshot().metadata.binding).toBeNull();
    expect(
      vi
        .mocked(invoke)
        .mock.calls.some(([method]) => method === "deliver_codex"),
    ).toBe(false);
  });

  test("ignores completion from a delivery after the writer changes documents", async () => {
    vi.useFakeTimers();
    let finishDelivery: (() => void) | undefined;
    vi.mocked(invoke).mockImplementation((method) => {
      if (method === "deliver_codex")
        return new Promise((resolve) => {
          finishDelivery = () => resolve(undefined);
        });
      return Promise.resolve(undefined);
    });
    const session = new DocumentSession();
    const metadata = createMetadata();
    const binding: Binding = {
      provider: "codex",
      sessionId: crypto.randomUUID(),
      label: "Codex",
      commandPath: "/usr/local/bin/codex",
    };
    metadata.binding = binding;
    const conversation = createConversation(
      "A garden.",
      metadata,
      { from: 0, to: 9 },
      "Check this.",
      "read",
    );
    metadata.threads.push(conversation.thread);
    metadata.requests.push(conversation.request);
    session.update({ metadata });
    const delivery = session.deliver(conversation.request.id);
    await vi.waitFor(() => expect(finishDelivery).toBeDefined());
    const nextMetadata = createMetadata();
    session.update({ epoch: 1, metadata: nextMetadata, dirty: false });
    finishDelivery?.();
    await delivery;
    expect(session.getSnapshot().metadata).toBe(nextMetadata);
    expect(session.getSnapshot().dirty).toBe(false);
  });
});

test("attachment confirmation clears candidates and completes its repair work", async () => {
  vi.useFakeTimers();
  vi.mocked(invoke).mockResolvedValue(undefined);
  const session = new DocumentSession();
  const metadata = createMetadata();
  const conversation = createConversation(
    "A garden.",
    metadata,
    { from: 0, to: 9 },
    "Keep this attached.",
    "read",
  );
  conversation.thread.anchor.status = "detached";
  conversation.thread.anchorSuggestions.push({
    id: crypto.randomUUID(),
    label: "Garden",
    anchor: {
      from: 0,
      to: 9,
      quote: "A garden.",
      before: "",
      after: "",
      status: "attached",
    },
  });
  metadata.threads.push(conversation.thread);
  metadata.requests.push({
    ...conversation.request,
    messageId: null,
    trigger: { kind: "anchor_detached" },
    state: "delivered",
  });
  session.update({ text: "A garden.", metadata });
  session.reanchor(conversation.thread.id, { from: 0, to: 9 });
  expect(session.getSnapshot().metadata.threads[0].anchor.status).toBe(
    "attached",
  );
  expect(session.getSnapshot().metadata.threads[0].anchorSuggestions).toEqual(
    [],
  );
  expect(session.getSnapshot().metadata.requests[0].state).toBe("answered");
});

test("waits for recovered delivery reconciliation before enabling the editor", async () => {
  vi.useFakeTimers();
  const metadata = createMetadata();
  const conversation = createConversation(
    "A garden.",
    metadata,
    { from: 0, to: 9 },
    "Check this.",
    "read",
  );
  metadata.threads.push(conversation.thread);
  metadata.requests.push({ ...conversation.request, state: "sending" });
  let finishReceipts: (() => void) | undefined;
  vi.mocked(invoke).mockImplementation((method) => {
    if (method === "bootstrap")
      return Promise.resolve({
        preferences: { ...defaultPreferences, autosave: false },
        recovery: {
          path: null,
          text: "A garden.",
          metadata,
          expectedHash: null,
          expectedSidecarHash: null,
          events: [],
          saveEvent: null,
        },
        lastPath: null,
        commandPath: "/local/inknb",
        codexPath: null,
        socketPath: "/local/control.sock",
      });
    if (method === "delivery_receipts")
      return new Promise((resolve) => {
        finishReceipts = () => resolve({ [conversation.request.id]: "queued" });
      });
    return Promise.resolve(undefined);
  });
  const session = new DocumentSession();
  const initializing = session.initialize();
  await vi.waitFor(() => expect(finishReceipts).toBeDefined());
  expect(session.getSnapshot().ready).toBe(false);
  finishReceipts?.();
  await initializing;
  expect(session.getSnapshot().ready).toBe(true);
  expect(session.getSnapshot().metadata.requests[0].state).toBe("delivered");
  expect(session.getSnapshot().text).toBe("A garden.");
});
