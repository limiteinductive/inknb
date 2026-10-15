import { StateEffect, StateField } from "@codemirror/state";
import { invertedEffects } from "@codemirror/commands";
import { mapAnchor } from "./domain";
import type { Anchor } from "./domain";

export const restoreAnchors = StateEffect.define<Record<string, Anchor>>();
export const selectConversation = StateEffect.define<{
  identity: string | null;
  inline: boolean;
}>();
export const recordAgentEdit = StateEffect.define<{
  identity: string;
  status: "applied" | "undone";
}>();
export const agentEditField = StateField.define<
  Record<string, "applied" | "undone">
>({
  create: () => ({}),
  update(value, transaction) {
    let next = value;
    for (const effect of transaction.effects)
      if (effect.is(recordAgentEdit))
        next = { ...next, [effect.value.identity]: effect.value.status };
    return next;
  },
});
export const agentEditHistory = invertedEffects.of((transaction) =>
  transaction.effects
    .filter((effect) => effect.is(recordAgentEdit))
    .map((effect) =>
      recordAgentEdit.of({
        identity: effect.value.identity,
        status:
          transaction.startState.field(agentEditField)[effect.value.identity] ??
          "undone",
      }),
    ),
);
export const anchorField = StateField.define<Record<string, Anchor>>({
  create: () => ({}),
  update(anchors, transaction) {
    let next = anchors;
    if (transaction.docChanged) {
      const text = transaction.newDoc.toString();
      next = Object.fromEntries(
        Object.entries(anchors).map(([identity, anchor]) => [
          identity,
          mapAnchor(text, anchor, transaction.changes),
        ]),
      );
    }
    for (const effect of transaction.effects)
      if (effect.is(restoreAnchors)) next = { ...next, ...effect.value };
    return next;
  },
});
export const conversationField = StateField.define<{
  identity: string | null;
  inline: boolean;
}>({
  create: () => ({ identity: null, inline: false }),
  update(value, transaction) {
    for (const effect of transaction.effects)
      if (effect.is(selectConversation)) return effect.value;
    return value;
  },
});
export const anchorHistory = invertedEffects.of((transaction) =>
  transaction.docChanged
    ? [restoreAnchors.of(transaction.startState.field(anchorField))]
    : [],
);
