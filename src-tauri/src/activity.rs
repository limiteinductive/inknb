use crate::DesktopState;
use inknb_core::activity::{ActivityPage, ActivityQuery};
use serde_json::Value;
use tauri::{Emitter, Manager, State};
use tauri_plugin_notification::NotificationExt;
use uuid::Uuid;

#[tauri::command]
pub fn activity_read(
    state: State<DesktopState>,
    query: ActivityQuery,
) -> Result<ActivityPage, String> {
    state
        .events
        .lock()
        .map_err(|error| error.to_string())?
        .read_activity(&query)
}

#[tauri::command]
pub fn activity_ack(state: State<DesktopState>, key: String, cursor: u64) -> Result<(), String> {
    state
        .events
        .lock()
        .map_err(|error| error.to_string())?
        .acknowledge_activity(&key, cursor)?;
    state.event_notification.notify_waiters();
    Ok(())
}

#[tauri::command]
pub fn activity_dismiss_all(
    state: State<DesktopState>,
    through_cursor: u64,
    document_ids: Option<Vec<Uuid>>,
) -> Result<(), String> {
    state
        .events
        .lock()
        .map_err(|error| error.to_string())?
        .dismiss_activity(through_cursor, document_ids.as_deref())?;
    state.event_notification.notify_waiters();
    Ok(())
}

#[tauri::command]
pub fn activity_thread_read(
    state: State<DesktopState>,
    document_id: Uuid,
    thread_id: Uuid,
    cursor: u64,
    message_id: Option<Uuid>,
) -> Result<(), String> {
    state
        .events
        .lock()
        .map_err(|error| error.to_string())?
        .read_thread_activity(document_id, thread_id, cursor, message_id)?;
    state.event_notification.notify_waiters();
    Ok(())
}

#[tauri::command]
pub fn activity_seed(
    state: State<DesktopState>,
    document_id: Uuid,
    metadata: Value,
    unread_threads: Vec<Uuid>,
) -> Result<(), String> {
    if metadata["documentId"].as_str() != Some(&document_id.to_string()) {
        return Err("The activity belongs to a different document.".into());
    }
    state
        .events
        .lock()
        .map_err(|error| error.to_string())?
        .seed_activity(document_id, &metadata, &unread_threads)?;
    state.event_notification.notify_waiters();
    Ok(())
}

#[tauri::command]
pub fn activity_issue(
    state: State<DesktopState>,
    document_id: Option<Uuid>,
    category: String,
    message: String,
    occurred_at: String,
    expected_message: Option<String>,
) -> Result<(), String> {
    state
        .events
        .lock()
        .map_err(|error| error.to_string())?
        .activity_issue(
            document_id,
            &category,
            &message,
            &occurred_at,
            expected_message.as_deref(),
        )?;
    state.event_notification.notify_waiters();
    Ok(())
}

#[tauri::command]
pub fn activity_background(app: tauri::AppHandle, enabled: bool) -> Result<(), String> {
    if enabled {
        app.notification()
            .request_permission()
            .map_err(|error| error.to_string())?;
    }
    let state = app.state::<DesktopState>();
    state
        .events
        .lock()
        .map_err(|error| error.to_string())?
        .background_notifications(enabled)?;
    state.event_notification.notify_waiters();
    Ok(())
}

#[tauri::command]
pub fn activity_show(app: tauri::AppHandle) -> Result<(), String> {
    let window = crate::space_windows::writing_window(&app)?;
    window.show().map_err(|error| error.to_string())?;
    window.set_focus().map_err(|error| error.to_string())?;
    window
        .emit_to(
            window.label(),
            "inknb-activity-open",
            Option::<String>::None,
        )
        .map_err(|error| error.to_string())
}

pub fn start(app: &tauri::AppHandle) -> Result<(), String> {
    let handle = app.clone();
    app.notification()
        .on_action(move |action| {
            if action.action_id() != "tap" {
                return;
            }
            let key = action
                .notification()
                .and_then(|notification| notification.extra().get("activityKey"))
                .and_then(Value::as_str);
            let _ = handle.emit_to("host", "inknb-activity-target", key);
        })
        .map_err(|error| error.to_string())?;
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut permission_requested = false;
        loop {
            let state = handle.state::<DesktopState>();
            state.event_notification.notified().await;
            let _ = handle.emit("inknb-activity", ());
            let decisions_enabled = state
                .configuration
                .lock()
                .map(|configuration| configuration.snapshot().effective.decision_notifications)
                .unwrap_or(false);
            let pending = state
                .events
                .lock()
                .ok()
                .and_then(|store| store.pending_notifications(decisions_enabled).ok())
                .unwrap_or_default();
            if !permission_requested && pending.iter().any(|item| item.kind == "decision") {
                permission_requested = true;
                let _ = handle.notification().request_permission();
            }
            let focused = handle
                .webview_windows()
                .values()
                .any(|window| window.is_focused().unwrap_or(false));
            for item in pending {
                let sent = focused
                    || handle
                        .notification()
                        .builder()
                        .title("ink and butter")
                        .body(&item.title)
                        .extra("activityKey", &item.key)
                        .show()
                        .is_ok();
                if sent {
                    if let Ok(store) = state.events.lock() {
                        let _ = store.notified_activity(&item.key, item.cursor);
                    }
                }
            }
        }
    });
    Ok(())
}
