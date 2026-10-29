use inknb_core::{
    configuration::Configuration,
    shortcuts::{self, ShortcutScope},
};

pub fn apply(app: &tauri::AppHandle, configuration: &Configuration) -> Result<(), String> {
    let Some(menu) = app.menu() else {
        return Ok(());
    };
    let commands = shortcuts::resolve(&configuration.shortcuts)?;
    for group in menu.items().map_err(|error| error.to_string())? {
        let Some(group) = group.as_submenu() else {
            continue;
        };
        for item in group.items().map_err(|error| error.to_string())? {
            let Some(item) = item.as_menuitem() else {
                continue;
            };
            let Some(command) = commands.iter().find(|command| {
                command.scope == ShortcutScope::Application && command.id == item.id().as_ref()
            }) else {
                continue;
            };
            let binding = command.bindings.first();
            let accelerator = binding
                .filter(|binding| !binding.contains(' '))
                .map(|binding| binding.replace("Meta+", "Super+"));
            item.set_accelerator(accelerator.as_deref())
                .map_err(|error| error.to_string())?;
            let text = if binding.is_some_and(|binding| binding.contains(' ')) {
                format!("{}  {}", command.label, command.hint)
            } else {
                command.label.clone()
            };
            item.set_text(text).map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}
