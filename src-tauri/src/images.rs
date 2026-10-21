use base64::Engine;
use inknb_core::storage::{application_directory, atomic_write, fingerprint};
use serde_json::{json, Value};
use std::fs;
use std::path::Path;

#[tauri::command]
pub fn image_copy(data: String) -> Result<(), String> {
    use objc2_app_kit::{NSPasteboard, NSPasteboardTypePNG};
    use objc2_foundation::NSData;

    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data)
        .map_err(|error| error.to_string())?;
    if !bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Err("Could not copy this image.".into());
    }
    let pasteboard = NSPasteboard::generalPasteboard();
    pasteboard.clearContents();
    let written = unsafe {
        pasteboard.setData_forType(Some(&NSData::with_bytes(&bytes)), NSPasteboardTypePNG)
    };
    if !written {
        return Err("macOS could not copy this image.".into());
    }
    Ok(())
}

#[tauri::command]
pub fn image_export(data: String, path: String) -> Result<(), String> {
    let (header, content) = data.split_once(",").ok_or("The image is not available.")?;
    if !matches!(
        header,
        "data:image/png;base64"
            | "data:image/jpeg;base64"
            | "data:image/gif;base64"
            | "data:image/webp;base64"
            | "data:image/svg+xml;base64"
    ) {
        return Err("The image is not available.".into());
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(content)
        .map_err(|error| error.to_string())?;
    atomic_write(Path::new(&path), &bytes)
}

fn image_extension(media_type: &str) -> Result<&str, String> {
    match media_type {
        "image/png" => Ok("png"),
        "image/jpeg" => Ok("jpg"),
        "image/gif" => Ok("gif"),
        "image/webp" => Ok("webp"),
        _ => Err("Paste a PNG, JPEG, GIF, or WebP image.".into()),
    }
}

#[tauri::command]
pub fn image_import(data: String, name: String) -> Result<Value, String> {
    if data.len() > 16 * 1024 * 1024 {
        return Err("Paste images smaller than 12 MB each.".into());
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data)
        .map_err(|error| error.to_string())?;
    let media_type = if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        "image/png"
    } else if bytes.starts_with(b"\xff\xd8\xff") {
        "image/jpeg"
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        "image/gif"
    } else if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") {
        "image/webp"
    } else {
        return Err("Paste a PNG, JPEG, GIF, or WebP image.".into());
    };
    let extension = image_extension(media_type)?;
    let identity = fingerprint(&bytes);
    let directory = application_directory()?.join("images");
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    let path = directory.join(format!("{identity}.{extension}"));
    atomic_write(&path, &bytes)?;
    Ok(json!({
        "id": identity,
        "name": name.chars().take(255).collect::<String>(),
        "path": path,
        "mediaType": media_type,
    }))
}

#[tauri::command]
pub fn image_read(image_id: String, media_type: String) -> Result<String, String> {
    if image_id.len() != 64 || !image_id.bytes().all(|value| value.is_ascii_hexdigit()) {
        return Err("Use a pasted image identity.".into());
    }
    let extension = image_extension(&media_type)?;
    let path = application_directory()?
        .join("images")
        .join(format!("{image_id}.{extension}"));
    let bytes = fs::read(path).map_err(|error| error.to_string())?;
    if fingerprint(&bytes) != image_id {
        return Err("The pasted image changed.".into());
    }
    Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
}
