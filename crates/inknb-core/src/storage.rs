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
    pub path: Option<String>,
    pub text: String,
    pub metadata: Value,
    pub expected_hash: Option<String>,
    pub expected_sidecar_hash: Option<String>,
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

pub fn application_directory() -> Result<PathBuf, String> {
    let directory = dirs::data_local_dir()
        .ok_or("The application support directory is unavailable.")?
        .join("aside");
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
    atomic_write(&directory.join("recovery.json"), &bytes)
}

pub fn save_document(directory: &Path, snapshot: &Snapshot) -> Result<SavedDocument, String> {
    let path = Path::new(
        snapshot
            .path
            .as_ref()
            .ok_or("Choose a file location first.")?,
    );
    let sidecar = sidecar_path(path);
    if file_hash(path)? != snapshot.expected_hash {
        return Err(
            "The Markdown file changed outside ink and butter. Reload it or save a separate copy."
                .into(),
        );
    }
    if file_hash(&sidecar)? != snapshot.expected_sidecar_hash {
        return Err(
            "The annotation file changed outside ink and butter. Reload it or save a separate copy.".into(),
        );
    }
    store_recovery(directory, snapshot)?;
    let hash = fingerprint(snapshot.text.as_bytes());
    let mut metadata = snapshot.metadata.clone();
    metadata["documentHash"] = Value::String(hash.clone());
    let annotation_bytes =
        serde_json::to_vec_pretty(&metadata).map_err(|error| error.to_string())?;
    let sidecar_hash = fingerprint(&annotation_bytes);
    atomic_write(path, snapshot.text.as_bytes())?;
    atomic_write(&sidecar, &annotation_bytes)?;
    atomic_write(
        &directory.join("workspace.json"),
        &serde_json::to_vec(&snapshot.path).map_err(|error| error.to_string())?,
    )?;
    fs::remove_file(directory.join("recovery.json")).map_err(|error| error.to_string())?;
    Ok(SavedDocument { hash, sidecar_hash })
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
            path: Some(path.to_string_lossy().into_owned()),
            text: "# Plants\r\n\r\nA 🪴 garden.\n".into(),
            metadata: json!({"version": 1, "documentHash": ""}),
            expected_hash: None,
            expected_sidecar_hash: None,
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
}
