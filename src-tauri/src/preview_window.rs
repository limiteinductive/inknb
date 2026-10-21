use serde_json::{json, Value};
use tauri::{Emitter, Manager};

#[tauri::command]
pub async fn preview_window_open(
    window: tauri::WebviewWindow,
    title: String,
) -> Result<(), String> {
    if window.label() != "host" {
        return Err("Only the writing window can detach a preview.".into());
    }
    if let Some(preview) = window.app_handle().get_webview_window("preview") {
        preview.unminimize().map_err(|error| error.to_string())?;
        preview.show().map_err(|error| error.to_string())?;
        return preview.set_focus().map_err(|error| error.to_string());
    }
    tauri::WebviewWindowBuilder::from_config(
        window.app_handle(),
        &crate::window_chrome::configuration("preview"),
    )
    .map_err(|error| error.to_string())?
    .title(title)
    .incognito(inknb_core::profile::application_profile().is_some())
    .inner_size(720.0, 860.0)
    .min_inner_size(360.0, 320.0)
    .disable_drag_drop_handler()
    .build()
    .map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn preview_window_state(window: tauri::WebviewWindow, snapshot: Value) -> Result<(), String> {
    if window.label() != "host" {
        return Err("Only the writing window can publish preview state.".into());
    }
    window
        .emit_to("preview", "inknb-preview-state", snapshot)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn preview_window_action(
    window: tauri::WebviewWindow,
    document_id: Option<String>,
    action: Value,
) -> Result<(), String> {
    if window.label() != "preview" {
        return Err("This window does not own a detached preview.".into());
    }
    window
        .emit_to(
            "host",
            "inknb-preview-action",
            json!({ "documentId": document_id, "action": action }),
        )
        .map_err(|error| error.to_string())?;
    if action["kind"] == "aside-action" && action["action"]["kind"] == "source" {
        let writer = crate::space_windows::writing_window(window.app_handle())?;
        writer.unminimize().map_err(|error| error.to_string())?;
        writer.show().map_err(|error| error.to_string())?;
        writer.set_focus().map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn preview_window_close(window: tauri::WebviewWindow) -> Result<(), String> {
    if window.label() != "host" {
        return Err("Only the writing window can close a detached preview.".into());
    }
    if let Some(preview) = window.app_handle().get_webview_window("preview") {
        preview.destroy().map_err(|error| error.to_string())?;
    }
    if let Ok(writer) = crate::space_windows::writing_window(window.app_handle()) {
        writer.show().map_err(|error| error.to_string())?;
        writer.set_focus().map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn preview_window_result(window: tauri::WebviewWindow, response: Value) -> Result<(), String> {
    if window.label() != "host" {
        return Err("Only the writing window can answer aside actions.".into());
    }
    window
        .emit_to("preview", "inknb-aside-result", response)
        .map_err(|error| error.to_string())
}
