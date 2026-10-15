import { describe, expect, test } from "vitest";
import {
  applyChanges,
  captureAnchor,
  createConversation,
  createMetadata,
  createProposal,
  relocateAnchor,
} from "./domain";

describe("annotation anchors", () => {
  test("keeps an exact replacement attached to its new passage", () => {
    const text = "A clear paragraph.";
    const metadata = createMetadata();
    metadata.threads.push(
      createConversation(
        text,
        metadata,
        { from: 0, to: text.length },
        "Review this",
        "read",
      ).thread,
    );
    const updated = applyChanges(text, metadata, [
      { from: 0, to: text.length, insert: "A direct paragraph." },
    ]);
    expect(updated.metadata.threads[0].anchor.quote).toBe(
      "A direct paragraph.",
    );
    expect(updated.metadata.threads[0].anchor.status).toBe("changed");
  });
  test("follows an untouched passage when the writer inserts text before it", () => {
    const text = "First paragraph.\n\nThe selected passage.\n";
    const metadata = createMetadata();
    const from = text.indexOf("The selected");
    const conversation = createConversation(
      text,
      metadata,
      { from, to: from + 21 },
      "Check this passage",
      "read",
    );
    metadata.threads.push(conversation.thread);
    const updated = applyChanges(text, metadata, [
      { from: 0, to: 0, insert: "A new opening.\n\n" },
    ]);
    const anchor = updated.metadata.threads[0].anchor;
    expect(updated.text.slice(anchor.from, anchor.to)).toBe(
      "The selected passage.",
    );
    expect(anchor.status).toBe("attached");
  });

  test("marks reviewed text as changed and deleted text as detached", () => {
    const text = "The observed result is small.";
    const metadata = createMetadata();
    metadata.threads.push(
      createConversation(
        text,
        metadata,
        { from: 4, to: 19 },
        "Check this result",
        "read",
      ).thread,
    );
    const changed = applyChanges(text, metadata, [
      { from: 4, to: 12, insert: "measured" },
    ]);
    expect(changed.metadata.threads[0].anchor.status).toBe("changed");
    const removed = applyChanges(text, metadata, [
      { from: 4, to: 19, insert: "" },
    ]);
    expect(removed.metadata.threads[0].anchor.status).toBe("detached");
  });

  test("relocates external edits only when the quote is unambiguous", () => {
    const anchor = captureAnchor("A unique passage.", { from: 2, to: 8 });
    expect(relocateAnchor("New opening.\nA unique passage.", anchor).from).toBe(
      15,
    );
    expect(
      relocateAnchor("unique unique", { ...anchor, before: "", after: "" })
        .status,
    ).toBe("detached");
  });

  test("preserves Unicode and existing line endings", () => {
    const text = "A 🪴 garden\r\n\r\nA quiet place.\r\n";
    const updated = applyChanges(text, createMetadata(), [
      { from: 0, to: 1, insert: "The" },
    ]);
    expect(updated.text).toBe("The 🪴 garden\r\n\r\nA quiet place.\r\n");
    expect(() => captureAnchor(text, { from: 3, to: 4 })).toThrow("Unicode");
  });
});

describe("proposed edits", () => {
  test("rejects edits outside the passage attached to the request", () => {
    const text = "First passage. Second passage.";
    const metadata = createMetadata();
    const conversation = createConversation(
      text,
      metadata,
      { from: 0, to: 14 },
      "Review the first passage",
      "edit",
    );
    metadata.threads.push(conversation.thread);
    metadata.requests.push(conversation.request);
    expect(() =>
      createProposal(
        text,
        metadata,
        conversation.request.id,
        0,
        { from: 15, to: text.length },
        "Second passage.",
        "A different passage.",
        "Change this sentence.",
      ),
    ).toThrow("outside the passage");
  });
  test("rejects stale edits without changing the manuscript", () => {
    const text = "A clear paragraph.";
    const metadata = createMetadata();
    const conversation = createConversation(
      text,
      metadata,
      { from: 0, to: text.length },
      "Rewrite this",
      "read",
    );
    metadata.threads.push(conversation.thread);
    metadata.requests.push(conversation.request);
    const updated = applyChanges(text, metadata, [
      { from: text.length, to: text.length, insert: " More text." },
    ]);
    expect(() =>
      createProposal(
        updated.text,
        updated.metadata,
        conversation.request.id,
        0,
        { from: 0, to: text.length },
        text,
        "A direct paragraph.",
        "Use a concrete adjective.",
      ),
    ).toThrow("document changed");
    expect(updated.text).toBe("A clear paragraph. More text.");
  });
});
