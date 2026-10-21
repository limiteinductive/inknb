import { ChangeSet, Text } from "@codemirror/state";
import { diffChars } from "diff";
import type { TextChange } from "./domain";

export function fileChanges(before: string, after: string): TextChange[] {
  const changes: TextChange[] = [];
  let position = 0;
  for (const part of diffChars(before, after)) {
    if (!part.added && !part.removed) {
      position += part.value.length;
      continue;
    }
    let change = changes.at(-1);
    if (!change || change.to !== position) {
      change = { from: position, to: position, insert: "" };
      changes.push(change);
    }
    if (part.removed) {
      position += part.value.length;
      change.to = position;
    } else change.insert += part.value;
  }
  return changes;
}

export function reconcileText(base: string, local: string, incoming: string) {
  const localChanges = fileChanges(base, local);
  const incomingChanges = fileChanges(base, incoming);
  const localMapping = ChangeSet.of(localChanges, base.length);
  const incomingMapping = ChangeSet.of(incomingChanges, base.length);
  const groups: {
    from: number;
    to: number;
    local: boolean;
    incoming: boolean;
  }[] = [];
  for (const change of [
    ...localChanges.map((change) => ({ ...change, local: true })),
    ...incomingChanges.map((change) => ({ ...change, local: false })),
  ].sort((first, second) => first.from - second.from || first.to - second.to)) {
    const previous = groups.at(-1);
    if (
      previous &&
      (change.from < previous.to ||
        (change.from === previous.to &&
          (change.from === change.to || previous.from === previous.to)))
    ) {
      previous.to = Math.max(previous.to, change.to);
      previous.local ||= change.local;
      previous.incoming ||= !change.local;
    } else
      groups.push({
        from: change.from,
        to: change.to,
        local: change.local,
        incoming: !change.local,
      });
  }
  for (const group of groups) {
    if (!group.local || !group.incoming) continue;
    const current = local.slice(
      localMapping.mapPos(group.from, -1),
      localMapping.mapPos(group.to, 1),
    );
    const external = incoming.slice(
      incomingMapping.mapPos(group.from, -1),
      incomingMapping.mapPos(group.to, 1),
    );
    if (current === external) continue;
    group.from = group.from === 0 ? 0 : base.lastIndexOf("\n", group.from - 1) + 1;
    const end = base.indexOf("\n", group.to);
    group.to = end < 0 ? base.length : end + 1;
  }
  const passages: typeof groups = [];
  for (const group of groups.sort(
    (first, second) => first.from - second.from || first.to - second.to,
  )) {
    const previous = passages.at(-1);
    if (previous && group.from < previous.to) {
      previous.to = Math.max(previous.to, group.to);
      previous.local ||= group.local;
      previous.incoming ||= group.incoming;
    } else passages.push({ ...group });
  }
  const changes: TextChange[] = [];
  const conflicts: TextChange[] = [];
  for (const group of passages) {
    if (!group.incoming) continue;
    const from = localMapping.mapPos(group.from, -1);
    const to = localMapping.mapPos(group.to, 1);
    const insert = incoming.slice(
      incomingMapping.mapPos(group.from, -1),
      incomingMapping.mapPos(group.to, 1),
    );
    if (local.slice(from, to) === insert) continue;
    const change = { from, to, insert };
    if (group.local) conflicts.push(change);
    else changes.push(change);
  }
  const mapping = ChangeSet.of(changes, local.length);
  return {
    changes,
    text: mapping.apply(Text.of(local.split("\n"))).toString(),
    conflicts: conflicts.map((change) => ({
      ...change,
      from: mapping.mapPos(change.from, -1),
      to: mapping.mapPos(change.to, 1),
    })),
  };
}
