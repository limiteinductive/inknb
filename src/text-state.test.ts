import { expect, test } from "vitest";
import { EditorState } from "@codemirror/state";
import { history, redo, undo } from "@codemirror/commands";
import { captureAnchor } from "./domain";
import {
  agentEditField,
  agentEditHistory,
  recordAgentEdit,
  anchorField,
  anchorHistory,
  restoreAnchors,
} from "./text-state";

test("undo restores a deleted annotation anchor and redo detaches it again", () => {
  const text = "A passage under review.";
  const anchor = captureAnchor(text, { from: 2, to: 9 });
  let state = EditorState.create({
    doc: text,
    extensions: [history(), anchorField, anchorHistory],
  });
  state = state.update({
    effects: restoreAnchors.of({ discussion: anchor }),
  }).state;
  state = state.update({
    changes: { from: 2, to: 9, insert: "" },
    userEvent: "delete",
  }).state;
  expect(state.field(anchorField).discussion.status).toBe("detached");
  undo({
    state,
    dispatch: (transaction) => {
      state = transaction.state;
    },
  });
  expect(state.doc.toString()).toBe(text);
  expect(state.field(anchorField).discussion).toEqual(anchor);
  redo({
    state,
    dispatch: (transaction) => {
      state = transaction.state;
    },
  });
  expect(state.field(anchorField).discussion.status).toBe("detached");
});

test("undo and redo preserve the status of an accepted agent edit", () => {
  let state = EditorState.create({
    doc: "A clear paragraph.",
    extensions: [history(), agentEditField, agentEditHistory],
  });
  state = state.update({
    changes: { from: 2, to: 7, insert: "direct" },
    effects: recordAgentEdit.of({ identity: "proposal", status: "applied" }),
  }).state;
  expect(state.field(agentEditField).proposal).toBe("applied");
  undo({
    state,
    dispatch: (transaction) => {
      state = transaction.state;
    },
  });
  expect(state.field(agentEditField).proposal).toBe("undone");
  redo({
    state,
    dispatch: (transaction) => {
      state = transaction.state;
    },
  });
  expect(state.field(agentEditField).proposal).toBe("applied");
});
