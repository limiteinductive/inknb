use crate::storage::{atomic_write, fingerprint};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Component, Path};

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ComponentManifest {
    pub version: u32,
    pub name: String,
    pub title: String,
    pub entry: String,
    pub height: u32,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ComponentBundle {
    pub manifest: ComponentManifest,
    pub files: BTreeMap<String, Vec<u8>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RegisteredComponent {
    pub bundle_id: String,
    pub manifest: ComponentManifest,
}

fn collect_files(
    root: &Path,
    directory: &Path,
    files: &mut BTreeMap<String, Vec<u8>>,
    total: &mut usize,
) -> Result<(), String> {
    for entry in fs::read_dir(directory).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let path = entry.path();
        let metadata = fs::symlink_metadata(&path).map_err(|error| error.to_string())?;
        if metadata.file_type().is_symlink() {
            return Err("Component packages cannot contain symbolic links.".into());
        }
        if metadata.is_dir() {
            collect_files(root, &path, files, total)?;
            continue;
        }
        if !metadata.is_file() {
            return Err("Component packages contain regular files only.".into());
        }
        if metadata.len() > 8 * 1024 * 1024 || files.len() >= 256 {
            return Err("Use at most 256 component files, each below 8 MiB.".into());
        }
        let bytes = fs::read(&path).map_err(|error| error.to_string())?;
        *total += bytes.len();
        if *total > 20 * 1024 * 1024 {
            return Err("A component package must stay below 20 MiB.".into());
        }
        let name = path
            .strip_prefix(root)
            .map_err(|error| error.to_string())?
            .to_str()
            .ok_or("Use UTF-8 component file names.")?
            .to_string();
        files.insert(name, bytes);
    }
    Ok(())
}

pub fn register(directory: &Path, package: &Path) -> Result<RegisteredComponent, String> {
    if !package.is_absolute() {
        return Err("Use an absolute component package directory.".into());
    }
    let package = package.canonicalize().map_err(|error| error.to_string())?;
    let mut files = BTreeMap::new();
    collect_files(&package, &package, &mut files, &mut 0)?;
    let manifest: ComponentManifest = serde_json::from_slice(
        files
            .get("inknb-component.json")
            .ok_or("The package needs inknb-component.json.")?,
    )
    .map_err(|error| error.to_string())?;
    if manifest.version != 1
        || manifest.name.is_empty()
        || manifest.name.len() > 100
        || manifest.title.is_empty()
        || manifest.title.len() > 160
        || !(100..=800).contains(&manifest.height)
        || !manifest.entry.ends_with(".html")
        || Path::new(&manifest.entry)
            .components()
            .any(|part| !matches!(part, Component::Normal(_)))
        || !files.contains_key(&manifest.entry)
    {
        return Err(
            "Use component format 1, an existing HTML entry, and height 100 to 800.".into(),
        );
    }
    std::str::from_utf8(&files[&manifest.entry])
        .map_err(|_| "The component HTML entry must use UTF-8.")?;
    let bundle = ComponentBundle { manifest, files };
    let bytes = serde_json::to_vec(&bundle).map_err(|error| error.to_string())?;
    let bundle_id = fingerprint(&bytes);
    let storage = directory.join("components");
    fs::create_dir_all(&storage).map_err(|error| error.to_string())?;
    let target = storage.join(format!("{bundle_id}.json"));
    atomic_write(&target, &bytes)?;
    Ok(RegisteredComponent {
        bundle_id,
        manifest: bundle.manifest,
    })
}

pub fn load(directory: &Path, bundle_id: &str) -> Result<ComponentBundle, String> {
    if bundle_id.len() != 64 || !bundle_id.bytes().all(|value| value.is_ascii_hexdigit()) {
        return Err("Use a registered component bundle identity.".into());
    }
    let bytes = fs::read(
        directory
            .join("components")
            .join(format!("{bundle_id}.json")),
    )
    .map_err(|_| "This component package is unavailable. Ask your agent to register it again.")?;
    if fingerprint(&bytes) != bundle_id {
        return Err("The registered component package changed.".into());
    }
    serde_json::from_slice(&bytes).map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::symlink;

    #[test]
    fn registration_captures_immutable_packages_and_rejects_links() {
        let storage = tempfile::tempdir().unwrap();
        let package = tempfile::tempdir().unwrap();
        fs::write(
            package.path().join("inknb-component.json"),
            r#"{"version":1,"name":"study","title":"Study","entry":"index.html","height":240}"#,
        )
        .unwrap();
        fs::write(package.path().join("index.html"), "<h1>Study</h1>").unwrap();
        let first = register(storage.path(), package.path()).unwrap();
        fs::write(package.path().join("index.html"), "<h1>Updated</h1>").unwrap();
        let second = register(storage.path(), package.path()).unwrap();
        assert_ne!(first.bundle_id, second.bundle_id);
        assert_eq!(
            load(storage.path(), &first.bundle_id).unwrap().files["index.html"],
            b"<h1>Study</h1>"
        );
        symlink(
            package.path().join("index.html"),
            package.path().join("linked.html"),
        )
        .unwrap();
        assert!(register(storage.path(), package.path()).is_err());
        assert!(load(storage.path(), "../invalid").is_err());
    }
}
