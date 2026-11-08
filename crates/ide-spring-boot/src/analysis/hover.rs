//! Documentation of keys and values (hover, Quick Documentation, the completion side panel),
//! and what a position of a configuration file refers to (navigation).

use super::{Context, DocKind, DocValue, PropertyDoc, parse, property_doc};
use crate::ClassKind;
use crate::document::{ConfigFile, Entry, Format, Utf16, Value, ValueKind};
use crate::metadata::HintTarget;
use crate::name;
use crate::resolve::{self, Resolved, type_of};
use crate::types::JavaType;
use serde::{Deserialize, Serialize};
use specta::Type;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct BootHover {
    pub from: u32,
    pub to: u32,
    pub content: BootHoverContent,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum BootHoverContent {
    /// A key.
    Key { doc: Box<PropertyDoc> },
    /// A value with documentation (enum constant, hint value).
    Value { key: String, value: String, description: Option<String>, ty: Option<String> },
    /// `${key}`: the definitions of `key` in the module's configuration files.
    Placeholder { key: String, definitions: Vec<PlaceholderDefinition> },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PlaceholderDefinition {
    pub path: std::path::PathBuf,
    pub line: u32,
    pub offset: u32,
    pub value: Option<String>,
    pub profile: Option<String>,
}

/// Documentation of the property (or group, or nested key) `key` as written.
pub fn describe(cx: &Context, key: &str) -> Option<PropertyDoc> {
    let key = key.trim_end_matches('.');
    match resolve::resolve(cx.index, cx.oracle, key) {
        Resolved::Property(p) => Some(property_doc(cx.index, p)),
        Resolved::Nested { property, ty, doc } => {
            let parent = property_doc(cx.index, property);
            let values = cx
                .index
                .hint(&property.key, HintTarget::Values)
                .map(|h| {
                    h.values
                        .iter()
                        .map(|v| DocValue { value: v.value.clone(), description: v.description.clone() })
                        .collect()
                })
                .unwrap_or_default();
            Some(PropertyDoc {
                name: key.to_owned(),
                kind: DocKind::Nested,
                ty: ty.as_ref().map(JavaType::display),
                qualified_type: None,
                default: None,
                description: doc.or(parent.description),
                deprecation: parent.deprecation,
                source_type: parent.source_type,
                source_method: parent.source_method,
                origins: parent.origins,
                values,
            })
        }
        Resolved::Group => {
            let canonical = name::canonical(key);
            let g = cx.index.groups_named(&canonical).next()?;
            Some(PropertyDoc {
                name: g.name.to_string(),
                kind: DocKind::Group,
                ty: g.ty.as_deref().map(crate::types::display_type),
                qualified_type: g.ty.as_deref().map(str::to_owned),
                default: None,
                description: g.description.as_deref().map(str::to_owned),
                deprecation: None,
                source_type: g.source_type.as_deref().map(str::to_owned),
                source_method: g.source_method.as_deref().map(str::to_owned),
                origins: g.origins.iter().map(|o| super::DocOrigin { kind: o.kind, path: o.path.clone() }).collect(),
                values: Vec::new(),
            })
        }
        _ => None,
    }
}

/// What is at a position: a key, a value (of a key), a `${…}` placeholder.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Target {
    Key { key: String, from: usize, to: usize },
    Value { key: String, value: String, from: usize, to: usize },
    Placeholder { key: String, from: usize, to: usize },
}

/// The `${key}` placeholders of a value text: key and byte range of the key in `text`
/// (offset by `base`).
pub fn placeholders(text: &str, base: usize) -> Vec<(String, usize, usize)> {
    let mut out = Vec::new();
    let mut i = 0;
    while let Some(p) = text[i..].find("${") {
        let start = i + p + 2;
        let Some(close) = text[start..].find('}') else { break };
        let inner = &text[start..start + close];
        let key = inner.split(':').next().unwrap_or(inner).trim();
        if !key.is_empty() && !key.contains("${") {
            let lead = inner.len() - inner.trim_start().len();
            out.push((key.to_owned(), base + start + lead, base + start + lead + key.len()));
        }
        i = start + close + 1;
    }
    out
}

fn item_at(v: &Value, at: usize) -> Option<&Value> {
    match v.kind {
        ValueKind::Sequence => v.items.iter().find(|i| i.span.contains(at)),
        ValueKind::Scalar | ValueKind::Block if v.span.contains(at) => Some(v),
        _ => None,
    }
}

pub fn target_at(file: &ConfigFile, text: &str, at: usize) -> Option<Target> {
    let entry: &Entry = file.entries().filter(|e| e.span.contains(at)).max_by_key(|e| e.depth)?;
    if entry.key_span.contains(at) {
        return Some(Target::Key { key: entry.key.clone(), from: entry.key_span.from, to: entry.key_span.to });
    }
    let v = entry.value.as_ref().and_then(|v| item_at(v, at))?;
    // `${…}` inside the value: located in the raw text of the value.
    let raw = &text[v.span.from..v.span.to];
    for (key, from, to) in placeholders(raw, v.span.from) {
        if from <= at && at <= to {
            return Some(Target::Placeholder { key, from, to });
        }
    }
    // A comma-separated item.
    let (from, value) = if v.kind == ValueKind::Scalar && !v.quoted && raw.contains(',') {
        let mut start = v.span.from;
        let mut found = (v.span.from, v.text.clone());
        for part in raw.split(',') {
            let end = start + part.len();
            if start <= at && at <= end {
                let lead = part.len() - part.trim_start().len();
                found = (start + lead, part.trim().to_owned());
                break;
            }
            start = end + 1;
        }
        found
    } else {
        (v.span.from, v.text.clone())
    };
    Some(Target::Value { key: entry.key.clone(), to: from + value.len(), value, from })
}

pub fn hover(cx: &Context, format: Format, text: &str, offset: u32) -> Option<BootHover> {
    let u = Utf16::new(text);
    let at = u.byte(offset);
    let file = parse(format, text);
    let target = target_at(&file, text, at)?;
    let (from, to, content) = match target {
        Target::Key { key, from, to } => (from, to, BootHoverContent::Key { doc: Box::new(describe(cx, &key)?) }),
        Target::Placeholder { key, from, to } => {
            let canonical = name::canonical(&key);
            let definitions: Vec<PlaceholderDefinition> = cx
                .project
                .keys
                .iter()
                .filter(|k| k.canonical == canonical)
                .map(|k| PlaceholderDefinition {
                    path: k.path.clone(),
                    line: k.line,
                    offset: k.offset,
                    value: k.value.clone(),
                    profile: k.profile.clone(),
                })
                .collect();
            if definitions.is_empty() {
                (from, to, BootHoverContent::Key { doc: Box::new(describe(cx, &key)?) })
            } else {
                (from, to, BootHoverContent::Placeholder { key, definitions })
            }
        }
        Target::Value { key, value, from, to } => {
            let (description, ty) = value_doc(cx, &key, &value)?;
            (from, to, BootHoverContent::Value { key, value, description, ty })
        }
    };
    Some(BootHover { from: u.of(from), to: u.of(to), content })
}

/// The documentation of `value` of `key`: an enum constant's, a hint value's, a class's.
fn value_doc(cx: &Context, key: &str, value: &str) -> Option<(Option<String>, Option<String>)> {
    let resolved = resolve::resolve(cx.index, cx.oracle, key);
    let (hint, ty) = match &resolved {
        Resolved::Property(p) => (cx.index.hint(&p.key, HintTarget::Value), type_of(p)),
        Resolved::Nested { property, ty, .. } => (cx.index.hint(&property.key, HintTarget::Values), ty.clone()),
        _ => return None,
    };
    if let Some(h) = hint
        && let Some(v) = h.values.iter().find(|v| v.value.eq_ignore_ascii_case(value))
        && v.description.is_some()
    {
        return Some((v.description.clone(), ty.as_ref().map(JavaType::display)));
    }
    let element = match &ty {
        Some(JavaType::List(e)) => Some((**e).clone()),
        t => t.clone(),
    };
    if let Some(JavaType::Class(c)) = &element
        && let ClassKind::Enum(constants) = cx.oracle.class_kind(c)
    {
        let want = name::uniform(value);
        let k = constants.into_iter().find(|k| name::uniform(&k.name) == want)?;
        return Some((k.description, Some(crate::types::simple(c).to_owned())));
    }
    // A class name (class-reference values, driver classes).
    if value.contains('.') && cx.oracle.class_exists(value) == Some(true) {
        return Some((cx.oracle.class_doc(value), Some(crate::types::simple(value).to_owned())));
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::analysis::fixtures::index;
    use crate::analysis::{KnownKey, Options, ProjectConfig};
    use crate::tests::FakeOracle;

    fn at(text: &str) -> (String, u32) {
        let i = text.find('|').unwrap();
        (text.replace('|', ""), i as u32)
    }

    #[test]
    fn hovers() {
        let ix = index();
        let project = ProjectConfig {
            keys: vec![KnownKey {
                key: "app.name".into(),
                canonical: "app.name".into(),
                value: Some("Demo".into()),
                path: "application.yml".into(),
                offset: 0,
                line: 3,
                profile: None,
            }],
            ..Default::default()
        };
        let options = Options::default();
        let cx = Context { index: &ix, oracle: &FakeOracle, project: &project, file_profile: None, options: &options };
        let (t, o) = at("server:\n  po|rt: 80\n");
        let h = hover(&cx, Format::Yaml, &t, o).unwrap();
        let BootHoverContent::Key { doc } = h.content else { panic!() };
        assert_eq!(doc.name, "server.port");
        assert_eq!(doc.ty.as_deref(), Some("Integer"));
        assert_eq!(doc.default.as_deref(), Some("8080"));
        assert_eq!((h.from, h.to), (10, 14));
        let (t, o) = at("server.shutdown=fa|st\n");
        let h = hover(&cx, Format::Properties, &t, o).unwrap();
        assert!(
            matches!(h.content, BootHoverContent::Value { ref description, .. } if description.as_deref() == Some("Fast mode."))
        );
        let (t, o) = at("x=${app.na|me:d}\n");
        let h = hover(&cx, Format::Properties, &t, o).unwrap();
        assert!(matches!(h.content, BootHoverContent::Placeholder { ref definitions, .. } if definitions.len() == 1));
        let (t, o) = at("logging.level.demo.w|eb=info\n");
        let h = hover(&cx, Format::Properties, &t, o).unwrap();
        assert!(matches!(h.content, BootHoverContent::Key { ref doc } if doc.kind == DocKind::Nested));
        let (t, o) = at("spring.main.banner-mode=o|ff\n");
        let h = hover(&cx, Format::Properties, &t, o).unwrap();
        assert!(matches!(h.content, BootHoverContent::Value { ref description, .. } if description.is_some()));
    }

    #[test]
    fn finds_placeholders() {
        assert_eq!(placeholders("a ${x.y:1} ${ z }", 10), vec![("x.y".into(), 14, 17), ("z".into(), 24, 25)]);
        assert!(placeholders("${unclosed", 0).is_empty());
    }
}
