use crate::storage::{atomic_write, fingerprint};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use std::fs::{self, File};
use std::io::Read;
use std::path::{Path, PathBuf};

const MAXIMUM_BYTES: u64 = 65536;

#[derive(Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum Placement {
    Margin,
    Inline,
}

#[derive(Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum Appearance {
    System,
    Light,
    Dark,
}

#[derive(Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum Typeface {
    Editorial,
    System,
    Monospace,
}

#[derive(Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum DetachedPreview {
    Document,
    ActiveDocument,
}

#[derive(Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum LibrarySort {
    Recent,
    Alphabetical,
    Manual,
}

#[derive(Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum OutlinePresentation {
    Panel,
    Rail,
}

#[derive(Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum OutlineSide {
    Left,
    Right,
}

#[derive(Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(default, deny_unknown_fields)]
pub struct OutlineConfiguration {
    pub presentation: OutlinePresentation,
    pub side: OutlineSide,
    #[schemars(range(min = 160, max = 360))]
    pub width: u32,
    #[schemars(range(min = 1, max = 6))]
    pub min_level: u32,
    #[schemars(range(min = 1, max = 6))]
    pub max_level: u32,
    #[schemars(range(min = 0, max = 24))]
    pub indent: u32,
    pub follow: bool,
}

impl Default for OutlineConfiguration {
    fn default() -> Self {
        Self {
            presentation: OutlinePresentation::Panel,
            side: OutlineSide::Left,
            width: 200,
            min_level: 1,
            max_level: 6,
            indent: 10,
            follow: true,
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FontSizeChange {
    Increase,
    Decrease,
    Reset,
}

#[derive(Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(default, deny_unknown_fields)]
pub struct Configuration {
    #[schemars(range(min = 1, max = 1))]
    pub version: u32,
    pub placement: Placement,
    pub appearance: Appearance,
    pub typeface: Typeface,
    #[schemars(range(min = 14, max = 28))]
    pub font_size: f64,
    #[schemars(range(min = 440, max = 820))]
    pub line_width: f64,
    pub reduce_motion: bool,
    pub autosave: bool,
    pub agent_edits: bool,
    pub detached_preview: DetachedPreview,
    #[schemars(range(min = -1))]
    pub library_depth: i32,
    pub library_sort: LibrarySort,
    pub document_outline: bool,
    pub decision_notifications: bool,
    pub outline: OutlineConfiguration,
}

impl Default for Configuration {
    fn default() -> Self {
        Self {
            version: 1,
            placement: Placement::Margin,
            appearance: Appearance::System,
            typeface: Typeface::Editorial,
            font_size: 17.0,
            line_width: 620.0,
            reduce_motion: false,
            autosave: true,
            agent_edits: true,
            detached_preview: DetachedPreview::Document,
            library_depth: 1,
            library_sort: LibrarySort::Recent,
            document_outline: true,
            decision_notifications: true,
            outline: OutlineConfiguration::default(),
        }
    }
}

impl Configuration {
    pub fn parse(source: &str) -> Result<Self, String> {
        if source.len() > MAXIMUM_BYTES as usize {
            return Err("inknb.toml exceeds 64 KiB.".into());
        }
        let mut fields: toml::Table = toml::from_str(source).map_err(|error| error.to_string())?;
        if let Some(layout) = fields.remove("library_layout") {
            let depth = match layout.as_str() {
                Some("flat") => 0,
                Some("tree") => 1,
                _ => return Err("library_layout must be tree or flat.".into()),
            };
            fields
                .entry("library_depth")
                .or_insert(toml::Value::Integer(depth));
        }
        let configuration: Self = fields
            .try_into()
            .map_err(|error: toml::de::Error| error.to_string())?;
        configuration.validate()?;
        Ok(configuration)
    }

    pub fn validate(&self) -> Result<(), String> {
        if self.version != 1 {
            return Err("version must be 1.".into());
        }
        if !(14.0..=28.0).contains(&self.font_size) {
            return Err("font_size must be between 14 and 28 pixels.".into());
        }
        if !(440.0..=820.0).contains(&self.line_width) {
            return Err("line_width must be between 440 and 820 pixels.".into());
        }
        if self.library_depth < -1 {
            return Err("library_depth must be -1 or a nonnegative integer.".into());
        }
        if !(160..=360).contains(&self.outline.width) {
            return Err("outline.width must be between 160 and 360 pixels.".into());
        }
        if !(1..=6).contains(&self.outline.min_level)
            || !(self.outline.min_level..=6).contains(&self.outline.max_level)
        {
            return Err(
                "outline levels must be between 1 and 6, with min_level at most max_level.".into(),
            );
        }
        if self.outline.indent > 24 {
            return Err("outline.indent must be between 0 and 24 pixels.".into());
        }
        Ok(())
    }
}

#[derive(Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigurationSnapshot {
    pub path: PathBuf,
    pub source: Option<String>,
    pub fingerprint: Option<String>,
    pub effective: Configuration,
    pub diagnostic: Option<String>,
    pub revision: u64,
}

pub struct ConfigurationStore {
    directory: PathBuf,
    snapshot: ConfigurationSnapshot,
}

impl ConfigurationStore {
    pub fn open(directory: &Path) -> Result<Self, String> {
        let path = directory.join("inknb.toml");
        let mut effective = fs::read_to_string(directory.join("configuration-last-good.toml"))
            .ok()
            .and_then(|source| Configuration::parse(&source).ok())
            .unwrap_or_default();
        if !path.exists() {
            let legacy = directory.join("preferences.json");
            if legacy.exists() {
                let mut preferences: serde_json::Value =
                    serde_json::from_slice(&fs::read(&legacy).map_err(|error| error.to_string())?)
                        .map_err(|error| error.to_string())?;
                let fields = preferences
                    .as_object_mut()
                    .ok_or("The previous preferences must be an object.")?;
                for (previous, current) in [
                    ("fontSize", "font_size"),
                    ("lineWidth", "line_width"),
                    ("reduceMotion", "reduce_motion"),
                ] {
                    if let Some(value) = fields.remove(previous) {
                        fields.insert(current.into(), value);
                    }
                }
                effective = Configuration::parse(
                    &toml::to_string(&preferences).map_err(|error| error.to_string())?,
                )?;
            }
            let source = toml::to_string_pretty(&effective).map_err(|error| error.to_string())?;
            atomic_write(&path, source.as_bytes())?;
            if legacy.exists() {
                fs::rename(&legacy, directory.join("preferences-migrated.json"))
                    .map_err(|error| error.to_string())?;
            }
        }
        let mut store = Self {
            directory: directory.into(),
            snapshot: ConfigurationSnapshot {
                path,
                source: None,
                fingerprint: None,
                effective,
                diagnostic: None,
                revision: 0,
            },
        };
        store.refresh();
        Ok(store)
    }

    pub fn snapshot(&self) -> ConfigurationSnapshot {
        self.snapshot.clone()
    }

    pub fn set_placement(&mut self, placement: Placement) -> Result<ConfigurationSnapshot, String> {
        #[derive(Deserialize)]
        struct PlacementField {
            placement: Option<toml::Spanned<Placement>>,
        }
        self.refresh();
        if let Some(diagnostic) = &self.snapshot.diagnostic {
            return Err(diagnostic.clone());
        }
        let mut source = self
            .snapshot
            .source
            .clone()
            .ok_or("The configuration is unavailable.")?;
        let fields: PlacementField = toml::from_str(&source).map_err(|error| error.to_string())?;
        let replacement = match placement {
            Placement::Margin => "\"margin\"",
            Placement::Inline => "\"inline\"",
        };
        if let Some(field) = fields.placement {
            source.replace_range(field.span(), replacement);
        } else {
            source.insert_str(0, &format!("placement = {replacement}\n"));
        }
        let fingerprint = self
            .snapshot
            .fingerprint
            .clone()
            .ok_or("The configuration is unavailable.")?;
        self.write(&source, &fingerprint)
    }

    pub fn change_font_size(
        &mut self,
        change: FontSizeChange,
    ) -> Result<ConfigurationSnapshot, String> {
        #[derive(Deserialize)]
        struct FontSizeField {
            font_size: Option<toml::Spanned<f64>>,
        }
        self.refresh();
        if let Some(diagnostic) = &self.snapshot.diagnostic {
            return Err(diagnostic.clone());
        }
        let current = self.snapshot.effective.font_size;
        let font_size = match change {
            FontSizeChange::Increase => (current + 1.0).min(28.0),
            FontSizeChange::Decrease => (current - 1.0).max(14.0),
            FontSizeChange::Reset => Configuration::default().font_size,
        };
        if font_size == current {
            return Ok(self.snapshot());
        }
        let mut source = self
            .snapshot
            .source
            .clone()
            .ok_or("The configuration is unavailable.")?;
        let fields: FontSizeField = toml::from_str(&source).map_err(|error| error.to_string())?;
        if let Some(field) = fields.font_size {
            source.replace_range(field.span(), &font_size.to_string());
        } else {
            source.insert_str(0, &format!("font_size = {font_size}\n"));
        }
        let fingerprint = self
            .snapshot
            .fingerprint
            .clone()
            .ok_or("The configuration is unavailable.")?;
        self.write(&source, &fingerprint)
    }

    pub fn refresh(&mut self) -> bool {
        let previous = self.snapshot.clone();
        self.snapshot.source = None;
        self.snapshot.fingerprint = None;
        let result = (|| -> Result<Configuration, String> {
            let file = File::open(&self.snapshot.path).map_err(|error| error.to_string())?;
            let mut bytes = Vec::new();
            file.take(MAXIMUM_BYTES + 1)
                .read_to_end(&mut bytes)
                .map_err(|error| error.to_string())?;
            if bytes.len() > MAXIMUM_BYTES as usize {
                return Err("inknb.toml exceeds 64 KiB.".into());
            }
            self.snapshot.fingerprint = Some(fingerprint(&bytes));
            let source = String::from_utf8(bytes).map_err(|error| error.to_string())?;
            self.snapshot.source = Some(source);
            if self.snapshot.fingerprint == previous.fingerprint && previous.diagnostic.is_none() {
                return Ok(previous.effective.clone());
            }
            let configuration = Configuration::parse(self.snapshot.source.as_deref().unwrap())?;
            let cached =
                toml::to_string_pretty(&configuration).map_err(|error| error.to_string())?;
            atomic_write(
                &self.directory.join("configuration-last-good.toml"),
                cached.as_bytes(),
            )?;
            Ok(configuration)
        })();
        self.snapshot.diagnostic = result.as_ref().err().cloned();
        if let Ok(configuration) = result {
            self.snapshot.effective = configuration;
        }
        let changed = self.snapshot != previous;
        if changed {
            self.snapshot.revision += 1;
        }
        changed
    }

    pub fn write(
        &mut self,
        source: &str,
        expected_fingerprint: &str,
    ) -> Result<ConfigurationSnapshot, String> {
        Configuration::parse(source)?;
        self.refresh();
        if self.snapshot.fingerprint.as_deref() != Some(expected_fingerprint) {
            return Err("inknb.toml changed. Read configuration_read before writing again.".into());
        }
        atomic_write(&self.snapshot.path, source.as_bytes())?;
        self.refresh();
        Ok(self.snapshot())
    }
}
