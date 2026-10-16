use objc2::rc::Retained;
use objc2::runtime::ProtocolObject;
use objc2_app_kit::{NSWindow, NSWindowButton};
use objc2_foundation::{NSNotificationCenter, NSObjectProtocol, NSPoint, NSRect, NSSize};
use serde::Serialize;
use std::sync::Mutex;
use tauri::{Emitter, Manager};

pub const TOOLBAR_HEIGHT: f64 = 52.0;
const WINDOW_CONTROL_LEFT: f64 = 20.0;

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
                let state = observed.state::<Mutex<WindowChrome>>();
                let mut chrome = state.lock().map_err(|error| error.to_string())?.clone();
                if chrome.mode == WindowMode::Windowed {
                    let native = observed.ns_window().map_err(|error| error.to_string())?;
                    chrome.windowed_controls = controls(unsafe { &*(native as *mut NSWindow) })?;
                }
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
    let state = window.state::<Mutex<WindowChrome>>();
    let mut next = state.lock().map_err(|error| error.to_string())?.clone();
    next.mode = mode;
    if matches!(mode, WindowMode::ExitingFullscreen | WindowMode::Windowed) {
        for kind in [
            NSWindowButton::CloseButton,
            NSWindowButton::MiniaturizeButton,
            NSWindowButton::ZoomButton,
        ] {
            let button = native
                .standardWindowButton(kind)
                .ok_or("Missing window control.")?;
            let hidden = mode == WindowMode::ExitingFullscreen;
            if button.isHidden() != hidden {
                button.setHidden(hidden);
            }
        }
    }
    if mode == WindowMode::Windowed {
        let content = native.contentView().ok_or("Missing window content.")?;
        let bounds = content.bounds();
        let current_controls = controls(native)?;
        let first = native
            .standardWindowButton(NSWindowButton::CloseButton)
            .ok_or("Missing window control.")?;
        let container = unsafe { first.superview().and_then(|view| view.superview()) }
            .ok_or("Missing native title bar.")?;
        let top = if content.isFlipped() {
            bounds.origin.y
        } else {
            bounds.origin.y + bounds.size.height - TOOLBAR_HEIGHT
        };
        let region = NSRect::new(
            NSPoint::new(bounds.origin.x, top),
            NSSize::new(bounds.size.width, TOOLBAR_HEIGHT),
        );
        let parent = unsafe { container.superview() };
        let frame = content.convertRect_toView(region, parent.as_deref());
        if container.frame() != frame {
            container.setFrame(frame);
        }
        for (kind, control) in [
            NSWindowButton::CloseButton,
            NSWindowButton::MiniaturizeButton,
            NSWindowButton::ZoomButton,
        ]
        .into_iter()
        .zip(&current_controls)
        {
            let button = native
                .standardWindowButton(kind)
                .ok_or("Missing window control.")?;
            let top = (TOOLBAR_HEIGHT - control.height) / 2.0;
            let origin = NSPoint::new(
                bounds.origin.x + WINDOW_CONTROL_LEFT + control.left - current_controls[0].left,
                if content.isFlipped() {
                    bounds.origin.y + top
                } else {
                    bounds.origin.y + bounds.size.height - top - control.height
                },
            );
            let parent =
                unsafe { button.superview() }.ok_or("Missing window control container.")?;
            let origin = parent.convertPoint_fromView(origin, Some(&content));
            if button.frame().origin != origin {
                button.setFrameOrigin(origin);
            }
        }
        next.windowed_controls = controls(native)?;
    }
    next.leading_inset = 12.0;
    if mode != WindowMode::Fullscreen {
        let first = next
            .windowed_controls
            .first()
            .ok_or("Missing window control bounds.")?;
        next.leading_inset = next
            .windowed_controls
            .iter()
            .map(|control| WINDOW_CONTROL_LEFT + control.left - first.left + control.width + 16.0)
            .fold(0.0, f64::max);
    }
    let mut current = state.lock().map_err(|error| error.to_string())?;
    if *current != next {
        *current = next.clone();
        drop(current);
        window
            .emit("inknb-window-chrome", next)
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}
