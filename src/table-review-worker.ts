import { Fragment, Slice } from "prosemirror-model";
import type { Node as DocumentNode } from "prosemirror-model";
import { nativeSchema, semanticSignature } from "./native-schema";
import { projectDocument } from "./native-document";
import { projectSourceChanges } from "./native-source-edit";
import type {
  TableSuggestionGroup,
  TableReviewRequest,
  TableReviewResponse,
} from "./table-suggestions";

self.onmessage = (event: MessageEvent<TableReviewRequest>) => {
  const { generation, proposals } = event.data;
  try {
    const document = nativeSchema.nodeFromJSON(event.data.document);
    const projection = projectDocument(document);
    const tables: TableSuggestionGroup[] = [];
    document.descendants((node, position) => {
      if (node.type.spec.tableRole !== "table") return;
      tables.push({
        identity: String(node.attrs.identity),
        position,
        tableIndex: tables.length,
        node,
        proposals: [],
      });
      return false;
    });
    const insertions: TableSuggestionGroup[] = [];
    const signature = semanticSignature(document);
    for (const proposal of proposals) {
      let projected: DocumentNode;
      try {
        projected = projectSourceChanges(document, projection, [
          {
            from: proposal.from,
            to: proposal.to,
            insert: proposal.replacement,
          },
        ]);
      } catch {
        continue;
      }
      let tableIndex = 0;
      projected.descendants((node, position) => {
        if (node.type.spec.tableRole !== "table") return;
        const table =
          tables.find((table) => table.identity === node.attrs.identity) ??
          tables[tableIndex];
        const index = tableIndex++;
        if (table?.node) {
          if (semanticSignature(table.node) === semanticSignature(node))
            return false;
          const restored = projected.replace(
            position,
            position + node.nodeSize,
            new Slice(Fragment.from(table.node), 0, 0),
          );
          if (semanticSignature(restored) === signature) {
            table.proposals.push(proposal);
            return false;
          }
        }
        if (proposal.expectedText) return false;
        const placeholder =
          document.childCount === 1 &&
          document.firstChild?.type.name === "paragraph" &&
          !document.firstChild.content.size
            ? document.firstChild
            : null;
        const parent = projected.resolve(position);
        if (
          !parent.parent.canReplace(
            parent.index(),
            parent.index() + 1,
            Fragment.from(placeholder),
          )
        )
          return false;
        const restored = projected.replace(
          position,
          position + node.nodeSize,
          new Slice(Fragment.from(placeholder), 0, 0),
        );
        if (semanticSignature(restored) === signature)
          insertions.push({
            identity: proposal.id,
            position,
            tableIndex: index,
            node: placeholder,
            proposals: [proposal],
          });
        return false;
      });
    }
    const groups = [
      ...tables.filter((table) => table.proposals.length),
      ...insertions,
    ];
    const response: TableReviewResponse = {
      generation,
      groups: groups.map((group) => ({
        identity: group.identity,
        tableIndex: group.tableIndex,
        position: group.position,
        nodeIdentity: group.node ? String(group.node.attrs.identity) : null,
        proposals: group.proposals.map((proposal) => proposal.id),
      })),
    };
    self.postMessage(response);
  } catch (error) {
    const response: TableReviewResponse = { generation, error: String(error) };
    self.postMessage(response);
  }
};
