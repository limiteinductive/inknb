use std::sync::OnceLock;

static APPLICATION_PROFILE: OnceLock<Option<String>> = OnceLock::new();

pub fn configure_profile(mut arguments: Vec<String>) -> Result<Vec<String>, String> {
    let mut profile = None;
    if let Some(name) = arguments
        .first()
        .and_then(|argument| argument.strip_prefix("--profile="))
    {
        if name.is_empty()
            || name.len() > 20
            || !name.bytes().all(|character| {
                character.is_ascii_lowercase() || character.is_ascii_digit() || character == b'-'
            })
        {
            return Err(
                "Use a profile name with 1 to 20 lowercase letters, digits, or hyphens.".into(),
            );
        }
        profile = Some(name.to_owned());
        arguments.remove(0);
    }
    if arguments
        .first()
        .is_some_and(|argument| argument.starts_with("--profile"))
    {
        return Err("Put one --profile=<name> option before the command or document path.".into());
    }
    APPLICATION_PROFILE
        .set(profile)
        .map_err(|_| "The application profile is already configured.")?;
    Ok(arguments)
}

pub fn application_profile() -> Option<&'static str> {
    APPLICATION_PROFILE
        .get()
        .and_then(|profile| profile.as_deref())
}
