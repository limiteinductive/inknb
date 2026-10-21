use crate::events::{EventInput, EventStore};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use uuid::Uuid;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityItem {
    pub key: String,
    pub document_id: Option<Uuid>,
    pub thread_id: Option<Uuid>,
    pub request_id: Option<Uuid>,
    #[serde(default)]
    pub decision_id: Option<Uuid>,
    #[serde(default)]
    pub message_id: Option<Uuid>,
    pub kind: String,
    #[serde(default)]
    pub attention: bool,
    pub title: String,
    pub detail: String,
    pub occurred_at: String,
    pub cursor: u64,
    pub read: bool,
    pub resolved: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ActivityQuery {
    pub document_ids: Option<Vec<Uuid>>,
    pub before_cursor: Option<u64>,
    pub before_key: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityPage {
    pub through_cursor: u64,
    pub items: Vec<ActivityItem>,
    pub pending: Vec<ActivityItem>,
    pub unread: u64,
    pub attention: u64,
    pub has_more: bool,
    pub background_notifications: bool,
}

impl EventStore {
    pub fn read_activity(&self, query: &ActivityQuery) -> Result<ActivityPage, String> {
        if query.before_cursor.is_some() != query.before_key.is_some() {
            return Err("Supply both activity cursor fields.".into());
        }
        let scope = query
            .document_ids
            .as_ref()
            .map(serde_json::to_string)
            .transpose()
            .map_err(|error| error.to_string())?;
        let mut statement = self.connection.prepare("SELECT content,read OR EXISTS(SELECT 1 FROM activity_dismissals WHERE identity=activities.identity AND cursor>=activities.cursor),resolved FROM activities WHERE (?1 IS NULL OR cursor<?1 OR (cursor=?1 AND identity>?2)) AND (?3 IS NULL OR document IS NULL OR document IN (SELECT value FROM json_each(?3))) ORDER BY cursor DESC,identity LIMIT 101").map_err(|error| error.to_string())?;
        let rows = statement
            .query_map(
                params![query.before_cursor, query.before_key, scope],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, bool>(1)?,
                        row.get::<_, bool>(2)?,
                    ))
                },
            )
            .map_err(|error| error.to_string())?;
        let mut items = Vec::new();
        for row in rows {
            let (content, read, resolved) = row.map_err(|error| error.to_string())?;
            let mut item: ActivityItem =
                serde_json::from_str(&content).map_err(|error| error.to_string())?;
            item.read = read;
            item.resolved = resolved;
            items.push(item);
        }
        let has_more = items.len() > 100;
        items.truncate(100);
        let mut pending = Vec::new();
        let mut statement = self.connection.prepare("SELECT content,read FROM activities WHERE (?1 IS NULL OR document IS NULL OR document IN (SELECT value FROM json_each(?1))) AND resolved=0 AND NOT EXISTS(SELECT 1 FROM activity_dismissals WHERE identity=activities.identity AND cursor>=activities.cursor) ORDER BY cursor DESC,identity").map_err(|error|error.to_string())?;
        let rows = statement
            .query_map(params![scope], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, bool>(1)?))
            })
            .map_err(|error| error.to_string())?;
        for row in rows {
            let (content, read) = row.map_err(|error| error.to_string())?;
            let mut item: ActivityItem =
                serde_json::from_str(&content).map_err(|error| error.to_string())?;
            item.read = read;
            item.resolved = false;
            pending.push(item);
        }
        let unread = self
            .connection
            .query_row(
                "SELECT COUNT(*) FROM activities WHERE (?1 IS NULL OR document IS NULL OR document IN (SELECT value FROM json_each(?1))) AND read=0 AND resolved=0 AND NOT EXISTS(SELECT 1 FROM activity_dismissals WHERE identity=activities.identity AND cursor>=activities.cursor)",
                params![scope],
                |row| row.get(0),
            )
            .map_err(|error| error.to_string())?;
        let attention = self.connection.query_row("SELECT COUNT(*) FROM activities WHERE (?1 IS NULL OR document IS NULL OR document IN (SELECT value FROM json_each(?1))) AND resolved=0 AND json_extract(content,'$.attention')=1 AND NOT EXISTS(SELECT 1 FROM activity_dismissals WHERE identity=activities.identity AND cursor>=activities.cursor)", params![scope], |row| row.get(0)).map_err(|error| error.to_string())?;
        let through_cursor = self
            .connection
            .query_row("SELECT COALESCE(MAX(cursor),0) FROM events", [], |row| {
                row.get(0)
            })
            .map_err(|error| error.to_string())?;
        let background_notifications = self
            .connection
            .query_row(
                "SELECT enabled FROM activity_preferences WHERE identity=1",
                [],
                |row| row.get(0),
            )
            .map_err(|error| error.to_string())?;
        Ok(ActivityPage {
            through_cursor,
            items,
            pending,
            unread,
            attention,
            has_more,
            background_notifications,
        })
    }

    pub fn acknowledge_activity(&self, key: &str, cursor: u64) -> Result<(), String> {
        self.connection.execute("UPDATE activities SET read=1,resolved=CASE WHEN json_extract(content,'$.kind') IN ('reply','change') THEN 1 ELSE resolved END WHERE identity=?1 AND cursor<=?2", params![key,cursor]).map_err(|error| error.to_string())?;
        Ok(())
    }

    pub fn dismiss_activity(
        &self,
        through_cursor: u64,
        document_ids: Option<&[Uuid]>,
    ) -> Result<(), String> {
        let scope = document_ids
            .map(serde_json::to_string)
            .transpose()
            .map_err(|error| error.to_string())?;
        self.connection.execute("INSERT INTO activity_dismissals(identity,cursor) SELECT identity,cursor FROM activities WHERE cursor<=?1 AND (?2 IS NULL OR document IS NULL OR document IN (SELECT value FROM json_each(?2))) ON CONFLICT(identity) DO UPDATE SET cursor=MAX(activity_dismissals.cursor,excluded.cursor)", params![through_cursor, scope]).map_err(|error| error.to_string())?;
        Ok(())
    }

    pub fn read_thread_activity(
        &self,
        document_id: Uuid,
        thread_id: Uuid,
        cursor: u64,
        message_id: Option<Uuid>,
    ) -> Result<(), String> {
        self.connection.execute("UPDATE activities SET read=1,resolved=CASE WHEN json_extract(content,'$.kind') IN ('reply','change') THEN 1 ELSE resolved END WHERE document=?1 AND json_extract(content,'$.threadId')=?2 AND (cursor<=?3 OR (json_extract(content,'$.messageId')=?4 AND json_extract(content,'$.kind') IN ('reply','question')))", params![document_id.to_string(),thread_id.to_string(),cursor,message_id.map(|identity|identity.to_string())]).map_err(|error| error.to_string())?;
        Ok(())
    }

    pub fn activity_issue(
        &mut self,
        document_id: Option<Uuid>,
        category: &str,
        message: &str,
        occurred_at: &str,
        expected_message: Option<&str>,
    ) -> Result<(), String> {
        if !["save", "error", "external"].contains(&category) {
            return Err("Unsupported activity issue.".into());
        }
        let key_kind = if category == "error" { "error" } else { "file" };
        let key = format!("{}:{key_kind}", document_id.unwrap_or(Uuid::nil()));
        let previous: Option<(String, bool, bool)> = self
            .connection
            .query_row(
                "SELECT content,resolved,EXISTS(SELECT 1 FROM activity_dismissals WHERE identity=activities.identity AND cursor>=activities.cursor) FROM activities WHERE identity=?1",
                [&key],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()
            .map_err(|error| error.to_string())?;
        if let Some((content, resolved, dismissed)) = previous {
            let previous: ActivityItem =
                serde_json::from_str(&content).map_err(|error| error.to_string())?;
            if expected_message.is_some_and(|expected| previous.detail != expected) {
                return Ok(());
            }
            if (message.is_empty() && (resolved || previous.kind != category))
                || (!resolved
                    && !dismissed
                    && previous.kind == category
                    && previous.detail == message)
                || (!resolved && previous.kind == "save" && category == "external")
            {
                return Ok(());
            }
        } else if message.is_empty() {
            return Ok(());
        }
        self.append(&[EventInput {
            id: Uuid::new_v4(),
            document_id: document_id.unwrap_or(Uuid::nil()),
            revision: 0,
            kind: if message.is_empty() {
                "operation.recovered"
            } else {
                "operation.failed"
            }
            .into(),
            occurred_at: occurred_at.into(),
            payload: json!({"category":category,"message":message}),
        }])
    }

    pub fn seed_activity(
        &self,
        document_id: Uuid,
        metadata: &Value,
        unread_threads: &[Uuid],
    ) -> Result<(), String> {
        Self::index_decisions(&self.connection, metadata, false)?;
        let cursor: u64 = self
            .connection
            .query_row("SELECT COALESCE(MAX(cursor),0) FROM events", [], |row| {
                row.get(0)
            })
            .map_err(|error| error.to_string())?;
        for thread in metadata["threads"]
            .as_array()
            .ok_or("The document needs its discussions.")?
        {
            let thread_id = Uuid::parse_str(
                thread["id"]
                    .as_str()
                    .ok_or("The discussion needs an identity.")?,
            )
            .map_err(|error| error.to_string())?;
            let latest = thread["messages"].as_array().and_then(|messages| {
                messages
                    .iter()
                    .rev()
                    .find(|message| message["author"] == "agent")
            });
            if let Some(message) = latest.filter(|message| {
                thread["resolved"] != true
                    && (unread_threads.contains(&thread_id)
                        || (message["awaitingHuman"] == true
                            && thread["messages"]
                                .as_array()
                                .and_then(|messages| messages.last())
                                .is_some_and(|latest| latest["id"] == message["id"])))
            }) {
                let key = format!("{document_id}:reply:{thread_id}");
                let item = ActivityItem {
                    key,
                    document_id: Some(document_id),
                    thread_id: Some(thread_id),
                    decision_id: None,
                    request_id: None,
                    message_id: message["id"]
                        .as_str()
                        .map(Uuid::parse_str)
                        .transpose()
                        .map_err(|error| error.to_string())?,
                    attention: false,
                    kind: if message["awaitingHuman"] == true {
                        "question"
                    } else {
                        "reply"
                    }
                    .into(),
                    title: format!(
                        "{} {}",
                        message["agent"]["label"].as_str().unwrap_or("Agent"),
                        if message["awaitingHuman"] == true {
                            "needs your answer"
                        } else {
                            "replied"
                        }
                    ),
                    detail: message["content"]
                        .as_str()
                        .unwrap_or_default()
                        .chars()
                        .take(240)
                        .collect(),
                    occurred_at: message["createdAt"].as_str().unwrap_or_default().into(),
                    cursor,
                    read: !unread_threads.contains(&thread_id),
                    resolved: false,
                };
                self.connection.execute("INSERT OR IGNORE INTO activities(identity,document,cursor,content,read,resolved) VALUES(?1,?2,?3,?4,?5,0)",params![item.key,document_id.to_string(),cursor,serde_json::to_string(&item).map_err(|error| error.to_string())?,item.read]).map_err(|error| error.to_string())?;
            }
        }
        for proposal in metadata["proposals"]
            .as_array()
            .ok_or("The document needs its proposals.")?
        {
            if proposal["status"] != "pending" {
                continue;
            }
            let identity = proposal["id"]
                .as_str()
                .ok_or("The proposal needs an identity.")?;
            let thread_id = proposal["threadId"]
                .as_str()
                .map(Uuid::parse_str)
                .transpose()
                .map_err(|error| error.to_string())?;
            let key = format!("{document_id}:suggestion:{identity}");
            let item = ActivityItem {
                key,
                document_id: Some(document_id),
                thread_id,
                decision_id: None,
                request_id: None,
                message_id: None,
                kind: "suggestion".into(),
                attention: false,
                title: "Suggestion ready".into(),
                detail: proposal["explanation"]
                    .as_str()
                    .unwrap_or_default()
                    .chars()
                    .take(240)
                    .collect(),
                occurred_at: proposal["createdAt"].as_str().unwrap_or_default().into(),
                cursor,
                read: !thread_id.is_some_and(|identity| unread_threads.contains(&identity)),
                resolved: false,
            };
            self.connection.execute("INSERT OR IGNORE INTO activities(identity,document,cursor,content,read,resolved) VALUES(?1,?2,?3,?4,?5,0)",params![item.key,document_id.to_string(),cursor,serde_json::to_string(&item).map_err(|error| error.to_string())?,item.read]).map_err(|error| error.to_string())?;
        }
        Ok(())
    }
}

impl EventStore {
    pub fn background_notifications(&self, enabled: bool) -> Result<(), String> {
        self.connection
            .execute("UPDATE activities SET notified=cursor", [])
            .map_err(|error| error.to_string())?;
        self.connection
            .execute(
                "UPDATE activity_preferences SET enabled=?1 WHERE identity=1",
                [enabled],
            )
            .map_err(|error| error.to_string())?;
        Ok(())
    }

    pub fn pending_notifications(
        &self,
        decisions_enabled: bool,
    ) -> Result<Vec<ActivityItem>, String> {
        let enabled: bool = self
            .connection
            .query_row(
                "SELECT enabled FROM activity_preferences WHERE identity=1",
                [],
                |row| row.get(0),
            )
            .map_err(|error| error.to_string())?;
        if !enabled && !decisions_enabled {
            return Ok(Vec::new());
        }
        let mut statement=self.connection.prepare("SELECT content FROM activities WHERE (?1 OR (?2 AND json_extract(content,'$.kind')='decision')) AND read=0 AND resolved=0 AND notified<cursor AND NOT EXISTS(SELECT 1 FROM activity_dismissals WHERE identity=activities.identity AND cursor>=activities.cursor) ORDER BY cursor").map_err(|error|error.to_string())?;
        let rows = statement
            .query_map(params![enabled, decisions_enabled], |row| {
                row.get::<_, String>(0)
            })
            .map_err(|error| error.to_string())?;
        rows.map(|row| {
            serde_json::from_str(&row.map_err(|error| error.to_string())?)
                .map_err(|error| error.to_string())
        })
        .collect()
    }

    pub fn notified_activity(&self, key: &str, cursor: u64) -> Result<(), String> {
        self.connection
            .execute(
                "UPDATE activities SET notified=MAX(notified,?2) WHERE identity=?1",
                params![key, cursor],
            )
            .map_err(|error| error.to_string())?;
        Ok(())
    }
}
