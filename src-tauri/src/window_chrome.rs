use objc2::rc::Retained;
use objc2::runtime::ProtocolObject;
use objc2_app_kit::{NSWindow, NSWindowButton, NSWindowStyleMask};
use objc2_foundation::{NSNotificationCenter, NSObjectProtocol};
use serde::Serialize;
use std::collections::HashMap;
use std::sync::Mutex;
use tauri::{Emitter, Manager};

pub const TOOLBAR_HEIGHT: f64 = 52.0;

pub fn configuration(label: impl Into<String>) -> tauri::utils::config::WindowConfig {
    tauri::utils::config::WindowConfig {
        label: label.into(),
        title_bar_style: tauri::TitleBarStyle::Overlay,
        hidden_title: true,
        traffic_light_position: Some(tauri::utils::config::LogicalPosition { x: 20.0, y: 28.0 }),
        ..Default::default()
    }
}

#[derive(Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum WindowMode {
    Windowed,
    EnteringFullscreen,
    Fullscreen,
    ExitingFullscreen,
}

#[derive(Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowControl {
    pub left: f64,
    pub top: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowChrome {
    pub mode: WindowMode,
    pub toolbar_height: f64,
    pub leading_inset: f64,
    pub windowed_controls: Vec<WindowControl>,
}

pub struct NativeObservers {
    pub center: Retained<NSNotificationCenter>,
    pub tokens: Vec<Retained<ProtocolObject<dyn NSObjectProtocol>>>,
}

impl Drop for NativeObservers {
    fn drop(&mut self) {
        for token in &self.tokens {
            unsafe { self.center.removeObserver((**token).as_ref()) };
        }
    }
}

#[tauri::command]
pub async fn window_chrome(window: tauri::WebviewWindow) -> Result<WindowChrome, String> {
    let (sender, receiver) = tokio::sync::oneshot::channel();
    let observed = window.clone();
    window
        .run_on_main_thread(move || {
            let result = (|| {
                let state = observed.state::<Mutex<HashMap<String, WindowChrome>>>();
                let native = observed.ns_window().map_err(|error| error.to_string())?;
                let native = unsafe { &*(native as *mut NSWindow) };
                let mode = state
                    .lock()
                    .map_err(|error| error.to_string())?
                    .get(observed.label())
                    .map(|chrome| chrome.mode)
                    .unwrap_or_else(|| {
                        if native.styleMask().contains(NSWindowStyleMask::FullScreen) {
                            WindowMode::Fullscreen
                        } else {
                            WindowMode::Windowed
                        }
                    });
                synchronize(native, &observed, mode)?;
                let chrome = state
                    .lock()
                    .map_err(|error| error.to_string())?
                    .get(observed.label())
                    .cloned()
                    .ok_or("Missing window layout.")?;
                Ok(chrome)
            })();
            let _ = sender.send(result);
        })
        .map_err(|error| error.to_string())?;
    receiver.await.map_err(|error| error.to_string())?
}

fn controls(native: &NSWindow) -> Result<Vec<WindowControl>, String> {
    let content = native.contentView().ok_or("Missing window content.")?;
    let bounds = content.bounds();
    [
        NSWindowButton::CloseButton,
        NSWindowButton::MiniaturizeButton,
        NSWindowButton::ZoomButton,
    ]
    .into_iter()
    .map(|kind| {
        let button = native
            .standardWindowButton(kind)
            .ok_or("Missing window control.")?;
        let frame = button.convertRect_toView(button.bounds(), Some(&content));
        Ok(WindowControl {
            left: frame.origin.x - bounds.origin.x,
            top: if content.isFlipped() {
                frame.origin.y - bounds.origin.y
            } else {
                bounds.origin.y + bounds.size.height - frame.origin.y - frame.size.height
            },
            width: frame.size.width,
            height: frame.size.height,
        })
    })
    .collect()
}

pub fn synchronize(
    native: &NSWindow,
    window: &tauri::WebviewWindow,
    mode: WindowMode,
) -> Result<(), String> {
    let state = window.state::<Mutex<HashMap<String, WindowChrome>>>();
    let mut next = state
        .lock()
        .map_err(|error| error.to_string())?
        .get(window.label())
        .cloned()
        .unwrap_or(WindowChrome {
            mode,
            toolbar_height: TOOLBAR_HEIGHT,
            leading_inset: 96.0,
            windowed_controls: Vec::new(),
        });
    next.mode = mode;
    if mode == WindowMode::Windowed {
        next.windowed_controls = controls(native)?;
    }
    next.leading_inset = 12.0;
    if mode != WindowMode::Fullscreen {
        next.leading_inset = next
            .windowed_controls
            .iter()
            .map(|control| control.left + control.width + 16.0)
            .fold(96.0, f64::max);
    }
    let mut current = state.lock().map_err(|error| error.to_string())?;
    if current.get(window.label()) != Some(&next) {
        current.insert(window.label().to_string(), next.clone());
        drop(current);
        window
            .emit_to(window.label(), "inknb-window-chrome", next)
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}
