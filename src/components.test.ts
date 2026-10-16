import { afterEach, expect, test, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import {
  createConversation,
  createMetadata,
  defaultPreferences,
  metadataSchema,
} from "./domain";
import { DocumentSession } from "./session";
import { checkComponentValue, componentMessage } from "./component-bridge";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
afterEach(() => {
  vi.useRealTimers();
  vi.resetAllMocks();
});

test("persists component state and rejects stale or hidden frame writes without editing prose", async () => {
  vi.useFakeTimers();
  vi.mocked(invoke).mockResolvedValue(undefined);
  const session = new DocumentSession();
  const metadata = createMetadata();
  const text = "A garden needs a replicated trial.";
  const conversation = createConversation(
    text,
    metadata,
    { from: 0, to: text.length },
    "Inspect the evidence.",
    "read",
  );
  const component = {
    id: crypto.randomUUID(),
    bundleId: "a".repeat(64),
    title: "Evidence",
    revision: 0,
    data: { plants: 3 },
    state: { selected: "weekly" },
    hidden: false,
  };
  conversation.thread.components.push(component);
  metadata.threads.push(conversation.thread);
  metadata.requests.push(conversation.request);
  session.update({
    text,
    metadata,
    preferences: { ...defaultPreferences, autosave: false },
  });
  await session.componentMessage(component.id, {
    type: "state",
    revision: 0,
    state: { selected: "daily" },
  });
  expect(session.getSnapshot().text).toBe(text);
  expect(session.getSnapshot().metadata.requests[0].permission).toBe("read");
  expect(session.getSnapshot().metadata.threads[0].components[0]).toMatchObject(
    { revision: 1, state: { selected: "daily" } },
  );
  await expect(
    session.componentMessage(component.id, {
      type: "state",
      revision: 0,
      state: null,
    }),
  ).rejects.toThrow("Component state changed");
  await session.componentMessage(component.id, {
    type: "event",
    name: "inspect-schedule",
    payload: { schedule: "daily" },
  });
  expect(
    vi
      .mocked(invoke)
      .mock.calls.some(
        ([method, parameters]) =>
          method === "write_recovery" &&
          JSON.stringify(parameters).includes("component.event"),
      ),
  ).toBe(true);
  expect(
    metadataSchema.parse(
      JSON.parse(JSON.stringify(session.getSnapshot().metadata)),
    ),
  ).toEqual(session.getSnapshot().metadata);
  session.hideComponent(component.id);
  await expect(
    session.componentMessage(component.id, {
      type: "event",
      name: "inspect-schedule",
      payload: null,
    }),
  ).rejects.toThrow("no longer open");
});

test("the component bridge accepts local state and events without native commands", () => {
  expect(
    componentMessage.safeParse({
      inknb: 1,
      type: "invoke",
      command: "persist_document",
    }).success,
  ).toBe(false);
  expect(
    componentMessage.safeParse({
      inknb: 1,
      type: "state",
      requestId: "1",
      revision: 0,
      state: { visible: true },
    }).success,
  ).toBe(true);
  expect(() => checkComponentValue("x".repeat(256 * 1024))).toThrow("256 KiB");
});
