import type { Node as DocumentNode } from "prosemirror-model";
import type { Proposal } from "./domain";
import type { NativeDocumentModel } from "./native-model";

export interface TableSuggestionGroup {
  identity: string;
  position: number;
  tableIndex: number;
  node: DocumentNode | null;
  proposals: Proposal[];
}

export interface TableReviewRequest {
  generation: number;
  document: unknown;
  proposals: Proposal[];
}

type ReviewedGroup = {
  identity: string;
  tableIndex: number;
  position: number;
  nodeIdentity: string | null;
  proposals: string[];
};

export type TableReviewResponse =
  | { generation: number; groups: ReviewedGroup[] }
  | { generation: number; error: string };

export class TableSuggestionReview {
  private worker: Worker | null = null;
  private source = "";
  private document: DocumentNode | null = null;
  private key = "";
  private generation = 0;
  private running = false;
  private queued: TableReviewRequest | null = null;
  private groups: ReviewedGroup[] = [];
  private listeners = new Set<() => void>();
  private revision = 0;
  private displayed: {
    document: DocumentNode;
    proposals: Proposal[];
    revision: number;
    groups: TableSuggestionGroup[];
  } | null = null;
  pending = false;

  constructor(
    private notify: () => void,
    private fail: (error: Error) => void,
  ) {}

  getSnapshot = (): number => this.revision;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  read(
    model: NativeDocumentModel,
    proposals: Proposal[],
  ): TableSuggestionGroup[] {
    const document = model.state.doc;
    const key = JSON.stringify(
      proposals.map(({ id, from, to, expectedText, replacement }) => ({
        id,
        from,
        to,
        expectedText,
        replacement,
      })),
    );
    if (
      document.content !== this.document?.content ||
      document.attrs.format !== this.document?.attrs.format ||
      model.projection.text !== this.source ||
      key !== this.key
    ) {
      this.document = document;
      this.source = model.projection.text;
      this.key = key;
      this.generation += 1;
      this.pending = proposals.length > 0;
      this.queued = null;
      if (!proposals.length) {
        this.groups = [];
        this.worker?.terminate();
        this.worker = null;
        this.running = false;
      } else {
        if (!this.worker) {
          const worker = new Worker(
            new URL("./table-review-worker.ts", import.meta.url),
            { type: "module" },
          );
          this.worker = worker;
          worker.onmessage = (event: MessageEvent<TableReviewResponse>) => {
            if (this.worker !== worker) return;
            this.running = false;
            if (event.data.generation === this.generation) {
              this.pending = false;
              if ("error" in event.data) {
                this.groups = [];
                this.fail(Error(event.data.error));
              } else this.groups = event.data.groups;
              this.revision += 1;
              this.notify();
              for (const listener of this.listeners) listener();
            }
            if (this.queued) {
              worker.postMessage(this.queued);
              this.queued = null;
              this.running = true;
            }
          };
          worker.onerror = (event) => {
            if (this.worker !== worker) return;
            worker.terminate();
            this.worker = null;
            this.running = false;
            this.queued = null;
            this.pending = false;
            this.groups = [];
            this.revision += 1;
            this.fail(Error(event.message));
            this.notify();
            for (const listener of this.listeners) listener();
          };
        }
        const request: TableReviewRequest = {
          generation: this.generation,
          document: document.toJSON(),
          proposals,
        };
        if (this.running) this.queued = request;
        else {
          this.worker.postMessage(request);
          this.running = true;
        }
      }
    }
    if (!this.groups.length) return [];
    if (
      this.displayed?.document === document &&
      this.displayed.revision === this.revision &&
      this.displayed.proposals.length === proposals.length &&
      proposals.every(
        (proposal, index) => proposal === this.displayed!.proposals[index],
      )
    )
      return this.displayed.groups;
    const nodes = new Map<string, { node: DocumentNode; position: number }>();
    document.descendants((node, position) => {
      if (node.isText) return;
      nodes.set(String(node.attrs.identity), { node, position });
    });
    const groups = this.groups.flatMap((group) => {
      const target = group.nodeIdentity ? nodes.get(group.nodeIdentity) : null;
      const owners = proposals.filter((proposal) =>
        group.proposals.includes(proposal.id),
      );
      if (
        !owners.length ||
        (group.nodeIdentity && !target) ||
        (this.pending && !target)
      )
        return [];
      return [
        {
          identity: group.identity,
          tableIndex: group.tableIndex,
          node: target?.node ?? null,
          position: target?.position ?? group.position,
          proposals: owners,
        },
      ];
    });
    this.displayed = { document, proposals, revision: this.revision, groups };
    return groups;
  }

  destroy(): void {
    this.worker?.terminate();
    this.listeners.clear();
  }
}
