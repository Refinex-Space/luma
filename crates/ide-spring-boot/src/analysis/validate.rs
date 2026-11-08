//! Inspections of configuration files (IDEA's Spring › Spring Boot group): unknown and
//! deprecated keys, values the binder cannot convert, duplicates, profile-specific and
//! legacy profile properties, `spring.config.import` locations, placeholders, JDBC drivers.

use super::{BootTextEdit, Context, line_at, parse, removed};
use crate::ClassKind;
use crate::document::{ConfigFile, Document, Entry, Format, Span, Utf16, Value, ValueKind, escape_key};
use crate::metadata::{DeprecationLevel, HintTarget, Property, ValueProvider};
use crate::name;
use crate::resolve::{self, Problem as KeyProblem, Resolved, Shape, shape, type_of};
use crate::types::{JavaType, Scalar};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::HashMap;

/// Inspections, with IDEA's ids where IDEA has the check.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
pub enum BootInspection {
    /// `SpringBootApplicationProperties`.
    SpringBootApplicationProperties,
    /// `SpringBootApplicationYaml`.
    SpringBootApplicationYaml,
    /// Profile-specific and legacy profile properties (Boot's `InvalidConfigDataPropertyException`).
    SpringBootProfileSpecificProperty,
    /// `spring.config.import` locations.
    SpringBootConfigImport,
    /// `${…}` that nothing defines (off by default).
    SpringBootUnresolvedPlaceholder,
    /// `SpringDataPropertiesNoDriverDependencyInspection` / `SpringDataYamlNoDriverDependencyInspection`.
    SpringDataNoDriverDependency,
    /// `SpringBootAdditionalConfig`: additional metadata files.
    SpringBootAdditionalConfig,
    /// `.imports` / `spring.factories` registrations.
    SpringBootImports,
    /// `ConfigurationProperties`: `@ConfigurationProperties` classes.
    ConfigurationProperties,
    /// `SpringBootApplicationSetup`.
    SpringBootApplicationSetup,
    /// `SpringBootReactorHooksOnDebug`.
    SpringBootReactorHooksOnDebug,
    /// Inapplicable `@EventListener` for early application events.
    SpringBootEarlyEventListener,
    /// Not autowired test constructor parameter.
    SpringBootTestConstructorAutowired,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum BootSeverity {
    Error,
    Warning,
    WeakWarning,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct BootProblem {
    pub inspection: BootInspection,
    /// UTF-16 range.
    pub from: u32,
    pub to: u32,
    pub severity: BootSeverity,
    /// English (the editor translates it).
    pub message: String,
    /// Shown struck through (a deprecated key).
    pub deprecated: bool,
    pub fixes: Vec<BootFix>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct BootFix {
    pub label: String,
    pub edits: Vec<BootTextEdit>,
    /// Writes the key to the module's additional metadata file instead of editing this one.
    pub define: Option<DefineKey>,
    /// Edits of other files (applied as one undoable workspace edit).
    pub workspace: Option<ide_core::WorkspaceEdit>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DefineKey {
    pub name: String,
    /// Inferred from the value (`java.lang.Integer`, `java.lang.Boolean`, `java.lang.String`).
    pub ty: String,
}

struct Out<'t> {
    text: &'t str,
    u: Utf16<'t>,
    format: Format,
    problems: Vec<BootProblem>,
}

impl Out<'_> {
    fn main(&self) -> BootInspection {
        match self.format {
            Format::Properties => BootInspection::SpringBootApplicationProperties,
            Format::Yaml => BootInspection::SpringBootApplicationYaml,
        }
    }

    fn push(
        &mut self,
        inspection: BootInspection,
        span: Span,
        severity: BootSeverity,
        message: String,
        fixes: Vec<BootFix>,
    ) {
        self.problems.push(BootProblem {
            inspection,
            from: self.u.of(span.from),
            to: self.u.of(span.to.max(span.from)),
            severity,
            message,
            deprecated: false,
            fixes,
        });
    }

    fn edit(&self, from: usize, to: usize, insert: impl Into<String>) -> BootTextEdit {
        BootTextEdit { from: self.u.of(from), to: self.u.of(to), insert: insert.into() }
    }

    /// Removes the whole lines of `span`.
    fn delete_lines(&self, span: Span) -> BootTextEdit {
        let (start, _) = line_at(self.text, span.from);
        let (_, end) = line_at(self.text, span.to.saturating_sub(1).max(span.from));
        let end = if self.text[end..].starts_with("\r\n") {
            end + 2
        } else if self.text[end..].starts_with('\n') {
            end + 1
        } else {
            end
        };
        self.edit(start, end, "")
    }
}

pub fn validate(cx: &Context, format: Format, text: &str) -> Vec<BootProblem> {
    let file = parse(format, text);
    let mut out = Out { text, u: Utf16::new(text), format, problems: Vec::new() };
    let reports_unknown = !cx.index.is_empty() && !cx.index.incomplete;
    for doc in &file.documents {
        document(cx, &file, doc, reports_unknown, &mut out);
    }
    out.problems
}

/// The type a value suggests for a new metadata entry.
fn inferred_type(value: Option<&Value>) -> String {
    let Some(v) = value else { return "java.lang.String".into() };
    let t = v.text.trim();
    if v.kind == ValueKind::Sequence {
        return "java.util.List<java.lang.String>".into();
    }
    if matches!(t, "true" | "false") {
        "java.lang.Boolean".into()
    } else if !t.is_empty() && t.parse::<i32>().is_ok() {
        "java.lang.Integer".into()
    } else if !t.is_empty() && t.parse::<i64>().is_ok() {
        "java.lang.Long".into()
    } else if !t.is_empty() && t.parse::<f64>().is_ok() && t.contains('.') {
        "java.lang.Double".into()
    } else {
        "java.lang.String".into()
    }
}

/// The property most likely meant by an unknown canonical key.
fn suggestion<'a>(cx: &Context<'a>, canonical: &str) -> Option<&'a Property> {
    let limit = (canonical.len() / 5).clamp(2, 3);
    let parent = canonical.rfind('.').map_or("", |i| &canonical[..i]);
    let near = cx
        .index
        .properties_under(parent)
        .filter(|p| !removed(p))
        .filter_map(|p| Some((name::distance(&p.key, canonical, limit)?, p)))
        .min_by_key(|(d, _)| *d);
    near.or_else(|| {
        cx.index
            .properties()
            .iter()
            .filter(|p| !removed(p))
            .filter_map(|p| Some((name::distance(&p.key, canonical, limit)?, p)))
            .min_by_key(|(d, _)| *d)
    })
    .map(|(_, p)| p)
}

/// Rewrites the key of `entry` to `target` (a metadata name): the whole key in properties;
/// in YAML its own part when `target` lies under the same parents.
fn rename_key(out: &Out, entry: &Entry, target: &str) -> Option<BootTextEdit> {
    match out.format {
        Format::Properties => Some(out.edit(entry.key_span.from, entry.key_span.to, escape_key(target))),
        Format::Yaml => {
            let parent = name::canonical(entry.key[..entry.prefix_len.min(entry.key.len())].trim_end_matches('.'));
            let target_canonical = name::canonical(target);
            if !parent.is_empty() && !name::is_under(&target_canonical, &parent) {
                return None;
            }
            let skip = if parent.is_empty() { 0 } else { name::elements(&parent).len() };
            let own: Vec<String> = name::elements(target)
                .into_iter()
                .skip(skip)
                .map(|e| if e.indexed { format!("[{}]", e.text) } else { e.text.to_owned() })
                .collect();
            if own.is_empty() {
                return None;
            }
            Some(out.edit(entry.key_span.from, entry.key_span.to, own.join(".").replace(".[", "[")))
        }
    }
}

/// Whether placeholders or replacement tokens make a value unknown until runtime / build.
fn dynamic(cx: &Context, value: &str) -> bool {
    if value.contains("${") || value.contains("#{") {
        return true;
    }
    if cx.options.replacement_tokens
        && let Some(a) = value.find('@')
        && value[a + 1..].contains('@')
    {
        return true;
    }
    false
}

const PROFILE_SPECIFIC: [&str; 3] = ["spring.profiles.active", "spring.profiles.include", "spring.profiles.default"];

fn document(cx: &Context, file: &ConfigFile, doc: &Document, reports_unknown: bool, out: &mut Out) {
    let _ = file;
    // Keys under a reported or opaque YAML parent are not looked at.
    let mut skipped: Vec<String> = Vec::new();
    let mut seen: HashMap<String, usize> = HashMap::new();
    let profile_specific_file = cx.file_profile.is_some();
    let profile_doc = doc.on_profile.is_some();
    for (i, e) in doc.entries.iter().enumerate() {
        if skipped.iter().any(|s| name::is_under(&e.canonical, s)) {
            continue;
        }
        // Profile-specific and legacy profile properties (checked before the metadata, which
        // lists some of them as removed).
        let canonical = e.canonical.as_str();
        if e.is_leaf() {
            if (profile_specific_file || profile_doc) && PROFILE_SPECIFIC.contains(&canonical) {
                let fix = BootFix {
                    label: "Remove property".into(),
                    edits: vec![out.delete_lines(e.span)],
                    define: None,
                    workspace: None,
                };
                out.push(
                    BootInspection::SpringBootProfileSpecificProperty,
                    e.key_span,
                    BootSeverity::Error,
                    format!("Property '{}' is invalid in a profile specific resource", e.key),
                    vec![fix],
                );
                continue;
            }
            if profile_specific_file && canonical == "spring.config.activate.onprofile" {
                let fix = BootFix {
                    label: "Remove property".into(),
                    edits: vec![out.delete_lines(e.span)],
                    define: None,
                    workspace: None,
                };
                out.push(
                    BootInspection::SpringBootProfileSpecificProperty,
                    e.key_span,
                    BootSeverity::Error,
                    format!("Property '{}' is invalid in a profile specific resource", e.key),
                    vec![fix],
                );
                continue;
            }
            if canonical == "spring.profiles" && cx.options.boot_major.is_none_or(|m| m >= 3) {
                let mut fixes = Vec::new();
                if let Some(edit) = rename_key(out, e, "spring.config.activate.on-profile") {
                    fixes.push(BootFix {
                        label: "Replace with 'spring.config.activate.on-profile'".into(),
                        edits: vec![edit],
                        define: None,
                        workspace: None,
                    });
                }
                out.push(
                    BootInspection::SpringBootProfileSpecificProperty,
                    e.key_span,
                    BootSeverity::Error,
                    "Property 'spring.profiles' is invalid: use 'spring.config.activate.on-profile'".into(),
                    fixes,
                );
                continue;
            }
        }
        let resolved = resolve::resolve(cx.index, cx.oracle, &e.key);
        match &resolved {
            Resolved::Unknown(problem) => {
                if !reports_unknown {
                    continue;
                }
                // A YAML parent that is a prefix of nothing: reported once, its keys skipped.
                skipped.push(e.canonical.clone());
                report_unknown(cx, out, e, problem);
                continue;
            }
            Resolved::Opaque => {
                skipped.push(e.canonical.clone());
                continue;
            }
            Resolved::Group => continue,
            Resolved::Property(_) | Resolved::Nested { .. } => {}
        }
        if let Resolved::Property(p) = &resolved
            && let Some(d) = &p.deprecation
        {
            report_deprecated(out, doc, i, e, p, d.level);
        }
        if !e.is_leaf() {
            continue;
        }
        // Duplicates within a document (relaxed names compare equal).
        if let Some(&first) = seen.get(&e.canonical) {
            let _ = first;
            let fix = BootFix {
                label: "Remove duplicate".into(),
                edits: vec![out.delete_lines(e.span)],
                define: None,
                workspace: None,
            };
            out.push(out.main(), e.key_span, BootSeverity::Error, format!("Duplicate key '{}'", e.key), vec![fix]);
        } else {
            seen.insert(e.canonical.clone(), i);
        }
        if let Some(v) = &e.value {
            check_value(cx, out, e, &resolved, v);
            if e.canonical == "spring.config.import" {
                check_imports(cx, out, v);
            }
        }
    }
    placeholders(cx, out, doc);
}

fn report_unknown(cx: &Context, out: &mut Out, e: &Entry, problem: &KeyProblem) {
    let span = e.key_span;
    match problem {
        KeyProblem::Unknown => {
            let mut fixes = Vec::new();
            let mut message = format!("Cannot resolve configuration property '{}'", e.key);
            if let Some(s) = suggestion(cx, &e.canonical)
                && let Some(edit) = rename_key(out, e, &s.name)
            {
                message = format!("Cannot resolve configuration property '{}'. Did you mean '{}'?", e.key, s.name);
                fixes.push(BootFix {
                    label: format!("Change to '{}'", s.name),
                    edits: vec![edit],
                    define: None,
                    workspace: None,
                });
            }
            if e.is_leaf() {
                fixes.push(BootFix {
                    label: format!("Define configuration key '{}'", e.key),
                    edits: Vec::new(),
                    define: Some(DefineKey { name: e.key.clone(), ty: inferred_type(e.value.as_ref()) }),
                    workspace: None,
                });
            }
            out.push(out.main(), span, BootSeverity::Warning, message, fixes);
        }
        KeyProblem::IndexRequired { property } => {
            out.push(
                out.main(),
                span,
                BootSeverity::Error,
                format!("Index access required for property '{property}'"),
                Vec::new(),
            );
        }
        KeyProblem::NonIntegerIndex => {
            let message = if e.key.contains("[]") {
                "Missing index value".to_owned()
            } else {
                "Index must be an integer".to_owned()
            };
            out.push(out.main(), span, BootSeverity::Error, message, Vec::new());
        }
        KeyProblem::UnclosedBracket => {
            out.push(out.main(), span, BootSeverity::Error, "No matching ']'".into(), Vec::new());
        }
    }
}

fn report_deprecated(out: &mut Out, doc: &Document, index: usize, e: &Entry, p: &Property, level: DeprecationLevel) {
    let d = p.deprecation.as_ref().expect("deprecated");
    let message = match &d.reason {
        Some(reason) => format!("Deprecated configuration property '{}': {}", e.key, reason.trim_end_matches('.')),
        None => format!("Deprecated configuration property '{}'", e.key),
    };
    let mut fixes = Vec::new();
    if let Some(r) = &d.replacement {
        if let Some(edit) = rename_key(out, e, r) {
            fixes.push(BootFix {
                label: format!("Use replacement key '{r}'"),
                edits: vec![edit],
                define: None,
                workspace: None,
            });
        } else if out.format == Format::Yaml
            && let Some(v) = &e.value
            && matches!(v.kind, ValueKind::Scalar | ValueKind::Sequence)
        {
            // Another parent: move the value under the replacement (a flat key), removing
            // the parents left empty.
            let mut edits = vec![out.delete_lines(empty_ancestors(doc, index))];
            let raw = &out.text[v.span.from..v.span.to];
            let (_, end) = line_at(out.text, doc.span.to.saturating_sub(1).max(doc.span.from));
            let value = if v.kind == ValueKind::Sequence {
                format!(
                    "[{}]",
                    v.items.iter().map(|i| out.text[i.span.from..i.span.to].to_owned()).collect::<Vec<_>>().join(", ")
                )
            } else {
                raw.to_owned()
            };
            let sep = if out.text[..end].ends_with('\n') || end == 0 { "" } else { "\n" };
            edits.push(out.edit(end, end, format!("{sep}{r}: {value}")));
            fixes.push(BootFix { label: format!("Use replacement key '{r}'"), edits, define: None, workspace: None });
        }
    }
    let severity = if level == DeprecationLevel::Error { BootSeverity::Error } else { BootSeverity::Warning };
    out.push(out.main(), e.key_span, severity, message, fixes);
    out.problems.last_mut().unwrap().deprecated = true;
}

/// The span to delete with entry `index`: the entry, or its outermost ancestor that has
/// no other children.
fn empty_ancestors(doc: &Document, index: usize) -> Span {
    let mut span = doc.entries[index].span;
    let mut depth = doc.entries[index].depth;
    let mut i = index;
    while depth > 0 {
        let Some(parent) = (0..i).rev().find(|&j| doc.entries[j].depth < depth) else { break };
        let p = &doc.entries[parent];
        let children = doc.entries[parent + 1..]
            .iter()
            .take_while(|c| c.span.from < p.span.to)
            .filter(|c| c.depth == p.depth + 1)
            .count();
        if children != 1 {
            break;
        }
        span = p.span;
        depth = p.depth;
        i = parent;
    }
    span
}

fn check_value(cx: &Context, out: &mut Out, e: &Entry, resolved: &Resolved, v: &Value) {
    let Some(ty) = resolve::value_type(resolved) else { return };
    // Class names of drivers and class references.
    let hint = match resolved {
        Resolved::Property(p) => cx.index.hint(&p.key, HintTarget::Value),
        _ => None,
    };
    let class_reference =
        hint.is_some_and(|h| h.providers.iter().any(|p| matches!(p, ValueProvider::ClassReference { .. })));
    match v.kind {
        ValueKind::Scalar => {
            if dynamic(cx, &v.text) {
                return;
            }
            if class_reference && v.text.trim().contains('.') {
                check_class(cx, out, e, v);
                return;
            }
            match &ty {
                JavaType::List(item) => {
                    if v.text.trim().is_empty() {
                        return;
                    }
                    // A comma-separated list (properties, or a YAML scalar).
                    let raw = &out.text[v.span.from..v.span.to];
                    if v.quoted || !raw.contains(',') {
                        check_scalar(cx, out, item, &v.text, v.span);
                        return;
                    }
                    let mut start = v.span.from;
                    for part in raw.split(',') {
                        let lead = part.len() - part.trim_start().len();
                        let t = part.trim();
                        if !t.is_empty() {
                            check_scalar(cx, out, item, t, Span::new(start + lead, start + lead + t.len()));
                        }
                        start += part.len() + 1;
                    }
                }
                JavaType::Map(..) => structure_expected(cx, out, &ty, v),
                _ => check_scalar(cx, out, &ty, &v.text, v.span),
            }
        }
        ValueKind::Sequence => {
            let item = match &ty {
                JavaType::List(item) => (**item).clone(),
                // A sequence for a scalar String is joined with commas by the binder.
                JavaType::Scalar(Scalar::String | Scalar::Text | Scalar::Object) => return,
                _ => return,
            };
            for i in &v.items {
                if i.kind == ValueKind::Scalar && !dynamic(cx, &i.text) {
                    check_scalar(cx, out, &item, &i.text, i.span);
                }
            }
        }
        _ => {}
    }
}

/// A scalar where a map or bean is expected.
fn structure_expected(cx: &Context, out: &mut Out, ty: &JavaType, v: &Value) {
    if v.text.trim().is_empty() || shape(cx.oracle, ty) != Shape::Structure {
        return;
    }
    let message = format!("Cannot convert '{}' to {}", v.text.trim(), ty.display());
    out.push(out.main(), v.span, BootSeverity::Error, message, Vec::new());
}

fn check_scalar(cx: &Context, out: &mut Out, ty: &JavaType, text: &str, span: Span) {
    let t = text.trim();
    match ty {
        JavaType::Scalar(s) => {
            // An empty value binds null (or an empty string).
            if t.is_empty() || s.accepts(t) {
                return;
            }
            out.push(
                out.main(),
                span,
                BootSeverity::Error,
                format!("Cannot convert '{t}' to {}", s.qualified()),
                Vec::new(),
            );
        }
        JavaType::Class(c) => match cx.oracle.class_kind(c) {
            ClassKind::Enum(constants) => {
                if t.is_empty() {
                    return;
                }
                let want = name::uniform(t);
                // `LenientObjectToEnumConverterFactory`: relaxed names, and on/off for enums with
                // ON/OFF-like constants.
                let ok = constants.iter().any(|k| name::uniform(&k.name) == want)
                    || (matches!(want.as_str(), "true" | "false" | "on" | "off")
                        && constants
                            .iter()
                            .any(|k| matches!(name::uniform(&k.name).as_str(), "on" | "off" | "true" | "false")));
                if !ok {
                    out.push(out.main(), span, BootSeverity::Error, format!("Cannot convert '{t}' to {c}"), Vec::new());
                }
            }
            ClassKind::Bean(_) if !t.is_empty() => {
                out.push(out.main(), span, BootSeverity::Error, format!("Cannot convert '{t}' to {c}"), Vec::new());
            }
            _ => {}
        },
        _ => {}
    }
}

fn check_class(cx: &Context, out: &mut Out, e: &Entry, v: &Value) {
    let class = v.text.trim();
    if cx.oracle.class_exists(class) != Some(false) {
        return;
    }
    let driver = e.canonical.ends_with(".driverclassname") && e.canonical.starts_with("spring.");
    if driver {
        out.push(
            BootInspection::SpringDataNoDriverDependency,
            v.span,
            BootSeverity::Error,
            format!("Driver class '{class}' isn't found in dependencies"),
            Vec::new(),
        );
    } else {
        out.push(out.main(), v.span, BootSeverity::Error, format!("Cannot resolve class '{class}'"), Vec::new());
    }
}

fn check_imports(cx: &Context, out: &mut Out, v: &Value) {
    let items: Vec<(String, Span)> = match v.kind {
        ValueKind::Sequence => v.items.iter().map(|i| (i.text.clone(), i.span)).collect(),
        ValueKind::Scalar => {
            let raw = &out.text[v.span.from..v.span.to];
            let mut start = v.span.from;
            let mut parts = Vec::new();
            for part in raw.split(',') {
                let lead = part.len() - part.trim_start().len();
                let t = part.trim();
                if !t.is_empty() {
                    parts.push((
                        t.trim_matches(['"', '\'']).to_owned(),
                        Span::new(start + lead, start + lead + t.len()),
                    ));
                }
                start += part.len() + 1;
            }
            parts
        }
        _ => return,
    };
    for (item, span) in items {
        if item.starts_with("optional:") || dynamic(cx, &item) {
            continue;
        }
        let Some(path) = item.strip_prefix("classpath:") else { continue };
        let path = path.trim_start_matches('/');
        if path.contains('*') {
            out.push(
                BootInspection::SpringBootConfigImport,
                span,
                BootSeverity::Error,
                "Wildcard locations are not supported with 'classpath:'".into(),
                Vec::new(),
            );
            continue;
        }
        let directory = path.ends_with('/');
        let found = if directory {
            cx.project.resources.iter().any(|r| r.starts_with(path))
        } else {
            cx.project.resources.iter().any(|r| r == path)
        };
        if !found && !cx.project.resources.is_empty() {
            let fix = BootFix {
                label: "Add 'optional:' prefix".into(),
                edits: vec![out.edit(span.from, span.from, "optional:")],
                define: None,
                workspace: None,
            };
            out.push(
                BootInspection::SpringBootConfigImport,
                span,
                BootSeverity::Warning,
                format!("Config data location '{item}' does not exist"),
                vec![fix],
            );
        }
    }
}

fn placeholders(cx: &Context, out: &mut Out, doc: &Document) {
    for e in &doc.entries {
        let Some(v) = &e.value else { continue };
        let values: Vec<&Value> = match v.kind {
            ValueKind::Sequence => v.items.iter().collect(),
            ValueKind::Scalar | ValueKind::Block => vec![v],
            _ => continue,
        };
        for v in values {
            let raw = &out.text[v.span.from..v.span.to];
            for (key, from, to) in super::hover::placeholders(raw, v.span.from) {
                // With a default (`${x:d}`) there is nothing to report.
                let after = &out.text[to..];
                if after.trim_start().starts_with(':') {
                    continue;
                }
                if super::RUNTIME_PREFIXES.iter().any(|p| key.starts_with(p))
                    || key.chars().all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_')
                {
                    continue;
                }
                let canonical = name::canonical(&key);
                if cx.project.keys.iter().any(|k| k.canonical == canonical)
                    || doc.entries.iter().any(|k| k.canonical == canonical)
                    || cx.index.property(&canonical).is_some()
                {
                    continue;
                }
                out.push(
                    BootInspection::SpringBootUnresolvedPlaceholder,
                    Span::new(from, to),
                    BootSeverity::Warning,
                    format!("Cannot resolve placeholder '{key}'"),
                    Vec::new(),
                );
            }
        }
    }
}

/// The bean type of a property, for messages.
#[allow(dead_code)]
fn property_type(p: &Property) -> Option<JavaType> {
    type_of(p)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::analysis::fixtures::index;
    use crate::analysis::{Options, ProjectConfig};
    use crate::tests::FakeOracle;

    fn problems(format: Format, text: &str, profile: Option<&str>) -> Vec<BootProblem> {
        let ix = index();
        let project = ProjectConfig { resources: vec!["extra.yml".into(), "config/".into()], ..Default::default() };
        let options = Options { boot_major: Some(3), ..Default::default() };
        let cx =
            Context { index: &ix, oracle: &FakeOracle, project: &project, file_profile: profile, options: &options };
        validate(&cx, format, text)
    }

    fn messages(p: &[BootProblem]) -> Vec<&str> {
        p.iter().map(|p| p.message.as_str()).collect()
    }

    fn apply(text: &str, edits: &[BootTextEdit]) -> String {
        let mut s = text.to_owned();
        let mut edits = edits.to_vec();
        edits.sort_by_key(|e| std::cmp::Reverse(e.from));
        for e in edits {
            s.replace_range(e.from as usize..e.to as usize, &e.insert);
        }
        s
    }

    #[test]
    fn properties_problems() {
        let text = "server.prot=8080\nserver.port=ten\nserver.Port=1\nspring.datasource.old-name=x\nspring.datasource.initialization-mode=always\nserver.shutdown=fast\nserver.shutdown=SLOW_START\nspring.jpa.show-sql=on\napp.size=10MB\napp.version=@project.version@\nspring.datasource.driver-class-name=com.nope.Driver\napp.tags=a,b\nlogging.level.demo=debug\nunknown.key=${server.port}\n";
        let p = problems(Format::Properties, text, None);
        assert_eq!(
            messages(&p),
            [
                "Cannot resolve configuration property 'server.prot'. Did you mean 'server.port'?",
                "Cannot convert 'ten' to java.lang.Integer",
                "Duplicate key 'server.Port'",
                "Deprecated configuration property 'spring.datasource.old-name'",
                "Deprecated configuration property 'spring.datasource.initialization-mode'",
                "Duplicate key 'server.shutdown'",
                "Cannot resolve configuration property 'app.version'",
                "Driver class 'com.nope.Driver' isn't found in dependencies",
                "Cannot resolve configuration property 'unknown.key'",
            ]
        );
        let fix = &p[0].fixes[0];
        assert_eq!(fix.label, "Change to 'server.port'");
        assert_eq!(apply(text, &fix.edits).lines().next().unwrap(), "server.port=8080");
        assert!(p[0].fixes[1].define.is_some());
        assert_eq!(p[0].fixes[1].define.as_ref().unwrap().ty, "java.lang.Integer");
        assert!(p[3].deprecated && p[3].severity == BootSeverity::Warning);
        assert_eq!(p[4].severity, BootSeverity::Error);
        assert_eq!(apply(text, &p[3].fixes[0].edits).lines().nth(3).unwrap(), "spring.datasource.name=x");
    }

    #[test]
    fn yaml_problems() {
        let text = "server:\n  prot: 1\n  port: 2\nspring:\n  datasource:\n    old-name: x\n  nope:\n    deep: 1\napp:\n  servers:\n    - host: a\n      port: x\n  tags: [a, b]\n";
        let p = problems(Format::Yaml, text, None);
        assert_eq!(
            messages(&p),
            [
                "Cannot resolve configuration property 'server.prot'. Did you mean 'server.port'?",
                "Deprecated configuration property 'spring.datasource.old-name'",
                "Cannot resolve configuration property 'spring.nope'",
                "Cannot convert 'x' to java.lang.Integer",
            ]
        );
        assert_eq!(apply(text, &p[0].fixes[0].edits).lines().nth(1).unwrap(), "  port: 1");
        assert_eq!(apply(text, &p[1].fixes[0].edits).lines().nth(5).unwrap(), "    name: x");
    }

    #[test]
    fn yaml_replacement_elsewhere_moves_the_value() {
        let text = "spring:\n  datasource:\n    initialization-mode: always\n  jpa:\n    show-sql: true\n";
        let p = problems(Format::Yaml, text, None);
        let fix = &p[0].fixes[0];
        assert_eq!(apply(text, &fix.edits), "spring:\n  jpa:\n    show-sql: true\nspring.sql.init.mode: always\n");
    }

    #[test]
    fn profiles_and_imports() {
        let p = problems(
            Format::Properties,
            "spring.profiles.active=dev\nspring.config.activate.on-profile=x\n",
            Some("dev"),
        );
        assert_eq!(
            messages(&p),
            [
                "Property 'spring.profiles.active' is invalid in a profile specific resource",
                "Property 'spring.config.activate.on-profile' is invalid in a profile specific resource",
            ]
        );
        let p = problems(
            Format::Yaml,
            "a: 1\n---\nspring:\n  config:\n    activate:\n      on-profile: dev\n  profiles:\n    include: x\n",
            None,
        );
        assert!(messages(&p).contains(&"Property 'spring.profiles.include' is invalid in a profile specific resource"));
        let p = problems(Format::Yaml, "spring:\n  profiles: dev\n", None);
        assert_eq!(messages(&p), ["Property 'spring.profiles' is invalid: use 'spring.config.activate.on-profile'"]);
        let p = problems(
            Format::Properties,
            "spring.config.import=classpath:extra.yml,classpath:missing.yml,optional:classpath:nope.yml,classpath:*.yml\n",
            None,
        );
        assert_eq!(
            messages(&p),
            [
                "Config data location 'classpath:missing.yml' does not exist",
                "Wildcard locations are not supported with 'classpath:'",
            ]
        );
        let p = problems(
            Format::Properties,
            "spring.datasource.url=${db.url}\nx.y=${MISSING_ENV} ${random.int} ${z:1}\n",
            None,
        );
        assert!(messages(&p).contains(&"Cannot resolve placeholder 'db.url'"));
        assert_eq!(p.iter().filter(|p| p.inspection == BootInspection::SpringBootUnresolvedPlaceholder).count(), 1);
    }
}
