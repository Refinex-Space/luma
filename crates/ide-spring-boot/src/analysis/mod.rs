//! Analysis of one Spring Boot configuration file against the module's metadata:
//! completion ([`complete`]), documentation ([`hover`]) and inspections ([`validate`]).
//! Offsets crossing the IPC boundary are UTF-16 code units (the editor's offsets).

pub mod complete;
pub mod hover;
pub mod validate;

use crate::TypeOracle;
use crate::document::{ConfigFile, Format};
use crate::metadata::{DeprecationLevel, MetadataIndex, OriginKind, Property};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::path::PathBuf;

/// A key defined in one of the module's configuration files (for `${…}` and profiles).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct KnownKey {
    pub key: String,
    pub canonical: String,
    pub value: Option<String>,
    pub path: PathBuf,
    /// UTF-16 offset of the key in its file, and its 0-based line.
    pub offset: u32,
    pub line: u32,
    /// The profile of its document (file name or `on-profile`).
    pub profile: Option<String>,
}

/// What the module's configuration files and resources say, beyond the file analyzed.
#[derive(Clone, Debug, Default)]
pub struct ProjectConfig {
    /// Profiles named by configuration file names, `on-profile`, `spring.profiles.group`, `@Profile`.
    pub profiles: Vec<String>,
    /// Keys of every configuration file of the module.
    pub keys: Vec<KnownKey>,
    /// Class path resources of the module (`application-dev.yml`, `db/schema.sql`), relative.
    pub resources: Vec<String>,
}

#[derive(Clone, Debug)]
pub struct Options {
    /// Skip values with Maven resource filtering tokens (`@project.version@`).
    pub replacement_tokens: bool,
    /// The Boot major version (`3`), when known.
    pub boot_major: Option<u32>,
}

impl Default for Options {
    fn default() -> Self {
        Self { replacement_tokens: true, boot_major: None }
    }
}

#[derive(Clone, Copy)]
pub struct Context<'a> {
    pub index: &'a MetadataIndex,
    pub oracle: &'a dyn TypeOracle,
    pub project: &'a ProjectConfig,
    /// The profile of the file from its name (`application-dev.yml` → `dev`).
    pub file_profile: Option<&'a str>,
    pub options: &'a Options,
}

/// A text replacement (UTF-16 offsets of the analyzed text).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct BootTextEdit {
    pub from: u32,
    pub to: u32,
    pub insert: String,
}

/// Documentation of a property (completion side panel, hover, Quick Documentation).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PropertyDoc {
    /// The metadata name (kebab-case) or the key as written under a map / bean.
    pub name: String,
    pub kind: DocKind,
    /// Simple type (`Map<String, Duration>`).
    pub ty: Option<String>,
    /// Qualified type as the metadata writes it.
    pub qualified_type: Option<String>,
    pub default: Option<String>,
    pub description: Option<String>,
    pub deprecation: Option<crate::metadata::Deprecation>,
    /// `HikariConfig#setMaximumPoolSize`-like source of the property.
    pub source_type: Option<String>,
    pub source_method: Option<String>,
    /// Where the metadata came from (jar file names, metadata files).
    pub origins: Vec<DocOrigin>,
    /// Allowed values with descriptions (hints, enum constants).
    pub values: Vec<DocValue>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum DocKind {
    Property,
    Group,
    /// An entry under a map / list / nested bean property.
    Nested,
    /// A value (enum constant, hint value).
    Value,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DocOrigin {
    pub kind: OriginKind,
    pub path: PathBuf,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DocValue {
    pub value: String,
    pub description: Option<String>,
}

pub(crate) fn property_doc(ix: &MetadataIndex, p: &Property) -> PropertyDoc {
    let hint = ix.hint(&p.key, crate::metadata::HintTarget::Value);
    PropertyDoc {
        name: p.name.to_string(),
        kind: DocKind::Property,
        ty: p.ty.as_deref().map(crate::types::display_type),
        qualified_type: p.ty.as_deref().map(str::to_owned),
        default: p.default.as_ref().and_then(crate::metadata::value_text),
        description: p.description.as_deref().map(str::to_owned),
        deprecation: p.deprecation.clone(),
        source_type: p.source_type.as_deref().map(str::to_owned),
        source_method: p.source_method.as_deref().map(str::to_owned),
        origins: p.origins.iter().map(|o| DocOrigin { kind: o.kind, path: o.path.clone() }).collect(),
        values: hint
            .map(|h| {
                h.values
                    .iter()
                    .map(|v| DocValue { value: v.value.clone(), description: v.description.clone() })
                    .collect()
            })
            .unwrap_or_default(),
    }
}

/// Whether a property is deprecated so that it is no longer bound.
pub(crate) fn removed(p: &Property) -> bool {
    p.deprecation.as_ref().is_some_and(|d| d.level == DeprecationLevel::Error)
}

/// The line containing byte `at`: (start, end without the newline).
pub(crate) fn line_at(text: &str, at: usize) -> (usize, usize) {
    let at = at.min(text.len());
    let start = text[..at].rfind('\n').map_or(0, |i| i + 1);
    let end = text[at..].find('\n').map_or(text.len(), |i| at + i);
    let end = if end > start && text.as_bytes()[end - 1] == b'\r' { end - 1 } else { end };
    (start, end)
}

/// Parses `text` as `format` (shared by the three entry points).
pub(crate) fn parse(format: Format, text: &str) -> ConfigFile {
    ConfigFile::parse(format, text)
}

/// Runtime placeholder prefixes resolved by the environment, not the configuration files.
pub(crate) const RUNTIME_PREFIXES: [&str; 10] =
    ["random.", "user.", "java.", "os.", "file.", "line.", "path.", "LOG_", "PID", "sun."];

#[cfg(test)]
pub(crate) mod fixtures {
    use super::*;
    use crate::metadata::{Builder, Origin, parse};
    use std::sync::Arc;

    pub const METADATA: &[u8] = br#"{
      "groups": [{"name":"server","type":"demo.ServerProperties","sourceType":"demo.ServerProperties"},
                 {"name":"spring.datasource","type":"demo.DataSourceProperties","sourceType":"demo.DataSourceProperties"}],
      "properties": [
        {"name":"server.port","type":"java.lang.Integer","description":"Server HTTP port.","defaultValue":8080,"sourceType":"demo.ServerProperties"},
        {"name":"server.address","type":"java.net.InetAddress","description":"Network address."},
        {"name":"server.shutdown","type":"demo.Mode","description":"Shutdown mode."},
        {"name":"server.servlet.context-path","type":"java.lang.String","description":"Context path."},
        {"name":"spring.datasource.url","type":"java.lang.String","description":"JDBC URL of the database."},
        {"name":"spring.datasource.driver-class-name","type":"java.lang.String","description":"Fully qualified name of the JDBC driver."},
        {"name":"spring.datasource.hikari.maximum-pool-size","type":"java.lang.Integer","defaultValue":10},
        {"name":"spring.datasource.hikari.connection-timeout","type":"java.time.Duration"},
        {"name":"spring.datasource.initialization-mode","type":"java.lang.String","deprecation":{"level":"error","replacement":"spring.sql.init.mode","since":"2.5.0"}},
        {"name":"spring.datasource.old-name","type":"java.lang.String","deprecation":{"level":"warning","replacement":"spring.datasource.name"}},
        {"name":"spring.datasource.name","type":"java.lang.String"},
        {"name":"spring.sql.init.mode","type":"java.lang.String"},
        {"name":"spring.main.banner-mode","type":"java.lang.String"},
        {"name":"spring.profiles.active","type":"java.util.List<java.lang.String>"},
        {"name":"spring.profiles.include","type":"java.util.List<java.lang.String>"},
        {"name":"spring.profiles.group","type":"java.util.Map<java.lang.String,java.util.List<java.lang.String>>"},
        {"name":"spring.config.activate.on-profile","type":"java.lang.String[]"},
        {"name":"spring.config.import","type":"java.util.List<java.lang.String>"},
        {"name":"spring.jpa.show-sql","type":"java.lang.Boolean","defaultValue":false},
        {"name":"spring.jackson.default-property-inclusion","type":"demo.Mode"},
        {"name":"logging.level","type":"java.util.Map<java.lang.String,java.lang.String>"},
        {"name":"logging.group","type":"java.util.Map<java.lang.String,java.util.List<java.lang.String>>"},
        {"name":"app.servers","type":"java.util.List<demo.Server>"},
        {"name":"app.tags","type":"java.util.List<java.lang.String>"},
        {"name":"app.size","type":"org.springframework.util.unit.DataSize"}
      ],
      "hints": [
        {"name":"spring.datasource.driver-class-name","providers":[{"name":"class-reference","parameters":{"target":"java.sql.Driver"}}]},
        {"name":"spring.main.banner-mode","values":[{"value":"off","description":"Disable printing of the banner."},{"value":"console"},{"value":"log"}]},
        {"name":"logging.level.keys","values":[{"value":"root"}],"providers":[{"name":"logger-name"}]},
        {"name":"logging.level.values","values":[{"value":"info"},{"value":"debug"}]},
        {"name":"spring.profiles.active","providers":[{"name":"spring-profile-name"}]}
      ]
    }"#;

    pub fn index() -> MetadataIndex {
        let mut b = Builder::new();
        b.add(&parse(METADATA).unwrap(), Arc::new(Origin { kind: OriginKind::Jar, path: "boot.jar".into() }), false);
        b.build()
    }
}
