import type { Node as DocumentNode } from "prosemirror-model";
import { sourcePosition } from "./native-source";
import type { SourceProjection } from "./native-source";

export const documentAuthoring =
  "Use semantic headings for document sections and subsections. Read native.outline before changing structure. Use one level for sibling sections and the next level for their subsections. Preserve the surrounding hierarchy. Bold text is inline emphasis, not a section heading. Place a subsection heading in its own block before its explanation. Keep existing wording when formatting. The app owns type size, weight, color, and spacing. Do not add inline presentation styles. Structural changes require the same permission or suggestion review as other document edits.";

export interface DocumentHeading {
  identity: string;
  title: string;
  level: number;
  from: number;
}

export function documentOutline(
  document: DocumentNode,
  projection: SourceProjection,
): DocumentHeading[] {
  const headings: DocumentHeading[] = [];
  document.descendants((node, position) => {
    if (node.type.name !== "heading") return;
    headings.push({
      identity: String(node.attrs.identity),
      title: node.textContent,
      level: Number(node.attrs.level),
      from: sourcePosition(projection, position + 1),
    });
  });
  return headings;
}
