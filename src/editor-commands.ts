import type { Command } from "prosemirror-state";
import { setBlockType, toggleMark } from "prosemirror-commands";
import { nativeSchema } from "./native-schema";
import catalog from "./shortcuts.json";

export const formattingCommands: Record<string, Command> = {
  "editor.bold": toggleMark(nativeSchema.marks.strong),
  "editor.italic": toggleMark(nativeSchema.marks.em),
  "editor.strikethrough": toggleMark(nativeSchema.marks.strike),
  "editor.code": toggleMark(nativeSchema.marks.code),
  "editor.paragraph": setBlockType(nativeSchema.nodes.paragraph),
  ...Object.fromEntries(
    Array.from({ length: 6 }, (_, index) => [
      `editor.heading-${index + 1}`,
      setBlockType(nativeSchema.nodes.heading, { level: index + 1 }),
    ]),
  ),
};

export const formattingEntries = catalog.filter((command) =>
  Object.hasOwn(formattingCommands, command.id),
);
