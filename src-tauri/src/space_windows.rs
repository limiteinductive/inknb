use crate::{ControlRequest, DesktopState};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{Emitter, Manager, State};

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum HostPhase {
    NativeStarting,
    LoadingCode,
    Starting,
    LoadingDocuments,
    DocumentsReady,
    Ready,
    Failed,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostLifecycle {
    pub phase: HostPhase,
    pub message: Option<String>,
}

#[tauri::command]
pub fn host_lifecycle(
    window: tauri::WebviewWindow,
    state: State<DesktopState>,
    status: HostLifecycle,
) -> Result<(), String> {
    if window.label() != "host" {
        return Err("Only the document host owns its lifecycle.".into());
    }
    if matches!(status.phase, HostPhase::Failed) {
        window.show().map_err(|error| error.to_string())?;
    }
    *state
        .host_lifecycle
        .lock()
        .map_err(|error| error.to_string())? = status;
    Ok(())
}

pub fn writing_window(app: &tauri::AppHandle) -> Result<tauri::WebviewWindow, String> {
    let focused = app
        .state::<DesktopState>()
        .focused_window
        .lock()
        .map_err(|error| error.to_string())?
        .clone();
    focused
        .and_then(|label| app.get_webview_window(&label))
        .or_else(|| {
            app.webview_windows()
                .into_values()
                .find(|window| window.label().starts_with("writing-"))
        })
        .ok_or("No writing window is open.".into())
}

pub fn window_for_identity(
    app: &tauri::AppHandle,
    identity: Option<uuid::Uuid>,
) -> Result<tauri::WebviewWindow, String> {
    match identity {
        Some(identity) => app
            .get_webview_window(&format!("writing-{identity}"))
            .ok_or("This writing window is closed.".into()),
        None => writing_window(app),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowBounds {
    left: Option<f64>,
    top: Option<f64>,
    width: f64,
    height: f64,
}

#[tauri::command]
pub async fn host_request(window: tauri::WebviewWindow, request: Value) -> Result<Value, String> {
    let identity = window
        .label()
        .strip_prefix("writing-")
        .ok_or("This window cannot send writing requests.")?;
    uuid::Uuid::parse_str(identity).map_err(|error| error.to_string())?;
    let request_id = uuid::Uuid::new_v4().to_string();
    let (sender, receiver) = tokio::sync::oneshot::channel();
    window
        .state::<DesktopState>()
        .pending
        .lock()
        .map_err(|error| error.to_string())?
        .insert(request_id.clone(), sender);
    window
        .emit_to(
            "host",
            "inknb-host-request",
            json!({ "id": request_id, "windowId": identity, "request": request }),
        )
        .map_err(|error| error.to_string())?;
    let response = tokio::time::timeout(std::time::Duration::from_secs(25), receiver).await;
    window
        .state::<DesktopState>()
        .pending
        .lock()
        .map_err(|error| error.to_string())?
        .remove(&request_id);
    match response {
        Ok(Ok(result)) => result,
        _ => Err("The document host did not respond. Your window keeps its pending text.".into()),
    }
}

#[tauri::command]
pub fn host_changed(window: tauri::WebviewWindow) -> Result<(), String> {
    if window.label() != "host" {
        return Err("Only the document host publishes changes.".into());
    }
    for writer in window
        .app_handle()
        .webview_windows()
        .values()
        .filter(|writer| writer.label().starts_with("writing-"))
    {
        writer
            .emit_to(writer.label(), "inknb-host-changed", ())
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn space_window_open(
    window: tauri::WebviewWindow,
    identity: String,
    title: String,
    bounds: WindowBounds,
) -> Result<(), String> {
    if window.label() != "host" {
        return Err("Only the document host opens writing windows.".into());
    }
    uuid::Uuid::parse_str(&identity).map_err(|error| error.to_string())?;
    let label = format!("writing-{identity}");
    if let Some(writer) = window.app_handle().get_webview_window(&label) {
        writer.unminimize().map_err(|error| error.to_string())?;
        writer.show().map_err(|error| error.to_string())?;
        return writer.set_focus().map_err(|error| error.to_string());
    }
    let mut builder = tauri::WebviewWindowBuilder::from_config(
        window.app_handle(),
        &crate::window_chrome::configuration(label),
    )
    .map_err(|error| error.to_string())?
    .title(format!("{title} · ink and butter"))
    .incognito(inknb_core::profile::application_profile().is_some())
    .inner_size(bounds.width.max(700.0), bounds.height.max(480.0))
    .min_inner_size(700.0, 480.0)
    .disable_drag_drop_handler();
    if let (Some(left), Some(top)) = (bounds.left, bounds.top) {
        builder = builder.position(left, top);
    }
    builder.build().map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn space_window_ready(
    window: tauri::WebviewWindow,
    state: State<DesktopState>,
) -> Result<(), String> {
    if !window.label().starts_with("writing-") {
        return Err("This window is not a writing window.".into());
    }
    state
        .ready_windows
        .lock()
        .map_err(|error| error.to_string())?
        .insert(window.label().into());
    state.window_ready.notify_waiters();
    Ok(())
}

#[tauri::command]
pub fn space_window_focused(
    window: tauri::WebviewWindow,
    state: State<DesktopState>,
) -> Result<(), String> {
    let Some(identity) = window.label().strip_prefix("writing-") else {
        return Ok(());
    };
    *state
        .focused_window
        .lock()
        .map_err(|error| error.to_string())? = Some(window.label().into());
    window
        .emit_to("host", "inknb-space-focused", identity)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn space_window_control(
    window: tauri::WebviewWindow,
    identity: String,
    method: String,
    parameters: Value,
) -> Result<Value, String> {
    if window.label() != "host" {
        return Err("Only the document host routes window actions.".into());
    }
    uuid::Uuid::parse_str(&identity).map_err(|error| error.to_string())?;
    crate::dispatch_to(
        window.app_handle(),
        &format!("writing-{identity}"),
        ControlRequest {
            agent_id: None,
            version: 1,
            id: uuid::Uuid::new_v4().to_string(),
            method,
            params: parameters,
        },
    )
    .await
}

#[tauri::command]
pub fn request_quit(window: tauri::WebviewWindow) -> Result<(), String> {
    let app = window.app_handle().clone();
    tauri::async_runtime::spawn(async move {
        for writer in app
            .webview_windows()
            .values()
            .filter(|writer| writer.label().starts_with("writing-"))
        {
            let result = crate::dispatch_to(
                &app,
                writer.label(),
                ControlRequest {
                    agent_id: None,
                    version: 1,
                    id: uuid::Uuid::new_v4().to_string(),
                    method: "window_flush".into(),
                    params: json!({ "closing": true }),
                },
            )
            .await;
            if let Err(error) = result {
                for target in app
                    .webview_windows()
                    .values()
                    .filter(|target| target.label().starts_with("writing-"))
                {
                    let _ = target.emit_to(target.label(), "inknb-quit-error", &error);
                }
                return;
            }
        }
        let result = crate::dispatch_to(
            &app,
            "host",
            ControlRequest {
                agent_id: None,
                version: 1,
                id: uuid::Uuid::new_v4().to_string(),
                method: "application_quit".into(),
                params: json!({}),
            },
        )
        .await;
        if let Err(error) = result {
            for target in app
                .webview_windows()
                .values()
                .filter(|target| target.label().starts_with("writing-"))
            {
                let _ = target.emit_to(target.label(), "inknb-quit-error", &error);
            }
        }
    });
    Ok(())
}

#[tauri::command]
pub fn host_quit(window: tauri::WebviewWindow) -> Result<(), String> {
    if window.label() != "host" {
        return Err("Only the document host can finish quitting.".into());
    }
    window.app_handle().exit(0);
    Ok(())
}
