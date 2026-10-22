import { describe, expect, test } from "vitest";
import {
  applyChanges,
  createConversation,
  createMetadata,
  createProposal,
  metadataSchema,
} from "./domain";
import { planAutomation } from "./automation";

describe("writing maintenance", () => {
  test("keeps pending suggestions valid through unrelated typing and another accepted change", () => {
    const text = "Opening. A clear paragraph. Closing.";
    const metadata = createMetadata();
    const conversation = createConversation(
      text,
      metadata,
      { from: 9, to: 27 },
      "Improve this.",
      "read",
    );
    metadata.threads.push(conversation.thread);
    metadata.requests.push(conversation.request);
    const proposal = createProposal(
      text,
      metadata,
      conversation.request.id,
      0,
      { from: 11, to: 16 },
      "clear",
      "direct",
      "Use a concrete adjective.",
    );
    metadata.proposals.push(proposal);
    const changed = applyChanges(text, metadata, [
      { from: 0, to: 0, insert: "New opening. " },
    ]);
    expect(changed.metadata.proposals[0]).toMatchObject({
      status: "pending",
      revision: 1,
      from: 24,
      to: 29,
    });
    expect(changed.text.slice(24, 29)).toBe("clear");
    expect(
      planAutomation(metadata, changed.metadata).metadata.requests,
    ).toHaveLength(1);
    const touched = applyChanges(changed.text, changed.metadata, [
      { from: 24, to: 29, insert: "measured" },
    ]);
    const planned = planAutomation(changed.metadata, touched.metadata);
    expect(planned.metadata.proposals[0].status).toBe("conflict");
    expect(planned.metadata.requests.at(-1)).toMatchObject({
      trigger: { kind: "proposal_stale", proposalId: proposal.id },
      permission: "read",
      messageId: null,
    });
    expect(
      planned.events.some((event) => event.kind === "document.changed"),
    ).toBe(true);
    expect(
      planAutomation(planned.metadata, planned.metadata).events,
    ).toHaveLength(0);
  });

  test("queues source reviews once per version and supersedes obsolete work", () => {
    const metadata = createMetadata();
    const conversation = createConversation(
      "A result.",
      metadata,
      { from: 0, to: 9 },
      "Check this.",
      "read",
    );
    conversation.thread.messages.push({
      id: crypto.randomUUID(),
      author: "agent",
      createdAt: new Date().toISOString(),
      content: "Initial result.",
      images: [],
      sources: [
        {
          id: crypto.randomUUID(),
          path: "/tmp/results.csv",
          label: "Results",
          hash: "old",
          observedHash: "old",
          review: null,
          status: "current",
        },
      ],
    });
    metadata.threads.push(conversation.thread);
    metadata.requests.push({ ...conversation.request, state: "answered" });
    const changed = structuredClone(metadata);
    const source = changed.threads[0].messages[1].sources[0];
    source.observedHash = "new";
    source.status = "changed";
    const planned = planAutomation(metadata, changed);
    expect(planned.metadata.requests.at(-1)).toMatchObject({
      permission: "read",
      trigger: { kind: "source_changed", hash: "new" },
    });
    expect(
      planAutomation(planned.metadata, planned.metadata).metadata.requests,
    ).toHaveLength(2);
    const restored = structuredClone(planned.metadata);
    restored.threads[0].messages[1].sources[0].observedHash = "old";
    restored.threads[0].messages[1].sources[0].status = "current";
    expect(
      planAutomation(planned.metadata, restored).metadata.requests.at(-1)
        ?.state,
    ).toBe("answered");
  });

  test("loads existing sidecars with human requests and without automation fields", () => {
    const metadata = createMetadata();
    const conversation = createConversation(
      "A result.",
      metadata,
      { from: 0, to: 9 },
      "Check this.",
      "read",
    );
    metadata.threads.push(conversation.thread);
    metadata.requests.push(conversation.request);
    const serialized = JSON.parse(JSON.stringify(metadata));
    serialized.version = 1;
    delete serialized.requests[0].trigger;
    delete serialized.threads[0].anchorSuggestions;
    const loaded = metadataSchema.parse(serialized);
    expect(loaded.version).toBe(13);
    expect(loaded.requests[0].trigger.kind).toBe("human");
    expect(loaded.threads[0].anchorSuggestions).toEqual([]);
  });
});
