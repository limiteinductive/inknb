use base64::Engine;
use inknb_core::configuration::{
    Configuration, ConfigurationSnapshot, ConfigurationStore, FontSizeChange, Placement,
};
use inknb_core::events::{EventInput, EventQuery, EventStore};
use inknb_core::history::{HistoryPage, HistoryQuery, HistoryRevision, RevisionQuery};
use inknb_core::profile::{application_profile, configure_profile};
use inknb_core::protocol::{socket_path, ControlRequest, ControlResponse};
use inknb_core::storage::{
    application_directory, atomic_write, file_hash, load_document, recovery_path, save_document,
    sidecar_path, store_recovery, LoadedDocument, SavedDocument, Snapshot,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::fs::{self, File, OpenOptions};
use std::os::fd::AsRawFd;
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tauri::{Emitter, Manager, State};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::sync::oneshot;
mod activity;
mod keyboard;
#[cfg(target_os = "macos")]
mod mac_notifications;
mod images;
mod preview_window;
mod space_windows;
mod window_chrome;
use window_chrome::{WindowChrome, WindowMode};

type PendingResult = oneshot::Sender<Result<Value, String>>;

#[tauri::command]
async fn register_preview(path: String) -> Result<inknb_core::previews::PreviewInfo, String> {
    tauri::async_runtime::spawn_blocking(move || {
        inknb_core::previews::register(&application_directory()?, Path::new(&path))
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
fn preview_info(artifact_id: String) -> Result<inknb_core::previews::PreviewInfo, String> {
    inknb_core::previews::info(&application_directory()?, &artifact_id)
}

#[tauri::command]
fn preview_file(artifact_id: String, name: String) -> Result<String, String> {
    Ok(
        base64::engine::general_purpose::STANDARD.encode(inknb_core::previews::asset(
            &application_directory()?,
            &artifact_id,
            &name,
        )?),
    )
}

#[tauri::command]
async fn register_markdown_preview(
    document_id: uuid::Uuid,
    title: String,
    source_text: String,
    html: String,
    source_map: Vec<inknb_core::previews::SourceMapping>,
) -> Result<inknb_core::previews::PreviewInfo, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let directory = application_directory()?;
        let package = directory.join(format!(".preview-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&package).map_err(|error| error.to_string())?;
        let result = (|| {
            atomic_write(&package.join("source.txt"), source_text.as_bytes())?;
            atomic_write(&package.join("index.html"), html.as_bytes())?;
            let mut title_end = title.len().min(160);
            while !title.is_char_boundary(title_end) {
                title_end -= 1;
            }
            let manifest = inknb_core::previews::PreviewManifest {
                page: None,
                version: 1,
                document_id,
                kind: inknb_core::previews::PreviewKind::Html,
                title: title[..title_end].to_owned(),
                entry: "index.html".into(),
                source: "source.txt".into(),
                source_map,
            };
            atomic_write(
                &package.join("inknb-preview.json"),
                &serde_json::to_vec(&manifest).map_err(|error| error.to_string())?,
            )?;
            inknb_core::previews::register(&directory, &package)
        })();
        let _ = fs::remove_dir_all(package);
        result
    })
    .await
    .map_err(|error| error.to_string())?
}

#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct CaptureRectangle {
    left: f64,
    top: f64,
    width: f64,
    height: f64,
}

#[tauri::command]
async fn document_capture(
    window: tauri::WebviewWindow,
    rectangle: CaptureRectangle,
) -> Result<Value, String> {
    if window.label() != "main" {
        return Err("Choose a region in the document window.".into());
    }
    let bytes = capture_window(window.app_handle(), window.label(), Some(rectangle)).await?;
    images::image_import(
        base64::engine::general_purpose::STANDARD.encode(bytes),
        "Selected region.png".into(),
    )
}

#[tauri::command]
async fn preview_capture(
    window: tauri::WebviewWindow,
    artifact_id: String,
    rectangle: CaptureRectangle,
) -> Result<Value, String> {
    inknb_core::previews::load(&application_directory()?, &artifact_id)?;
    let bytes = capture_window(window.app_handle(), window.label(), Some(rectangle)).await?;
    let identity = inknb_core::storage::fingerprint(&bytes);
    let directory = application_directory()?.join("preview-captures");
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    atomic_write(&directory.join(format!("{identity}.png")), &bytes)?;
    Ok(json!({
        "id": identity,
        "width": u32::from_be_bytes(bytes[16..20].try_into().unwrap()),
        "height": u32::from_be_bytes(bytes[20..24].try_into().unwrap()),
    }))
}

#[tauri::command]
fn preview_capture_read(capture_id: String) -> Result<String, String> {
    if capture_id.len() != 64 || !capture_id.bytes().all(|value| value.is_ascii_hexdigit()) {
        return Err("Use a preview capture identity.".into());
    }
    let bytes = fs::read(
        application_directory()?
            .join("preview-captures")
            .join(format!("{capture_id}.png")),
    )
    .map_err(|error| error.to_string())?;
    if inknb_core::storage::fingerprint(&bytes) != capture_id {
        return Err("The preview capture changed.".into());
    }
    Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
}

struct DesktopState {
    directory: PathBuf,
    persistence: Mutex<()>,
    configuration: Mutex<ConfigurationStore>,
    events: Mutex<EventStore>,
    event_notification: tokio::sync::Notify,
    pending: Mutex<HashMap<String, PendingResult>>,
    open_path: Mutex<Option<String>>,
    focused_window: Mutex<Option<String>>,
    host_lifecycle: Mutex<space_windows::HostLifecycle>,
    ready_windows: Mutex<HashSet<String>>,
    window_ready: tokio::sync::Notify,
    _lock: File,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Bootstrap {
    configuration: ConfigurationSnapshot,
    recovery: Option<Snapshot>,
    recoveries: Vec<Snapshot>,
    library: Option<Value>,
    last_path: Option<String>,
    requested_path: Option<String>,
    command_path: String,
    codex_path: Option<String>,
    socket_path: String,
    profile: Option<String>,
}

#[tauri::command]
fn bootstrap(state: State<DesktopState>) -> Result<Bootstrap, String> {
    *state
        .host_lifecycle
        .lock()
        .map_err(|error| error.to_string())? = space_windows::HostLifecycle {
        phase: space_windows::HostPhase::LoadingDocuments,
        message: Some("Reading saved documents".into()),
    };
    inknb_core::storage::recover_move(&state.directory)?;
    let read = |name: &str| -> Result<Option<Value>, String> {
        let path = state.directory.join(name);
        if !path.exists() {
            return Ok(None);
        }
        serde_json::from_slice(&fs::read(path).map_err(|error| error.to_string())?)
            .map(Some)
            .map_err(|error| format!("Could not read {name}: {error}"))
    };
    let mut recovery: Option<Snapshot> = read("recovery.json")?
        .map(serde_json::from_value)
        .transpose()
        .map_err(|error| error.to_string())?;
    if let Some(snapshot) = &recovery {
        store_recovery(&state.directory, snapshot)?;
        fs::rename(
            state.directory.join("recovery.json"),
            state.directory.join("recovery-migrated.json"),
        )
        .map_err(|error| error.to_string())?;
    }
    let mut recoveries = Vec::new();
    let recovery_directory = state.directory.join("recoveries");
    if recovery_directory.exists() {
        for entry in fs::read_dir(&recovery_directory).map_err(|error| error.to_string())? {
            let path = entry.map_err(|error| error.to_string())?.path();
            if path.extension().and_then(|extension| extension.to_str()) != Some("json") {
                continue;
            }
            let snapshot = serde_json::from_slice::<Snapshot>(
                &fs::read(path).map_err(|error| error.to_string())?,
            )
            .map_err(|error| error.to_string())?;
            recoveries.push(snapshot);
        }
    }
    let committed = state
        .events
        .lock()
        .map_err(|error| error.to_string())?
        .committed_snapshots()?;
    for snapshot in committed {
        recoveries
            .retain(|previous| previous.metadata["documentId"] != snapshot.metadata["documentId"]);
        recoveries.push(snapshot);
    }
    for snapshot in &mut recoveries {
        if let Some(path) = &snapshot.path {
            let new_hash = inknb_core::storage::fingerprint(snapshot.text.as_bytes());
            let mut metadata = snapshot.metadata.clone();
            metadata["documentHash"] = json!(new_hash);
            let new_sidecar_hash = inknb_core::storage::fingerprint(
                &serde_json::to_vec_pretty(&metadata).map_err(|error| error.to_string())?,
            );
            let actual_hash = file_hash(Path::new(path))?;
            let actual_sidecar_hash = file_hash(&sidecar_path(Path::new(path)))?;
            if actual_hash.as_ref() == Some(&new_hash) {
                snapshot.base_text = Some(snapshot.text.clone());
            }
            if actual_hash.as_ref() == Some(&new_hash)
                && actual_sidecar_hash.as_ref() == Some(&new_sidecar_hash)
            {
                if let Some(event) = &snapshot.save_event {
                    state
                        .events
                        .lock()
                        .map_err(|error| error.to_string())?
                        .append(std::slice::from_ref(event))?;
                }
            }
            if (actual_hash == snapshot.expected_hash || actual_hash.as_ref() == Some(&new_hash))
                && (actual_sidecar_hash == snapshot.expected_sidecar_hash
                    || actual_sidecar_hash.as_ref() == Some(&new_sidecar_hash))
            {
                snapshot.expected_hash = actual_hash;
                snapshot.expected_sidecar_hash = actual_sidecar_hash;
            }
        }
        state
            .events
            .lock()
            .map_err(|error| error.to_string())?
            .commit_snapshot(snapshot)?;
    }
    recovery = recovery.and_then(|legacy| {
        recoveries
            .iter()
            .find(|snapshot| snapshot.metadata["documentId"] == legacy.metadata["documentId"])
            .cloned()
    });
    let stored_path = read("workspace.json")?.and_then(|value| value.as_str().map(String::from));
    let requested_path = state
        .open_path
        .lock()
        .map_err(|error| error.to_string())?
        .take();
    let executable = std::env::current_exe().map_err(|error| error.to_string())?;
    let mut library = read("library.json")?;
    if let Some(documents) = library
        .as_mut()
        .and_then(|library| library["documents"].as_array_mut())
    {
        for document in documents {
            if document.get("modifiedAt").is_some() {
                continue;
            }
            let modified_at = document["path"]
                .as_str()
                .and_then(|path| fs::metadata(path).ok())
                .and_then(|metadata| metadata.modified().ok())
                .and_then(|modified| modified.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|duration| duration.as_secs_f64() * 1000.0)
                .unwrap_or(0.0);
            document["modifiedAt"] = json!(modified_at);
        }
    }
    Ok(Bootstrap {
        configuration: state
            .configuration
            .lock()
            .map_err(|error| error.to_string())?
            .snapshot(),
        recovery,
        recoveries,
        library,
        last_path: requested_path.clone().or(stored_path),
        requested_path,
        command_path: executable
            .with_file_name("inknb")
            .to_string_lossy()
            .into_owned(),
        codex_path: find_executable("codex"),
        socket_path: socket_path()?.to_string_lossy().into_owned(),
        profile: application_profile().map(str::to_owned),
    })
}

fn find_executable(name: &str) -> Option<String> {
    let mut directories: Vec<PathBuf> =
        std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default()).collect();
    directories.extend([
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/usr/local/bin"),
    ]);
    if let Some(home_directory) = dirs::home_dir() {
        directories.push(home_directory.join(".local/bin"));
    }
    directories
        .into_iter()
        .map(|directory| directory.join(name))
        .find(|path| path.is_file())
        .map(|path| path.to_string_lossy().into_owned())
}

#[tauri::command]
async fn component_info(
    bundle_id: String,
) -> Result<inknb_core::components::RegisteredComponent, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let directory = application_directory()?;
        let bundle = inknb_core::components::load(&directory, &bundle_id)?;
        Ok(inknb_core::components::RegisteredComponent {
            bundle_id,
            manifest: bundle.manifest,
        })
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn read_document(path: String) -> Result<LoadedDocument, String> {
    tauri::async_runtime::spawn_blocking(move || load_document(Path::new(&path)))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn write_recovery(app: tauri::AppHandle, snapshot: Snapshot) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<DesktopState>();
        let _guard = state
            .persistence
            .lock()
            .map_err(|error| error.to_string())?;
        state
            .events
            .lock()
            .map_err(|error| error.to_string())?
            .commit_snapshot(&snapshot)?;
        state.event_notification.notify_waiters();
        Ok(())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn persist_document(
    app: tauri::AppHandle,
    snapshot: Snapshot,
) -> Result<SavedDocument, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<DesktopState>();
        let _guard = state
            .persistence
            .lock()
            .map_err(|error| error.to_string())?;
        state
            .events
            .lock()
            .map_err(|error| error.to_string())?
            .commit_snapshot(&snapshot)?;
        let saved = save_document(&state.directory, &snapshot)?;
        state
            .events
            .lock()
            .map_err(|error| error.to_string())?
            .forget_snapshot(
                snapshot.metadata["documentId"]
                    .as_str()
                    .ok_or("The document needs an identity.")?,
            )?;
        state.event_notification.notify_waiters();
        Ok(saved)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn publish_events(app: tauri::AppHandle, events: Vec<EventInput>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<DesktopState>();
        state
            .events
            .lock()
            .map_err(|error| error.to_string())?
            .append(&events)?;
        state.event_notification.notify_waiters();
        Ok(())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn move_document(
    app: tauri::AppHandle,
    snapshot: Snapshot,
    destination: String,
    assets: Vec<String>,
    event: EventInput,
) -> Result<SavedDocument, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<DesktopState>();
        let _guard = state
            .persistence
            .lock()
            .map_err(|error| error.to_string())?;
        let saved = inknb_core::storage::move_document(
            &state.directory,
            &snapshot,
            Path::new(&destination),
            &assets,
            event,
        )?;
        state.event_notification.notify_waiters();
        Ok(saved)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn discard_recovery(app: tauri::AppHandle, document_id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<DesktopState>();
        let _guard = state
            .persistence
            .lock()
            .map_err(|error| error.to_string())?;
        let path = recovery_path(&state.directory, &json!({"documentId": document_id}))?;
        if path.exists() {
            fs::remove_file(path).map_err(|error| error.to_string())?;
        }
        state
            .events
            .lock()
            .map_err(|error| error.to_string())?
            .forget_snapshot(&document_id)?;
        Ok(())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn store_library(app: tauri::AppHandle, library: Value) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<DesktopState>();
        atomic_write(
            &state.directory.join("library.json"),
            &serde_json::to_vec_pretty(&library).map_err(|error| error.to_string())?,
        )
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
fn allocate_document(
    state: State<DesktopState>,
    document_id: String,
    format: DocumentFormat,
) -> Result<String, String> {
    let identity = uuid::Uuid::parse_str(&document_id).map_err(|error| error.to_string())?;
    let extension = match format {
        DocumentFormat::Text => "txt",
        DocumentFormat::Markdown => "md",
        DocumentFormat::Html => "html",
        DocumentFormat::Latex => "tex",
    };
    let directory = state.directory.join("documents");
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    Ok(directory
        .join(format!("{identity}.{extension}"))
        .to_string_lossy()
        .into_owned())
}

#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
enum DocumentFormat {
    Text,
    Markdown,
    Html,
    Latex,
}

#[tauri::command]
fn configuration_read(app: tauri::AppHandle) -> Result<ConfigurationSnapshot, String> {
    let state = app.state::<DesktopState>();
    let mut configuration = state
        .configuration
        .lock()
        .map_err(|error| error.to_string())?;
    let changed = configuration.refresh();
    let snapshot = configuration.snapshot();
    drop(configuration);
    if changed {
        keyboard::apply(&app, &snapshot.effective)?;
        app.emit_to("host", "inknb-configuration", &snapshot).map_err(|error| error.to_string())?;
    }
    Ok(snapshot)
}

#[tauri::command]
fn configuration_placement(
    app: tauri::AppHandle,
    placement: Placement,
) -> Result<ConfigurationSnapshot, String> {
    let state = app.state::<DesktopState>();
    let mut configuration = state
        .configuration
        .lock()
        .map_err(|error| error.to_string())?;
    let snapshot = configuration.set_placement(placement)?;
    drop(configuration);
    keyboard::apply(&app, &snapshot.effective)?;
    app.emit_to("host", "inknb-configuration", &snapshot)
        .map_err(|error| error.to_string())?;
    Ok(snapshot)
}

#[tauri::command]
fn configuration_font_size(
    app: tauri::AppHandle,
    change: FontSizeChange,
) -> Result<ConfigurationSnapshot, String> {
    let state = app.state::<DesktopState>();
    let mut configuration = state
        .configuration
        .lock()
        .map_err(|error| error.to_string())?;
    let snapshot = configuration.change_font_size(change)?;
    drop(configuration);
    keyboard::apply(&app, &snapshot.effective)?;
    app.emit_to("host", "inknb-configuration", &snapshot)
        .map_err(|error| error.to_string())?;
    Ok(snapshot)
}

#[tauri::command]
fn remember_document(state: State<DesktopState>, path: Option<String>) -> Result<(), String> {
    atomic_write(
        &state.directory.join("workspace.json"),
        &serde_json::to_vec(&path).map_err(|error| error.to_string())?,
    )
}

#[tauri::command]
async fn inspect_files(path: Option<String>, sources: Vec<String>) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let document = path.map(|path| -> Result<Value, String> {
            Ok(json!({"hash":file_hash(Path::new(&path))?,"sidecarHash":file_hash(&sidecar_path(Path::new(&path)))?}))
        }).transpose()?;
        let mut fingerprints = HashMap::new();
        for source in sources {
            fingerprints.insert(source.clone(), file_hash(Path::new(&source))?);
        }
        Ok(json!({"document":document,"sources":fingerprints}))
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn source_fingerprint(path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        file_hash(Path::new(&path))?.ok_or("This source file no longer exists.".into())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
fn relative_asset_path(
    document_path: Option<String>,
    asset_path: String,
) -> Result<String, String> {
    let asset = Path::new(&asset_path)
        .canonicalize()
        .map_err(|error| error.to_string())?;
    let Some(document) = document_path else {
        return Ok(asset.to_string_lossy().into_owned());
    };
    let parent = Path::new(&document)
        .parent()
        .ok_or("The document has no parent directory.")?;
    let base: Vec<_> = parent.components().collect();
    let target: Vec<_> = asset.components().collect();
    let shared = base
        .iter()
        .zip(&target)
        .take_while(|(first, second)| first == second)
        .count();
    let mut relative = PathBuf::new();
    for _component in &base[shared..] {
        relative.push("..");
    }
    for component in &target[shared..] {
        relative.push(component.as_os_str());
    }
    Ok(relative.to_string_lossy().into_owned())
}

#[tauri::command]
fn preview_assets(
    document_path: Option<String>,
    references: Vec<String>,
) -> Result<HashMap<String, String>, String> {
    let mut assets = HashMap::new();
    let parent = document_path
        .as_ref()
        .and_then(|path| Path::new(path).parent());
    for reference in references {
        if tauri::Url::parse(&reference).is_ok() {
            continue;
        }
        let decoded = percent_encoding::percent_decode_str(&reference)
            .decode_utf8()
            .map_err(|error| error.to_string())?;
        let path = Path::new(decoded.as_ref());
        let path = if path.is_absolute() {
            path.to_path_buf()
        } else if let Some(parent) = parent {
            parent.join(path)
        } else {
            continue;
        };
        let extension = path
            .extension()
            .and_then(|extension| extension.to_str())
            .unwrap_or_default()
            .to_lowercase();
        let content_type = match extension.as_str() {
            "png" => "image/png",
            "jpg" | "jpeg" => "image/jpeg",
            "webp" => "image/webp",
            "svg" => "image/svg+xml",
            "gif" => "image/gif",
            _ => continue,
        };
        let Ok(metadata) = fs::metadata(&path) else {
            continue;
        };
        if metadata.len() > 12 * 1024 * 1024 {
            continue;
        }
        if let Ok(bytes) = fs::read(path) {
            assets.insert(
                reference,
                format!(
                    "data:{content_type};base64,{}",
                    base64::engine::general_purpose::STANDARD.encode(bytes)
                ),
            );
        }
    }
    Ok(assets)
}

#[derive(Deserialize)]
#[serde(rename_all = "kebab-case")]
enum EditingAction {
    Undo,
    Redo,
    Cut,
    Copy,
    Paste,
    SelectAll,
}

#[tauri::command]
fn clipboard_write(text: String) -> Result<(), String> {
    use objc2_app_kit::{NSPasteboard, NSPasteboardTypeString};
    use objc2_foundation::NSString;

    let pasteboard = NSPasteboard::generalPasteboard();
    pasteboard.clearContents();
    let written =
        unsafe { pasteboard.setString_forType(&NSString::from_str(&text), NSPasteboardTypeString) };
    if !written {
        return Err("macOS could not copy this text.".into());
    }
    Ok(())
}

#[tauri::command]
fn editing_action(window: tauri::WebviewWindow, action: EditingAction) -> Result<(), String> {
    window
        .with_webview(move |_| {
            let main_thread = objc2::MainThreadMarker::new().unwrap();
            let application = objc2_app_kit::NSApplication::sharedApplication(main_thread);
            let selector = match action {
                EditingAction::Undo => objc2::sel!(undo:),
                EditingAction::Redo => objc2::sel!(redo:),
                EditingAction::Cut => objc2::sel!(cut:),
                EditingAction::Copy => objc2::sel!(copy:),
                EditingAction::Paste => objc2::sel!(paste:),
                EditingAction::SelectAll => objc2::sel!(selectAll:),
            };
            unsafe {
                application.sendAction_to_from(selector, None, None);
            }
        })
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn link_preview(reference: String) -> Result<String, String> {
    let destination = tauri::Url::parse(&reference).map_err(|error| error.to_string())?;
    if !matches!(destination.scheme(), "http" | "https")
        || !destination.username().is_empty()
        || destination.password().is_some()
    {
        return Err("This link has no web preview.".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        use std::io::Read;
        use std::process::{Command, Stdio};

        let mut child = Command::new("/usr/bin/curl")
            .args([
                "--disable",
                "--silent",
                "--fail",
                "--location",
                "--max-redirs",
                "3",
                "--max-time",
                "6",
                "--proto",
                "=http,https",
                "--proto-redir",
                "=http,https",
                "--user-agent",
                "InkAndButter/0.5 LinkPreview",
                "--url",
                &reference,
            ])
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|error| error.to_string())?;
        let mut bytes = Vec::new();
        let read = child
            .stdout
            .take()
            .ok_or("The preview could not be read.")?
            .take(262144)
            .read_to_end(&mut bytes);
        if bytes.len() == 262144 || read.is_err() {
            let _ = child.kill();
        }
        let status = child.wait().map_err(|error| error.to_string())?;
        read.map_err(|error| error.to_string())?;
        if !status.success() && bytes.len() < 262144 {
            return Err("The preview is unavailable.".into());
        }
        Ok(String::from_utf8_lossy(&bytes).into_owned())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn open_reference(
    app: tauri::AppHandle,
    document_path: Option<String>,
    reference: String,
) -> Result<(), String> {
    if let Ok(url) = tauri::Url::parse(&reference) {
        if url.scheme() == "inknb" && matches!(url.host_str(), Some("document" | "aside")) {
            let parts: Vec<_> = url.path().trim_matches('/').split('/').collect();
            let document_id = parts
                .first()
                .ok_or("The document link is incomplete.")?
                .parse::<uuid::Uuid>()
                .map_err(|error| error.to_string())?;
            let (method, parameters) = if url.host_str() == Some("aside") && parts.len() == 2 {
                let thread_id = parts[1]
                    .parse::<uuid::Uuid>()
                    .map_err(|error| error.to_string())?;
                (
                    "aside_open",
                    json!({ "documentId": document_id, "threadId": thread_id }),
                )
            } else if url.host_str() == Some("document") && parts.len() == 1 {
                ("document_activate", json!({ "documentId": document_id }))
            } else {
                return Err("The document link is incomplete.".into());
            };
            dispatch_to(
                &app,
                "host",
                ControlRequest {
                    agent_id: None,
                    version: 1,
                    id: uuid::Uuid::new_v4().to_string(),
                    method: method.into(),
                    params: parameters,
                },
            )
            .await?;
            return Ok(());
        }
    }
    let destination = match tauri::Url::parse(&reference) {
        Ok(url) if matches!(url.scheme(), "http" | "https" | "codex" | "claude") => url.to_string(),
        Ok(_) => return Err("This link type cannot be opened from ink and butter.".into()),
        Err(_) => {
            let decoded = percent_encoding::percent_decode_str(&reference)
                .decode_utf8()
                .map_err(|error| error.to_string())?;
            let path = Path::new(decoded.as_ref());
            let path = if path.is_absolute() {
                path.to_path_buf()
            } else {
                Path::new(
                    document_path
                        .as_ref()
                        .ok_or("Save the document before opening relative sources.")?,
                )
                .parent()
                .ok_or("The document has no parent directory.")?
                .join(path)
            };
            path.canonicalize()
                .map_err(|error| error.to_string())?
                .to_string_lossy()
                .into_owned()
        }
    };
    let status = std::process::Command::new("/usr/bin/open")
        .args(["--", &destination])
        .status()
        .map_err(|error| error.to_string())?;
    if !status.success() {
        return Err("macOS could not open this reference.".into());
    }
    Ok(())
}

#[tauri::command]
async fn deliver_codex(
    app: tauri::AppHandle,
    request_id: String,
    command_path: String,
    session_id: String,
    message: String,
) -> Result<(), String> {
    uuid::Uuid::parse_str(&request_id).map_err(|_| "Invalid work request identity.")?;
    if !Path::new(&command_path).is_absolute() || !Path::new(&command_path).is_file() {
        return Err("The agent must reconnect using its installed Codex executable.".into());
    }
    uuid::Uuid::parse_str(&session_id)
        .map_err(|_| "The agent must reconnect using its current session identity.")?;
    let state = app.state::<DesktopState>();
    let receipt = state
        .events
        .lock()
        .map_err(|error| error.to_string())?
        .begin_delivery(&request_id)?;
    if receipt == "queued" {
        return Ok(());
    }
    if receipt != "new" {
        return Err(
            "Delivery is unconfirmed. The agent must reconcile this request before retrying."
                .into(),
        );
    }
    tauri::async_runtime::spawn_blocking(move || {
        let mut started = None;
        let mut failure = String::new();
        for attempt in 0..3 {
            match std::process::Command::new(&command_path)
                .args(["queue", "--thread", &session_id, "--message", &message])
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped())
                .spawn()
            {
                Ok(child) => {
                    started = Some(child);
                    break;
                }
                Err(error) => {
                    failure = error.to_string();
                    if !matches!(
                        error.kind(),
                        std::io::ErrorKind::Interrupted | std::io::ErrorKind::WouldBlock
                    ) {
                        break;
                    }
                    std::thread::sleep(std::time::Duration::from_millis(250 * (attempt + 1)));
                }
            }
        }
        let state = app.state::<DesktopState>();
        let Some(mut child) = started else {
            state
                .events
                .lock()
                .map_err(|error| error.to_string())?
                .finish_delivery(&request_id, "unstarted")?;
            return Err(format!("The agent transport could not start: {failure}"));
        };
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
        let mut timed_out = false;
        loop {
            match child.try_wait() {
                Ok(Some(_)) => break,
                Err(_) => {
                    let _ = child.kill();
                    break;
                }
                Ok(None) if std::time::Instant::now() >= deadline => {
                    timed_out = true;
                    let _ = child.kill();
                    break;
                }
                Ok(None) => std::thread::sleep(std::time::Duration::from_millis(50)),
            }
        }
        let output = child.wait_with_output();
        let queued = output
            .as_ref()
            .map(|result| result.status.success())
            .unwrap_or(false);
        state
            .events
            .lock()
            .map_err(|error| error.to_string())?
            .finish_delivery(&request_id, if queued { "queued" } else { "uncertain" })?;
        if queued {
            return Ok(());
        }
        if timed_out {
            return Err(
                "The transport timed out. The agent must reconcile this request before retrying."
                    .into(),
            );
        }
        let detail = output
            .map(|output| {
                String::from_utf8_lossy(&output.stderr)
                    .chars()
                    .take(1200)
                    .collect::<String>()
            })
            .unwrap_or_else(|error| error.to_string());
        Err(format!(
            "Delivery needs reconciliation by the agent: {detail}"
        ))
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
fn history_read(state: State<DesktopState>, query: HistoryQuery) -> Result<HistoryPage, String> {
    state
        .events
        .lock()
        .map_err(|error| error.to_string())?
        .read_history(&query)
}

#[tauri::command]
fn revision_read(
    state: State<DesktopState>,
    query: RevisionQuery,
) -> Result<HistoryRevision, String> {
    state
        .events
        .lock()
        .map_err(|error| error.to_string())?
        .read_revision(&query)
}

#[tauri::command]
fn delivery_receipts(
    state: State<DesktopState>,
    requests: Vec<String>,
) -> Result<HashMap<String, Option<String>>, String> {
    let store = state.events.lock().map_err(|error| error.to_string())?;
    requests
        .into_iter()
        .map(|identity| store.delivery(&identity).map(|receipt| (identity, receipt)))
        .collect()
}

#[tauri::command]
fn reset_delivery(state: State<DesktopState>, request_id: String) -> Result<(), String> {
    state
        .events
        .lock()
        .map_err(|error| error.to_string())?
        .finish_delivery(&request_id, "unstarted")
}

#[tauri::command]
fn complete_control(
    state: State<DesktopState>,
    request_id: String,
    result: Value,
    error: Option<String>,
) -> Result<(), String> {
    if let Some(sender) = state
        .pending
        .lock()
        .map_err(|error| error.to_string())?
        .remove(&request_id)
    {
        let response = match error {
            Some(message) => Err(message),
            None => Ok(result),
        };
        let _ = sender.send(response);
    }
    Ok(())
}

async fn dispatch(app: &tauri::AppHandle, request: ControlRequest) -> Result<Value, String> {
    dispatch_to(app, "host", request).await
}

async fn dispatch_to(
    app: &tauri::AppHandle,
    label: &str,
    request: ControlRequest,
) -> Result<Value, String> {
    let state = app.state::<DesktopState>();
    if label.starts_with("writing-") {
        tokio::time::timeout(std::time::Duration::from_secs(10), async {
            loop {
                let notification = state.window_ready.notified();
                if state
                    .ready_windows
                    .lock()
                    .map_err(|error| error.to_string())?
                    .contains(label)
                {
                    return Ok::<(), String>(());
                }
                notification.await;
            }
        })
        .await
        .map_err(|_| "The writing window is still opening.")??;
    }
    let (sender, receiver) = oneshot::channel();
    state
        .pending
        .lock()
        .map_err(|error| error.to_string())?
        .insert(request.id.clone(), sender);
    app.emit_to(label, "inknb-control", &request)
        .map_err(|error| error.to_string())?;
    let response = tokio::time::timeout(std::time::Duration::from_secs(25), receiver).await;
    state
        .pending
        .lock()
        .map_err(|error| error.to_string())?
        .remove(&request.id);
    match response {
        Ok(Ok(result)) => result,
        _ => Err("The editor did not respond. Check that its window is ready.".into()),
    }
}

async fn write_control(
    writer: &mut tokio::net::unix::OwnedWriteHalf,
    response: ControlResponse,
) -> Result<(), String> {
    let mut bytes = serde_json::to_vec(&response).map_err(|error| error.to_string())?;
    bytes.push(b'\n');
    tokio::time::timeout(std::time::Duration::from_secs(10), writer.write_all(&bytes))
        .await
        .map_err(|_| "The control client stopped reading.")?
        .map_err(|error| error.to_string())
}

async fn serve_connection(
    app: tauri::AppHandle,
    stream: tokio::net::UnixStream,
) -> Result<(), String> {
    let (reader, mut writer) = stream.into_split();
    let mut line = String::new();
    tokio::time::timeout(
        std::time::Duration::from_secs(5),
        BufReader::new(reader.take(4 * 1024 * 1024 + 1)).read_line(&mut line),
    )
    .await
    .map_err(|_| "The request timed out.")?
    .map_err(|error| error.to_string())?;
    if line.len() > 4 * 1024 * 1024 {
        return Err("The request is too large.".into());
    }
    let request: ControlRequest = serde_json::from_str(&line).map_err(|error| error.to_string())?;
    if request.version != 1 {
        return write_control(
            &mut writer,
            ControlResponse {
                version: 1,
                id: request.id,
                result: None,
                error: Some("Unsupported protocol version. Use version 1.".into()),
            },
        )
        .await;
    }
    if request.id.len() > 80 {
        return Err("Invalid request identity.".into());
    }
    if request.method == "events_subscribe" {
        let mut query = match serde_json::from_value::<EventQuery>(request.params.clone()) {
            Ok(query) => query,
            Err(error) => {
                return write_control(
                    &mut writer,
                    ControlResponse {
                        version: 1,
                        id: request.id,
                        result: None,
                        error: Some(error.to_string()),
                    },
                )
                .await
            }
        };
        loop {
            let state = app.state::<DesktopState>();
            let notified = state.event_notification.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            let result = state
                .events
                .lock()
                .map_err(|error| error.to_string())
                .and_then(|store| store.read(&query));
            let page = match result {
                Ok(page) => page,
                Err(error) => {
                    return write_control(
                        &mut writer,
                        ControlResponse {
                            version: 1,
                            id: request.id,
                            result: None,
                            error: Some(error),
                        },
                    )
                    .await
                }
            };
            let has_events = !page.events.is_empty();
            query.after = page.next_cursor;
            write_control(
                &mut writer,
                ControlResponse {
                    version: 1,
                    id: request.id.clone(),
                    result: Some(serde_json::to_value(page).map_err(|error| error.to_string())?),
                    error: None,
                },
            )
            .await?;
            if !has_events {
                let _ = tokio::time::timeout(std::time::Duration::from_secs(15), notified).await;
            }
        }
    }
    let identity = request.id.clone();
    let method = request.method.clone();
    let result: Result<Value, String> = async {
        if method == "decision_read" {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase", deny_unknown_fields)]
            struct DecisionQuery { decision_id: uuid::Uuid, document_id: Option<uuid::Uuid> }
            let query: DecisionQuery = serde_json::from_value(request.params).map_err(|error| error.to_string())?;
            app.state::<DesktopState>().events.lock().map_err(|error| error.to_string())?.read_decision(query.decision_id, query.document_id)
        } else if method == "tools_list" {
            if request.params != json!({}) { return Err("This tool takes no parameters.".into()); }
            Ok(json!({"tools":inknb_core::protocol::tools()}))
        } else if method == "protocol_info" {
            if request.params != json!({}) {
                return Err("This tool takes no parameters.".into());
            }
            Ok(
                json!({"version":1,"transport":"unix-json-lines","socketPath":socket_path()?,"eventDelivery":"at-least-once","streamMethod":"events_subscribe","componentGuide":include_str!("../../docs/components.md"),"previewGuide":include_str!("../../docs/previews.md"),"tools":inknb_core::protocol::tools()}),
            )
        } else if method == "configuration_read" {
            if request.params != json!({}) {
                return Err("This tool takes no parameters.".into());
            }
            let snapshot = configuration_read(app.clone())?;
            let shortcuts = inknb_core::shortcuts::resolve(&snapshot.effective.shortcuts)?;
            let mut result = serde_json::to_value(snapshot).map_err(|error| error.to_string())?;
            result["schema"] = serde_json::to_value(schemars::schema_for!(Configuration))
                .map_err(|error| error.to_string())?;
            result["shortcuts"] = serde_json::to_value(shortcuts).map_err(|error|error.to_string())?;
            Ok(result)
        } else if method == "configuration_write" {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase", deny_unknown_fields)]
            struct ConfigurationWrite {
                source: String,
                expected_fingerprint: String,
            }
            let parameters: ConfigurationWrite = serde_json::from_value(request.params)
                .map_err(|error| error.to_string())?;
            let state = app.state::<DesktopState>();
            let mut configuration = state.configuration.lock().map_err(|error| error.to_string())?;
            let result = configuration.write(&parameters.source, &parameters.expected_fingerprint);
            let snapshot = configuration.snapshot();
            drop(configuration);
            keyboard::apply(&app, &snapshot.effective)?;
            app.emit_to("host", "inknb-configuration", &snapshot)
                .map_err(|error| error.to_string())?;
            result.and_then(|snapshot| serde_json::to_value(snapshot).map_err(|error| error.to_string()))
        } else if method == "component_register" {
            #[derive(Deserialize)]
            #[serde(deny_unknown_fields)]
            struct Registration { path: String }
            let registration: Registration = serde_json::from_value(request.params).map_err(|error| error.to_string())?;
            tauri::async_runtime::spawn_blocking(move || {
                let directory = application_directory()?;
                inknb_core::components::register(&directory, Path::new(&registration.path))
                    .and_then(|bundle| serde_json::to_value(bundle).map_err(|error| error.to_string()))
            }).await.map_err(|error| error.to_string())?
        } else if method == "request_delivery" {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase", deny_unknown_fields)]
            struct DeliveryQuery {
                request_id: uuid::Uuid,
            }
            let parsed: DeliveryQuery =
                serde_json::from_value(request.params).map_err(|error| error.to_string())?;
            let receipt = app
                .state::<DesktopState>()
                .events
                .lock()
                .map_err(|error| error.to_string())?
                .delivery(&parsed.request_id.to_string())?;
            Ok(json!({"requestId":parsed.request_id,"receipt":receipt}))
        } else if method == "activity_read" {
            let query: inknb_core::activity::ActivityQuery = serde_json::from_value(request.params.clone()).map_err(|error|error.to_string())?;
            let page = app.state::<DesktopState>().events.lock().map_err(|error|error.to_string())?.read_activity(&query)?;
            serde_json::to_value(page).map_err(|error|error.to_string())
        } else if method == "events_read" {
            let query: EventQuery =
                serde_json::from_value(request.params).map_err(|error| error.to_string())?;
            app.state::<DesktopState>()
                .events
                .lock()
                .map_err(|error| error.to_string())?
                .read(&query)
                .and_then(|page| serde_json::to_value(page).map_err(|error| error.to_string()))
        } else if method == "events_ack" {
            #[derive(Deserialize)]
            #[serde(deny_unknown_fields)]
            struct Acknowledgement {
                consumer: String,
                cursor: u64,
            }
            let acknowledgement: Acknowledgement =
                serde_json::from_value(request.params).map_err(|error| error.to_string())?;
            app.state::<DesktopState>()
                .events
                .lock()
                .map_err(|error| error.to_string())?
                .acknowledge(&acknowledgement.consumer, acknowledgement.cursor)?;
            Ok(json!({"acknowledged":acknowledgement.cursor}))
        } else if method == "host_status" {
            let status = app.state::<DesktopState>().host_lifecycle.lock().map_err(|error| error.to_string())?.clone();
            Ok(json!({ "status": status, "windows": app.webview_windows().values().map(|window| json!({ "label": window.label(), "visible": window.is_visible().unwrap_or(false) })).collect::<Vec<_>>() }))
        } else if method == "window_close" {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase", deny_unknown_fields)]
            struct CloseWindow { window_id: uuid::Uuid }
            let target: CloseWindow = serde_json::from_value(request.params.clone()).map_err(|error| error.to_string())?;
            let window = space_windows::window_for_identity(&app, Some(target.window_id))?;
            window.close().map_err(|error| error.to_string())?;
            Ok(json!({ "closing": true, "windowId": target.window_id }))
        } else if method == "window_show" {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase", deny_unknown_fields)]
            struct WindowTarget { window_id: Option<uuid::Uuid> }
            let target: WindowTarget = serde_json::from_value(request.params.clone()).map_err(|error| error.to_string())?;
            space_windows::window_for_identity(&app, target.window_id)
                    .and_then(|window| {
                        window.unminimize().map_err(|error| error.to_string())?;
                        window.show().map_err(|error| error.to_string())?;
                        window.set_focus().map_err(|error| error.to_string())?;
                        window
                            .with_webview(|_| {
                                let main_thread = objc2::MainThreadMarker::new().unwrap();
                                let application =
                                    objc2_app_kit::NSApplication::sharedApplication(main_thread);
                                #[allow(deprecated)]
                                application.activateIgnoringOtherApps(true);
                            })
                            .map_err(|error| error.to_string())?;
                        Ok(json!({"shown":true}))
                    })
        } else if method == "screenshot" {
            #[derive(Default, Deserialize)]
            #[serde(rename_all = "lowercase")]
            enum ScreenshotWindow {
                #[default]
                Main,
                Preview,
            }
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase", deny_unknown_fields)]
            struct ScreenshotParameters {
                #[serde(default)]
                window: ScreenshotWindow,
                window_id: Option<uuid::Uuid>,
            }
            let parameters: ScreenshotParameters = serde_json::from_value(request.params.clone()).map_err(|error| error.to_string())?;
            let label = match parameters.window {
                ScreenshotWindow::Main => space_windows::window_for_identity(&app, parameters.window_id)?.label().to_string(),
                ScreenshotWindow::Preview => "preview".into(),
            };
            let mut state_request = request.clone();
            state_request.method = "ui_state".into();
            state_request.params = match label.strip_prefix("writing-") {
                Some(identity) => json!({ "windowId": identity }),
                None => json!({}),
            };
            let mut before = dispatch(&app, state_request.clone()).await?;
            let bytes = capture_window(&app, &label, None).await?;
            let mut after = dispatch(&app, state_request).await?;
            before
                .as_object_mut()
                .map(|state| state.remove("capturedAt"));
            let captured_at = after
                .as_object_mut()
                .and_then(|state| state.remove("capturedAt"));
            if before != after {
                Err("The editor changed during capture. Take another screenshot.".into())
            } else {
                after["capturedAt"] = captured_at.unwrap_or(Value::Null);
                after["captureId"] = Value::String(uuid::Uuid::new_v4().to_string());
                Ok(
                    json!({"window": label, "state":after,"data":base64::engine::general_purpose::STANDARD.encode(bytes)}),
                )
            }
        } else {
            dispatch(&app, request).await
        }
    }
    .await;
    let response = match result {
        Ok(result) => ControlResponse {
            version: 1,
            id: identity,
            result: Some(result),
            error: None,
        },
        Err(error) => ControlResponse {
            version: 1,
            id: identity,
            result: None,
            error: Some(error),
        },
    };
    write_control(&mut writer, response).await
}

async fn capture_window(
    app: &tauri::AppHandle,
    label: &str,
    rectangle: Option<CaptureRectangle>,
) -> Result<Vec<u8>, String> {
    use block2::RcBlock;
    use objc2::MainThreadOnly;
    use objc2_app_kit::{NSBitmapImageFileType, NSBitmapImageRep, NSImage};
    use objc2_foundation::{NSDictionary, NSError};
    use objc2_web_kit::{WKSnapshotConfiguration, WKWebView};
    let window = app
        .get_webview_window(label)
        .ok_or("The editor window is closed.")?;
    let (sender, receiver) = oneshot::channel();
    let sender = Arc::new(Mutex::new(Some(sender)));
    window
        .with_webview(move |platform| {
            let completion = RcBlock::new(move |image: *mut NSImage, error: *mut NSError| {
                let result = if !error.is_null() || image.is_null() {
                    Err("The system could not capture this window.".into())
                } else {
                    unsafe { (&*image).TIFFRepresentation() }
                        .and_then(|data| NSBitmapImageRep::imageRepWithData(&data))
                        .and_then(|bitmap| unsafe {
                            bitmap.representationUsingType_properties(
                                NSBitmapImageFileType::PNG,
                                &NSDictionary::new(),
                            )
                        })
                        .map(|data| data.to_vec())
                        .ok_or("The screenshot could not be encoded.".into())
                };
                if let Ok(mut pending) = sender.lock() {
                    if let Some(sender) = pending.take() {
                        let _ = sender.send(result);
                    }
                }
            });
            let webview = unsafe { &*(platform.inner() as *mut WKWebView) };
            let configuration = unsafe { WKSnapshotConfiguration::new(webview.mtm()) };
            unsafe {
                configuration.setAfterScreenUpdates(true);
            }
            if let Some(rectangle) = rectangle {
                let bounds = webview.bounds();
                if [
                    rectangle.left,
                    rectangle.top,
                    rectangle.width,
                    rectangle.height,
                ]
                .iter()
                .any(|value| !value.is_finite())
                    || rectangle.left < 0.0
                    || rectangle.top < 0.0
                    || rectangle.width < 1.0
                    || rectangle.height < 1.0
                    || rectangle.left + rectangle.width > bounds.size.width + 0.01
                    || rectangle.top + rectangle.height > bounds.size.height + 0.01
                {
                    completion.call((std::ptr::null_mut(), std::ptr::null_mut()));
                    return;
                }
                unsafe {
                    configuration.setRect(objc2_foundation::NSRect::new(
                        objc2_foundation::NSPoint::new(rectangle.left, rectangle.top),
                        objc2_foundation::NSSize::new(rectangle.width, rectangle.height),
                    ));
                }
            }
            unsafe {
                webview.takeSnapshotWithConfiguration_completionHandler(
                    Some(&configuration),
                    &completion,
                );
            }
        })
        .map_err(|error| error.to_string())?;
    tokio::time::timeout(std::time::Duration::from_secs(10), receiver)
        .await
        .map_err(|_| "The screenshot timed out.".to_string())?
        .map_err(|error| error.to_string())?
}

fn main() {
    let arguments = match configure_profile(std::env::args().skip(1).collect()) {
        Ok(arguments) => arguments,
        Err(error) => {
            eprintln!("{error}");
            std::process::exit(1);
        }
    };
    let mut context = tauri::generate_context!();
    if let Some(profile) = application_profile() {
        context.config_mut().identifier =
            format!("{}.profiles.{profile}", context.config().identifier);
        for window in &mut context.config_mut().app.windows {
            window.incognito = true;
        }
    }
    let directory =
        application_directory().expect("The ink and butter support directory is unavailable.");
    let lock = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .mode(0o600)
        .open(directory.join("instance.lock"))
        .unwrap();
    if unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
        eprintln!("ink and butter is already running.");
        return;
    }
    let socket = socket_path().unwrap();
    if socket.exists() {
        fs::remove_file(&socket).unwrap();
    }
    let listener = std::os::unix::net::UnixListener::bind(&socket)
        .expect("The local control socket could not be opened.");
    fs::set_permissions(&socket, fs::Permissions::from_mode(0o600)).unwrap();
    listener.set_nonblocking(true).unwrap();
    let requested_path = arguments
        .into_iter()
        .find(|argument| !argument.starts_with('-'));
    let events = EventStore::open(&directory).expect("The automation journal could not be opened.");
    let configuration = ConfigurationStore::open(&directory)
        .expect("The ink and butter configuration could not be opened.");
    let builder = tauri::Builder::default().plugin(tauri_plugin_dialog::init());
    #[cfg(not(target_os = "macos"))]
    let builder = builder.plugin(tauri_plugin_notification::init());
    let app = builder
        .plugin(tauri::plugin::Builder::<tauri::Wry>::new("component-navigation")
            .on_navigation(|_, url| {
                matches!(url.scheme(), "tauri" | "inknb-component" | "inknb-preview" | "about")
                    || (cfg!(debug_assertions) && url.scheme() == "http" && url.host_str() == Some("127.0.0.1") && url.port() == Some(1420))
            }).build())
        .register_asynchronous_uri_scheme_protocol("inknb-component", |_, request, responder| {
            tauri::async_runtime::spawn_blocking(move || {
                let result = (|| -> Result<(Vec<u8>, &str), String> {
                    if request.method() != "GET" {
                        return Err("Use GET for component assets.".into());
                    }
                    let path = percent_encoding::percent_decode_str(request.uri().path())
                        .decode_utf8()
                        .map_err(|error| error.to_string())?;
                    if path == "/runtime/v1.js" {
                        return Ok((
                            include_bytes!("../../component-runtime/runtime.js").to_vec(),
                            "text/javascript",
                        ));
                    }
                    let (identity, file) = path
                        .trim_start_matches('/')
                        .split_once('/')
                        .ok_or("Unknown component asset.")?;
                    if Path::new(file)
                        .components()
                        .any(|part| !matches!(part, std::path::Component::Normal(_)))
                    {
                        return Err("Invalid component asset path.".into());
                    }
                    let bundle = inknb_core::components::load(&application_directory()?, identity)?;
                    let bytes = bundle
                        .files
                        .get(file)
                        .ok_or("Unknown component asset.")?
                        .clone();
                    let mime = match Path::new(file)
                        .extension()
                        .and_then(|extension| extension.to_str())
                        .unwrap_or_default()
                    {
                        "html" => "text/html; charset=utf-8",
                        "js" | "mjs" => "text/javascript",
                        "css" => "text/css",
                        "svg" => "image/svg+xml",
                        "png" => "image/png",
                        "jpg" | "jpeg" => "image/jpeg",
                        "webp" => "image/webp",
                        "woff2" => "font/woff2",
                        "json" => "application/json",
                        _ => "application/octet-stream",
                    };
                    if file == bundle.manifest.entry {
                        let mut html = br#"<!doctype html><script src="inknb-component://localhost/runtime/v1.js"></script>"#.to_vec();
                        html.extend(bytes);
                        return Ok((html, mime));
                    }
                    Ok((bytes, mime))
                })();
                let (status, bytes, mime) = match result {
                    Ok((bytes, mime)) => (200, bytes, mime),
                    Err(_) => (404, b"Component unavailable".to_vec(), "text/plain"),
                };
                let response = tauri::http::Response::builder().status(status)
                .header("Content-Type", mime)
                .header("Access-Control-Allow-Origin", "*")
                .header("X-Content-Type-Options", "nosniff")
                .header("Content-Security-Policy", "default-src 'none'; script-src inknb-component: 'unsafe-inline'; style-src inknb-component: 'unsafe-inline'; img-src inknb-component: data: blob:; font-src inknb-component: data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; sandbox allow-scripts")
                .body(bytes).unwrap();
                responder.respond(response);
            });
        })
        .register_asynchronous_uri_scheme_protocol("inknb-preview", |_, request, responder| {
            tauri::async_runtime::spawn_blocking(move || {
                let runtime = include_bytes!("../../preview-runtime/runtime.js");
                let runtime_path = format!("/runtime/{}.js", inknb_core::storage::fingerprint(runtime));
                let result = (|| -> Result<(Vec<u8>, &str), String> {
                    if request.method() != "GET" {
                        return Err("Use GET for preview assets.".into());
                    }
                    let path = percent_encoding::percent_decode_str(request.uri().path())
                        .decode_utf8().map_err(|error| error.to_string())?;
                    if path == runtime_path {
                        return Ok((runtime.to_vec(), "text/javascript"));
                    }
                    let (identity, name) = path.trim_start_matches('/').split_once('/')
                        .ok_or("Unknown preview asset.")?;
                    let directory = application_directory()?;
                    let record = inknb_core::previews::load(&directory, identity)?;
                    let mut bytes = inknb_core::previews::asset(&directory, identity, name)?;
                    let mime = match Path::new(name).extension().and_then(|extension| extension.to_str()).unwrap_or_default() {
                        "html" => "text/html; charset=utf-8",
                        "css" => "text/css",
                        "js" | "mjs" => "text/javascript",
                        "svg" => "image/svg+xml",
                        "png" => "image/png",
                        "jpg" | "jpeg" => "image/jpeg",
                        "webp" => "image/webp",
                        "gif" => "image/gif",
                        "woff" => "font/woff",
                        "woff2" => "font/woff2",
                        "ttf" => "font/ttf",
                        "otf" => "font/otf",
                        "pdf" => "application/pdf",
                        "json" => "application/json",
                        _ => "text/plain; charset=utf-8",
                    };
                    if name == record.manifest.entry && matches!(record.manifest.kind, inknb_core::previews::PreviewKind::Html) {
                        let mut rendered = format!(r#"<!doctype html><script src="inknb-preview://localhost{runtime_path}"></script>"#).into_bytes();
                        rendered.append(&mut bytes);
                        bytes = rendered;
                    }
                    Ok((bytes, mime))
                })();
                let (status, bytes, mime) = match result {
                    Ok((bytes, mime)) => (200, bytes, mime),
                    Err(_) => (404, b"Preview unavailable".to_vec(), "text/plain"),
                };
                let response = tauri::http::Response::builder().status(status)
                    .header("Content-Type", mime)
                    .header("Access-Control-Allow-Origin", "*")
                    .header("X-Content-Type-Options", "nosniff")
                    .header("Content-Security-Policy", "default-src 'none'; script-src inknb-preview: 'unsafe-inline'; style-src inknb-preview: 'unsafe-inline'; img-src inknb-preview: data: blob:; font-src inknb-preview: data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; sandbox allow-scripts")
                    .body(bytes).unwrap();
                responder.respond(response);
            });
        })
        .manage(DesktopState {
            directory,
            persistence: Mutex::new(()),
            configuration: Mutex::new(configuration),
            events: Mutex::new(events),
            event_notification: tokio::sync::Notify::new(),
            pending: Mutex::new(HashMap::new()),
            open_path: Mutex::new(requested_path),
            focused_window: Mutex::new(None),
            host_lifecycle: Mutex::new(space_windows::HostLifecycle { phase: space_windows::HostPhase::NativeStarting, message: None }),
            ready_windows: Mutex::new(HashSet::new()),
            window_ready: tokio::sync::Notify::new(),
            _lock: lock,
        })
        .manage(Mutex::new(HashMap::<String, WindowChrome>::new()))
        .invoke_handler(tauri::generate_handler![
            space_windows::host_lifecycle,
            space_windows::host_request,
            space_windows::host_changed,
            space_windows::space_window_open,
            space_windows::space_window_focused,
            space_windows::space_window_ready,
            space_windows::space_window_control,
            space_windows::request_quit,
            space_windows::host_quit,
            activity::activity_read,
            activity::activity_ack,
            activity::activity_dismiss_all,
            activity::activity_thread_read,
            activity::activity_seed,
            activity::activity_issue,
            activity::activity_background,
            activity::activity_show,
            preview_window::preview_window_open,
            preview_window::preview_window_state,
            preview_window::preview_window_action,
            preview_window::preview_window_result,
            preview_window::preview_window_close,
            window_chrome::window_chrome,
            bootstrap,
            component_info,
            register_preview,
            register_markdown_preview,
            preview_capture,
            preview_capture_read,
            document_capture,
            images::image_import,
            images::image_read,
            preview_info,
            preview_file,
            read_document,
            write_recovery,
            publish_events,
            persist_document,
            move_document,
            discard_recovery,
            configuration_read,
            configuration_placement,
            configuration_font_size,
            remember_document,
            store_library,
            allocate_document,
            inspect_files,
            source_fingerprint,
            relative_asset_path,
            preview_assets,
            images::image_copy,
            images::image_export,
            open_reference,
            link_preview,
            editing_action,
            clipboard_write,
            deliver_codex,
            history_read,
            revision_read,
            delivery_receipts,
            reset_delivery,
            complete_control
        ])
        .setup(move |app| {
            activity::start(app.handle())?;
            use tauri::menu::{MenuBuilder, MenuItem, PredefinedMenuItem, SubmenuBuilder};
            let new = MenuItem::with_id(app, "new", "New", true, None::<&str>)?;
            let open = MenuItem::with_id(app, "open", "Open…", true, None::<&str>)?;
            let save = MenuItem::with_id(app, "save", "Save", true, None::<&str>)?;
            let save_as =
                MenuItem::with_id(app, "save-as", "Save As…", true, None::<&str>)?;
            let comment =
                MenuItem::with_id(app, "comment", "Add aside", true, None::<&str>)?;
            let focus =
                MenuItem::with_id(app, "focus", "Focus Mode", true, None::<&str>)?;
            let application = SubmenuBuilder::new(app, "ink and butter")
                .item(&PredefinedMenuItem::about(
                    app,
                    Some("About ink and butter"),
                    None,
                )?)
                .separator()
                .item(&PredefinedMenuItem::hide(app, None)?)
                .item(&PredefinedMenuItem::hide_others(app, None)?)
                .separator()
                .item(&MenuItem::with_id(
                    app,
                    "close",
                    "Quit ink and butter",
                    true,
                    None::<&str>,
                )?)
                .build()?;
            let file = SubmenuBuilder::new(app, "File")
                .items(&[&new, &open, &save, &save_as])
                .item(&MenuItem::with_id(app, "window-close", "Close Window", true, None::<&str>)?)
                .item(&MenuItem::with_id(app, "preview", "Open Published Output", true, None::<&str>)?)
                .build()?;
            let edit = SubmenuBuilder::new(app, "Edit")
                .item(&MenuItem::with_id(app, "undo", "Undo", true, None::<&str>)?)
                .item(&MenuItem::with_id(app, "redo", "Redo", true, None::<&str>)?)
                .separator()
                .item(&MenuItem::with_id(app, "cut", "Cut", true, None::<&str>)?)
                .item(&MenuItem::with_id(app, "copy", "Copy", true, None::<&str>)?)
                .item(&MenuItem::with_id(app, "paste", "Paste", true, None::<&str>)?)
                .item(&MenuItem::with_id(app, "select-all", "Select All", true, None::<&str>)?)
                .separator()
                .item(&MenuItem::with_id(app, "find", "Find…", true, None::<&str>)?)
                .item(&comment)
                .item(&MenuItem::with_id(app, "selection-comment", "Send Selection as Aside", true, None::<&str>)?)
                .item(&MenuItem::with_id(app, "comment-document", "Add file aside", true, None::<&str>)?)
                .item(&MenuItem::with_id(app, "comment-region", "Comment on Region…", true, None::<&str>)?)
                .item(&MenuItem::with_id(app, "resolve-asides", "Resolve All Asides", true, None::<&str>)?)
                .item(&MenuItem::with_id(app, "accept-asides", "Accept All Suggestions", true, None::<&str>)?)
                .build()?;
            let view = SubmenuBuilder::new(app, "View")
                .item(&MenuItem::with_id(app, "commands", "Commands…", true, None::<&str>)?)
                .item(&MenuItem::with_id(app, "project-search", "Search Project…", true, None::<&str>)?)
                .item(&MenuItem::with_id(app, "sidebar", "Toggle Library", true, None::<&str>)?)
                .separator()
                .item(&MenuItem::with_id(app, "text-larger", "Larger Text", true, None::<&str>)?)
                .item(&MenuItem::with_id(app, "text-smaller", "Smaller Text", true, None::<&str>)?)
                .item(&MenuItem::with_id(app, "text-reset", "Default Text Size", true, None::<&str>)?)
                .separator()
                .item(&MenuItem::with_id(app, "activity", "Activity", true, None::<&str>)?)
                .item(&focus)
                .separator()
                .item(&PredefinedMenuItem::fullscreen(app, None)?)
                .build()?;
            app.set_menu(
                MenuBuilder::new(app)
                    .items(&[&application, &file, &edit, &view])
                    .build()?,
            )?;
            keyboard::apply(app.handle(), &app.state::<DesktopState>().configuration.lock().map_err(|error|error.to_string())?.snapshot().effective)?;
            app.on_menu_event(|app, event| {
                let editing = match event.id().as_ref() { "cut" => Some(EditingAction::Cut), "copy" => Some(EditingAction::Copy), "paste" => Some(EditingAction::Paste), "select-all" => Some(EditingAction::SelectAll), _ => None };
                if let Some(action) = editing {
                    if let Some(window) = app.webview_windows().into_values().find(|window|window.is_focused().unwrap_or(false)) { let _ = editing_action(window, action); }
                    return;
                }
                if ["comment", "comment-document", "resolve-asides", "window-close", "undo", "redo", "find"].contains(&event.id().as_ref()) {
                    if let Some(window) = app.webview_windows().values().find(|window| window.label() == "preview" && window.is_focused().unwrap_or(false)) {
                        let _ = window.emit_to(window.label(), "inknb-preview-menu", event.id().as_ref());
                        return;
                    }
                }
                if let Ok(window) = space_windows::writing_window(app) {
                    let _ = window.emit_to(window.label(), "inknb-menu", event.id().as_ref());
                } else if event.id().as_ref() == "close" {
                    let _ = app.emit_to("host", "inknb-quit", ());
                } else if event.id().as_ref() == "new" {
                    let _ = app.emit_to("host", "inknb-open-default", ());
                }
            });
            let configuration_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let mut interval = tokio::time::interval(std::time::Duration::from_millis(500));
                loop {
                    interval.tick().await;
                    let _ = configuration_read(configuration_handle.clone());
                }
            });
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let listener = tokio::net::UnixListener::from_std(listener).unwrap();
                while let Ok((stream, _)) = listener.accept().await {
                    let credentials = stream.peer_cred();
                    if credentials
                        .map(|credentials| credentials.uid() != unsafe { libc::geteuid() })
                        .unwrap_or(true)
                    {
                        continue;
                    }
                    let handle = handle.clone();
                    tauri::async_runtime::spawn(async move {
                        let _ = serve_connection(handle, stream).await;
                    });
                }
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "host" { api.prevent_close(); }
                if window.label().starts_with("writing-") {
                    api.prevent_close();
                    let _ = window.emit_to(window.label(), "inknb-window-close", ());
                }
            }
            if let tauri::WindowEvent::Destroyed = event {
                window.state::<DesktopState>().ready_windows.lock().unwrap().remove(window.label());
                window
                    .state::<Mutex<HashMap<String, WindowChrome>>>()
                    .lock()
                    .unwrap()
                    .remove(window.label());
                if window.label() == "preview" {
                    let _ = window.emit_to("host", "inknb-preview-action", json!({ "documentId": null, "action": { "kind": "closed" } }));
                }

            }
        })
        .build(context)
        .expect("ink and butter could not start.");
    let mut observers: Option<window_chrome::NativeObservers> = None;
    app.run(move |handle, event| match event {
        tauri::RunEvent::Ready => {
            use block2::RcBlock;
            use objc2::rc::Retained;
            use objc2_app_kit::{
                NSWindow, NSWindowDidChangeBackingPropertiesNotification,
                NSWindowDidEnterFullScreenNotification, NSWindowDidExitFullScreenNotification,
                NSWindowDidResizeNotification, NSWindowStyleMask,
                NSWindowWillEnterFullScreenNotification, NSWindowWillExitFullScreenNotification,
            };
            use objc2_foundation::{NSNotification, NSNotificationCenter, NSOperationQueue};

            let window = handle
                .get_webview_window("host")
                .expect("The writing window is unavailable.");
            let native = unsafe {
                Retained::retain(
                    window
                        .ns_window()
                        .expect("The native window is unavailable.")
                        as *mut NSWindow,
                )
            }
            .expect("The native window is unavailable.");
            let mode = if native.styleMask().contains(NSWindowStyleMask::FullScreen) {
                WindowMode::Fullscreen
            } else {
                WindowMode::Windowed
            };
            window_chrome::synchronize(&native, &window, mode)
                .expect("Window controls could not be measured.");
            let center = NSNotificationCenter::defaultCenter();
            let notifications = unsafe {
                [
                    (
                        NSWindowWillEnterFullScreenNotification,
                        Some(WindowMode::EnteringFullscreen),
                    ),
                    (
                        NSWindowDidEnterFullScreenNotification,
                        Some(WindowMode::Fullscreen),
                    ),
                    (
                        NSWindowWillExitFullScreenNotification,
                        Some(WindowMode::ExitingFullscreen),
                    ),
                    (
                        NSWindowDidExitFullScreenNotification,
                        Some(WindowMode::Windowed),
                    ),
                    (NSWindowDidResizeNotification, None),
                    (NSWindowDidChangeBackingPropertiesNotification, None),
                ]
            };
            let mut tokens = Vec::new();
            for (notification, transition) in notifications {
                let handle = handle.clone();
                let callback =
                    RcBlock::new(move |notification: std::ptr::NonNull<NSNotification>| {
                        let Some(object) = (unsafe { notification.as_ref() }).object() else {
                            return;
                        };
                        for window in handle.webview_windows().values() {
                            let Ok(pointer) = window.ns_window() else {
                                continue;
                            };
                            if pointer != Retained::as_ptr(&object) as *mut std::ffi::c_void {
                                continue;
                            }
                            let observed = unsafe { &*(pointer as *mut NSWindow) };
                            let mode = transition.unwrap_or_else(|| {
                                window
                                    .state::<Mutex<HashMap<String, WindowChrome>>>()
                                    .lock()
                                    .unwrap()
                                    .get(window.label())
                                    .map(|chrome| chrome.mode)
                                    .unwrap_or(WindowMode::Windowed)
                            });
                            let _ = window_chrome::synchronize(observed, window, mode);
                        }
                    });
                tokens.push(unsafe {
                    center.addObserverForName_object_queue_usingBlock(
                        Some(notification),
                        None,
                        Some(&NSOperationQueue::mainQueue()),
                        &callback,
                    )
                });
            }
            observers = Some(window_chrome::NativeObservers { center, tokens });
        }
        tauri::RunEvent::Reopen {
            has_visible_windows: false,
            ..
        } => {
            let _ = handle.emit_to("host", "inknb-open-default", ());
        }
        tauri::RunEvent::Exit => {
            observers.take();
        }
        tauri::RunEvent::Opened { urls } => {
            if let Some(path) = urls.first().and_then(|url| {
                if url.scheme() == "inknb" && url.host_str() == Some("aside") {
                    return Some(url.to_string());
                }
                url.to_file_path()
                    .ok()
                    .map(|path| path.to_string_lossy().into_owned())
            }) {
                if let Ok(mut pending) = handle.state::<DesktopState>().open_path.lock() {
                    *pending = Some(path.clone());
                }
                let _ = handle.emit_to("host", "inknb-open", path);
            }
        }
        _ => {}
    });
}
