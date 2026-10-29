use keyboard_types::Code;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Clone, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ShortcutScope {
    Application,
    Editor,
    Composer,
    Annotation,
}

#[derive(Clone, Deserialize, Serialize)]
pub struct ShortcutCommand {
    pub id: String,
    pub label: String,
    pub scope: ShortcutScope,
    pub defaults: Vec<String>,
    #[serde(default)]
    pub bindings: Vec<String>,
    #[serde(default)]
    pub repeat: Option<bool>,
    #[serde(default)]
    pub hint: String,
}

pub fn normalize(binding: &str) -> Result<String, String> {
    let mut sequence = Vec::new();
    for stroke in binding.split_whitespace() {
        let mut modifiers = Vec::new();
        let mut key = None;
        for part in stroke.split('+') {
            let modifier = match part.to_ascii_lowercase().as_str() {
                "mod" | "cmdorctrl" | "commandorcontrol" => Some(if cfg!(target_os = "macos") {
                    "Meta"
                } else {
                    "Ctrl"
                }),
                "cmd" | "command" | "meta" | "super" => Some("Meta"),
                "ctrl" | "control" => Some("Ctrl"),
                "alt" | "option" => Some("Alt"),
                "shift" => Some("Shift"),
                _ => None,
            };
            if let Some(modifier) = modifier {
                if modifiers.contains(&modifier) {
                    return Err(format!("Repeated modifier in {binding}."));
                }
                modifiers.push(modifier);
                continue;
            }
            if key.is_some() {
                return Err(format!("Use one key per stroke in {binding}."));
            }
            let name = if part.len() == 1 && part.as_bytes()[0].is_ascii_alphabetic() {
                format!("Key{}", part.to_ascii_uppercase())
            } else if part.len() == 1 && part.as_bytes()[0].is_ascii_digit() {
                format!("Digit{part}")
            } else {
                match part {
                    "Esc" => "Escape",
                    "Return" => "Enter",
                    "Spacebar" => "Space",
                    "\\" => "Backslash",
                    "[" => "BracketLeft",
                    "]" => "BracketRight",
                    "-" => "Minus",
                    "=" => "Equal",
                    "," => "Comma",
                    "." => "Period",
                    "/" => "Slash",
                    ";" => "Semicolon",
                    "'" => "Quote",
                    "`" => "Backquote",
                    _ => part,
                }
                .into()
            };
            let code = name.parse::<Code>().map_err(|_| {
                format!("Unknown key {part} in {binding}. Use a KeyboardEvent.code name.")
            })?;
            if code == Code::Unidentified {
                return Err(format!("Use an identified key in {binding}."));
            }
            key = Some(code.to_string());
        }
        modifiers.sort();
        let key = key.ok_or_else(|| format!("Supply a key in {binding}."))?;
        sequence.push(if modifiers.is_empty() {
            key
        } else {
            format!("{}+{key}", modifiers.join("+"))
        });
    }
    if sequence.is_empty() {
        return Err("A shortcut cannot be empty. Use [] to disable a command.".into());
    }
    Ok(sequence.join(" "))
}

pub fn resolve(overrides: &BTreeMap<String, Vec<String>>) -> Result<Vec<ShortcutCommand>, String> {
    let mut commands: Vec<ShortcutCommand> =
        serde_json::from_str(include_str!("../../../src/shortcuts.json"))
            .map_err(|error| error.to_string())?;
    for identity in overrides.keys() {
        if !commands.iter().any(|command| &command.id == identity) {
            return Err(format!("Unknown shortcut command {identity}. Read configuration_read.shortcuts for command identities."));
        }
    }
    for command in &mut commands {
        command.bindings = overrides
            .get(&command.id)
            .unwrap_or(&command.defaults)
            .iter()
            .map(|binding| normalize(binding))
            .collect::<Result<_, _>>()?;
        let mut unique = BTreeSet::new();
        command
            .bindings
            .retain(|binding| unique.insert(binding.clone()));
        command.hint = command
            .bindings
            .first()
            .map(|binding| {
                binding
                    .split(' ')
                    .map(|stroke| {
                        stroke
                            .split('+')
                            .map(|part| match part {
                                "Meta" => "⌘",
                                "Ctrl" => "⌃",
                                "Alt" => "⌥",
                                "Shift" => "⇧",
                                "Enter" => "↵",
                                "Escape" => "Esc",
                                "Tab" => "⇥",
                                "Backspace" => "⌫",
                                "Delete" => "⌦",
                                "Backslash" => "\\",
                                "BracketLeft" => "[",
                                "BracketRight" => "]",
                                "Equal" => "=",
                                "Minus" => "−",
                                "ArrowLeft" => "←",
                                "ArrowRight" => "→",
                                "ArrowUp" => "↑",
                                "ArrowDown" => "↓",
                                _ => part
                                    .strip_prefix("Key")
                                    .or_else(|| part.strip_prefix("Digit"))
                                    .unwrap_or(part),
                            })
                            .collect::<String>()
                    })
                    .collect::<Vec<_>>()
                    .join(" ")
            })
            .unwrap_or_default();
    }
    for (index, command) in commands.iter().enumerate() {
        for other in &commands[index..] {
            if command.scope != other.scope
                && command.scope != ShortcutScope::Application
                && other.scope != ShortcutScope::Application
            {
                continue;
            }
            for (binding_index, binding) in command.bindings.iter().enumerate() {
                for (other_index, other_binding) in other.bindings.iter().enumerate() {
                    if command.id == other.id && binding_index == other_index {
                        continue;
                    }
                    if binding == other_binding
                        || binding.starts_with(&format!("{other_binding} "))
                        || other_binding.starts_with(&format!("{binding} "))
                    {
                        return Err(format!("Shortcut {binding} for {} conflicts with {other_binding} for {}. Rebind or disable one command in the same configuration change.", command.id,other.id));
                    }
                }
            }
        }
    }
    Ok(commands)
}
