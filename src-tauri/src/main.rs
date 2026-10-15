use base64::Engine;
use inknb_core::protocol::{socket_path, ControlRequest, ControlResponse};
use inknb_core::storage::{
    application_directory, atomic_write, file_hash, load_document, save_document, sidecar_path,
    store_recovery, LoadedDocument, SavedDocument, Snapshot,
};
use serde::Serialize;
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

type PendingResult = oneshot::Sender<Result<Value, String>>;

struct DesktopState {
    directory: PathBuf,
    persistence: Mutex<()>,
    pending: Mutex<HashMap<String, PendingResult>>,
    open_path: Mutex<Option<String>>,
    _lock: File,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Bootstrap {
    preferences: Option<Value>,
    recovery: Option<Snapshot>,
    last_path: Option<String>,
    command_path: String,
    codex_path: Option<String>,
    socket_path: String,
}

#[tauri::command]
fn bootstrap(state: State<DesktopState>) -> Result<Bootstrap, String> {
    let read = |name: &str| -> Result<Option<Value>, String> {
        let path = state.directory.join(name);
        if !path.exists() {
            return Ok(None);
        }
        serde_json::from_slice(&fs::read(path).map_err(|error| error.to_string())?)
            .map(Some)
            .map_err(|error| format!("Could not read {name}: {error}"))
    };
    let recovery = read("recovery.json")?
        .map(serde_json::from_value)
        .transpose()
        .map_err(|error| error.to_string())?;
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
        last_path: requested_path.or(stored_path),
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
async fn read_document(path: String) -> Result<LoadedDocument, String> {
    tauri::async_runtime::spawn_blocking(move || load_document(Path::new(&path)))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
fn write_recovery(state: State<DesktopState>, snapshot: Snapshot) -> Result<(), String> {
    let _guard = state
        .persistence
        .lock()
        .map_err(|error| error.to_string())?;
    store_recovery(&state.directory, &snapshot)
}

#[tauri::command]
fn persist_document(
    state: State<DesktopState>,
    snapshot: Snapshot,
) -> Result<SavedDocument, String> {
    let _guard = state
        .persistence
        .lock()
        .map_err(|error| error.to_string())?;
    save_document(&state.directory, &snapshot)
}

#[tauri::command]
fn discard_recovery(state: State<DesktopState>) -> Result<(), String> {
    let _guard = state
        .persistence
        .lock()
        .map_err(|error| error.to_string())?;
    let path = state.directory.join("recovery.json");
    if path.exists() {
        fs::remove_file(path).map_err(|error| error.to_string())?;
    }
    Ok(())
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
    command_path: String,
    session_id: String,
    message: String,
) -> Result<(), String> {
    if !Path::new(&command_path).is_absolute() || !Path::new(&command_path).is_file() {
        return Err("Choose the installed Codex executable in connection settings.".into());
    }
    uuid::Uuid::parse_str(&session_id).map_err(|_| "Enter the exact Codex session UUID.")?;
    let result = tauri::async_runtime::spawn_blocking(move || {
        std::process::Command::new(command_path)
            .args(["queue", "--thread", &session_id, "--message", &message])
            .output()
    })
    .await
    .map_err(|error| error.to_string())?
    .map_err(|error| error.to_string())?;
    if !result.status.success() {
        return Err(format!(
            "Codex could not queue this request: {}",
            String::from_utf8_lossy(&result.stderr)
                .chars()
                .take(1200)
                .collect::<String>()
        ));
    }
    Ok(())
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
    if request.id.len() > 80 {
        return Err("Invalid request identity.".into());
    }
    let identity = request.id.clone();
    let method = request.method.clone();
    let result = if method == "window_show" {
        if request.params != json!({}) {
            Err("This tool takes no parameters.".into())
        } else {
            app.get_webview_window("main")
                .ok_or("The writing window is unavailable.".to_string())
                .and_then(|window| {
                    window.unminimize().map_err(|error| error.to_string())?;
                    window.show().map_err(|error| error.to_string())?;
                    window.set_focus().map_err(|error| error.to_string())?;
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
    };
    let response = match result {
        Ok(result) => ControlResponse {
            id: identity,
            result: Some(result),
            error: None,
        },
        Err(error) => ControlResponse {
            id: identity,
            result: None,
            error: Some(error),
        },
    };
    let bytes = serde_json::to_vec(&response).map_err(|error| error.to_string())?;
    writer
        .write_all(&bytes)
        .await
        .map_err(|error| error.to_string())?;
    writer
        .write_all(b"\n")
        .await
        .map_err(|error| error.to_string())?;
    Ok(())
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
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(DesktopState {
            directory,
            persistence: Mutex::new(()),
            pending: Mutex::new(HashMap::new()),
            open_path: Mutex::new(requested_path),
            _lock: lock,
        })
        .invoke_handler(tauri::generate_handler![
            bootstrap,
            read_document,
            write_recovery,
            persist_document,
            discard_recovery,
            store_preferences,
            remember_document,
            inspect_files,
            source_fingerprint,
            relative_asset_path,
            preview_assets,
            open_reference,
            deliver_codex,
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
            let view = SubmenuBuilder::new(app, "View").item(&focus).build()?;
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
    app.run(|handle, event| {
        if let tauri::RunEvent::Opened { urls } = event {
            if let Some(path) = urls.first().and_then(|url| url.to_file_path().ok()) {
                let path = path.to_string_lossy().into_owned();
                if let Ok(mut pending) = handle.state::<DesktopState>().open_path.lock() {
                    *pending = Some(path.clone());
                }
                let _ = handle.emit_to("main", "inknb-open", path);
            }
        }
    });
}
