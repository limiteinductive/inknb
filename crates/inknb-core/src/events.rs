use crate::activity::ActivityItem;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use uuid::Uuid;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EventInput {
    pub id: Uuid,
    pub document_id: Uuid,
    pub revision: u64,
    pub kind: String,
    pub occurred_at: String,
    pub payload: Value,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Event {
    pub cursor: u64,
    #[serde(flatten)]
    pub event: EventInput,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EventQuery {
    #[serde(default)]
    pub after: u64,
    pub document_id: Option<Uuid>,
    pub consumer: Option<String>,
    #[serde(default = "page_size")]
    pub limit: u32,
}

fn page_size() -> u32 {
    100
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventPage {
    pub version: u32,
    pub events: Vec<Event>,
    pub next_cursor: u64,
}

pub struct EventStore {
    pub(crate) connection: Connection,
}

impl EventStore {
    pub fn open(directory: &Path) -> Result<Self, String> {
        let path = directory.join("automation.sqlite3");
        let connection = Connection::open(&path).map_err(|error| error.to_string())?;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))
            .map_err(|error| error.to_string())?;
        connection
            .busy_timeout(std::time::Duration::from_secs(5))
            .map_err(|error| error.to_string())?;
        connection.execute_batch(
            "PRAGMA journal_mode=WAL;
             PRAGMA synchronous=FULL;
             CREATE TABLE IF NOT EXISTS events (
                cursor INTEGER PRIMARY KEY AUTOINCREMENT,
                identity TEXT NOT NULL UNIQUE,
                document TEXT NOT NULL,
                content TEXT NOT NULL
             );
             CREATE INDEX IF NOT EXISTS events_document ON events(document, cursor);
             CREATE TABLE IF NOT EXISTS revisions (cursor INTEGER PRIMARY KEY AUTOINCREMENT, identity TEXT NOT NULL UNIQUE, document TEXT NOT NULL, content TEXT NOT NULL);
             CREATE INDEX IF NOT EXISTS revisions_document ON revisions(document,cursor);
             CREATE TABLE IF NOT EXISTS revision_checkpoints (cursor INTEGER PRIMARY KEY, document TEXT NOT NULL, text TEXT NOT NULL, format TEXT NOT NULL);
             CREATE INDEX IF NOT EXISTS revision_checkpoints_document ON revision_checkpoints(document,cursor);
             CREATE TABLE IF NOT EXISTS revision_heads (document TEXT PRIMARY KEY, text TEXT NOT NULL, format TEXT NOT NULL);
             CREATE TABLE IF NOT EXISTS document_snapshots (document TEXT PRIMARY KEY, content TEXT NOT NULL);
             CREATE TABLE IF NOT EXISTS decision_records (identity TEXT PRIMARY KEY, document TEXT NOT NULL, content TEXT NOT NULL);
             CREATE TABLE IF NOT EXISTS activities (identity TEXT PRIMARY KEY,document TEXT,cursor INTEGER NOT NULL,content TEXT NOT NULL,read INTEGER NOT NULL,resolved INTEGER NOT NULL,notified INTEGER NOT NULL DEFAULT 0);
             CREATE INDEX IF NOT EXISTS activities_cursor ON activities(cursor,identity);
             CREATE TABLE IF NOT EXISTS activity_dismissals (identity TEXT PRIMARY KEY,cursor INTEGER NOT NULL);
             CREATE TABLE IF NOT EXISTS activity_preferences (identity INTEGER PRIMARY KEY CHECK(identity=1),enabled INTEGER NOT NULL);
             INSERT OR IGNORE INTO activity_preferences(identity,enabled) VALUES(1,0);
             CREATE TABLE IF NOT EXISTS consumers (name TEXT PRIMARY KEY, cursor INTEGER NOT NULL);
             CREATE TABLE IF NOT EXISTS deliveries (identity TEXT PRIMARY KEY, state TEXT NOT NULL, error TEXT);"
        ).map_err(|error| error.to_string())?;
        Ok(Self { connection })
    }

    pub fn append(&mut self, events: &[EventInput]) -> Result<(), String> {
        let transaction = self
            .connection
            .transaction()
            .map_err(|error| error.to_string())?;
        Self::append_events_to(&transaction, events)?;
        transaction.commit().map_err(|error| error.to_string())
    }

    pub(crate) fn append_events_to(
        transaction: &Connection,
        events: &[EventInput],
    ) -> Result<(), String> {
        for event in events {
            if ![
                "document.opened",
                "document.changed",
                "document.access_changed",
                "document.saved",
                "document.moved",
                "request.created",
                "request.updated",
                "proposal.created",
                "proposal.updated",
                "source.changed",
                "source.attached",
                "source.reviewed",
                "conversation.updated",
                "anchor.detached",
                "anchor.reattached",
                "decision.created",
                "decision.answered",
                "decision.acknowledged",
                "decision.withdrawn",
                "decision.superseded",
                "connection.changed",
                "component.mounted",
                "component.updated",
                "component.removed",
                "component.event",
                "preview.published",
                "preview.rendered",
                "preview.build",
                "operation.failed",
                "operation.recovered",
            ]
            .contains(&event.kind.as_str())
            {
                return Err("Unknown event kind.".into());
            }
            let content = serde_json::to_string(event).map_err(|error| error.to_string())?;
            let previous: Option<String> = transaction
                .query_row(
                    "SELECT content FROM events WHERE identity=?1",
                    [event.id.to_string()],
                    |row| row.get(0),
                )
                .optional()
                .map_err(|error| error.to_string())?;
            if previous
                .as_ref()
                .is_some_and(|previous| previous != &content)
            {
                return Err("An event identity already contains different content.".into());
            }
            let inserted = transaction
                .execute(
                    "INSERT OR IGNORE INTO events(identity,document,content) VALUES(?1,?2,?3)",
                    params![event.id.to_string(), event.document_id.to_string(), content],
                )
                .map_err(|error| error.to_string())?;
            if inserted == 0 {
                continue;
            }
            let cursor = transaction.last_insert_rowid() as u64;
            let payload = &event.payload;
            let thread_id = payload["threadId"]
                .as_str()
                .map(Uuid::parse_str)
                .transpose()
                .map_err(|error| error.to_string())?;
            let request_id = payload["requestId"]
                .as_str()
                .map(Uuid::parse_str)
                .transpose()
                .map_err(|error| error.to_string())?;
            if event.kind == "conversation.updated" {
                if payload["resolved"] == true {
                    transaction.execute("UPDATE activities SET resolved=1 WHERE document=?1 AND json_extract(content,'$.threadId')=?2 AND (?3=0 OR read=1 OR json_extract(content,'$.kind')!='reply')",params![event.document_id.to_string(),thread_id.map(|identity|identity.to_string()),payload["completion"] == true]).map_err(|error|error.to_string())?;
                } else if payload["message"]["author"] == "human" {
                    transaction.execute("UPDATE activities SET resolved=1 WHERE document=?1 AND json_extract(content,'$.threadId')=?2 AND json_extract(content,'$.kind')='question'",params![event.document_id.to_string(),thread_id.map(|identity|identity.to_string())]).map_err(|error|error.to_string())?;
                }
            }
            let mut resolved = false;
            let mut read = false;
            let (kind, target, title, detail) = match event.kind.as_str() {
                "conversation.updated"
                    if payload["message"]["author"] == "agent"
                        && (payload["resolved"] != true || payload["completion"] == true) =>
                {
                    (
                        if payload["message"]["awaitingHuman"] == true {
                            "question"
                        } else {
                            "reply"
                        },
                        thread_id
                            .map(|identity| identity.to_string())
                            .unwrap_or_default(),
                        format!(
                            "{} {}",
                            payload["message"]["label"].as_str().unwrap_or("Agent"),
                            if payload["message"]["awaitingHuman"] == true {
                                "needs your answer"
                            } else {
                                "replied"
                            }
                        ),
                        payload["message"]["content"]
                            .as_str()
                            .unwrap_or_default()
                            .to_owned(),
                    )
                }
                "decision.created"
                | "decision.answered"
                | "decision.acknowledged"
                | "decision.withdrawn"
                | "decision.superseded" => {
                    resolved = payload["decision"]["status"] != "open";
                    read = resolved;
                    (
                        "decision",
                        payload["decisionId"].as_str().unwrap_or_default().into(),
                        payload["decision"]["question"]
                            .as_str()
                            .unwrap_or("A decision needs your answer")
                            .into(),
                        payload["decision"]["creator"]["name"]
                            .as_str()
                            .or_else(|| payload["decision"]["creator"]["label"].as_str())
                            .unwrap_or("Agent")
                            .into(),
                    )
                }
                "proposal.created" | "proposal.updated" => {
                    resolved = event.kind == "proposal.updated" && payload["status"] != "pending";
                    (
                        "suggestion",
                        payload["proposalId"].as_str().unwrap_or_default().into(),
                        match payload["status"].as_str() {
                            Some("applied") => "Suggestion accepted",
                            Some("rejected") => "Suggestion dismissed",
                            Some("conflict") => "Suggestion out of date",
                            _ => "Suggestion ready",
                        }
                        .into(),
                        String::new(),
                    )
                }
                "request.created" | "request.updated" => {
                    let state = payload["state"].as_str().unwrap_or("pending");
                    resolved = state == "answered";
                    read = state != "failed";
                    (
                        "delivery",
                        request_id
                            .map(|identity| identity.to_string())
                            .unwrap_or_default(),
                        match state {
                            "failed" => "Delivery needs attention",
                            "sending" => "Sending to the agent",
                            "delivered" => "Sent to the agent",
                            "answered" => "Agent request answered",
                            _ => "Waiting to send to the agent",
                        }
                        .into(),
                        payload["error"].as_str().unwrap_or_default().into(),
                    )
                }
                "source.changed" | "source.reviewed" => {
                    resolved = event.kind == "source.reviewed";
                    (
                        "source",
                        payload["sourceId"].as_str().unwrap_or_default().into(),
                        if resolved {
                            "Source reviewed"
                        } else {
                            "A linked source changed"
                        }
                        .into(),
                        String::new(),
                    )
                }
                "anchor.detached" | "anchor.reattached" => {
                    resolved = event.kind == "anchor.reattached";
                    (
                        "anchor",
                        thread_id
                            .map(|identity| identity.to_string())
                            .unwrap_or_default(),
                        if resolved {
                            "Aside reattached"
                        } else {
                            "An aside needs a passage"
                        }
                        .into(),
                        String::new(),
                    )
                }
                "preview.build" => {
                    resolved = payload["build"].is_null();
                    read = payload["build"]["status"] != "failed";
                    (
                        "preview",
                        String::new(),
                        if resolved {
                            "Page build finished"
                        } else if read {
                            "Page is building"
                        } else {
                            "Page build failed"
                        }
                        .into(),
                        payload["build"]["message"]
                            .as_str()
                            .unwrap_or_default()
                            .into(),
                    )
                }
                "document.changed"
                    if payload["actor"]
                        .as_str()
                        .is_some_and(|actor| actor != "You") =>
                {
                    (
                        "change",
                        String::new(),
                        format!(
                            "{} updated the document",
                            payload["actor"].as_str().unwrap_or("Agent")
                        ),
                        String::new(),
                    )
                }
                "operation.failed" | "operation.recovered" => {
                    resolved = event.kind == "operation.recovered";
                    let category = payload["category"].as_str().unwrap_or("error");
                    (
                        category,
                        String::new(),
                        match category {
                            "save" => {
                                if resolved {
                                    "Document saved"
                                } else {
                                    "Could not save the document"
                                }
                            }
                            "external" => {
                                if resolved {
                                    "File change handled"
                                } else {
                                    "Document files need attention"
                                }
                            }
                            _ => {
                                if resolved {
                                    "Issue cleared"
                                } else {
                                    "An operation needs attention"
                                }
                            }
                        }
                        .into(),
                        payload["message"].as_str().unwrap_or_default().into(),
                    )
                }
                _ => continue,
            };
            let key_kind = match kind {
                "question" => "reply",
                "save" | "external" => "file",
                _ => kind,
            };
            let key = if target.is_empty() {
                format!("{}:{key_kind}", event.document_id)
            } else {
                format!("{}:{key_kind}:{target}", event.document_id)
            };
            let item = ActivityItem {
                key,
                document_id: (!event.document_id.is_nil()).then_some(event.document_id),
                thread_id,
                request_id,
                decision_id: payload["decisionId"]
                    .as_str()
                    .map(Uuid::parse_str)
                    .transpose()
                    .map_err(|error| error.to_string())?,
                message_id: payload["message"]["id"]
                    .as_str()
                    .map(Uuid::parse_str)
                    .transpose()
                    .map_err(|error| error.to_string())?,
                attention: ["save", "error", "external"].contains(&kind)
                    || (kind == "delivery" && payload["state"] == "failed")
                    || (kind == "preview" && payload["build"]["status"] == "failed"),
                kind: kind.into(),
                title,
                detail: detail.chars().take(2000).collect(),
                occurred_at: event.occurred_at.clone(),
                cursor,
                read,
                resolved,
            };
            transaction.execute("INSERT INTO activities(identity,document,cursor,content,read,resolved) VALUES(?1,?2,?3,?4,?5,?6) ON CONFLICT(identity) DO UPDATE SET cursor=excluded.cursor,content=excluded.content,read=excluded.read,resolved=excluded.resolved",params![item.key,item.document_id.map(|identity|identity.to_string()),cursor,serde_json::to_string(&item).map_err(|error|error.to_string())?,item.read,item.resolved]).map_err(|error|error.to_string())?;
        }
        Ok(())
    }

    pub(crate) fn index_decisions(
        connection: &Connection,
        metadata: &Value,
        replace: bool,
    ) -> Result<(), String> {
        let document_id = metadata["documentId"]
            .as_str()
            .ok_or("The document needs an identity.")?;
        let Some(decisions) = metadata["decisions"].as_array() else {
            return Ok(());
        };
        for decision in decisions {
            let identity = decision["id"]
                .as_str()
                .ok_or("The decision needs an identity.")?;
            Uuid::parse_str(identity).map_err(|error| error.to_string())?;
            let existing_document: Option<String> = connection
                .query_row(
                    "SELECT document FROM decision_records WHERE identity=?1",
                    [identity],
                    |row| row.get(0),
                )
                .optional()
                .map_err(|error| error.to_string())?;
            if existing_document
                .as_deref()
                .is_some_and(|existing| existing != document_id)
            {
                return Err("This decision identity belongs to another document.".into());
            }
            let content = serde_json::to_string(decision).map_err(|error| error.to_string())?;
            if replace {
                connection.execute("INSERT INTO decision_records(identity,document,content) VALUES(?1,?2,?3) ON CONFLICT(identity) DO UPDATE SET content=excluded.content", params![identity,document_id,content]).map_err(|error| error.to_string())?;
            } else {
                connection.execute("INSERT OR IGNORE INTO decision_records(identity,document,content) VALUES(?1,?2,?3)", params![identity,document_id,content]).map_err(|error| error.to_string())?;
            }
        }
        Ok(())
    }

    pub fn read_decision(
        &self,
        decision_id: Uuid,
        document_id: Option<Uuid>,
    ) -> Result<Value, String> {
        let record: Option<(String, String)> = self.connection.query_row(
            "SELECT document,content FROM decision_records WHERE identity=?1 AND (?2 IS NULL OR document=?2)",
            params![decision_id.to_string(),document_id.map(|identity| identity.to_string())],
            |row| Ok((row.get(0)?, row.get(1)?)),
        ).optional().map_err(|error| error.to_string())?;
        let (document, decision) = record.ok_or("This decision is unavailable.")?;
        Ok(
            serde_json::json!({"documentId":document,"decision":serde_json::from_str::<Value>(&decision).map_err(|error| error.to_string())?}),
        )
    }

    pub fn read(&self, query: &EventQuery) -> Result<EventPage, String> {
        if query.limit == 0 || query.limit > 500 || query.after > i64::MAX as u64 {
            return Err("Use a cursor within the journal and a page size from 1 to 500.".into());
        }
        if query
            .consumer
            .as_ref()
            .is_some_and(|consumer| consumer.is_empty() || consumer.len() > 120)
        {
            return Err("Use a consumer name from 1 to 120 bytes.".into());
        }
        let mut after = query.after;
        if let Some(consumer) = &query.consumer {
            after = after.max(
                self.connection
                    .query_row(
                        "SELECT cursor FROM consumers WHERE name=?1",
                        [consumer],
                        |row| row.get(0),
                    )
                    .optional()
                    .map_err(|error| error.to_string())?
                    .unwrap_or(0),
            );
        }
        let document = query.document_id.map(|identity| identity.to_string());
        let mut statement = self.connection.prepare(
            "SELECT cursor,content FROM events WHERE cursor>?1 AND (?2 IS NULL OR document=?2) ORDER BY cursor LIMIT ?3"
        ).map_err(|error| error.to_string())?;
        let rows = statement
            .query_map(params![after, document, query.limit], |row| {
                Ok((row.get::<_, u64>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|error| error.to_string())?;
        let mut events = Vec::new();
        for row in rows {
            let (cursor, content) = row.map_err(|error| error.to_string())?;
            events.push(Event {
                cursor,
                event: serde_json::from_str(&content).map_err(|error| error.to_string())?,
            });
        }
        let next_cursor = events.last().map(|event| event.cursor).unwrap_or(after);
        Ok(EventPage {
            version: 1,
            events,
            next_cursor,
        })
    }

    pub fn acknowledge(&self, consumer: &str, cursor: u64) -> Result<(), String> {
        if consumer.is_empty() || consumer.len() > 120 {
            return Err("Use a consumer name from 1 to 120 bytes.".into());
        }
        let latest: u64 = self
            .connection
            .query_row("SELECT COALESCE(MAX(cursor),0) FROM events", [], |row| {
                row.get(0)
            })
            .map_err(|error| error.to_string())?;
        if cursor > latest {
            return Err("The cursor is beyond the journal.".into());
        }
        self.connection.execute(
            "INSERT INTO consumers(name,cursor) VALUES(?1,?2) ON CONFLICT(name) DO UPDATE SET cursor=MAX(cursor,excluded.cursor)",
            params![consumer,cursor],
        ).map_err(|error| error.to_string())?;
        Ok(())
    }

    pub fn begin_delivery(&self, identity: &str) -> Result<String, String> {
        let inserted = self
            .connection
            .execute(
                "INSERT OR IGNORE INTO deliveries(identity,state) VALUES(?1,'started')",
                [identity],
            )
            .map_err(|error| error.to_string())?;
        if inserted == 1 {
            return Ok("new".into());
        }
        let state: String = self
            .connection
            .query_row(
                "SELECT state FROM deliveries WHERE identity=?1",
                [identity],
                |row| row.get(0),
            )
            .map_err(|error| error.to_string())?;
        if state == "unstarted" {
            self.finish_delivery(identity, "started")?;
            return Ok("new".into());
        }
        Ok(state)
    }

    pub fn delivery(&self, identity: &str) -> Result<Option<String>, String> {
        self.connection
            .query_row(
                "SELECT state FROM deliveries WHERE identity=?1",
                [identity],
                |row| row.get(0),
            )
            .optional()
            .map_err(|error| error.to_string())
    }

    pub fn finish_delivery(&self, identity: &str, state: &str) -> Result<(), String> {
        self.connection
            .execute(
                "UPDATE deliveries SET state=?2 WHERE identity=?1",
                params![identity, state],
            )
            .map_err(|error| error.to_string())?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn replay_deduplicates_events_and_preserves_consumer_checkpoints() {
        let directory = tempfile::tempdir().unwrap();
        let mut store = EventStore::open(directory.path()).unwrap();
        let event = EventInput {
            id: Uuid::new_v4(),
            document_id: Uuid::new_v4(),
            revision: 2,
            kind: "document.access_changed".into(),
            occurred_at: "2026-10-15T00:00:00Z".into(),
            payload: json!({"agentAccess":"edit"}),
        };
        store.append(&[event.clone(), event.clone()]).unwrap();
        let query = EventQuery {
            after: 0,
            document_id: Some(event.document_id),
            consumer: Some("fixture".into()),
            limit: 100,
        };
        let page = store.read(&query).unwrap();
        assert_eq!(page.events.len(), 1);
        store.acknowledge("fixture", page.next_cursor).unwrap();
        drop(store);
        let mut store = EventStore::open(directory.path()).unwrap();
        assert!(store.read(&query).unwrap().events.is_empty());
        let mut conflicting = event;
        conflicting.payload = json!({"different":true});
        assert!(store.append(&[conflicting]).is_err());
        assert!(store.acknowledge("fixture", 999).is_err());
    }
    #[test]
    fn delivery_receipts_preserve_uncertainty_and_completed_sends() {
        let directory = tempfile::tempdir().unwrap();
        let store = EventStore::open(directory.path()).unwrap();
        assert_eq!(store.begin_delivery("fixture").unwrap(), "new");
        assert_eq!(store.begin_delivery("fixture").unwrap(), "started");
        store.finish_delivery("fixture", "unstarted").unwrap();
        assert_eq!(store.begin_delivery("fixture").unwrap(), "new");
        store.finish_delivery("fixture", "queued").unwrap();
        drop(store);
        let store = EventStore::open(directory.path()).unwrap();
        assert_eq!(store.begin_delivery("fixture").unwrap(), "queued");
    }
}
