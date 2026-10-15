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
    #[serde(default = "protocol_version")]
    pub version: u32,
    pub id: String,
    pub method: String,
    #[serde(default = "empty_parameters")]
    pub params: Value,
}

#[derive(Serialize, Deserialize)]
pub struct ControlResponse {
    #[serde(default = "protocol_version")]
    pub version: u32,
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

pub fn protocol_version() -> u32 {
    1
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
        version: 1,
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
        json!({"name":"request_delivery","description":"Read a durable delivery receipt before recovering a failed send. queued must not resend. started or uncertain requires provider reconciliation. unstarted has no queued transport.","inputSchema":{"type":"object","properties":{"requestId":{"type":"string","format":"uuid"}},"required":["requestId"],"additionalProperties":false}}),
        json!({"name":"protocol_info","description":"Inspect local protocol version, socket location, event delivery rules, and supported tools.","inputSchema":{"type":"object","properties":{},"required":[],"additionalProperties":false}}),
        json!({"name":"events_read","description":"Read durable local events after a cursor. Named consumers resume from their saved checkpoint. Events use stable identities and at-least-once delivery.","inputSchema":{"type":"object","properties":{"after":{"type":"integer","minimum":0},"documentId":{"type":"string","format":"uuid"},"consumer":{"type":"string"},"limit":{"type":"integer","minimum":1,"maximum":500}},"required":[],"additionalProperties":false}}),
        json!({"name":"events_ack","description":"Acknowledge a successfully handled event for a named backend. Use stable event IDs to make external side effects idempotent.","inputSchema":{"type":"object","properties":{"consumer":{"type":"string"},"cursor":{"type":"integer","minimum":0}},"required":["consumer","cursor"],"additionalProperties":false}}),
        json!({"name":"request_retry","description":"Retry a failed delivery only after the agent or backend confirms that the earlier transport did not queue it.","inputSchema":{"type":"object","properties":{"requestId":{"type":"string","format":"uuid"},"confirmedNotQueued":{"const":true,"type":"boolean"}},"required":["requestId","confirmedNotQueued"],"additionalProperties":false}}),
        json!({"name":"source_review","description":"Complete a source_changed request with an explanation of its effect. The hash must match both the request and current file. This never changes prose.","inputSchema":{"type":"object","properties":{"requestId":{"type":"string","format":"uuid"},"hash":{"type":["string","null"]},"messageId":{"type":"string","format":"uuid"},"summary":{"type":"string"}},"required":["requestId","hash","messageId","summary"],"additionalProperties":false}}),
        json!({"name":"anchor_suggest","description":"Locate a detached conversation. A unique exact original quote reconnects automatically. Other candidates appear for human confirmation.","inputSchema":{"type":"object","properties":{"requestId":{"type":"string","format":"uuid"},"revision":{"type":"integer","minimum":0},"candidates":{"type":"array","minItems":1,"maxItems":5,"items":{"type":"object","properties":{"from":{"type":"integer","minimum":0},"to":{"type":"integer","minimum":0},"expectedText":{"type":"string"},"label":{"type":"string"}},"required":["from","to","expectedText","label"],"additionalProperties":false}}},"required":["requestId","revision","candidates"],"additionalProperties":false}}),
        json!({"name":"figure_propose","description":"Prepare an escaped Markdown figure insertion at the end of the request passage. The human reviews it before insertion.","inputSchema":{"type":"object","properties":{"requestId":{"type":"string","format":"uuid"},"revision":{"type":"integer","minimum":0},"path":{"type":"string","pattern":"^/"},"label":{"type":"string"}},"required":["requestId","revision","path","label"],"additionalProperties":false}}),
        json!({"name":"table_propose","description":"Prepare a Markdown table from actual columns and rows at the request anchor. The human reviews it before insertion.","inputSchema":{"type":"object","properties":{"requestId":{"type":"string","format":"uuid"},"revision":{"type":"integer","minimum":0},"columns":{"type":"array","minItems":1,"items":{"type":"string"}},"rows":{"type":"array","minItems":1,"items":{"type":"array","items":{"type":"string"}}}},"required":["requestId","revision","columns","rows"],"additionalProperties":false}}),
        json!({"name":"document_move","description":"Move the saved document and its annotations with crash recovery. Local references within the document folder are copied to preserve Markdown paths. Existing destinations are protected.","inputSchema":{"type":"object","properties":{"documentId":{"type":"string","format":"uuid"},"revision":{"type":"integer","minimum":0},"path":{"type":"string","pattern":"^/"}},"required":["documentId","revision","path"],"additionalProperties":false}}),
        json!({"name":"annotation_create","description":"Post a read-only finding from an external backend at an exact passage. Reuse messageId for retries. Findings confer no edit permission.","inputSchema":{"type":"object","properties":{"documentId":{"type":"string","format":"uuid"},"revision":{"type":"integer","minimum":0},"from":{"type":"integer","minimum":0},"to":{"type":"integer","minimum":0},"expectedText":{"type":"string"},"messageId":{"type":"string","format":"uuid"},"consumer":{"type":"string"},"label":{"type":"string"},"content":{"type":"string"}},"required":["documentId","revision","from","to","expectedText","messageId","consumer","label","content"],"additionalProperties":false}}),
        json!({"name":"annotation_resolve","description":"Resolve an automation finding owned by the same consumer. Human conversations and findings with human replies remain under human control.","inputSchema":{"type":"object","properties":{"documentId":{"type":"string","format":"uuid"},"threadId":{"type":"string","format":"uuid"},"consumer":{"type":"string"}},"required":["documentId","threadId","consumer"],"additionalProperties":false}}),
        json!({"name":"document_read","description":"Read the live Markdown buffer, revision, selection, path, durable conversations, and proposals. Use UTF-16 offsets for all ranges.","inputSchema":empty}),
        json!({"name":"document_open","description":"Open a specific local UTF-8 Markdown file in ink and butter. Unsaved work uses the app's normal save flow.","inputSchema":{"type":"object","properties":{"path":{"type":"string"}},"required":["path"],"additionalProperties":false}}),
        json!({"name":"requests_list","description":"Read human and maintenance work. Inspect trigger.kind. Maintenance work permits replies and proposals only. Source reviews use source_review. Stale suggestions use edit_propose with replaces. Detached anchors use anchor_suggest.","inputSchema":empty}),
        json!({"name":"agent_connect","description":"Register your external agent session for the document you just read. Handle setup yourself when the human asks you to join. Codex should run the bundled inknb connect command from its own shell to use its current CODEX_THREAD_ID. Claude uses its configured channel connection name. Pending asides send automatically. Connection grants no prose edit permission. Retrying never resends delivered or answered requests.","inputSchema":{"type":"object","properties":{"documentId":{"type":"string","format":"uuid"},"provider":{"type":"string","enum":["codex","claude"]},"sessionId":{"type":"string","minLength":1},"commandPath":{"type":"string","pattern":"^/"}},"required":["documentId","provider","sessionId"],"additionalProperties":false}}),
        json!({"name":"conversation_reply","description":"Reply to an existing human request at its anchor. Replies never change prose. Reuse the same messageId when retrying.","inputSchema":{"type":"object","properties":{"requestId":{"type":"string"},"messageId":{"type":"string","format":"uuid"},"content":{"type":"string"}},"required":["requestId","messageId","content"],"additionalProperties":false}}),
        json!({"name":"edit_propose","description":"Propose an edit for human acceptance. Read the current revision first. expectedText must match the exact UTF-16 range. Never infer permission to change prose from a question.","inputSchema":{"type":"object","properties":{"requestId":{"type":"string"},"revision":{"type":"integer"},"from":{"type":"integer"},"to":{"type":"integer"},"expectedText":{"type":"string"},"replacement":{"type":"string"},"explanation":{"type":"string"},"replaces":{"type":"string","format":"uuid"}},"required":["requestId","revision","from","to","expectedText","replacement","explanation"],"additionalProperties":false}}),
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
