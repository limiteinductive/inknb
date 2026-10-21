use crate::events::EventStore;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use uuid::Uuid;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    #[serde(default)]
    pub base_text: Option<String>,
    pub path: Option<String>,
    pub text: String,
    pub metadata: Value,
    pub expected_hash: Option<String>,
    pub expected_sidecar_hash: Option<String>,
    #[serde(default)]
    pub events: Vec<crate::events::EventInput>,
    #[serde(default)]
    pub history: Vec<crate::history::HistoryChange>,
    #[serde(default)]
    pub save_event: Option<crate::events::EventInput>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadedDocument {
    pub path: String,
    pub text: String,
    pub metadata: Option<Value>,
    pub hash: String,
    pub sidecar_hash: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedDocument {
    pub hash: String,
    pub sidecar_hash: String,
}

impl EventStore {
    pub fn committed_snapshots(&self) -> Result<Vec<Snapshot>, String> {
        let mut statement = self
            .connection
            .prepare("SELECT content FROM document_snapshots")
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|error| error.to_string())?;
        rows.map(|row| {
            serde_json::from_str(&row.map_err(|error| error.to_string())?)
                .map_err(|error| error.to_string())
        })
        .collect()
    }

    pub fn forget_snapshot(&mut self, identity: &str) -> Result<(), String> {
        self.connection
            .execute(
                "DELETE FROM document_snapshots WHERE document=?1",
                [identity],
            )
            .map_err(|error| error.to_string())?;
        Ok(())
    }
}

pub fn application_directory() -> Result<PathBuf, String> {
    let mut directory = dirs::data_local_dir()
        .ok_or("The application support directory is unavailable.")?
        .join("aside");
    if let Some(profile) = crate::profile::application_profile() {
        directory = directory.join("profiles").join(profile);
    }
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    fs::set_permissions(&directory, fs::Permissions::from_mode(0o700))
        .map_err(|error| error.to_string())?;
    Ok(directory)
}

pub fn fingerprint(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

pub fn sidecar_path(path: &Path) -> PathBuf {
    let mut name = path.as_os_str().to_os_string();
    name.push(".aside.json");
    PathBuf::from(name)
}

pub fn file_hash(path: &Path) -> Result<Option<String>, String> {
    match File::open(path) {
        Ok(mut file) => {
            let mut hasher = Sha256::new();
            let mut buffer = [0u8; 65536];
            loop {
                let count = file.read(&mut buffer).map_err(|error| error.to_string())?;
                if count == 0 {
                    break;
                }
                hasher.update(&buffer[..count]);
            }
            Ok(Some(format!("{:x}", hasher.finalize())))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

pub fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path.parent().ok_or("The file has no parent directory.")?;
    let temporary = parent.join(format!(".inknb-{}.tmp", Uuid::new_v4()));
    let result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&temporary)
            .map_err(|error| error.to_string())?;
        file.write_all(bytes).map_err(|error| error.to_string())?;
        file.sync_all().map_err(|error| error.to_string())?;
        if let Ok(metadata) = fs::metadata(path) {
            fs::set_permissions(&temporary, metadata.permissions())
                .map_err(|error| error.to_string())?;
        }
        fs::rename(&temporary, path).map_err(|error| error.to_string())?;
        File::open(parent)
            .and_then(|directory| directory.sync_all())
            .map_err(|error| error.to_string())?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(temporary);
    }
    result
}

pub fn load_document(path: &Path) -> Result<LoadedDocument, String> {
    let canonical = fs::canonicalize(path).map_err(|error| error.to_string())?;
    let bytes = fs::read(&canonical).map_err(|error| error.to_string())?;
    let hash = fingerprint(&bytes);
    let text = String::from_utf8(bytes).map_err(|_| "This file is not valid UTF-8 Markdown.")?;
    let sidecar = sidecar_path(&canonical);
    let metadata = match fs::read(&sidecar) {
        Ok(bytes) => Some(
            serde_json::from_slice(&bytes)
                .map_err(|error| format!("The annotation file needs repair: {error}"))?,
        ),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => return Err(error.to_string()),
    };
    Ok(LoadedDocument {
        path: canonical.to_string_lossy().into_owned(),
        text,
        metadata,
        hash,
        sidecar_hash: file_hash(&sidecar)?,
    })
}

pub fn store_recovery(directory: &Path, snapshot: &Snapshot) -> Result<(), String> {
    let bytes = serde_json::to_vec(snapshot).map_err(|error| error.to_string())?;
    atomic_write(&recovery_path(directory, &snapshot.metadata)?, &bytes)
}

pub fn recovery_path(directory: &Path, metadata: &Value) -> Result<PathBuf, String> {
    let Some(identity) = metadata["documentId"].as_str() else {
        return Ok(directory.join("recovery.json"));
    };
    let identity = Uuid::parse_str(identity).map_err(|error| error.to_string())?;
    let recoveries = directory.join("recoveries");
    fs::create_dir_all(&recoveries).map_err(|error| error.to_string())?;
    Ok(recoveries.join(format!("{identity}.json")))
}

pub fn save_document(directory: &Path, snapshot: &Snapshot) -> Result<SavedDocument, String> {
    let path = Path::new(
        snapshot
            .path
            .as_ref()
            .ok_or("Choose a file location first.")?,
    );
    let sidecar = sidecar_path(path);
    let hash = fingerprint(snapshot.text.as_bytes());
    let mut metadata = snapshot.metadata.clone();
    metadata["documentHash"] = Value::String(hash.clone());
    let annotation_bytes =
        serde_json::to_vec_pretty(&metadata).map_err(|error| error.to_string())?;
    let sidecar_hash = fingerprint(&annotation_bytes);
    let actual_hash = file_hash(path)?;
    let actual_sidecar_hash = file_hash(&sidecar)?;
    if actual_hash != snapshot.expected_hash && actual_hash.as_ref() != Some(&hash) {
        return Err(
            "The document changed outside ink and butter. Reload it or save a separate copy."
                .into(),
        );
    }
    if actual_sidecar_hash != snapshot.expected_sidecar_hash
        && actual_sidecar_hash.as_ref() != Some(&sidecar_hash)
    {
        return Err("The annotation file changed outside ink and butter. Reload it or save a separate copy.".into());
    }
    store_recovery(directory, snapshot)?;
    atomic_write(path, snapshot.text.as_bytes())?;
    atomic_write(&sidecar, &annotation_bytes)?;
    atomic_write(
        &directory.join("workspace.json"),
        &serde_json::to_vec(&snapshot.path).map_err(|error| error.to_string())?,
    )?;
    if let Some(event) = &snapshot.save_event {
        crate::events::EventStore::open(directory)?.append(std::slice::from_ref(event))?;
    }
    fs::remove_file(recovery_path(directory, &snapshot.metadata)?)
        .map_err(|error| error.to_string())?;
    Ok(SavedDocument { hash, sidecar_hash })
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MoveFile {
    source: PathBuf,
    destination: PathBuf,
    hash: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DocumentMove {
    id: Uuid,
    source: PathBuf,
    destination: PathBuf,
    files: Vec<MoveFile>,
    event: crate::events::EventInput,
}

pub fn move_document(
    directory: &Path,
    snapshot: &Snapshot,
    destination: &Path,
    assets: &[String],
    event: crate::events::EventInput,
) -> Result<SavedDocument, String> {
    let source = Path::new(
        snapshot
            .path
            .as_ref()
            .ok_or("Save this document before moving it.")?,
    )
    .canonicalize()
    .map_err(|error| error.to_string())?;
    if !destination.is_absolute() {
        return Err("Use an absolute document destination.".into());
    }
    let parent = destination
        .parent()
        .ok_or("The destination has no parent directory.")?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let parent = parent.canonicalize().map_err(|error| error.to_string())?;
    let destination = parent.join(
        destination
            .file_name()
            .ok_or("The destination needs a file name.")?,
    );
    if source == destination {
        return Err("The document already uses this path.".into());
    }
    if file_hash(&source)? != snapshot.expected_hash
        || file_hash(&sidecar_path(&source))? != snapshot.expected_sidecar_hash
    {
        return Err(
            "The document changed before the move. Reconcile its current files first.".into(),
        );
    }
    let hash = snapshot
        .expected_hash
        .clone()
        .ok_or("Save the document before moving it.")?;
    let sidecar_hash = snapshot
        .expected_sidecar_hash
        .clone()
        .ok_or("Save the annotations before moving the document.")?;
    if destination.exists() || sidecar_path(&destination).exists() {
        return Err("The destination already exists.".into());
    }
    let mut files = Vec::new();
    if source.parent() != Some(parent.as_path()) {
        for reference in assets {
            let relative = Path::new(reference);
            if relative.is_absolute() {
                continue;
            }
            if relative
                .components()
                .any(|component| matches!(component, std::path::Component::ParentDir))
            {
                return Err("A relative reference leaves the document folder. Prepare its destination before moving this document.".into());
            }
            let asset = source.parent().unwrap().join(relative);
            if !asset.is_file() {
                return Err(format!("A referenced file is unavailable: {reference}"));
            }
            files.push(MoveFile {
                source: asset.clone(),
                destination: parent.join(relative),
                hash: file_hash(&asset)?.ok_or("A referenced file disappeared.")?,
            });
        }
    }
    files.push(MoveFile {
        source: source.clone(),
        destination: destination.clone(),
        hash: hash.clone(),
    });
    files.push(MoveFile {
        source: sidecar_path(&source),
        destination: sidecar_path(&destination),
        hash: sidecar_hash.clone(),
    });
    let plan = DocumentMove {
        id: Uuid::new_v4(),
        source,
        destination,
        files,
        event,
    };
    atomic_write(
        &directory.join("move.json"),
        &serde_json::to_vec(&plan).map_err(|error| error.to_string())?,
    )?;
    recover_move(directory)?;
    Ok(SavedDocument { hash, sidecar_hash })
}

pub fn recover_move(directory: &Path) -> Result<(), String> {
    let journal = directory.join("move.json");
    let bytes = match fs::read(&journal) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.to_string()),
    };
    let plan: DocumentMove = serde_json::from_slice(&bytes).map_err(|error| error.to_string())?;
    let parent = plan
        .destination
        .parent()
        .ok_or("The move destination has no parent.")?
        .canonicalize()
        .map_err(|error| error.to_string())?;
    for (index, file) in plan.files.iter().enumerate() {
        let destination_hash = file_hash(&file.destination)?;
        if destination_hash.as_deref() == Some(&file.hash) {
            continue;
        }
        if destination_hash.is_some() {
            return Err(
                "A move destination changed. Both copies remain available for reconciliation."
                    .into(),
            );
        }
        if file_hash(&file.source)?.as_deref() != Some(&file.hash) {
            return Err(
                "A move source changed. Both locations remain available for reconciliation.".into(),
            );
        }
        let destination_parent = file
            .destination
            .parent()
            .ok_or("A moved file has no parent.")?;
        fs::create_dir_all(destination_parent).map_err(|error| error.to_string())?;
        let destination_parent = destination_parent
            .canonicalize()
            .map_err(|error| error.to_string())?;
        if !destination_parent.starts_with(&parent) {
            return Err("A destination reference leaves the selected folder.".into());
        }
        let temporary = destination_parent.join(format!(".inknb-move-{}-{index}.tmp", plan.id));
        atomic_write(
            &temporary,
            &fs::read(&file.source).map_err(|error| error.to_string())?,
        )?;
        fs::hard_link(&temporary, &file.destination).map_err(|error| error.to_string())?;
        fs::remove_file(&temporary).map_err(|error| error.to_string())?;
        File::open(&destination_parent)
            .and_then(|file| file.sync_all())
            .map_err(|error| error.to_string())?;
    }
    for file in &plan.files {
        if file_hash(&file.destination)?.as_deref() != Some(&file.hash) {
            return Err(
                "A destination changed during the move. The originals remain available.".into(),
            );
        }
    }
    for file in plan
        .files
        .iter()
        .filter(|file| file.source == plan.source || file.source == sidecar_path(&plan.source))
    {
        if let Some(hash) = file_hash(&file.source)? {
            if hash != file.hash {
                return Err(
                    "The original file changed during the move. Both copies remain available."
                        .into(),
                );
            }
            fs::remove_file(&file.source).map_err(|error| error.to_string())?;
        }
    }
    atomic_write(
        &directory.join("workspace.json"),
        &serde_json::to_vec(&plan.destination).map_err(|error| error.to_string())?,
    )?;
    crate::events::EventStore::open(directory)?.append(&[plan.event])?;
    fs::remove_file(journal).map_err(|error| error.to_string())?;
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn save_preserves_unicode_and_detects_external_changes() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("paper.md");
        let mut snapshot = Snapshot {
            base_text: None,
            path: Some(path.to_string_lossy().into_owned()),
            text: "# Plants\r\n\r\nA 🪴 garden.\n".into(),
            metadata: json!({"version": 1, "documentHash": ""}),
            expected_hash: None,
            expected_sidecar_hash: None,
            events: Vec::new(),
            history: Vec::new(),
            save_event: None,
        };
        let saved = save_document(directory.path(), &snapshot).unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), snapshot.text);
        snapshot.expected_hash = Some(saved.hash);
        snapshot.expected_sidecar_hash = Some(saved.sidecar_hash);
        fs::write(&path, "External edit").unwrap();
        assert!(save_document(directory.path(), &snapshot).is_err());
        assert_eq!(fs::read_to_string(path).unwrap(), "External edit");
    }

    #[test]
    fn malformed_annotations_never_silently_disappear() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("paper.md");
        fs::write(&path, "Words").unwrap();
        fs::write(sidecar_path(&path), "broken").unwrap();
        assert!(load_document(&path).is_err());
    }
    #[test]
    fn move_preserves_annotations_and_relative_assets_without_overwriting_files() {
        let directory = tempfile::tempdir().unwrap();
        let source_directory = directory.path().join("source");
        let destination_directory = directory.path().join("destination");
        fs::create_dir_all(source_directory.join("figs")).unwrap();
        fs::write(source_directory.join("figs/chart.svg"), "<svg/>").unwrap();
        let source = source_directory.join("draft.md");
        let snapshot = Snapshot {
            base_text: None,
            path: Some(source.to_string_lossy().into_owned()),
            text: "# Draft\r\n\r\n![Chart](figs/chart.svg)\n".into(),
            metadata: json!({"version":2}),
            expected_hash: None,
            expected_sidecar_hash: None,
            events: Vec::new(),
            history: Vec::new(),
            save_event: None,
        };
        let saved = save_document(directory.path(), &snapshot).unwrap();
        let snapshot = Snapshot {
            expected_hash: Some(saved.hash),
            expected_sidecar_hash: Some(saved.sidecar_hash),
            ..snapshot
        };
        let destination = destination_directory.join("renamed.md");
        let event = crate::events::EventInput {
            id: Uuid::new_v4(),
            document_id: Uuid::new_v4(),
            revision: 0,
            kind: "document.moved".into(),
            occurred_at: "2026-10-15T00:00:00Z".into(),
            payload: json!({}),
        };
        move_document(
            directory.path(),
            &snapshot,
            &destination,
            &["figs/chart.svg".into()],
            event.clone(),
        )
        .unwrap();
        assert_eq!(fs::read_to_string(&destination).unwrap(), snapshot.text);
        assert!(sidecar_path(&destination).exists());
        assert!(destination_directory.join("figs/chart.svg").exists());
        assert!(source_directory.join("figs/chart.svg").exists());
        assert!(!source.exists());
        assert!(!sidecar_path(&source).exists());
        recover_move(directory.path()).unwrap();
        assert!(move_document(directory.path(), &snapshot, &destination, &[], event).is_err());
    }
    #[test]
    fn interrupted_move_resumes_after_one_original_is_removed() {
        let directory = tempfile::tempdir().unwrap();
        let source = directory.path().join("before.md");
        let destination = directory.path().join("after.md");
        fs::write(&destination, "Words").unwrap();
        fs::write(sidecar_path(&source), "{}").unwrap();
        fs::write(sidecar_path(&destination), "{}").unwrap();
        let event = crate::events::EventInput {
            id: Uuid::new_v4(),
            document_id: Uuid::new_v4(),
            revision: 0,
            kind: "document.moved".into(),
            occurred_at: "2026-10-15T00:00:00Z".into(),
            payload: json!({}),
        };
        let plan = DocumentMove {
            id: Uuid::new_v4(),
            source: source.clone(),
            destination: destination.clone(),
            files: vec![
                MoveFile {
                    source: source.clone(),
                    destination: destination.clone(),
                    hash: fingerprint(b"Words"),
                },
                MoveFile {
                    source: sidecar_path(&source),
                    destination: sidecar_path(&destination),
                    hash: fingerprint(b"{}"),
                },
            ],
            event,
        };
        atomic_write(
            &directory.path().join("move.json"),
            &serde_json::to_vec(&plan).unwrap(),
        )
        .unwrap();
        recover_move(directory.path()).unwrap();
        assert!(!sidecar_path(&source).exists());
        assert_eq!(fs::read_to_string(&destination).unwrap(), "Words");
        assert!(!directory.path().join("move.json").exists());
        let store = crate::events::EventStore::open(directory.path()).unwrap();
        assert_eq!(
            store
                .read(&crate::events::EventQuery {
                    after: 0,
                    document_id: None,
                    consumer: None,
                    limit: 100
                })
                .unwrap()
                .events
                .len(),
            1
        );
    }
}
