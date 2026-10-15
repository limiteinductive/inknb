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
    connection: Connection,
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
        for event in events {
            if ![
                "document.opened",
                "document.changed",
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
                "connection.changed",
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
            transaction
                .execute(
                    "INSERT OR IGNORE INTO events(identity,document,content) VALUES(?1,?2,?3)",
                    params![event.id.to_string(), event.document_id.to_string(), content],
                )
                .map_err(|error| error.to_string())?;
        }
        transaction.commit().map_err(|error| error.to_string())
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
            kind: "source.changed".into(),
            occurred_at: "2026-10-15T00:00:00Z".into(),
            payload: json!({"sourceId":"fixture"}),
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
