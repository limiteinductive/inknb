import { StateEffect, StateField } from "@codemirror/state";
import { invertedEffects } from "@codemirror/commands";
import { mapAnchor } from "./domain";
import type { Anchor, Proposal } from "./domain";

export const restoreAnchors = StateEffect.define<Record<string, Anchor>>();
export const refreshConversationActivity = StateEffect.define<null>();
export const showSuggestions = StateEffect.define<Proposal[]>();
export const suggestionField = StateField.define<Proposal[]>({
  create: () => [],
  update(value, transaction) {
    let suggestions = transaction.docChanged ? [] : value;
    for (const effect of transaction.effects)
      if (effect.is(showSuggestions)) suggestions = effect.value;
    return suggestions;
  },
});
export const emphasizeConversation = StateEffect.define<string | null>();
export const emphasizedConversation = StateField.define<string | null>({
  create: () => null,
  update(value, transaction) {
    for (const effect of transaction.effects)
      if (effect.is(emphasizeConversation)) return effect.value;
    return value;
  },
});
export const selectConversation = StateEffect.define<{
  identity: string | null;
  inline: boolean;
}>();
export const setSelectionAction = StateEffect.define<
  "hidden" | "selecting" | "ready"
>();
export const selectionActionField = StateField.define<
  "hidden" | "selecting" | "ready"
>({
  create: () => "hidden",
  update(value, transaction) {
    let next = value;
    if (transaction.docChanged) next = "hidden";
    else if (transaction.selection && next !== "selecting") next = "ready";
    for (const effect of transaction.effects)
      if (effect.is(setSelectionAction)) next = effect.value;
    return next;
  },
});
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
