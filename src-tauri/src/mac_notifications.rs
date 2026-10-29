use block2::{DynBlock, RcBlock};
use inknb_core::activity::ActivityItem;
use objc2::{
    define_class, msg_send,
    rc::Retained,
    runtime::{Bool, ProtocolObject},
    AnyThread, DefinedClass,
};
use objc2_foundation::{NSArray, NSDictionary, NSError, NSObject, NSObjectProtocol, NSString};
use objc2_user_notifications::{
    UNAuthorizationOptions, UNMutableNotificationContent, UNNotification, UNNotificationRequest,
    UNNotificationResponse, UNUserNotificationCenter, UNUserNotificationCenterDelegate,
};
use std::sync::Mutex;
use tauri::{Emitter, Manager};

define_class!(
    #[unsafe(super(NSObject))]
    #[ivars = tauri::AppHandle]
    pub struct NotificationDelegate;

    unsafe impl NSObjectProtocol for NotificationDelegate {}

    unsafe impl UNUserNotificationCenterDelegate for NotificationDelegate {
        #[unsafe(method(userNotificationCenter:didReceiveNotificationResponse:withCompletionHandler:))]
        fn receive(
            &self,
            _center: &UNUserNotificationCenter,
            response: &UNNotificationResponse,
            completion: &DynBlock<dyn Fn()>,
        ) {
            let content = response.notification().request().content();
            let key = content
                .userInfo()
                .objectForKey(&NSString::from_str("activityKey"));
            let key = key.and_then(|value| {
                value
                    .downcast_ref::<NSString>()
                    .map(|value| value.to_string())
            });
            let handle = self.ivars().clone();
            tauri::async_runtime::spawn(async move {
                let state = handle.state::<crate::DesktopState>();
                loop {
                    let changed = state.window_ready.notified();
                    tokio::pin!(changed);
                    changed.as_mut().enable();
                    let ready = state
                        .host_lifecycle
                        .lock()
                        .map(|lifecycle| {
                            matches!(lifecycle.phase, crate::space_windows::HostPhase::Ready)
                        })
                        .unwrap_or(false);
                    if ready {
                        let _ = handle.emit_to("host", "inknb-activity-target", &key);
                        break;
                    }
                    changed.await;
                }
            });
            completion.call(());
        }
    }
);

unsafe impl Send for NotificationDelegate {}
unsafe impl Sync for NotificationDelegate {}

pub fn start(app: &tauri::AppHandle) {
    let delegate: Retained<NotificationDelegate> = unsafe {
        let delegate = NotificationDelegate::alloc().set_ivars(app.clone());
        msg_send![super(delegate), init]
    };
    UNUserNotificationCenter::currentNotificationCenter()
        .setDelegate(Some(ProtocolObject::from_ref(&*delegate)));
    app.manage(delegate);
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        let state = handle.state::<crate::DesktopState>();
        let enabled = state
            .events
            .lock()
            .ok()
            .and_then(|store| {
                store
                    .read_activity(&inknb_core::activity::ActivityQuery {
                        document_ids: None,
                        before_cursor: None,
                        before_key: None,
                    })
                    .ok()
            })
            .is_some_and(|inbox| inbox.background_notifications);
        if enabled && authorize().await.is_err() {
            if let Ok(store) = state.events.lock() {
                let _ = store.background_notifications(false);
            }
        }
        state.event_notification.notify_waiters();
    });
}

pub async fn authorize() -> Result<(), String> {
    let (sender, receiver) = tokio::sync::oneshot::channel();
    {
        let sender = Mutex::new(Some(sender));
        let completion = RcBlock::new(move |granted: Bool, error: *mut NSError| {
            let result = if !error.is_null() {
                Err(unsafe { &*error }.localizedDescription().to_string())
            } else if granted.as_bool() {
                Ok(())
            } else {
                Err("Allow ink and butter in System Settings > Notifications, then enable notifications here.".into())
            };
            if let Some(sender) = sender.lock().ok().and_then(|mut sender| sender.take()) {
                let _ = sender.send(result);
            }
        });
        UNUserNotificationCenter::currentNotificationCenter()
            .requestAuthorizationWithOptions_completionHandler(
                UNAuthorizationOptions::Alert,
                &completion,
            );
    }
    receiver.await.map_err(|error| error.to_string())?
}

pub async fn show(item: &ActivityItem, document_title: &str) -> Result<(), String> {
    let (sender, receiver) = tokio::sync::oneshot::channel();
    {
        let content = UNMutableNotificationContent::new();
        content.setTitle(&NSString::from_str(&item.title));
        content.setSubtitle(&NSString::from_str(document_title));
        content.setBody(&NSString::from_str(
            &item.detail.chars().take(240).collect::<String>(),
        ));
        content.setThreadIdentifier(&NSString::from_str(
            &item.document_id.unwrap_or_default().to_string(),
        ));
        let information = NSDictionary::from_slices(
            &[&*NSString::from_str("activityKey")],
            &[&*NSString::from_str(&item.key)],
        );
        unsafe { content.setUserInfo(information.cast_unchecked()) };
        let request = UNNotificationRequest::requestWithIdentifier_content_trigger(
            &NSString::from_str(&identifier(item)),
            &content,
            None,
        );
        let sender = Mutex::new(Some(sender));
        let completion = RcBlock::new(move |error: *mut NSError| {
            let result = if error.is_null() {
                Ok(())
            } else {
                Err(unsafe { &*error }.localizedDescription().to_string())
            };
            if let Some(sender) = sender.lock().ok().and_then(|mut sender| sender.take()) {
                let _ = sender.send(result);
            }
        });
        UNUserNotificationCenter::currentNotificationCenter()
            .addNotificationRequest_withCompletionHandler(&request, Some(&completion));
    }
    receiver.await.map_err(|error| error.to_string())?
}

fn identifier(item: &ActivityItem) -> String {
    if ["reply", "question", "suggestion"].contains(&item.kind.as_str()) {
        if let Some(thread) = item.context_thread_id.or(item.thread_id) {
            return format!("{}:{thread}", item.document_id.unwrap_or_default());
        }
    }
    item.key.clone()
}

pub fn synchronize(items: &[ActivityItem]) {
    let active: Vec<String> = items
        .iter()
        .filter(|item| !item.read)
        .map(identifier)
        .collect();
    let completion = RcBlock::new(
        move |notifications: std::ptr::NonNull<NSArray<UNNotification>>| {
            let stale: Vec<Retained<NSString>> = unsafe { notifications.as_ref() }
                .iter()
                .map(|notification| notification.request().identifier())
                .filter(|identifier| !active.contains(&identifier.to_string()))
                .collect();
            UNUserNotificationCenter::currentNotificationCenter()
                .removeDeliveredNotificationsWithIdentifiers(&NSArray::from_retained_slice(&stale));
        },
    );
    UNUserNotificationCenter::currentNotificationCenter()
        .getDeliveredNotificationsWithCompletionHandler(&completion);
}
