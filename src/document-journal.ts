import type { Transaction } from "prosemirror-state";

export class DocumentJournal {
  readonly epoch = crypto.randomUUID();
  version = 0;
  lastClientId: string | null = null;
  changes: { step: unknown; clientId: string }[] = [];
  private consumers = new Map<string, number>();

  append(transactions: readonly Transaction[]): void {
    for (const [index, transaction] of transactions.entries()) {
      const clientId: string = index === 0 ? (transaction.getMeta("clientId") ?? "host") : "host";
      for (const step of transaction.steps) {
        this.changes.push({ step: step.toJSON(), clientId });
        this.version += 1;
        this.lastClientId = clientId;
      }
    }
    this.release();
  }

  acknowledge(clientId: string, version: number): void {
    if (version < this.version - this.changes.length || version > this.version)
      throw Error("The window document version is outside its synchronization journal.");
    this.consumers.set(clientId, version);
    this.release();
  }

  forget(clientId: string): void {
    this.consumers.delete(clientId);
    this.release();
  }

  private release(): void {
    const retainedFrom = Math.min(this.version, ...this.consumers.values());
    const discarded = retainedFrom - (this.version - this.changes.length);
    if (discarded) this.changes = this.changes.slice(discarded);
  }
}
