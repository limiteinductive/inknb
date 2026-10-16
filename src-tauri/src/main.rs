use base64::Engine;
use inknb_core::events::{EventInput, EventQuery, EventStore};
use inknb_core::protocol::{socket_path, ControlRequest, ControlResponse};
use inknb_core::storage::{
    application_directory, atomic_write, file_hash, load_document, recovery_path, save_document,
    sidecar_path, store_recovery, LoadedDocument, SavedDocument, Snapshot,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::os::fd::AsRawFd;
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tauri::{Emitter, Manager, State};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::sync::oneshot;
mod window_chrome;
use window_chrome::{WindowChrome, WindowMode, TOOLBAR_HEIGHT};

type PendingResult = oneshot::Sender<Result<Value, String>>;

struct DesktopState {
    directory: PathBuf,
    persistence: Mutex<()>,
    events: Mutex<EventStore>,
    event_notification: tokio::sync::Notify,
    pending: Mutex<HashMap<String, PendingResult>>,
    open_path: Mutex<Option<String>>,
    _lock: File,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Bootstrap {
    preferences: Option<Value>,
    recovery: Option<Snapshot>,
    recoveries: Vec<Snapshot>,
    library: Option<Value>,
    last_path: Option<String>,
    requested_path: Option<String>,
    command_path: String,
    codex_path: Option<String>,
    socket_path: String,
}

#[tauri::command]
fn bootstrap(state: State<DesktopState>) -> Result<Bootstrap, String> {
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
            .append(&snapshot.events)?;
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
    Ok(Bootstrap {
        preferences: read("preferences.json")?,
        recovery,
        recoveries,
        library: read("library.json")?,
        last_path: requested_path.clone().or(stored_path),
        requested_path,
        command_path: executable
            .with_file_name("inknb")
            .to_string_lossy()
            .into_owned(),
        codex_path: find_executable("codex"),
        socket_path: socket_path()?.to_string_lossy().into_owned(),
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
        store_recovery(&state.directory, &snapshot)?;
        state
            .events
            .lock()
            .map_err(|error| error.to_string())?
            .append(&snapshot.events)?;
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
        store_recovery(&state.directory, &snapshot)?;
        state
            .events
            .lock()
            .map_err(|error| error.to_string())?
            .append(&snapshot.events)?;
        state.event_notification.notify_waiters();
        let saved = save_document(&state.directory, &snapshot)?;
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
fn discard_recovery(state: State<DesktopState>, document_id: String) -> Result<(), String> {
    let _guard = state
        .persistence
        .lock()
        .map_err(|error| error.to_string())?;
    let path = recovery_path(&state.directory, &json!({"documentId": document_id}))?;
    if path.exists() {
        fs::remove_file(path).map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn store_library(state: State<DesktopState>, library: Value) -> Result<(), String> {
    atomic_write(
        &state.directory.join("library.json"),
        &serde_json::to_vec_pretty(&library).map_err(|error| error.to_string())?,
    )
}

#[tauri::command]
fn allocate_document(state: State<DesktopState>, document_id: String) -> Result<String, String> {
    let identity = uuid::Uuid::parse_str(&document_id).map_err(|error| error.to_string())?;
    let directory = state.directory.join("documents");
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    Ok(directory
        .join(format!("{identity}.txt"))
        .to_string_lossy()
        .into_owned())
}

#[tauri::command]
fn store_preferences(state: State<DesktopState>, preferences: Value) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(&preferences).map_err(|error| error.to_string())?;
    atomic_write(&state.directory.join("preferences.json"), &bytes)
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

#[tauri::command]
fn open_reference(document_path: Option<String>, reference: String) -> Result<(), String> {
    let destination = match tauri::Url::parse(&reference) {
        Ok(url) if matches!(url.scheme(), "http" | "https") => url.to_string(),
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
    result: Option<Value>,
    error: Option<String>,
) -> Result<(), String> {
    if let Some(sender) = state
        .pending
        .lock()
        .map_err(|error| error.to_string())?
        .remove(&request_id)
    {
        let response =
            result.ok_or_else(|| error.unwrap_or("The editor returned no result.".into()));
        let _ = sender.send(response);
    }
    Ok(())
}

async fn dispatch(app: &tauri::AppHandle, request: ControlRequest) -> Result<Value, String> {
    let (sender, receiver) = oneshot::channel();
    let state = app.state::<DesktopState>();
    state
        .pending
        .lock()
        .map_err(|error| error.to_string())?
        .insert(request.id.clone(), sender);
    app.emit_to("main", "inknb-control", &request)
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
        if method == "protocol_info" {
            if request.params != json!({}) {
                return Err("This tool takes no parameters.".into());
            }
            Ok(
                json!({"version":1,"transport":"unix-json-lines","socketPath":socket_path()?,"eventDelivery":"at-least-once","streamMethod":"events_subscribe","componentGuide":include_str!("../../docs/components.md"),"tools":inknb_core::protocol::tools()}),
            )
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
        } else if method == "window_show" {
            if request.params != json!({}) {
                Err("This tool takes no parameters.".into())
            } else {
                app.get_webview_window("main")
                    .ok_or("The writing window is unavailable.".to_string())
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
            }
        } else if method == "screenshot" {
            let mut state_request = request.clone();
            state_request.method = "ui_state".into();
            let mut before = dispatch(&app, state_request.clone()).await?;
            let bytes = capture_window(&app).await?;
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
                    json!({"state":after,"data":base64::engine::general_purpose::STANDARD.encode(bytes)}),
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

async fn capture_window(app: &tauri::AppHandle) -> Result<Vec<u8>, String> {
    use block2::RcBlock;
    use objc2_app_kit::{NSBitmapImageFileType, NSBitmapImageRep, NSImage};
    use objc2_foundation::{NSDictionary, NSError};
    use objc2_web_kit::WKWebView;
    let window = app
        .get_webview_window("main")
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
            unsafe {
                (&*(platform.inner() as *mut WKWebView))
                    .takeSnapshotWithConfiguration_completionHandler(None, &completion);
            }
        })
        .map_err(|error| error.to_string())?;
    tokio::time::timeout(std::time::Duration::from_secs(10), receiver)
        .await
        .map_err(|_| "The screenshot timed out.".to_string())?
        .map_err(|error| error.to_string())?
}

fn main() {
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
    let requested_path = std::env::args()
        .skip(1)
        .find(|argument| !argument.starts_with('-'));
    let events = EventStore::open(&directory).expect("The automation journal could not be opened.");
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri::plugin::Builder::<tauri::Wry>::new("component-navigation")
            .on_navigation(|_, url| {
                matches!(url.scheme(), "tauri" | "inknb-component" | "about")
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
        .manage(DesktopState {
            directory,
            persistence: Mutex::new(()),
            events: Mutex::new(events),
            event_notification: tokio::sync::Notify::new(),
            pending: Mutex::new(HashMap::new()),
            open_path: Mutex::new(requested_path),
            _lock: lock,
        })
        .manage(Mutex::new(WindowChrome {
            mode: WindowMode::Windowed,
            toolbar_height: TOOLBAR_HEIGHT,
            leading_inset: 86.0,
            windowed_controls: Vec::new(),
        }))
        .invoke_handler(tauri::generate_handler![
            window_chrome::window_chrome,
            bootstrap,
            component_info,
            read_document,
            write_recovery,
            publish_events,
            persist_document,
            move_document,
            discard_recovery,
            store_preferences,
            remember_document,
            store_library,
            allocate_document,
            inspect_files,
            source_fingerprint,
            relative_asset_path,
            preview_assets,
            open_reference,
            deliver_codex,
            delivery_receipts,
            reset_delivery,
            complete_control
        ])
        .setup(move |app| {
            use tauri::menu::{MenuBuilder, MenuItem, PredefinedMenuItem, SubmenuBuilder};
            let new = MenuItem::with_id(app, "new", "New", true, Some("CmdOrCtrl+N"))?;
            let open = MenuItem::with_id(app, "open", "Open…", true, Some("CmdOrCtrl+O"))?;
            let save = MenuItem::with_id(app, "save", "Save", true, Some("CmdOrCtrl+S"))?;
            let save_as =
                MenuItem::with_id(app, "save-as", "Save As…", true, Some("CmdOrCtrl+Shift+S"))?;
            let settings =
                MenuItem::with_id(app, "settings", "Settings…", true, Some("CmdOrCtrl+,"))?;
            let comment =
                MenuItem::with_id(app, "comment", "Add aside", true, Some("CmdOrCtrl+Shift+A"))?;
            let focus =
                MenuItem::with_id(app, "focus", "Focus Mode", true, Some("CmdOrCtrl+Shift+F"))?;
            let application = SubmenuBuilder::new(app, "ink and butter")
                .item(&PredefinedMenuItem::about(
                    app,
                    Some("About ink and butter"),
                    None,
                )?)
                .item(&settings)
                .separator()
                .item(&PredefinedMenuItem::hide(app, None)?)
                .item(&PredefinedMenuItem::hide_others(app, None)?)
                .separator()
                .item(&MenuItem::with_id(
                    app,
                    "close",
                    "Quit ink and butter",
                    true,
                    Some("CmdOrCtrl+Q"),
                )?)
                .build()?;
            let file = SubmenuBuilder::new(app, "File")
                .items(&[&new, &open, &save, &save_as])
                .build()?;
            let edit = SubmenuBuilder::new(app, "Edit")
                .item(&PredefinedMenuItem::undo(app, None)?)
                .item(&PredefinedMenuItem::redo(app, None)?)
                .separator()
                .item(&PredefinedMenuItem::cut(app, None)?)
                .item(&PredefinedMenuItem::copy(app, None)?)
                .item(&PredefinedMenuItem::paste(app, None)?)
                .item(&PredefinedMenuItem::select_all(app, None)?)
                .separator()
                .item(&comment)
                .build()?;
            let view = SubmenuBuilder::new(app, "View")
                .item(&focus)
                .separator()
                .item(&PredefinedMenuItem::fullscreen(app, None)?)
                .build()?;
            app.set_menu(
                MenuBuilder::new(app)
                    .items(&[&application, &file, &edit, &view])
                    .build()?,
            )?;
            app.on_menu_event(|app, event| {
                let _ = app.emit_to("main", "inknb-menu", event.id().as_ref());
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
                api.prevent_close();
                let _ = window.emit("inknb-menu", "close");
            }
        })
        .build(tauri::generate_context!())
        .expect("ink and butter could not start.");
    let mut observers: Option<window_chrome::NativeObservers> = None;
    app.run(move |handle, event| match event {
        tauri::RunEvent::Ready => {
            use block2::RcBlock;
            use objc2::rc::Retained;
            use objc2_app_kit::{
                NSWindow, NSWindowDidChangeBackingPropertiesNotification,
                NSWindowDidEnterFullScreenNotification, NSWindowDidExitFullScreenNotification,
                NSWindowDidResizeNotification, NSWindowDidUpdateNotification, NSWindowStyleMask,
                NSWindowWillEnterFullScreenNotification, NSWindowWillExitFullScreenNotification,
            };
            use objc2_foundation::{NSNotification, NSNotificationCenter, NSOperationQueue};

            let window = handle
                .get_webview_window("main")
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
                .expect("Window controls could not be aligned.");
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
                    (NSWindowDidUpdateNotification, None),
                    (NSWindowDidChangeBackingPropertiesNotification, None),
                ]
            };
            let mut tokens = Vec::new();
            for (notification, transition) in notifications {
                let window = window.clone();
                let observed = native.clone();
                let callback = RcBlock::new(move |_: std::ptr::NonNull<NSNotification>| {
                    let mode = transition.unwrap_or_else(|| {
                        window.state::<Mutex<WindowChrome>>().lock().unwrap().mode
                    });
                    let _ = window_chrome::synchronize(&observed, &window, mode);
                });
                tokens.push(unsafe {
                    center.addObserverForName_object_queue_usingBlock(
                        Some(notification),
                        Some(&native),
                        Some(&NSOperationQueue::mainQueue()),
                        &callback,
                    )
                });
            }
            observers = Some(window_chrome::NativeObservers { center, tokens });
        }
        tauri::RunEvent::Exit => {
            observers.take();
        }
        tauri::RunEvent::Opened { urls } => {
            if let Some(path) = urls.first().and_then(|url| url.to_file_path().ok()) {
                let path = path.to_string_lossy().into_owned();
                if let Ok(mut pending) = handle.state::<DesktopState>().open_path.lock() {
                    *pending = Some(path.clone());
                }
                let _ = handle.emit_to("main", "inknb-open", path);
            }
        }
        _ => {}
    });
}
