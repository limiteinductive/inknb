use crate::events::EventStore;
use crate::storage::Snapshot;
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HistoryChange {
    pub id: String,
    pub document_id: Uuid,
    pub revision: u64,
    pub created_at: String,
    pub actor: String,
    pub thread_id: Option<Uuid>,
    pub before_format: String,
    pub format: String,
    pub from: usize,
    pub removed: String,
    pub inserted: String,
    pub before_length: usize,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub baseline: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntry {
    pub cursor: u64,
    #[serde(flatten)]
    pub change: HistoryChange,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HistoryQuery {
    pub document_id: Uuid,
    pub before: Option<u64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryPage {
    pub entries: Vec<HistoryEntry>,
    pub has_more: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RevisionQuery {
    pub document_id: Uuid,
    pub from_cursor: u64,
    pub to_cursor: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryRevision {
    pub before: String,
    pub after: String,
    pub before_format: String,
    pub format: String,
}

impl EventStore {
    pub fn commit_snapshot(&mut self, snapshot: &Snapshot) -> Result<(), String> {
        let identity = snapshot.metadata["documentId"]
            .as_str()
            .ok_or("The document needs an identity.")?;
        Uuid::parse_str(identity).map_err(|error| error.to_string())?;
        if let Some(native) = snapshot
            .metadata
            .get("nativeDocument")
            .filter(|native| !native.is_null())
        {
            if native["source"].as_str() != Some(snapshot.text.as_str()) {
                return Err("The native document does not match its source.".into());
            }
        }
        let revision = snapshot.metadata["revision"]
            .as_u64()
            .ok_or("The document needs a revision.")?;
        let source: Vec<u16> = snapshot.text.encode_utf16().collect();
        for thread in snapshot.metadata["threads"]
            .as_array()
            .ok_or("The document needs its discussions.")?
        {
            let Some(anchor) = thread.get("anchor").filter(|anchor| !anchor.is_null()) else {
                continue;
            };
            let from = anchor["from"].as_u64().ok_or("Invalid anchor range.")? as usize;
            let to = anchor["to"].as_u64().ok_or("Invalid anchor range.")? as usize;
            if from > to
                || (anchor["status"] != "detached" && to > source.len())
                || (anchor["status"] == "attached"
                    && anchor["quote"]
                        .as_str()
                        .map(|quote| quote.encode_utf16().collect::<Vec<_>>())
                        .as_deref()
                        != Some(&source[from..to]))
            {
                return Err("The discussion anchor does not match its source.".into());
            }
        }
        for proposal in snapshot.metadata["proposals"]
            .as_array()
            .ok_or("The document needs its proposals.")?
        {
            if proposal["status"] != "pending" {
                continue;
            }
            let from = proposal["from"].as_u64().ok_or("Invalid proposal range.")? as usize;
            let to = proposal["to"].as_u64().ok_or("Invalid proposal range.")? as usize;
            if from > to
                || to > source.len()
                || proposal["expectedText"]
                    .as_str()
                    .map(|text| text.encode_utf16().collect::<Vec<_>>())
                    .as_deref()
                    != Some(&source[from..to])
            {
                return Err("The proposal does not match its source.".into());
            }
        }
        if snapshot
            .history
            .iter()
            .any(|change| change.document_id.to_string() != identity || change.revision > revision)
            || snapshot
                .events
                .iter()
                .any(|event| event.document_id.to_string() != identity || event.revision > revision)
        {
            return Err("The journal belongs to a different document revision.".into());
        }
        let transaction = self
            .connection
            .transaction()
            .map_err(|error| error.to_string())?;
        for change in &snapshot.history {
            if !["text", "markdown", "html", "latex"].contains(&change.format.as_str())
                || !["text", "markdown", "html", "latex"].contains(&change.before_format.as_str())
            {
                return Err("Unsupported revision format.".into());
            }
            let mut stored = change.clone();
            stored.baseline = None;
            let content = serde_json::to_string(&stored).map_err(|error| error.to_string())?;
            let previous: Option<String> = transaction
                .query_row(
                    "SELECT content FROM revisions WHERE identity=?1",
                    [&change.id],
                    |row| row.get(0),
                )
                .optional()
                .map_err(|error| error.to_string())?;
            if let Some(previous) = previous {
                if previous != content {
                    return Err("A revision identity already contains different content.".into());
                }
                continue;
            }
            let head: Option<(String, String)> = transaction
                .query_row(
                    "SELECT text,format FROM revision_heads WHERE document=?1",
                    [change.document_id.to_string()],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()
                .map_err(|error| error.to_string())?;
            let mut text = head.as_ref().map(|head| head.0.clone());
            if let Some(baseline) = &change.baseline {
                if let Some((previous, previous_format)) = &head {
                    if previous != baseline || previous_format != &change.before_format {
                        let boundary = HistoryChange {
                            id: format!("{}:external", change.id),
                            document_id: change.document_id,
                            revision: change.revision.saturating_sub(1),
                            created_at: change.created_at.clone(),
                            actor: "External file".into(),
                            thread_id: None,
                            before_format: previous_format.clone(),
                            format: change.before_format.clone(),
                            from: 0,
                            removed: previous.clone(),
                            inserted: baseline.clone(),
                            before_length: previous.encode_utf16().count(),
                            baseline: None,
                        };
                        transaction
                            .execute(
                                "INSERT INTO revisions(identity,document,content) VALUES(?1,?2,?3)",
                                params![
                                    boundary.id,
                                    boundary.document_id.to_string(),
                                    serde_json::to_string(&boundary)
                                        .map_err(|error| error.to_string())?
                                ],
                            )
                            .map_err(|error| error.to_string())?;
                    }
                }
                text = Some(baseline.clone());
            }
            let text = text.ok_or("The revision needs its initial text.")?;
            let mut units: Vec<u16> = text.encode_utf16().collect();
            let removed: Vec<u16> = change.removed.encode_utf16().collect();
            let end = change
                .from
                .checked_add(removed.len())
                .ok_or("Invalid revision range.")?;
            if units.len() != change.before_length
                || end > units.len()
                || units[change.from..end] != removed
                || head
                    .as_ref()
                    .is_some_and(|head| change.baseline.is_none() && head.1 != change.before_format)
            {
                return Err("The revision does not match its stored text.".into());
            }
            units.splice(change.from..end, change.inserted.encode_utf16());
            let next = String::from_utf16(&units).map_err(|error| error.to_string())?;
            transaction
                .execute(
                    "INSERT INTO revisions(identity,document,content) VALUES(?1,?2,?3)",
                    params![change.id, change.document_id.to_string(), content],
                )
                .map_err(|error| error.to_string())?;
            let cursor = transaction.last_insert_rowid();
            let checkpoint: i64 = transaction
                .query_row(
                    "SELECT COALESCE(MAX(cursor),0) FROM revision_checkpoints WHERE document=?1",
                    [change.document_id.to_string()],
                    |row| row.get(0),
                )
                .map_err(|error| error.to_string())?;
            if cursor - checkpoint >= 200 {
                transaction.execute("INSERT INTO revision_checkpoints(cursor,document,text,format) VALUES(?1,?2,?3,?4)",
                    params![cursor, change.document_id.to_string(), next, change.format],
                ).map_err(|error| error.to_string())?;
            }
            transaction.execute("INSERT INTO revision_heads(document,text,format) VALUES(?1,?2,?3) ON CONFLICT(document) DO UPDATE SET text=excluded.text,format=excluded.format",
                params![change.document_id.to_string(), next, change.format],
            ).map_err(|error| error.to_string())?;
        }
        let head: Option<(String, String)> = transaction
            .query_row(
                "SELECT text,format FROM revision_heads WHERE document=?1",
                [identity],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(|error| error.to_string())?;
        if head.as_ref().is_some_and(|(text, format)| {
            text != &snapshot.text
                || snapshot.metadata["nativeDocument"]["format"]
                    .as_str()
                    .is_some_and(|native_format| native_format != format)
        }) {
            return Err("The revision does not match its stored text.".into());
        }
        Self::index_decisions(&transaction, &snapshot.metadata, true)?;
        Self::append_events_to(&transaction, &snapshot.events)?;
        let content = serde_json::to_string(snapshot).map_err(|error| error.to_string())?;
        transaction.execute("INSERT INTO document_snapshots(document,content) VALUES(?1,?2) ON CONFLICT(document) DO UPDATE SET content=excluded.content", params![identity,content]).map_err(|error| error.to_string())?;
        transaction.commit().map_err(|error| error.to_string())
    }

    pub fn read_history(&self, query: &HistoryQuery) -> Result<HistoryPage, String> {
        let before = query.before.unwrap_or(i64::MAX as u64);
        if before > i64::MAX as u64 {
            return Err("Invalid history cursor.".into());
        }
        let mut statement = self.connection.prepare(
            "SELECT cursor,content FROM revisions WHERE document=?1 AND cursor<?2 ORDER BY cursor DESC LIMIT 101",
        ).map_err(|error| error.to_string())?;
        let rows = statement
            .query_map(params![query.document_id.to_string(), before], |row| {
                Ok((row.get::<_, u64>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|error| error.to_string())?;
        let mut entries = Vec::new();
        for row in rows {
            let (cursor, content) = row.map_err(|error| error.to_string())?;
            entries.push(HistoryEntry {
                cursor,
                change: serde_json::from_str(&content).map_err(|error| error.to_string())?,
            });
        }
        let has_more = entries.len() > 100;
        entries.truncate(100);
        Ok(HistoryPage { entries, has_more })
    }

    pub fn read_revision(&self, query: &RevisionQuery) -> Result<HistoryRevision, String> {
        if query.from_cursor == 0
            || query.from_cursor > query.to_cursor
            || query.to_cursor > i64::MAX as u64
        {
            return Err("Invalid revision range.".into());
        }
        let checkpoint: Option<(u64,String,String)> = self.connection.query_row(
            "SELECT cursor,text,format FROM revision_checkpoints WHERE document=?1 AND cursor>=?2 ORDER BY cursor LIMIT 1",
            params![query.document_id.to_string(),query.to_cursor],
            |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?)),
        ).optional().map_err(|error| error.to_string())?;
        let (upper, mut text, mut format) = match checkpoint {
            Some(checkpoint) => checkpoint,
            None => self
                .connection
                .query_row(
                    "SELECT text,format FROM revision_heads WHERE document=?1",
                    [query.document_id.to_string()],
                    |row| {
                        Ok((
                            i64::MAX as u64,
                            row.get::<_, String>(0)?,
                            row.get::<_, String>(1)?,
                        ))
                    },
                )
                .map_err(|error| error.to_string())?,
        };
        let mut statement = self.connection.prepare(
            "SELECT cursor,content FROM revisions WHERE document=?1 AND cursor>=?2 AND cursor<=?3 ORDER BY cursor DESC",
        ).map_err(|error| error.to_string())?;
        let rows = statement
            .query_map(
                params![query.document_id.to_string(), query.from_cursor, upper],
                |row| Ok((row.get::<_, u64>(0)?, row.get::<_, String>(1)?)),
            )
            .map_err(|error| error.to_string())?;
        let mut after = None;
        let mut after_format = None;
        let mut reached_before = false;
        for row in rows {
            let (cursor, content) = row.map_err(|error| error.to_string())?;
            let change: HistoryChange =
                serde_json::from_str(&content).map_err(|error| error.to_string())?;
            if cursor == query.to_cursor {
                after = Some(text.clone());
                after_format = Some(format.clone());
            }
            let mut units: Vec<u16> = text.encode_utf16().collect();
            let inserted: Vec<u16> = change.inserted.encode_utf16().collect();
            let end = change
                .from
                .checked_add(inserted.len())
                .ok_or("Invalid revision range.")?;
            if end > units.len() || units[change.from..end] != inserted {
                return Err("The stored revision chain needs repair.".into());
            }
            units.splice(change.from..end, change.removed.encode_utf16());
            text = String::from_utf16(&units).map_err(|error| error.to_string())?;
            format = change.before_format;
            if cursor == query.from_cursor {
                reached_before = true;
            }
        }
        if !reached_before {
            return Err("This revision is unavailable.".into());
        }
        Ok(HistoryRevision {
            before: text,
            after: after.ok_or("This revision is unavailable.")?,
            before_format: format,
            format: after_format.ok_or("This revision is unavailable.")?,
        })
    }
}
