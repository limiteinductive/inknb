import { createRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { z } from "zod";

export const activityItemSchema = z.object({
  key: z.string(),
  documentId: z.string().uuid().nullable(),
  threadId: z.string().uuid().nullable(),
  requestId: z.string().uuid().nullable(),
  contextThreadId: z.string().uuid().nullable().default(null),
  decisionId: z.string().uuid().nullable().default(null),
  messageId: z.string().uuid().nullable().default(null),
  kind: z.string(),
  attention: z.boolean().default(false),
  title: z.string(),
  detail: z.string(),
  occurredAt: z.string(),
  cursor: z.number().int().nonnegative(),
  read: z.boolean(),
  resolved: z.boolean(),
});
export type ActivityItem = z.infer<typeof activityItemSchema>;
const pageSchema = z.object({
  throughCursor: z.number().int().nonnegative(),
  items: z.array(activityItemSchema),
  pending: z.array(activityItemSchema),
  unread: z.number(),
  attention: z.number(),
  hasMore: z.boolean(),
  backgroundNotifications: z.boolean(),
});
export const activityTrigger = createRef<HTMLButtonElement>();

class ActivityStore {
  private state = {
    throughCursor: 0,
    items: [] as ActivityItem[],
    pending: [] as ActivityItem[],
    unread: 0,
    attention: 0,
    hasMore: false,
    backgroundNotifications: false,
    open: false,
    targetKey: null as string | null,
    error: null as string | null,
  };
  private documentIds: string[] | null = null;
  setScope(documentIds: string[]): void {
    if (JSON.stringify(this.documentIds) === JSON.stringify(documentIds))
      return;
    this.documentIds = [...documentIds];
    this.update({ items: [], pending: [], unread: 0, attention: 0 });
    void this.refresh();
  }
  private listeners = new Set<() => void>();
  private refreshing: Promise<void> | null = null;
  private refreshAgain = false;
  private issues = new Map<string, ActivityItem>();
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  update(patch: Partial<typeof this.state>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
  refresh(): Promise<void> {
    if (this.refreshing) {
      this.refreshAgain = true;
      return this.refreshing;
    }
    const scope = this.documentIds;
    this.refreshing = invoke("activity_read", { query: { documentIds: scope } })
      .then((result) => {
        if (scope !== this.documentIds) {
          this.refreshAgain = true;
          return;
        }
        const page = pageSchema.parse(result);
        const issues = [...this.issues.values()].filter(
          (item) =>
            !scope || !item.documentId || scope.includes(item.documentId),
        );
        this.update({
          ...page,
          unread: page.unread + issues.filter((item) => !item.read).length,
          attention: page.attention + issues.length,
          pending: [
            ...issues,
            ...page.pending.filter((item) => !this.issues.has(item.key)),
          ],
          items: [
            ...issues,
            ...page.items.filter((item) => !this.issues.has(item.key)),
          ],
          error: null,
        });
      })
      .catch((error) => this.update({ error: String(error) }))
      .finally(() => {
        this.refreshing = null;
        if (this.refreshAgain) {
          this.refreshAgain = false;
          return this.refresh();
        }
      });
    return this.refreshing;
  }
  report(
    documentId: string | null,
    category: "save" | "error" | "external",
    error: unknown,
  ): void {
    const detail = error instanceof Error ? error.message : String(error);
    const key = `${documentId ?? "00000000-0000-0000-0000-000000000000"}:${category === "error" ? "error" : "file"}`;
    if (
      this.state.pending.some(
        (item) =>
          item.key === key &&
          ((item.kind === category && item.detail === detail) ||
            (item.kind === "save" && category === "external")),
      )
    )
      return;
    const item: ActivityItem = {
      key,
      documentId,
      threadId: null,
      requestId: null,
      contextThreadId: null,
      decisionId: null,
      messageId: null,
      kind: category,
      attention: true,
      title:
        category === "save"
          ? "Could not save the document"
          : category === "external"
            ? "Document files need attention"
            : "An operation needs attention",
      detail,
      occurredAt: new Date().toISOString(),
      cursor: 0,
      read: false,
      resolved: false,
    };
    const previous = this.state.pending.find((item) => item.key === key);
    this.issues.set(key, item);
    this.update({
      pending: [
        item,
        ...this.state.pending.filter((previous) => previous.key !== key),
      ],
      unread: this.state.unread + (previous && !previous.read ? 0 : 1),
      items: [
        item,
        ...this.state.items.filter((previous) => previous.key !== key),
      ],
      attention: this.state.attention + (previous?.attention ? 0 : 1),
    });
    void invoke("activity_issue", {
      documentId,
      category,
      message: detail,
      occurredAt: item.occurredAt,
    })
      .then(() => {
        this.issues.delete(key);
        return this.refresh();
      })
      .catch((failure) =>
        this.update({
          error: `Activity could not be saved: ${String(failure)}`,
        }),
      );
  }
  clear(
    documentId: string | null,
    category: "save" | "error" | "external",
    expectedMessage?: string,
  ): void {
    const key = `${documentId ?? "00000000-0000-0000-0000-000000000000"}:${category === "error" ? "error" : "file"}`;
    if (
      !this.state.pending.some(
        (item) =>
          item.key === key &&
          item.kind === category &&
          (expectedMessage === undefined || item.detail === expectedMessage),
      )
    )
      return;
    this.issues.delete(key);
    void invoke("activity_issue", {
      documentId,
      category,
      message: "",
      occurredAt: new Date().toISOString(),
      expectedMessage,
    })
      .then(() => this.refresh())
      .catch((error) => this.update({ error: String(error) }));
  }
  async acknowledge(item: ActivityItem): Promise<void> {
    await invoke("activity_ack", { key: item.key, cursor: item.cursor });
    await this.refresh();
  }
  async dismissAll(): Promise<void> {
    const throughCursor = this.state.throughCursor;
    await invoke("activity_dismiss_all", {
      throughCursor,
      documentIds: this.documentIds,
    });
    this.update({
      items: this.state.items.map((item) =>
        item.cursor <= throughCursor ? { ...item, read: true } : item,
      ),
    });
    await this.refresh();
  }
  readThread(
    documentId: string,
    threadId: string,
    messageId: string | null,
  ): void {
    const cursor = Math.max(0, ...this.state.items.map((item) => item.cursor));
    void invoke("activity_thread_read", {
      documentId,
      threadId,
      cursor,
      messageId,
    })
      .then(() => this.refresh())
      .catch((error) => this.update({ error: String(error) }));
  }
}
export const activity = new ActivityStore();
