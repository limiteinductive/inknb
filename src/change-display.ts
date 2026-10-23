import { DOMSerializer } from "prosemirror-model";
import type { Fragment } from "prosemirror-model";
import { diffArrays, diffWordsWithSpace } from "diff";
import type { Change } from "diff";
import { importDocument } from "./native-document";
import { nativeSchema } from "./native-schema";
import type { SourceFormat } from "./native-schema";
import "./preview-suggestions.css";

function markText(
  element: Element,
  changes: Change[],
  side: "removed" | "added",
) {
  const nodes: { node: Text; from: number; to: number }[] = [];
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  let offset = 0;
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    nodes.push({ node, from: offset, to: offset + node.length });
    offset += node.length;
  }
  offset = 0;
  const ranges = changes.flatMap((change) => {
    if (side === "removed" ? change.added : change.removed) return [];
    const from = offset;
    offset += change.value.length;
    return change[side] ? [{ from, to: offset }] : [];
  });
  for (const change of ranges.reverse()) {
    for (const entry of [...nodes].reverse()) {
      const from = Math.max(entry.from, change.from);
      const to = Math.min(entry.to, change.to);
      if (to <= from) continue;
      const range = document.createRange();
      range.setStart(entry.node, from - entry.from);
      range.setEnd(entry.node, to - entry.from);
      const mark = document.createElement(side === "removed" ? "del" : "ins");
      mark.dataset.change = side;
      range.surroundContents(mark);
    }
  }
}

function compareBlocks(current: ParentNode, suggested: ParentNode) {
  const changes = diffArrays([...current.children], [...suggested.children], {
    comparator: (before, after) => before.isEqualNode(after),
  });
  for (let index = 0; index < changes.length; index += 1) {
    const change = changes[index];
    if (!change.removed && !change.added) continue;
    const following = changes[index + 1];
    if (change.removed && following?.added) {
      if (
        change.value.length === following.value.length &&
        change.value.every(
          (element, position) =>
            element.tagName === following.value[position].tagName,
        )
      ) {
        for (let position = 0; position < change.value.length; position += 1) {
          const before = change.value[position];
          const after = following.value[position];
          if (before.matches("p,h1,h2,h3,h4,h5,h6,pre")) {
            const words = diffWordsWithSpace(
              before.textContent ?? "",
              after.textContent ?? "",
            );
            markText(before, words, "removed");
            markText(after, words, "added");
          } else if (before.children.length && after.children.length) {
            compareBlocks(before, after);
          } else {
            before.setAttribute("data-change", "removed");
            after.setAttribute("data-change", "added");
          }
        }
      } else {
        for (const element of change.value)
          element.setAttribute("data-change", "removed");
        for (const element of following.value)
          element.setAttribute("data-change", "added");
      }
      index += 1;
      continue;
    }
    for (const element of change.value)
      element.setAttribute("data-change", change.removed ? "removed" : "added");
  }
}

export function renderChange(
  before: string,
  after: string,
  format: SourceFormat,
  labels: readonly [string, string] = ["Current", "Suggested"],
): DocumentFragment {
  return renderFragmentsChange(importDocument(before, format).content, importDocument(after, format).content, labels);
}

export function renderFragmentsChange(
  before: Fragment,
  after: Fragment,
  labels: readonly [string, string] = ["Current", "Suggested"],
): DocumentFragment {
  const serializer = new DOMSerializer(
    {
      ...DOMSerializer.nodesFromSchema(nativeSchema),
      table: () => [
        "div",
        {
          class: "tableWrapper",
          tabIndex: 0,
          role: "region",
          "aria-label": "Table",
        },
        ["table", ["tbody", 0]],
      ],
      image: (node) => [
        "img",
        {
          "data-native-image": String(node.attrs.src),
          alt: String(node.attrs.alt ?? ""),
        },
      ],
    },
    DOMSerializer.marksFromSchema(nativeSchema),
  );
  const current = serializer.serializeFragment(before);
  const suggested = serializer.serializeFragment(after);
  compareBlocks(current, suggested);
  const result = document.createDocumentFragment();
  const comparison = document.createElement("div");
  comparison.className = "change-comparison";
  for (const version of [
    { label: labels[0], content: current, empty: !before.size || before.childCount === 1 && before.firstChild?.isTextblock && !before.firstChild.content.size },
    { label: labels[1], content: suggested, empty: !after.size || after.childCount === 1 && after.firstChild?.isTextblock && !after.firstChild.content.size },
  ]) {
    const section = document.createElement("section");
    section.className = "change-version";
    section.setAttribute("aria-label", version.label);
    const heading = document.createElement("h3");
    heading.className = "change-version-label";
    heading.textContent = version.label;
    const content = document.createElement("div");
    content.className = "change-content";
    if (version.empty) {
      const empty = document.createElement("p");
      empty.className = "change-empty";
      empty.textContent = "No text";
      content.append(empty);
    } else content.append(version.content);
    section.append(heading, content);
    comparison.append(section);
  }
  result.append(comparison);
  return result;
}
