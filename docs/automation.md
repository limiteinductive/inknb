# Local automation

Design: `long-term`. The document session owns every live mutation. External agents and backends use the same versioned protocol.

A durable event journal records document changes, work requests, proposals, sources, anchors, and connections. Events have stable identities and increasing cursors. Socket subscribers can replay events after reconnecting. Named consumers acknowledge completed work. Delivery is at least once. Handlers use event identities to make side effects idempotent.

The CLI provides a JSON event stream and an executable hook runner. Hook programs run outside the desktop app. The app stores no model settings or credentials.

Human requests and maintenance requests share one work queue. Maintenance requests permit replies and proposals. They never grant permission to change prose. Source changes, affected proposals, and detached anchors create maintenance work. Events remain available to independent backends.

Untouched proposals follow document edits. A change to the proposed passage invalidates that proposal and requests a refresh. Incoming edits still require the current document revision and expected text.

Source reviews name the observed fingerprint. A review cannot claim to cover a newer file. Original source fingerprints remain available for inspection.

Exact anchor matches can reconnect automatically. Semantic attachment candidates require a human choice.

Document moves preserve Markdown and annotations. Explicit local asset references retain their paths. The move journal supports recovery after interruption. Existing destination files remain protected.

Delivery receipts reconcile completed sends after restart. `request_delivery` exposes the receipt to external backends. A null receipt gives no delivery guarantee. Automatic retries apply only when the transport has not started. An uncertain send requires reconciliation before another attempt.

## Socket protocol

`protocol_info` returns the protocol version, socket path, and tool schemas. The socket uses UTF-8 JSON Lines. Version 1 accepts one request per connection. Each request has `version`, `id`, `method`, and `params`. Older clients can omit `version` to select version 1.

```json
{
  "version": 1,
  "id": "backend-1",
  "method": "events_subscribe",
  "params": { "after": 0, "consumer": "my-backend", "limit": 100 }
}
```

`events_subscribe` keeps the connection open. Each response contains `version`, the request `id`, and an event page in `result`. Empty pages are heartbeats. A slow subscriber disconnects and resumes from its last processed cursor.

```json
{
  "version": 1,
  "events": [
    {
      "cursor": 12,
      "id": "00000000-0000-4000-8000-000000000012",
      "documentId": "00000000-0000-4000-8000-000000000001",
      "revision": 4,
      "kind": "document.changed",
      "occurredAt": "2026-10-15T00:00:00Z",
      "payload": {}
    }
  ],
  "nextCursor": 12
}
```

`events_read` returns the same page without subscribing. It accepts `after`, `consumer`, `documentId`, and `limit`. The page size ranges from 1 to 500. `events_ack` stores a monotonically increasing cursor for a consumer. Use a separate consumer name for each handler and document filter.

The journal uses local SQLite with full synchronization. Recovery snapshots retain unpublished event identities. Restart replays those identities without duplicate journal records. The journal retains events until its owner manages the application data. The app does not silently expire replay history.

The socket has mode 0600. The support directory has mode 0700. The server checks the peer user. No TCP listener or cloud service is required.

## CLI and hooks

Stream events as one JSON object per line:

```sh
inknb watch --after 0
inknb watch --document DOCUMENT_UUID --after 120
```

Run an external executable for each event:

```sh
inknb hook --consumer my-backend -- /absolute/path/to/handler argument
```

The handler receives one event on standard input. Exit status zero acknowledges it. A failure leaves it unacknowledged and retries it. The runner reconnects after an app restart. Stop it with the normal process controls in its external environment.

An interrupted handler can receive the same event again. Commit external side effects idempotently by event ID before returning success. A hook executes only the program supplied on its command line. Document text cannot configure executable hooks.

The repository includes a figure-reference checker:

```sh
inknb hook --consumer figure-references -- /absolute/path/to/node /path/to/inknb/examples/check-figure-references.mjs /path/to/inknb figure-references
```

Run `npm ci` in the repository before using that example. The handler reads the live manuscript and posts missing-figure findings through `annotation_create`. It resolves its own obsolete findings. Human replies keep a discussion under human control. The example preserves manually resolved findings until their content changes.

## Work and findings

`requests_list` includes a `trigger` for each item. The trigger kinds are `human`, `source_changed`, `proposal_stale`, and `anchor_detached`.

For `source_changed`, read the referenced file and call `source_review` with its observed hash and a concise explanation. A newer fingerprint rejects the review. Restoring the original file supersedes an obsolete review request.

For `proposal_stale`, read the current passage and call `edit_propose` with `replaces` set to the old proposal ID. The replacement remains a suggestion. It does not inherit direct edit permission.

For `anchor_detached`, call `anchor_suggest` with exact current text and candidate ranges. A unique original quote reconnects directly. Other candidates appear beside the conversation for human selection.

Use `annotation_create` for independent backend findings. Supply a stable `messageId` for retries, an exact revision and passage, and a consumer name. Findings create no edit grants. `annotation_resolve` accepts only discussions owned by that consumer without human messages.

Use `figure_propose` and `table_propose` for requested insertions. `document_move` protects existing destinations and journals document, annotation, and local reference moves. References outside the document folder need an explicit destination plan from the external agent.

## Event kinds

| Kind                                                   | Payload                                      |
| ------------------------------------------------------ | -------------------------------------------- |
| `document.opened`                                      | `path`                                       |
| `document.changed`                                     | Revision in the envelope                     |
| `document.saved`                                       | `path`                                       |
| `document.moved`                                       | `previousPath`, `path`                       |
| `request.created`, `request.updated`                   | `requestId`, `threadId`, `trigger`, `state`  |
| `proposal.created`, `proposal.updated`                 | `proposalId`, `threadId`, optional `status`  |
| `source.attached`, `source.changed`, `source.reviewed` | `sourceId`, `threadId`, path or fingerprints |
| `anchor.detached`, `anchor.reattached`                 | `threadId`                                   |
| `conversation.updated`                                 | `threadId`, `resolved`                       |

Read the current document before acting on an event. Events describe a committed observation. A newer document revision can supersede it.

Annotation format 2 reads format 1 sidecars directly. Earlier app releases do not understand maintenance requests in format 2.
