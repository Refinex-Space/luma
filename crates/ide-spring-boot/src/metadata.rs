//! Configuration metadata (`META-INF/spring-configuration-metadata.json` and
//! `additional-spring-configuration-metadata.json`, Spring Boot's "Configuration Metadata"
//! appendix): the JSON format, and the merged view of every file a module sees.

use crate::name;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

/// Where a metadata entry was read.
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Origin {
    pub kind: OriginKind,
    /// The jar, the metadata file, or the Java source file.
    pub path: PathBuf,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum OriginKind {
    /// A dependency jar's metadata.
    Jar,
    /// The annotation processor's output in a module's output folder.
    Output,
    /// A hand-written `additional-spring-configuration-metadata.json` of the project.
    Additional,
    /// Worked out from `@ConfigurationProperties` sources (no annotation processor needed).
    Source,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RawMetadata {
    #[serde(default)]
    pub groups: Vec<RawItem>,
    #[serde(default)]
    pub properties: Vec<RawItem>,
    #[serde(default)]
    pub hints: Vec<RawHint>,
    #[serde(default)]
    pub ignored: Option<RawIgnored>,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RawIgnored {
    #[serde(default)]
    pub properties: Vec<RawName>,
}

#[derive(Clone, Debug, Default, Deserialize)]
pub struct RawName {
    #[serde(default)]
    pub name: String,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RawItem {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default, rename = "type")]
    pub ty: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub source_type: Option<String>,
    #[serde(default)]
    pub source_method: Option<String>,
    #[serde(default)]
    pub default_value: Option<serde_json::Value>,
    #[serde(default)]
    pub deprecated: Option<bool>,
    #[serde(default)]
    pub deprecation: Option<RawDeprecation>,
}

#[derive(Clone, Debug, Default, Deserialize)]
pub struct RawDeprecation {
    #[serde(default)]
    pub level: Option<String>,
    #[serde(default)]
    pub reason: Option<String>,
    #[serde(default)]
    pub replacement: Option<String>,
    #[serde(default)]
    pub since: Option<String>,
}

#[derive(Clone, Debug, Default, Deserialize)]
pub struct RawHint {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub values: Vec<RawHintValue>,
    #[serde(default)]
    pub providers: Vec<RawProvider>,
}

#[derive(Clone, Debug, Default, Deserialize)]
pub struct RawHintValue {
    #[serde(default)]
    pub value: serde_json::Value,
    #[serde(default)]
    pub description: Option<String>,
}

#[derive(Clone, Debug, Default, Deserialize)]
pub struct RawProvider {
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub parameters: serde_json::Map<String, serde_json::Value>,
}

/// Parses a metadata file; `None` when it is no JSON object of the format.
pub fn parse(bytes: &[u8]) -> Option<RawMetadata> {
    serde_json::from_slice(bytes).ok()
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum DeprecationLevel {
    /// Still bound; a replacement may exist.
    Warning,
    /// No longer bound.
    Error,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Deprecation {
    pub level: DeprecationLevel,
    pub reason: Option<String>,
    pub replacement: Option<String>,
    pub since: Option<String>,
}

/// A configuration property.
#[derive(Clone, Debug)]
pub struct Property {
    /// As the metadata names it (kebab-case).
    pub name: Arc<str>,
    /// Canonical form (see [`name::canonical`]).
    pub key: Arc<str>,
    pub ty: Option<Arc<str>>,
    pub description: Option<Arc<str>>,
    pub default: Option<serde_json::Value>,
    pub deprecation: Option<Deprecation>,
    pub source_type: Option<Arc<str>>,
    pub source_method: Option<Arc<str>>,
    /// Every file declaring it, first read first.
    pub origins: Vec<Arc<Origin>>,
}

/// A group of properties (a `@ConfigurationProperties` class or `@Bean` method).
#[derive(Clone, Debug)]
pub struct Group {
    pub name: Arc<str>,
    pub key: Arc<str>,
    pub ty: Option<Arc<str>>,
    pub description: Option<Arc<str>>,
    pub source_type: Option<Arc<str>>,
    pub source_method: Option<Arc<str>>,
    pub origins: Vec<Arc<Origin>>,
}

/// What a hint applies to: the value of the property, or the keys / values of a map.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum HintTarget {
    Value,
    Keys,
    Values,
}

#[derive(Clone, Debug, Default)]
pub struct Hint {
    pub values: Vec<HintValue>,
    pub providers: Vec<ValueProvider>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct HintValue {
    pub value: String,
    pub description: Option<String>,
}

/// A value provider of a hint (Spring Boot's "Value Providers").
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ValueProvider {
    Any,
    ClassReference { target: Option<String>, concrete: bool },
    HandleAs { target: String },
    LoggerName { group: bool },
    SpringBeanReference { target: Option<String> },
    SpringProfileName,
    Unknown(String),
}

impl ValueProvider {
    fn from_raw(p: &RawProvider) -> ValueProvider {
        let text = |k: &str| p.parameters.get(k).and_then(|v| v.as_str()).map(str::to_owned);
        let flag = |k: &str, d: bool| p.parameters.get(k).and_then(serde_json::Value::as_bool).unwrap_or(d);
        match p.name.as_str() {
            "any" => ValueProvider::Any,
            "class-reference" => {
                ValueProvider::ClassReference { target: text("target"), concrete: flag("concrete", true) }
            }
            "handle-as" => match text("target") {
                Some(target) => ValueProvider::HandleAs { target },
                None => ValueProvider::Unknown(p.name.clone()),
            },
            "logger-name" => ValueProvider::LoggerName { group: flag("group", true) },
            "spring-bean-reference" => ValueProvider::SpringBeanReference { target: text("target") },
            "spring-profile-name" => ValueProvider::SpringProfileName,
            other => ValueProvider::Unknown(other.to_owned()),
        }
    }
}

/// Text of a JSON scalar value (`true`, `10`, `"text"` → `text`).
pub fn value_text(v: &serde_json::Value) -> Option<String> {
    match v {
        serde_json::Value::String(s) => Some(s.clone()),
        serde_json::Value::Bool(b) => Some(b.to_string()),
        serde_json::Value::Number(n) => Some(n.to_string()),
        serde_json::Value::Array(items) => {
            let parts: Option<Vec<String>> = items.iter().map(value_text).collect();
            parts.map(|p| p.join(","))
        }
        _ => None,
    }
}

/// The merged metadata a module sees, read-only once built.
#[derive(Debug, Default)]
pub struct MetadataIndex {
    properties: Vec<Property>,
    groups: Vec<Group>,
    hints: HashMap<(Arc<str>, HintTarget), Hint>,
    by_key: HashMap<Arc<str>, usize>,
    group_by_key: HashMap<Arc<str>, Vec<usize>>,
    /// Property indexes sorted by key, for prefix scans.
    sorted: Vec<usize>,
    /// Group indexes sorted by key.
    sorted_groups: Vec<usize>,
    /// Some file could not be read: unknown keys are not reported.
    pub incomplete: bool,
}

/// Builds a [`MetadataIndex`] from metadata files in order: later files fill in or replace
/// the documentation of earlier ones (`description`, `defaultValue`, `deprecation`), and
/// add new names.
#[derive(Default)]
pub struct Builder {
    index: MetadataIndex,
    ignored: Vec<Arc<str>>,
}

fn arc(s: &Option<String>) -> Option<Arc<str>> {
    s.as_deref().filter(|s| !s.is_empty()).map(Arc::from)
}

fn deprecation(item: &RawItem) -> Option<Deprecation> {
    let d = item.deprecation.as_ref();
    if d.is_none() && item.deprecated != Some(true) {
        return None;
    }
    let d = d.cloned().unwrap_or_default();
    Some(Deprecation {
        level: if d.level.as_deref().is_some_and(|l| l.eq_ignore_ascii_case("error")) {
            DeprecationLevel::Error
        } else {
            DeprecationLevel::Warning
        },
        reason: d.reason.filter(|s| !s.is_empty()),
        replacement: d.replacement.filter(|s| !s.is_empty()),
        since: d.since.filter(|s| !s.is_empty()),
    })
}

impl Builder {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn mark_incomplete(&mut self) {
        self.index.incomplete = true;
    }

    /// Adds one metadata file. `replace` makes its entries win over earlier ones entirely
    /// (sources worked out from Java replace the annotation processor's older output).
    pub fn add(&mut self, raw: &RawMetadata, origin: Arc<Origin>, replace: bool) {
        for g in &raw.groups {
            let Some(name) = g.name.as_deref().filter(|n| !n.is_empty()) else { continue };
            let key: Arc<str> = name::canonical(name).into();
            let same = self.index.group_by_key.get(&key).and_then(|ids| {
                ids.iter().copied().find(|&i| {
                    let e = &self.index.groups[i];
                    e.source_type.as_deref() == g.source_type.as_deref()
                        && e.source_method.as_deref() == g.source_method.as_deref()
                })
            });
            match same {
                Some(i) => {
                    let e = &mut self.index.groups[i];
                    if g.description.is_some() {
                        e.description = arc(&g.description);
                    }
                    if !e.origins.contains(&origin) {
                        e.origins.push(origin.clone());
                    }
                }
                None => {
                    let id = self.index.groups.len();
                    self.index.groups.push(Group {
                        name: name.into(),
                        key: key.clone(),
                        ty: arc(&g.ty),
                        description: arc(&g.description),
                        source_type: arc(&g.source_type),
                        source_method: arc(&g.source_method),
                        origins: vec![origin.clone()],
                    });
                    self.index.group_by_key.entry(key).or_default().push(id);
                }
            }
        }
        for p in &raw.properties {
            let Some(name) = p.name.as_deref().filter(|n| !n.is_empty()) else { continue };
            let key: Arc<str> = name::canonical(name).into();
            match self.index.by_key.get(&key).copied() {
                Some(i) => {
                    let e = &mut self.index.properties[i];
                    if replace {
                        e.ty = arc(&p.ty).or(e.ty.take());
                        e.description = arc(&p.description);
                        e.default = p.default_value.clone();
                        e.deprecation = deprecation(p);
                        if p.source_type.is_some() {
                            e.source_type = arc(&p.source_type);
                            e.source_method = arc(&p.source_method);
                        }
                    } else {
                        if e.ty.is_none() {
                            e.ty = arc(&p.ty);
                        }
                        if p.description.as_deref().is_some_and(|d| !d.is_empty()) {
                            e.description = arc(&p.description);
                        }
                        if p.default_value.is_some() {
                            e.default = p.default_value.clone();
                        }
                        if let Some(d) = deprecation(p) {
                            e.deprecation = Some(d);
                        }
                        if e.source_type.is_none() {
                            e.source_type = arc(&p.source_type);
                            e.source_method = arc(&p.source_method);
                        }
                    }
                    if !e.origins.contains(&origin) {
                        e.origins.push(origin.clone());
                    }
                }
                None => {
                    self.index.by_key.insert(key.clone(), self.index.properties.len());
                    self.index.properties.push(Property {
                        name: name.into(),
                        key,
                        ty: arc(&p.ty),
                        description: arc(&p.description),
                        default: p.default_value.clone(),
                        deprecation: deprecation(p),
                        source_type: arc(&p.source_type),
                        source_method: arc(&p.source_method),
                        origins: vec![origin.clone()],
                    });
                }
            }
        }
        for h in &raw.hints {
            let Some(name) = h.name.as_deref().filter(|n| !n.is_empty()) else { continue };
            let (base, target) = if let Some(b) = name.strip_suffix(".keys") {
                (b, HintTarget::Keys)
            } else if let Some(b) = name.strip_suffix(".values") {
                (b, HintTarget::Values)
            } else {
                (name, HintTarget::Value)
            };
            let key: Arc<str> = name::canonical(base).into();
            let hint = self.index.hints.entry((key, target)).or_default();
            for v in &h.values {
                let Some(value) = value_text(&v.value) else { continue };
                match hint.values.iter_mut().find(|x| x.value == value) {
                    Some(x) => {
                        if v.description.is_some() {
                            x.description = v.description.clone();
                        }
                    }
                    None => hint.values.push(HintValue { value, description: v.description.clone() }),
                }
            }
            for p in &h.providers {
                let p = ValueProvider::from_raw(p);
                if !hint.providers.contains(&p) {
                    hint.providers.push(p);
                }
            }
        }
        if let Some(ignored) = &raw.ignored {
            self.ignored.extend(
                ignored.properties.iter().filter(|n| !n.name.is_empty()).map(|n| name::canonical(&n.name).into()),
            );
        }
    }

    pub fn build(mut self) -> MetadataIndex {
        if !self.ignored.is_empty() {
            let ignored: std::collections::HashSet<Arc<str>> = self.ignored.into_iter().collect();
            self.index.properties.retain(|p| !ignored.contains(&p.key));
            self.index.by_key = self.index.properties.iter().enumerate().map(|(i, p)| (p.key.clone(), i)).collect();
        }
        let ix = &mut self.index;
        ix.sorted = (0..ix.properties.len()).collect();
        ix.sorted.sort_by(|&a, &b| ix.properties[a].key.cmp(&ix.properties[b].key));
        ix.sorted_groups = (0..ix.groups.len()).collect();
        ix.sorted_groups.sort_by(|&a, &b| ix.groups[a].key.cmp(&ix.groups[b].key));
        self.index
    }
}

impl MetadataIndex {
    pub fn properties(&self) -> &[Property] {
        &self.properties
    }

    pub fn groups(&self) -> &[Group] {
        &self.groups
    }

    pub fn hint_count(&self) -> usize {
        self.hints.len()
    }

    pub fn is_empty(&self) -> bool {
        self.properties.is_empty()
    }

    /// The property named `key` (canonical).
    pub fn property(&self, key: &str) -> Option<&Property> {
        self.by_key.get(key).map(|&i| &self.properties[i])
    }

    /// Groups named `key` (canonical).
    pub fn groups_named(&self, key: &str) -> impl Iterator<Item = &Group> {
        self.group_by_key.get(key).into_iter().flatten().map(|&i| &self.groups[i])
    }

    pub fn hint(&self, key: &str, target: HintTarget) -> Option<&Hint> {
        self.hints.get(&(Arc::from(key), target))
    }

    /// Properties under canonical `prefix` (all when empty), in key order.
    pub fn properties_under<'s, 'p>(&'s self, prefix: &'p str) -> impl Iterator<Item = &'s Property> + use<'s, 'p> {
        let start =
            if prefix.is_empty() { 0 } else { self.sorted.partition_point(|&i| *self.properties[i].key < *prefix) };
        self.sorted[start..]
            .iter()
            .map(|&i| &self.properties[i])
            .take_while(move |p| prefix.is_empty() || p.key.starts_with(prefix))
            .filter(move |p| name::is_under(&p.key, prefix))
    }

    /// Groups under canonical `prefix`, in key order.
    pub fn groups_under<'s, 'p>(&'s self, prefix: &'p str) -> impl Iterator<Item = &'s Group> + use<'s, 'p> {
        let start =
            if prefix.is_empty() { 0 } else { self.sorted_groups.partition_point(|&i| *self.groups[i].key < *prefix) };
        self.sorted_groups[start..]
            .iter()
            .map(|&i| &self.groups[i])
            .take_while(move |g| prefix.is_empty() || g.key.starts_with(prefix))
            .filter(move |g| name::is_under(&g.key, prefix))
    }

    /// Whether some property lies under canonical `prefix`.
    pub fn has_under(&self, prefix: &str) -> bool {
        self.properties_under(prefix).next().is_some()
    }

    /// The property whose name is the longest proper prefix of canonical `key`.
    pub fn longest_prefix_property(&self, key: &str) -> Option<&Property> {
        let mut end = key.len();
        loop {
            let cut = key[..end].rfind(['.', '['])?;
            if cut == 0 {
                return None;
            }
            if let Some(p) = self.property(&key[..cut]) {
                return Some(p);
            }
            end = cut;
        }
    }
}

/// The metadata files of a jar.
pub const JAR_ENTRIES: [&str; 2] =
    ["META-INF/spring-configuration-metadata.json", "META-INF/additional-spring-configuration-metadata.json"];

/// Largest metadata file read (bigger ones mark the index incomplete).
pub const MAX_FILE: u64 = 4 * 1024 * 1024;

/// Reads the metadata files of a jar (`None` when it is not readable).
pub fn read_jar(path: &Path) -> Option<Vec<RawMetadata>> {
    let archive = ide_java::archive::Archive::open(path).ok()?;
    let mut out = Vec::new();
    for name in JAR_ENTRIES {
        let Some(entry) = archive.entries.iter().find(|e| &*e.name == name) else { continue };
        if entry.size > MAX_FILE {
            continue;
        }
        let bytes = archive.read(entry).ok()?;
        if let Some(raw) = parse(&bytes) {
            out.push(raw);
        }
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn origin(p: &str) -> Arc<Origin> {
        Arc::new(Origin { kind: OriginKind::Jar, path: p.into() })
    }

    #[test]
    fn merges_and_ignores() {
        let a = parse(
            br#"{"groups":[{"name":"app","type":"a.App","sourceType":"a.App"}],
            "properties":[{"name":"app.time-out","type":"java.time.Duration","description":"Old."},
                          {"name":"app.secret","type":"java.lang.String"},
                          {"name":"app.legacy","type":"java.lang.String","deprecated":true}],
            "hints":[{"name":"app.mode","values":[{"value":"fast"}]},
                     {"name":"app.map.keys","values":[{"value":"k1","description":"Key."}]},
                     {"name":"app.map.values","providers":[{"name":"class-reference","parameters":{"target":"a.B"}}]}]}"#,
        )
        .unwrap();
        let b = parse(
            br#"{"properties":[{"name":"app.timeOut","description":"New.","defaultValue":"5s",
                 "deprecation":{"level":"error","replacement":"app.timeout"}},
                 {"name":"app.extra","type":"java.lang.Integer"}],
            "hints":[{"name":"app.mode","values":[{"value":"fast","description":"Fast."},{"value":"slow"}]}],
            "ignored":{"properties":[{"name":"app.secret"}]}}"#,
        )
        .unwrap();
        let mut builder = Builder::new();
        builder.add(&a, origin("a.jar"), false);
        builder.add(&b, origin("b.jar"), false);
        let ix = builder.build();
        let p = ix.property("app.timeout").unwrap();
        assert_eq!(&*p.name, "app.time-out");
        assert_eq!(p.description.as_deref(), Some("New."));
        assert_eq!(p.default, Some(serde_json::json!("5s")));
        assert_eq!(p.deprecation.as_ref().unwrap().level, DeprecationLevel::Error);
        assert_eq!(p.origins.len(), 2);
        assert!(ix.property("app.secret").is_none());
        assert_eq!(ix.property("app.legacy").unwrap().deprecation.as_ref().unwrap().level, DeprecationLevel::Warning);
        let mode = ix.hint("app.mode", HintTarget::Value).unwrap();
        assert_eq!(mode.values.len(), 2);
        assert_eq!(mode.values[0].description.as_deref(), Some("Fast."));
        assert_eq!(ix.hint("app.map", HintTarget::Keys).unwrap().values[0].value, "k1");
        assert_eq!(
            ix.hint("app.map", HintTarget::Values).unwrap().providers[0],
            ValueProvider::ClassReference { target: Some("a.B".into()), concrete: true }
        );
        assert_eq!(
            ix.properties_under("app").map(|p| &*p.name).collect::<Vec<_>>(),
            ["app.extra", "app.legacy", "app.time-out"]
        );
        assert!(ix.has_under("app"));
        assert!(!ix.has_under("ap"));
        assert_eq!(ix.groups_under("").count(), 1);
    }

    #[test]
    fn replacing_source_wins() {
        let old =
            parse(br#"{"properties":[{"name":"app.port","type":"java.lang.Integer","description":"Old."}]}"#).unwrap();
        let new = parse(br#"{"properties":[{"name":"app.port","type":"java.lang.Long"}]}"#).unwrap();
        let mut builder = Builder::new();
        builder.add(&old, origin("target/classes"), false);
        builder.add(&new, Arc::new(Origin { kind: OriginKind::Source, path: "A.java".into() }), true);
        let ix = builder.build();
        let p = ix.property("app.port").unwrap();
        assert_eq!(p.ty.as_deref(), Some("java.lang.Long"));
        assert_eq!(p.description, None);
    }

    #[test]
    fn longest_prefix() {
        let raw = parse(
            br#"{"properties":[{"name":"logging.level","type":"java.util.Map<java.lang.String,java.lang.String>"}]}"#,
        )
        .unwrap();
        let mut builder = Builder::new();
        builder.add(&raw, origin("x"), false);
        let ix = builder.build();
        assert_eq!(&*ix.longest_prefix_property("logging.level.org.foo").unwrap().name, "logging.level");
        assert!(ix.longest_prefix_property("logging.level").is_none());
        assert!(ix.longest_prefix_property("server.port").is_none());
    }
}
