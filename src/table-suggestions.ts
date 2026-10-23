import { Fragment, Slice } from "prosemirror-model";
import type { Node as DocumentNode } from "prosemirror-model";
import type { Proposal } from "./domain";
import type { NativeDocumentModel } from "./native-model";
import { semanticSignature } from "./native-schema";

export interface TableSuggestionGroup {
  identity: string;
  position: number;
  node: DocumentNode;
  proposals: Proposal[];
}

const cache = new WeakMap<DocumentNode, Map<string, TableSuggestionGroup[]>>();

export function tableSuggestionGroups(
  model: NativeDocumentModel,
  proposals: Proposal[],
): TableSuggestionGroup[] {
  const document = model.state.doc;
  const key = JSON.stringify(proposals);
  const saved = cache.get(document)?.get(key);
  if (saved) return saved;
  const tables: TableSuggestionGroup[] = [];
  document.descendants((node, position) => {
    if (node.type.spec.tableRole !== "table") return;
    tables.push({
      identity: String(node.attrs.identity),
      position,
      node,
      proposals: [],
    });
    return false;
  });
  if (!tables.length) return [];
  const signature = semanticSignature(document);
  for (const proposal of proposals) {
    let projected: DocumentNode;
    try {
      projected = model.sourceTransaction([
        { from: proposal.from, to: proposal.to, insert: proposal.replacement },
      ]).doc;
    } catch {
      continue;
    }
    projected.descendants((node, position) => {
      if (node.type.spec.tableRole !== "table") return;
      const table = tables.find(
        (table) => table.identity === node.attrs.identity,
      );
      if (!table || semanticSignature(table.node) === semanticSignature(node))
        return false;
      const restored = projected.replace(
        position,
        position + node.nodeSize,
        new Slice(Fragment.from(table.node), 0, 0),
      );
      if (semanticSignature(restored) !== signature) return false;
      table.proposals.push(proposal);
      return false;
    });
  }
  const groups = tables.filter((table) => table.proposals.length);
  const entries =
    cache.get(document) ?? new Map<string, TableSuggestionGroup[]>();
  entries.set(key, groups);
  cache.set(document, entries);
  return groups;
}
