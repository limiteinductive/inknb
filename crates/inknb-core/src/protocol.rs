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
    #[serde(default, rename = "agentId", skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<String>,
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
    call_as(method, params, None, None)
}

pub fn call_as(
    method: &str,
    mut params: Value,
    agent_id: Option<String>,
    cancelled: Option<&std::sync::atomic::AtomicBool>,
) -> Result<Value, String> {
    let explicit = params
        .as_object_mut()
        .and_then(|values| values.remove("callerAgentId"))
        .map(serde_json::from_value::<String>)
        .transpose()
        .map_err(|error| error.to_string())?;
    let agent_id = explicit.or(agent_id);
    if method != "decision_wait" {
        return call_once(method, params, agent_id).map_err(|(_, error)| error);
    }
    validate_tool(method, &params)?;
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct DecisionWait {
        decision_id: Uuid,
        document_id: Option<Uuid>,
        timeout_ms: Option<u64>,
    }
    let wait: DecisionWait = serde_json::from_value(params).map_err(|error| error.to_string())?;
    let timeout = wait.timeout_ms.unwrap_or(60_000);
    let mut query = json!({"decisionId":wait.decision_id});
    if let Some(document_id) = wait.document_id {
        query["documentId"] = json!(document_id);
    }
    let deadline = std::time::Instant::now() + Duration::from_millis(timeout);
    let mut latest = Value::Null;
    loop {
        if cancelled.is_some_and(|cancelled| cancelled.load(std::sync::atomic::Ordering::Acquire)) {
            return Err("The decision wait was cancelled.".into());
        }
        match call_once("decision_read", query.clone(), agent_id.clone()) {
            Ok(record) => {
                let completed = record["decision"]["status"] != "open";
                latest = record;
                if completed {
                    return Ok(json!({"timedOut":false,"record":latest}));
                }
            }
            Err((false, error)) => return Err(error),
            Err((true, _)) => {}
        }
        let remaining = deadline.saturating_duration_since(std::time::Instant::now());
        if remaining.is_zero() {
            return Ok(json!({"timedOut":true,"record":latest}));
        }
        std::thread::sleep(remaining.min(Duration::from_millis(250)));
    }
}

fn call_once(
    method: &str,
    params: Value,
    agent_id: Option<String>,
) -> Result<Value, (bool, String)> {
    let execute = || -> Result<ControlResponse, String> {
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
            agent_id,
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
        Ok(response)
    };
    let response = execute().map_err(|error| (true, error))?;
    response.result.ok_or_else(|| {
        (
            false,
            response
                .error
                .unwrap_or("The app returned no result.".into()),
        )
    })
}

struct ToolContract {
    tools: Vec<Value>,
    validators: std::collections::HashMap<String, jsonschema::Validator>,
}

fn tool_contract() -> Result<&'static ToolContract, String> {
    static CONTRACT: std::sync::OnceLock<Result<ToolContract, String>> = std::sync::OnceLock::new();
    CONTRACT
        .get_or_init(|| {
            let tools: Vec<Value> = serde_json::from_str(include_str!("tool-catalog.json"))
                .map_err(|error| error.to_string())?;
            let mut validators = std::collections::HashMap::new();
            for tool in &tools {
                let name = tool["name"].as_str().ok_or("The tool needs a name.")?;
                let validator = jsonschema::options()
                    .should_validate_formats(true)
                    .build(&tool["inputSchema"])
                    .map_err(|error| format!("Invalid {name} input schema: {error}"))?;
                validators.insert(name.to_owned(), validator);
            }
            Ok(ToolContract { tools, validators })
        })
        .as_ref()
        .map_err(Clone::clone)
}

pub fn tools() -> Vec<Value> {
    tool_contract()
        .expect("The generated agent contract must be valid.")
        .tools
        .clone()
}

pub fn validate_tool(method: &str, parameters: &Value) -> Result<(), String> {
    let name = if method == "events_subscribe" {
        "events_read"
    } else {
        method
    };
    if let Some(validator) = tool_contract()?.validators.get(name) {
        validator.validate(parameters).map_err(|error| {
            format!(
                "Invalid {method} input at {}: {error}",
                error.instance_path()
            )
        })?;
    }
    Ok(())
}
