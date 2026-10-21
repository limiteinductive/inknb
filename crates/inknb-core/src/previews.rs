use crate::storage::{atomic_write, fingerprint};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::io::Read;
use std::path::{Component, Path};
use uuid::Uuid;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SourceRange {
    pub from: usize,
    pub to: usize,
    pub expected_text: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Rectangle {
    pub left: f64,
    pub top: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum RenderTarget {
    Element {
        #[serde(rename = "elementId")]
        element_id: String,
    },
    Page {
        page: u32,
        rectangle: Rectangle,
    },
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SourceMapping {
    pub id: String,
    pub source: SourceRange,
    pub target: RenderTarget,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PreviewKind {
    Html,
    Pdf,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PageRole {
    Text,
    Item,
    Container,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PageBinding {
    pub identity: Uuid,
    pub element_id: String,
    pub role: PageRole,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DocumentPage {
    pub bindings: Vec<PageBinding>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PreviewManifest {
    pub version: u32,
    pub document_id: Uuid,
    pub kind: PreviewKind,
    pub title: String,
    pub entry: String,
    pub source: String,
    #[serde(default)]
    pub source_map: Vec<SourceMapping>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub page: Option<DocumentPage>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PreviewRecord {
    pub manifest: PreviewManifest,
    pub source_hash: String,
    pub files: BTreeMap<String, String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewInfo {
    pub artifact_id: String,
    pub manifest: PreviewManifest,
    pub source_hash: String,
    pub source_text: String,
}

pub fn register(directory: &Path, package: &Path) -> Result<PreviewInfo, String> {
    if !package.is_absolute() {
        return Err("Use an absolute preview package directory.".into());
    }
    let root = package.canonicalize().map_err(|error| error.to_string())?;
    let mut directories = vec![root.clone()];
    let mut files = BTreeMap::new();
    let mut total = 0;
    while let Some(directory) = directories.pop() {
        for entry in fs::read_dir(directory).map_err(|error| error.to_string())? {
            let path = entry.map_err(|error| error.to_string())?.path();
            let metadata = fs::symlink_metadata(&path).map_err(|error| error.to_string())?;
            if metadata.is_dir() {
                directories.push(path);
                continue;
            }
            if !metadata.is_file() || metadata.file_type().is_symlink() {
                return Err("Preview packages contain regular files and directories only.".into());
            }
            if metadata.len() > 64 * 1024 * 1024 || files.len() >= 512 {
                return Err("Use at most 512 preview files, each at most 64 MiB.".into());
            }
            let mut bytes = Vec::new();
            fs::File::open(&path)
                .map_err(|error| error.to_string())?
                .take(64 * 1024 * 1024 + 1)
                .read_to_end(&mut bytes)
                .map_err(|error| error.to_string())?;
            if bytes.len() > 64 * 1024 * 1024 {
                return Err("A preview file exceeds 64 MiB.".into());
            }
            total += bytes.len();
            if total > 128 * 1024 * 1024 {
                return Err("A preview package must stay within 128 MiB.".into());
            }
            let name = path
                .strip_prefix(&root)
                .map_err(|error| error.to_string())?
                .to_str()
                .ok_or("Use UTF-8 preview file names.")?
                .to_owned();
            files.insert(name, bytes);
        }
    }
    let manifest: PreviewManifest = serde_json::from_slice(
        files
            .get("inknb-preview.json")
            .ok_or("The package needs inknb-preview.json.")?,
    )
    .map_err(|error| error.to_string())?;
    if manifest.version != 1
        || manifest.title.is_empty()
        || manifest.title.len() > 160
        || manifest.source_map.len() > 10000
    {
        return Err("Use preview format 1, a title, and at most 10000 source mappings.".into());
    }
    let entry = files
        .get(&manifest.entry)
        .ok_or("The preview entry is missing.")?;
    if let Some(page) = &manifest.page {
        if !matches!(manifest.kind, PreviewKind::Html)
            || page.bindings.is_empty()
            || page.bindings.len() > 10000
        {
            return Err("A document page needs HTML and between 1 and 10000 node bindings.".into());
        }
        let identities: std::collections::HashSet<_> = page
            .bindings
            .iter()
            .map(|binding| binding.identity)
            .collect();
        let elements: std::collections::HashSet<_> = page
            .bindings
            .iter()
            .map(|binding| &binding.element_id)
            .collect();
        if identities.len() != page.bindings.len()
            || elements.len() != page.bindings.len()
            || page
                .bindings
                .iter()
                .any(|binding| binding.element_id.is_empty() || binding.element_id.len() > 200)
        {
            return Err(
                "Document page bindings need unique node identities and element identifiers."
                    .into(),
            );
        }
    }
    match manifest.kind {
        PreviewKind::Html => {
            if !manifest.entry.ends_with(".html") {
                return Err("An HTML preview needs an .html entry.".into());
            }
            std::str::from_utf8(entry).map_err(|_| "The HTML entry must use UTF-8.")?;
        }
        PreviewKind::Pdf => {
            if !entry.starts_with(b"%PDF-")
                || !entry[entry.len().saturating_sub(1024)..]
                    .windows(5)
                    .any(|window| window == b"%%EOF")
            {
                return Err("The PDF entry is incomplete or invalid.".into());
            }
        }
    }
    let source = files
        .get(&manifest.source)
        .ok_or("The source snapshot is missing.")?;
    if source.len() > 4 * 1024 * 1024 {
        return Err("The source snapshot must stay within 4 MiB.".into());
    }
    let source_text =
        std::str::from_utf8(source).map_err(|_| "The source snapshot must use UTF-8.")?;
    let units: Vec<u16> = source_text.encode_utf16().collect();
    let mut mapping_ids = std::collections::HashSet::new();
    for mapping in &manifest.source_map {
        if mapping.id.is_empty() || !mapping_ids.insert(&mapping.id) {
            return Err("Source mapping identities must be nonempty and unique.".into());
        }
        let range = &mapping.source;
        if range.from > range.to
            || range.to > units.len()
            || String::from_utf16(&units[range.from..range.to])
                .ok()
                .as_deref()
                != Some(&range.expected_text)
        {
            return Err(format!(
                "Source mapping {} does not match the UTF-16 source range.",
                mapping.id
            ));
        }
        match (&manifest.kind, &mapping.target) {
            (PreviewKind::Html, RenderTarget::Element { element_id }) if !element_id.is_empty() => {
            }
            (PreviewKind::Pdf, RenderTarget::Page { page, rectangle })
                if *page > 0
                    && [
                        rectangle.left,
                        rectangle.top,
                        rectangle.width,
                        rectangle.height,
                    ]
                    .iter()
                    .all(|value| value.is_finite() && (0.0..=1.0).contains(value))
                    && rectangle.width > 0.0
                    && rectangle.height > 0.0
                    && rectangle.left + rectangle.width <= 1.000001
                    && rectangle.top + rectangle.height <= 1.000001 => {}
            _ => {
                return Err(format!(
                    "Source mapping {} has an invalid rendered target.",
                    mapping.id
                ))
            }
        }
    }
    let record = PreviewRecord {
        source_hash: fingerprint(source),
        manifest,
        files: files
            .iter()
            .map(|(name, bytes)| (name.clone(), fingerprint(bytes)))
            .collect(),
    };
    let bytes = serde_json::to_vec(&record).map_err(|error| error.to_string())?;
    let artifact_id = fingerprint(&bytes);
    let storage = directory.join("previews");
    fs::create_dir_all(&storage).map_err(|error| error.to_string())?;
    let target = storage.join(&artifact_id);
    if !target.exists() {
        let temporary = storage.join(format!(".{}", Uuid::new_v4()));
        let result = (|| -> Result<(), String> {
            fs::create_dir(&temporary).map_err(|error| error.to_string())?;
            for (name, bytes) in &files {
                let destination = temporary.join("files").join(name);
                fs::create_dir_all(destination.parent().unwrap())
                    .map_err(|error| error.to_string())?;
                atomic_write(&destination, bytes)?;
            }
            atomic_write(&temporary.join("record.json"), &bytes)?;
            fs::rename(&temporary, &target).map_err(|error| error.to_string())?;
            fs::File::open(&storage)
                .and_then(|directory| directory.sync_all())
                .map_err(|error| error.to_string())?;
            Ok(())
        })();
        if result.is_err() {
            let _ = fs::remove_dir_all(&temporary);
        }
        result?;
    }
    info(directory, &artifact_id)
}

pub fn load(directory: &Path, artifact_id: &str) -> Result<PreviewRecord, String> {
    if artifact_id.len() != 64 || !artifact_id.bytes().all(|value| value.is_ascii_hexdigit()) {
        return Err("Use a registered preview artifact identity.".into());
    }
    let bytes = fs::read(
        directory
            .join("previews")
            .join(artifact_id)
            .join("record.json"),
    )
    .map_err(|_| "This preview is unavailable. Ask your agent to publish it again.")?;
    if fingerprint(&bytes) != artifact_id {
        return Err("The registered preview changed.".into());
    }
    serde_json::from_slice(&bytes).map_err(|error| error.to_string())
}

pub fn asset(directory: &Path, artifact_id: &str, name: &str) -> Result<Vec<u8>, String> {
    if Path::new(name)
        .components()
        .any(|part| !matches!(part, Component::Normal(_)))
    {
        return Err("Invalid preview asset path.".into());
    }
    let record = load(directory, artifact_id)?;
    let expected = record.files.get(name).ok_or("Unknown preview asset.")?;
    let bytes = fs::read(
        directory
            .join("previews")
            .join(artifact_id)
            .join("files")
            .join(name),
    )
    .map_err(|error| error.to_string())?;
    if &fingerprint(&bytes) != expected {
        return Err("The registered preview asset changed.".into());
    }
    Ok(bytes)
}

pub fn info(directory: &Path, artifact_id: &str) -> Result<PreviewInfo, String> {
    let record = load(directory, artifact_id)?;
    let source = asset(directory, artifact_id, &record.manifest.source)?;
    Ok(PreviewInfo {
        artifact_id: artifact_id.into(),
        manifest: record.manifest,
        source_hash: record.source_hash,
        source_text: String::from_utf8(source).map_err(|error| error.to_string())?,
    })
}
