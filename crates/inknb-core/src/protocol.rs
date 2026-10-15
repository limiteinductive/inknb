use crate::storage::application_directory;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::path::PathBuf;
use std::time::Duration;
use uuid::Uuid;

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ControlRequest {
    pub id: String,
    pub method: String,
    #[serde(default = "empty_parameters")]
    pub params: Value,
}

#[derive(Serialize, Deserialize)]
pub struct ControlResponse {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

pub fn empty_parameters() -> Value {
    json!({})
}

pub fn socket_path() -> Result<PathBuf, String> {
    Ok(application_directory()?.join("control.sock"))
}

pub fn call(method: &str, params: Value) -> Result<Value, String> {
    let mut stream = UnixStream::connect(socket_path()?)
        .map_err(|_| "Open ink and butter before connecting an agent.".to_string())?;
    stream
        .set_read_timeout(Some(Duration::from_secs(30)))
        .map_err(|error| error.to_string())?;
    stream
        .set_write_timeout(Some(Duration::from_secs(5)))
        .map_err(|error| error.to_string())?;
    let request = ControlRequest {
        id: Uuid::new_v4().to_string(),
        method: method.into(),
        params,
    };
    writeln!(
        stream,
        "{}",
        serde_json::to_string(&request).map_err(|error| error.to_string())?
    )
    .map_err(|error| error.to_string())?;
    let mut line = String::new();
    BufReader::new(stream)
        .read_line(&mut line)
        .map_err(|error| error.to_string())?;
    let response: ControlResponse =
        serde_json::from_str(&line).map_err(|error| error.to_string())?;
    if response.id != request.id {
        return Err("The response does not match this request.".into());
    }
    response.result.ok_or_else(|| {
        response
            .error
            .unwrap_or("The app returned no result.".into())
    })
}

pub fn tools() -> Vec<Value> {
    let empty = json!({"type":"object","properties":{},"additionalProperties":false});
    vec![
        json!({"name":"document_read","description":"Read the live Markdown buffer, revision, selection, path, durable conversations, and proposals. Use UTF-16 offsets for all ranges.","inputSchema":empty}),
        json!({"name":"document_open","description":"Open a specific local UTF-8 Markdown file in ink and butter. Unsaved work uses the app's normal save flow.","inputSchema":{"type":"object","properties":{"path":{"type":"string"}},"required":["path"],"additionalProperties":false}}),
        json!({"name":"requests_list","description":"Read pending requests created by the human in ink and butter. Request IDs remain stable across restarts.","inputSchema":empty}),
        json!({"name":"conversation_reply","description":"Reply to an existing human request at its anchor. Replies never change prose. Reuse the same messageId when retrying.","inputSchema":{"type":"object","properties":{"requestId":{"type":"string"},"messageId":{"type":"string","format":"uuid"},"content":{"type":"string"}},"required":["requestId","messageId","content"],"additionalProperties":false}}),
        json!({"name":"edit_propose","description":"Propose an edit for human acceptance. Read the current revision first. expectedText must match the exact UTF-16 range. Never infer permission to change prose from a question.","inputSchema":{"type":"object","properties":{"requestId":{"type":"string"},"revision":{"type":"integer"},"from":{"type":"integer"},"to":{"type":"integer"},"expectedText":{"type":"string"},"replacement":{"type":"string"},"explanation":{"type":"string"}},"required":["requestId","revision","from","to","expectedText","replacement","explanation"],"additionalProperties":false}}),
        json!({"name":"edit_apply","description":"Apply an edit only for a human request that explicitly grants edit permission. Uses exact revision and expected-text preconditions. The change enters the editor undo history.","inputSchema":{"type":"object","properties":{"requestId":{"type":"string"},"revision":{"type":"integer"},"from":{"type":"integer"},"to":{"type":"integer"},"expectedText":{"type":"string"},"replacement":{"type":"string"},"explanation":{"type":"string"}},"required":["requestId","revision","from","to","expectedText","replacement","explanation"],"additionalProperties":false}}),
        json!({"name":"source_attach","description":"Attach a local reference or generated file to an agent reply. ink and butter fingerprints it and flags later changes. Use this to return a PDF produced by the document's existing build workflow.","inputSchema":{"type":"object","properties":{"messageId":{"type":"string"},"path":{"type":"string"},"label":{"type":"string"}},"required":["messageId","path","label"],"additionalProperties":false}}),
        json!({"name":"editor_select","description":"Select and reveal an exact UTF-16 passage in the current revision.","inputSchema":{"type":"object","properties":{"revision":{"type":"integer"},"from":{"type":"integer"},"to":{"type":"integer"}},"required":["revision","from","to"],"additionalProperties":false}}),
        json!({"name":"ui_state","description":"Inspect the rendered editor state, theme, viewport, selection, focused control, thread placement, and build identity.","inputSchema":empty}),
        json!({"name":"window_show","description":"Bring ink and butter's writing window to the foreground for human use or native visual inspection.","inputSchema":empty}),
        json!({"name":"window_resize","description":"Resize ink and butter's actual desktop window for layout inspection. Dimensions use logical pixels. The minimum size is 700 by 480.","inputSchema":{"type":"object","properties":{"width":{"type":"integer","minimum":700,"maximum":2400},"height":{"type":"integer","minimum":480,"maximum":1800}},"required":["width","height"],"additionalProperties":false}}),
        json!({"name":"screenshot","description":"Capture actual rendered ink and butter pixels with document and UI state. Inspect the returned image for visual diagnosis.","inputSchema":empty}),
        json!({"name":"document_save","description":"Save the live Markdown and annotations. Supply an absolute path to save a new document or a separate copy. A different existing destination is rejected. Use the saved file with the document's external build and export tools.","inputSchema":{"type":"object","properties":{"path":{"type":"string","pattern":"^/"}},"additionalProperties":false}}),
    ]
}
