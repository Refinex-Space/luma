//! Completion in configuration files: keys (with YAML's nested structure), values (booleans,
//! enum constants, hints, value providers, profiles, import locations) and `${…}` placeholders.

use super::{Context, line_at, parse, removed};
use crate::ClassKind;
use crate::document::{Format, Utf16, ValueKind, unescape};
use crate::metadata::{HintTarget, ValueProvider};
use crate::name;
use crate::resolve::{self, Resolved, Shape, shape, type_of};
use crate::types::{JavaType, Scalar};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::{BTreeMap, HashSet};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct BootCompletion {
    /// UTF-16 range replaced by an item.
    pub from: u32,
    pub to: u32,
    pub items: Vec<BootCompletionItem>,
    /// For YAML keys: where the nested structure of an item goes.
    pub yaml: Option<YamlInsert>,
    /// The items are all there are for any text typed on (the editor filters them);
    /// `false` asks again as the text changes.
    pub complete: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum BootItemKind {
    Property,
    Group,
    Value,
    Enum,
    Keyword,
    Profile,
    File,
    Class,
    Logger,
    Bean,
}

/// What follows an inserted key.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum BootSuffix {
    /// A value: `key=` / `key: `.
    Value,
    /// A YAML sequence of values (`key:\n  - `); `key=` in properties.
    List,
    /// Nested keys: `key.` / `key:\n  ` (a bean, a map).
    Nested,
    /// Indexed items: `key[` / `key:\n  - ` (a list of beans).
    Index,
    /// Nothing (values).
    None,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct BootCompletionItem {
    pub label: String,
    pub kind: BootItemKind,
    /// The type column.
    pub detail: Option<String>,
    /// Inserted instead of `label` (values with a different form).
    pub insert: Option<String>,
    /// The property documented in the side panel (`spring_boot_describe`).
    pub key: Option<String>,
    pub deprecated: bool,
    pub replacement: Option<String>,
    /// A short description (values).
    pub description: Option<String>,
    /// YAML keys: the elements written under the context's parent.
    pub elements: Vec<String>,
    pub suffix: BootSuffix,
    pub boost: i32,
    /// The item is the property's default value.
    pub is_default: bool,
}

impl BootCompletionItem {
    fn new(label: impl Into<String>, kind: BootItemKind) -> Self {
        Self {
            label: label.into(),
            kind,
            detail: None,
            insert: None,
            key: None,
            deprecated: false,
            replacement: None,
            description: None,
            elements: Vec::new(),
            suffix: BootSuffix::None,
            boost: 0,
            is_default: false,
        }
    }
}

/// Where YAML structure is inserted (see `config/yamlInsert.ts`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct YamlInsert {
    /// Canonical key of the context's parent mapping (empty at the root).
    pub parent: String,
    /// Column of the key being typed.
    pub column: u32,
    pub indent_unit: u32,
    /// UTF-16 range of the line being typed (removed when the key merges elsewhere).
    pub line_from: u32,
    pub line_to: u32,
    /// Mappings of the current document under the parent: where a child key goes.
    pub paths: Vec<YamlPath>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct YamlPath {
    /// Canonical key.
    pub key: String,
    /// UTF-16 offset after the last line of the mapping's block.
    pub at: u32,
    /// Column of the mapping's children.
    pub indent: u32,
}

/// What the caret is in.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Site {
    /// A key: `parent` (written elements of the YAML parents), typed text from `from`.
    Key { from: usize, typed: String, parent: Vec<String>, column: usize, line: (usize, usize) },
    /// The value of `key` (full, as written); `from` starts the item being typed.
    Value { key: String, from: usize, typed: String, list: bool },
    /// Inside `${`.
    Placeholder { from: usize, typed: String },
}

pub fn complete(cx: &Context, format: Format, text: &str, offset: u32, explicit: bool) -> Option<BootCompletion> {
    let u = Utf16::new(text);
    let at = u.byte(offset);
    let site = match format {
        Format::Properties => properties_site(text, at)?,
        Format::Yaml => yaml_site(text, at)?,
    };
    let mut yaml = None;
    let (from, items, complete) = match site {
        Site::Key { from, typed, parent, column, line } => {
            if typed.is_empty() && !explicit && format == Format::Properties && column > 0 {
                return None;
            }
            let parent_key = parent.join(".").replace(".[", "[");
            let items = key_items(cx, format, &parent_key, &typed);
            if format == Format::Yaml {
                yaml = Some(yaml_insert(cx, text, &u, &parent_key, column, line));
            }
            (from, items, true)
        }
        Site::Value { key, from, typed, list } => {
            let (items, complete) = value_items(cx, &key, &typed, list);
            (from, items, complete)
        }
        Site::Placeholder { from, typed: _ } => (from, placeholder_items(cx), true),
    };
    if items.is_empty() {
        return None;
    }
    Some(BootCompletion { from: u.of(from), to: offset, items, yaml, complete })
}

// ---------------------------------------------------------------------------
// Where the caret is

/// Byte position in `line` where a properties key ends (an unescaped separator).
fn key_end(line: &str) -> usize {
    let b = line.as_bytes();
    let mut escaped = false;
    for (i, &c) in b.iter().enumerate() {
        if escaped {
            escaped = false;
        } else if c == b'\\' {
            escaped = true;
        } else if matches!(c, b'=' | b':' | b' ' | b'\t') {
            return i;
        }
    }
    b.len()
}

pub(crate) fn properties_site(text: &str, at: usize) -> Option<Site> {
    let (ls, le) = line_at(text, at);
    // A continuation line belongs to the previous logical line: not completed.
    if ls >= 2 {
        let prev_end = ls - 1;
        let (ps, _) = line_at(text, prev_end.saturating_sub(1));
        let prev = text[ps..prev_end].trim_end_matches('\r');
        if prev.bytes().rev().take_while(|b| *b == b'\\').count() % 2 == 1 && !prev.trim_start().starts_with(['#', '!'])
        {
            return None;
        }
    }
    let line = &text[ls..le];
    let col = at - ls;
    let lead = line.len() - line.trim_start_matches([' ', '\t', '\u{c}']).len();
    let body = &line[lead..];
    if body.starts_with(['#', '!']) {
        return None;
    }
    if col <= lead {
        return Some(Site::Key { from: at, typed: String::new(), parent: Vec::new(), column: col, line: (ls, le) });
    }
    let kend = lead + key_end(body);
    if col <= kend {
        return Some(Site::Key {
            from: ls + lead,
            typed: line[lead..col].to_owned(),
            parent: Vec::new(),
            column: lead,
            line: (ls, le),
        });
    }
    let mut vstart = kend;
    let bytes = line.as_bytes();
    while vstart < line.len() && matches!(bytes[vstart], b' ' | b'\t') {
        vstart += 1;
    }
    if vstart < line.len() && matches!(bytes[vstart], b'=' | b':') {
        vstart += 1;
        while vstart < line.len() && matches!(bytes[vstart], b' ' | b'\t') {
            vstart += 1;
        }
    }
    let vstart = vstart.min(col);
    let key = unescape(&line[lead..kend], true)?;
    let typed = &line[vstart..col];
    value_site(key, ls + vstart, typed)
}

fn value_site(key: String, from: usize, typed: &str) -> Option<Site> {
    if let Some(p) = typed.rfind("${")
        && !typed[p..].contains('}')
    {
        return Some(Site::Placeholder { from: from + p + 2, typed: typed[p + 2..].to_owned() });
    }
    // A comma-separated list: the item after the last comma.
    if let Some(c) = typed.rfind(',') {
        let item = &typed[c + 1..];
        let skip = item.len() - item.trim_start().len();
        return Some(Site::Value { key, from: from + c + 1 + skip, typed: item.trim_start().to_owned(), list: true });
    }
    Some(Site::Value { key, from, typed: typed.to_owned(), list: false })
}

fn indentation(line: &str) -> usize {
    line.len() - line.trim_start_matches(' ').len()
}

/// The key of a YAML line (`  name: value` → `name`), with the column after `:` when there
/// is one. Quoted keys are unquoted.
fn yaml_key(content: &str) -> Option<(String, usize)> {
    let b = content.as_bytes();
    let (mut i, quote) = match b.first() {
        Some(b'"') => (1, Some(b'"')),
        Some(b'\'') => (1, Some(b'\'')),
        _ => (0, None),
    };
    if let Some(q) = quote {
        while i < b.len() && b[i] != q {
            i += 1;
        }
        let k = content.get(1..i)?.to_owned();
        let rest = content.get(i + 1..)?;
        let colon = rest.find(':')?;
        return Some((k, i + 1 + colon + 1));
    }
    while i < b.len() {
        if b[i] == b':' && (i + 1 == b.len() || b[i + 1] == b' ' || b[i + 1] == b'\t') {
            return Some((content[..i].trim_end().to_owned(), i + 1));
        }
        if b[i] == b'#' && i > 0 && b[i - 1] == b' ' {
            return None;
        }
        i += 1;
    }
    None
}

/// What follows a key's `:` (comments removed, trimmed).
fn after_colon(content: &str, colon: usize) -> &str {
    let rest = &content[colon..];
    let rest = match rest.find(" #") {
        Some(i) => &rest[..i],
        None => rest,
    };
    rest.trim()
}

/// The written keys of the YAML mappings containing column `column` of the line at `ls`,
/// outermost first (`[i]` for sequence items); `None` inside a block scalar.
pub(crate) fn yaml_parents(text: &str, ls: usize, column: usize) -> Option<Vec<String>> {
    let mut path: Vec<String> = Vec::new();
    let mut limit = column;
    let mut end = ls;
    // Dashes seen at the current sequence column while looking for the sequence's key.
    let mut seq: Option<(usize, usize)> = None; // (dash column, items before ours)
    while end > 0 && limit > 0 {
        let (s, e) = line_at(text, end - 1);
        end = s;
        let line = &text[s..e];
        let trimmed = line.trim_start();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        if line.starts_with("---") || line.starts_with("...") {
            break;
        }
        let ind = indentation(line);
        if let Some((dash, n)) = seq {
            if ind == dash && trimmed.starts_with('-') {
                seq = Some((dash, n + 1));
                continue;
            }
            if ind >= dash {
                continue;
            }
            // The key owning the sequence.
            path.push(format!("[{n}]"));
            seq = None;
        }
        if ind >= limit {
            continue;
        }
        let (content, content_col, dash) = if let Some(rest) = trimmed.strip_prefix("- ") {
            let skip = rest.len() - rest.trim_start().len();
            (&rest[skip..], ind + 2 + skip, true)
        } else if trimmed == "-" {
            ("", ind + 2, true)
        } else {
            (trimmed, ind, false)
        };
        if dash {
            // Inside a sequence item: its own key when we are below it, then the index.
            if content_col < limit
                && let Some((k, colon)) = yaml_key(content)
            {
                let v = after_colon(content, colon);
                if v.starts_with(['|', '>']) {
                    return None;
                }
                if v.is_empty() {
                    path.push(k);
                }
            }
            seq = Some((ind, 0));
            limit = ind;
            continue;
        }
        match yaml_key(content) {
            Some((k, colon)) => {
                let v = after_colon(content, colon);
                if v.starts_with(['|', '>']) {
                    return None;
                }
                if !v.is_empty() && !v.starts_with('&') && !v.starts_with('!') {
                    // A scalar-valued key above with less indentation: not a parent.
                    limit = content_col;
                    continue;
                }
                path.push(k);
                limit = content_col;
            }
            None => {
                limit = content_col;
            }
        }
    }
    if let Some((_, n)) = seq {
        path.push(format!("[{n}]"));
    }
    path.reverse();
    Some(path)
}

pub(crate) fn yaml_site(text: &str, at: usize) -> Option<Site> {
    let (ls, le) = line_at(text, at);
    let line = &text[ls..le];
    let col = at - ls;
    let trimmed = line.trim_start();
    if trimmed.starts_with('#') || line.starts_with("---") || line.starts_with("...") {
        return None;
    }
    let indent = indentation(line);
    let mut key_col = indent;
    let mut item = false;
    if trimmed.starts_with("- ") || trimmed == "-" {
        let rest = &trimmed[1..];
        key_col = indent + 1 + (rest.len() - rest.trim_start().len());
        item = true;
    }
    if col < key_col {
        if item {
            return None;
        }
        let parent = yaml_parents(text, ls, col)?;
        return Some(Site::Key { from: at, typed: String::new(), parent, column: col, line: (ls, le) });
    }
    let content = &line[key_col..];
    let parents = yaml_parents(text, ls, if item { indent } else { key_col })?;
    let written = |mut p: Vec<String>, k: &str| {
        p.push(k.to_owned());
        p.join(".").replace(".[", "[")
    };
    if let Some((k, colon)) = yaml_key(content)
        && key_col + colon <= col
    {
        // The value of `k`.
        let vtext = &content[colon..col - key_col];
        let skip = vtext.len() - vtext.trim_start().len();
        let vtext = vtext.trim_start();
        if vtext.starts_with(['[', '{', '|', '>', '&', '*', '!']) {
            return None;
        }
        let (vtext, quote) = match vtext.as_bytes().first() {
            Some(b'"') | Some(b'\'') => (&vtext[1..], 1),
            _ => (vtext, 0),
        };
        let key = if item { written(item_path(text, ls, indent, parents), &k) } else { written(parents, &k) };
        return value_site(key, ls + key_col + colon + skip + quote, vtext);
    }
    if item {
        // `- value` of a sequence, or the first key of a sequence item's mapping.
        let owner = parents.join(".").replace(".[", "[");
        let typed = &line[key_col..col];
        if !owner.is_empty() {
            return Some(Site::Value { key: owner, from: ls + key_col, typed: typed.to_owned(), list: true });
        }
        return None;
    }
    let typed = &line[key_col..col];
    if typed.contains(['"', '\'', '{', '[']) {
        return None;
    }
    Some(Site::Key { from: ls + key_col, typed: typed.to_owned(), parent: parents, column: key_col, line: (ls, le) })
}

/// The written path of the sequence item on the line at `ls` (dash at `dash`): parents with
/// the item's index.
fn item_path(text: &str, ls: usize, dash: usize, parents: Vec<String>) -> Vec<String> {
    // Count dashes at the same column above, up to the sequence's key.
    let mut n = 0;
    let mut end = ls;
    while end > 0 {
        let (s, e) = line_at(text, end - 1);
        end = s;
        let line = &text[s..e];
        let t = line.trim_start();
        if t.is_empty() || t.starts_with('#') {
            continue;
        }
        let ind = indentation(line);
        if ind < dash || (ind == dash && !t.starts_with('-')) {
            break;
        }
        if ind == dash {
            n += 1;
        }
    }
    let mut p = parents;
    p.push(format!("[{n}]"));
    p
}

// ---------------------------------------------------------------------------
// Keys

fn suffix_of(cx: &Context, ty: Option<&JavaType>) -> BootSuffix {
    let Some(ty) = ty else { return BootSuffix::Value };
    match ty {
        JavaType::Map(..) => BootSuffix::Nested,
        JavaType::List(e) => match shape(cx.oracle, e) {
            Shape::Structure => BootSuffix::Index,
            _ => BootSuffix::List,
        },
        _ => match shape(cx.oracle, ty) {
            Shape::Structure => BootSuffix::Nested,
            _ => BootSuffix::Value,
        },
    }
}

/// Element count of a canonical key.
fn element_count(canonical: &str) -> usize {
    if canonical.is_empty() { 0 } else { name::elements(canonical).len() }
}

/// The elements of a metadata name after the first `skip` (kebab-case as written there).
fn rest_elements(name: &str, skip: usize) -> Vec<String> {
    name::elements(name)
        .into_iter()
        .skip(skip)
        .map(|e| if e.indexed { format!("[{}]", e.text) } else { e.text.to_owned() })
        .collect()
}

fn join_elements(e: &[String]) -> String {
    e.join(".").replace(".[", "[")
}

pub(crate) fn key_items(cx: &Context, format: Format, parent_written: &str, typed: &str) -> Vec<BootCompletionItem> {
    let ix = cx.index;
    let parent = name::canonical(parent_written);
    let skip = element_count(&parent);
    let typed_canonical = name::canonical(typed);
    let mut items = Vec::new();
    // Inside a map, a list item or a nested bean: what that type offers.
    if !parent.is_empty() && ix.property(&parent).is_some_or_nested(cx, parent_written) {
        items.extend(nested_key_items(cx, parent_written));
        if !items.is_empty() {
            return items;
        }
    }
    let mut children: BTreeMap<String, (bool, Vec<String>)> = BTreeMap::new();
    for p in ix.properties_under(&parent) {
        let full = name::join(&parent, name::rest_under(&p.key, &parent));
        if removed(p) && typed_canonical != full && typed_canonical != name::rest_under(&p.key, &parent) {
            continue;
        }
        let elements = rest_elements(&p.name, skip);
        if elements.is_empty() {
            continue;
        }
        let ty = type_of(p);
        let mut item = BootCompletionItem::new(
            if format == Format::Yaml { join_elements(&elements) } else { p.name.to_string() },
            BootItemKind::Property,
        );
        item.detail = ty.as_ref().map(JavaType::display);
        item.key = Some(p.name.to_string());
        item.suffix = suffix_of(cx, ty.as_ref());
        if let Some(d) = &p.deprecation {
            item.deprecated = true;
            item.replacement = d.replacement.clone();
            item.boost = -20;
        }
        if format == Format::Yaml {
            // The first element as a parent mapping too (`datasource` under `spring`).
            if elements.len() > 1 {
                children.entry(elements[0].clone()).or_insert((false, vec![elements[0].clone()]));
            } else if let Some(c) = children.get_mut(&elements[0]) {
                c.0 = true;
            }
        }
        item.elements = elements;
        items.push(item);
    }
    match format {
        Format::Yaml => {
            for (label, (is_property, elements)) in children {
                if is_property || items.iter().any(|i| i.elements.len() == 1 && i.elements[0] == label) {
                    continue;
                }
                let mut item = BootCompletionItem::new(label.clone(), BootItemKind::Group);
                item.elements = elements;
                item.suffix = BootSuffix::Nested;
                item.boost = 5;
                item.key = Some(join_elements(&[parent_written.to_owned(), label]).trim_start_matches('.').to_owned());
                items.push(item);
            }
        }
        Format::Properties => {
            for g in ix.groups_under(&parent) {
                if items.iter().any(|i| i.label == *g.name) {
                    continue;
                }
                let mut item = BootCompletionItem::new(format!("{}.", g.name), BootItemKind::Group);
                item.insert = Some(format!("{}.", g.name));
                item.detail = g.ty.as_deref().map(crate::types::display_type);
                item.key = Some(g.name.to_string());
                item.suffix = BootSuffix::None;
                item.boost = -1;
                items.push(item);
            }
            // Known keys of maps (`logging.level.root`).
            for p in ix.properties_under(&parent) {
                if let Some(h) = ix.hint(&p.key, HintTarget::Keys) {
                    for v in &h.values {
                        let mut item =
                            BootCompletionItem::new(format!("{}.{}", p.name, v.value), BootItemKind::Property);
                        item.description = v.description.clone();
                        item.key = Some(p.name.to_string());
                        item.suffix = BootSuffix::Value;
                        items.push(item);
                    }
                }
            }
        }
    }
    let mut seen = HashSet::new();
    items.retain(|i| seen.insert((i.label.clone(), i.kind as u8)));
    items
}

trait NestedParent {
    fn is_some_or_nested(&self, cx: &Context, parent: &str) -> bool;
}

impl NestedParent for Option<&crate::metadata::Property> {
    /// Whether `parent` is a property itself, or lies under one (a map entry, a list item).
    fn is_some_or_nested(&self, cx: &Context, parent: &str) -> bool {
        self.is_some() || matches!(resolve::resolve(cx.index, cx.oracle, parent), Resolved::Nested { .. })
    }
}

/// Keys inside a map / list item / bean value: map key hints, enum keys, bean properties.
fn nested_key_items(cx: &Context, parent: &str) -> Vec<BootCompletionItem> {
    let resolved = resolve::resolve(cx.index, cx.oracle, parent);
    let (property, ty) = match &resolved {
        Resolved::Property(p) => (*p, type_of(p)),
        Resolved::Nested { property, ty, .. } => (*property, ty.clone()),
        _ => return Vec::new(),
    };
    let mut items = Vec::new();
    match ty {
        Some(JavaType::Map(k, v)) => {
            let suffix = match shape(cx.oracle, &v) {
                Shape::Structure => BootSuffix::Nested,
                _ => BootSuffix::Value,
            };
            if let Some(h) = cx.index.hint(&property.key, HintTarget::Keys) {
                for hv in &h.values {
                    let mut item = BootCompletionItem::new(hv.value.clone(), BootItemKind::Value);
                    item.description = hv.description.clone();
                    item.elements = vec![hv.value.clone()];
                    item.suffix = suffix;
                    items.push(item);
                }
            }
            if let JavaType::Class(c) = &*k
                && let ClassKind::Enum(constants) = cx.oracle.class_kind(c)
            {
                for c in constants {
                    let label = name::kebab(&c.name.to_lowercase());
                    let mut item = BootCompletionItem::new(label.clone(), BootItemKind::Enum);
                    item.description = c.description;
                    item.elements = vec![label];
                    item.suffix = suffix;
                    items.push(item);
                }
            }
        }
        Some(JavaType::Class(c)) => {
            if let ClassKind::Bean(props) = cx.oracle.class_kind(&c) {
                for bp in props {
                    let ty = bp.ty.as_deref().and_then(JavaType::parse);
                    let mut item = BootCompletionItem::new(bp.name.clone(), BootItemKind::Property);
                    item.detail = ty.as_ref().map(JavaType::display);
                    item.description = bp.description;
                    item.elements = vec![bp.name];
                    item.suffix = suffix_of(cx, ty.as_ref());
                    items.push(item);
                }
            }
        }
        _ => {}
    }
    items
}

fn yaml_insert(
    cx: &Context,
    text: &str,
    u: &Utf16,
    parent_written: &str,
    column: usize,
    line: (usize, usize),
) -> YamlInsert {
    let _ = cx;
    let parent = name::canonical(parent_written);
    // The line being typed is incomplete: parsed blank, so the rest keeps its structure.
    let mut blank = String::with_capacity(text.len());
    blank.push_str(&text[..line.0]);
    blank.extend(text[line.0..line.1].chars().map(|c| if c.is_whitespace() { c } else { ' ' }));
    blank.push_str(&text[line.1..]);
    let text = blank.as_str();
    let file = parse(Format::Yaml, text);
    let doc = file.document_at(line.0);
    let mut paths = Vec::new();
    let mut unit = 0usize;
    if let Some(doc) = doc {
        for (i, e) in doc.entries.iter().enumerate() {
            let Some(v) = &e.value else { continue };
            if v.kind != ValueKind::Mapping || !name::is_under(&e.canonical, &parent) && !parent.is_empty() {
                continue;
            }
            if parent.is_empty() && e.canonical.is_empty() {
                continue;
            }
            // Not the mapping being typed in.
            if e.span.from <= line.0 && line.0 <= e.span.to && e.canonical == parent {
                continue;
            }
            let Some(child) = doc.entries[i + 1..].iter().find(|c| c.depth == e.depth + 1) else { continue };
            let child_col = column_of(text, child.key_span.from);
            let key_col = column_of(text, e.key_span.from);
            if unit == 0 && child_col > key_col {
                unit = child_col - key_col;
            }
            // After the last line of the block (its last entry's line), skipping the line typed in.
            let last = doc.entries[i..]
                .iter()
                .take_while(|c| c.span.from <= e.span.to)
                .filter(|c| !(c.span.from >= line.0 && c.span.from <= line.1))
                .map(|c| c.span.to)
                .max()
                .unwrap_or(e.span.to);
            let (_, end) = line_at(text, last.saturating_sub(1).max(e.span.from));
            paths.push(YamlPath { key: e.canonical.clone(), at: u.of(end), indent: child_col as u32 });
        }
    }
    YamlInsert {
        parent,
        column: column as u32,
        indent_unit: if unit == 0 { 2 } else { unit as u32 },
        line_from: u.of(line.0),
        line_to: u.of(line.1),
        paths,
    }
}

fn column_of(text: &str, byte: usize) -> usize {
    let (s, _) = line_at(text, byte);
    text[s..byte].chars().count()
}

// ---------------------------------------------------------------------------
// Values

const PROFILE_KEYS: [&str; 4] = [
    "spring.profiles.active",
    "spring.profiles.include",
    "spring.profiles.default",
    "spring.config.activate.onprofile",
];

const CHARSETS: [&str; 8] = ["UTF-8", "US-ASCII", "ISO-8859-1", "UTF-16", "UTF-16BE", "UTF-16LE", "GBK", "GB18030"];
const LOCALES: [&str; 12] = ["en", "en_US", "en_GB", "zh_CN", "zh_TW", "de", "fr", "ja", "ko", "es", "it", "pt_BR"];
const MIME_TYPES: [&str; 10] = [
    "application/json",
    "application/xml",
    "application/octet-stream",
    "application/x-www-form-urlencoded",
    "multipart/form-data",
    "text/plain",
    "text/html",
    "text/css",
    "text/event-stream",
    "image/png",
];
const DURATIONS: [&str; 6] = ["500ms", "10s", "30s", "1m", "5m", "1h"];
const DATA_SIZES: [&str; 5] = ["512KB", "1MB", "10MB", "100MB", "1GB"];
const IMPORT_PREFIXES: [&str; 4] = ["optional:", "classpath:", "file:", "configtree:"];

fn value_item(value: impl Into<String>, kind: BootItemKind, description: Option<String>) -> BootCompletionItem {
    let mut item = BootCompletionItem::new(value, kind);
    item.description = description;
    item
}

/// Values for `key` (as written); `typed` is the text before the caret. Returns whether
/// the list is complete for any text typed on.
pub(crate) fn value_items(cx: &Context, key: &str, typed: &str, _list: bool) -> (Vec<BootCompletionItem>, bool) {
    let canonical = name::canonical(key);
    let mut items = Vec::new();
    let mut complete = true;
    if PROFILE_KEYS.contains(&canonical.as_str()) || name::is_under(&canonical, "spring.profiles.group") {
        items.extend(cx.project.profiles.iter().map(|p| value_item(p.clone(), BootItemKind::Profile, None)));
        return (items, true);
    }
    if canonical == "spring.config.import" {
        return (import_items(cx, typed), true);
    }
    let resolved = resolve::resolve(cx.index, cx.oracle, key);
    let (hint, ty, default) = match &resolved {
        Resolved::Property(p) => (
            cx.index.hint(&p.key, HintTarget::Value),
            type_of(p),
            p.default.as_ref().and_then(crate::metadata::value_text),
        ),
        Resolved::Nested { property, ty, .. } => {
            let map_values = matches!(type_of(property), Some(JavaType::Map(..)));
            (if map_values { cx.index.hint(&property.key, HintTarget::Values) } else { None }, ty.clone(), None)
        }
        _ => (None, None, None),
    };
    let element = match &ty {
        Some(JavaType::List(e)) => Some((**e).clone()),
        t => t.clone(),
    };
    if let Some(h) = hint {
        for v in &h.values {
            items.push(value_item(v.value.clone(), BootItemKind::Value, v.description.clone()));
        }
        for p in &h.providers {
            match p {
                ValueProvider::ClassReference { target, concrete } => {
                    for c in cx.oracle.subclasses(target.as_deref(), *concrete, 1000) {
                        let mut item = value_item(c.clone(), BootItemKind::Class, None);
                        item.detail = Some(crate::types::simple(&c).to_owned());
                        items.push(item);
                    }
                }
                ValueProvider::HandleAs { target } => {
                    if let Some(t) = JavaType::parse(target) {
                        let t = match t {
                            JavaType::List(e) => *e,
                            t => t,
                        };
                        type_items(cx, &t, typed, &mut items);
                    }
                }
                ValueProvider::LoggerName { group } => {
                    complete = false;
                    for n in cx.oracle.logger_names(typed, 200) {
                        items.push(value_item(n, BootItemKind::Logger, None));
                    }
                    if *group {
                        for k in &cx.project.keys {
                            if let Some(g) = name::is_under(&k.canonical, "logging.group")
                                .then(|| name::rest_under(&k.key, "logging.group"))
                            {
                                let g = k.key.rsplit('.').next().unwrap_or(g).to_owned();
                                items.push(value_item(g, BootItemKind::Logger, None));
                            }
                        }
                        for g in ["web", "sql"] {
                            items.push(value_item(g, BootItemKind::Logger, None));
                        }
                    }
                }
                ValueProvider::SpringBeanReference { target } => {
                    for (bean, ty) in cx.oracle.beans(target.as_deref()) {
                        let mut item = value_item(bean, BootItemKind::Bean, None);
                        item.detail = Some(crate::types::simple(&ty).to_owned());
                        items.push(item);
                    }
                }
                ValueProvider::SpringProfileName => {
                    items
                        .extend(cx.project.profiles.iter().map(|p| value_item(p.clone(), BootItemKind::Profile, None)));
                }
                ValueProvider::Any | ValueProvider::Unknown(_) => {}
            }
        }
    }
    if let Some(t) = &element {
        type_items(cx, t, typed, &mut items);
    }
    if let Some(d) = default {
        for i in &mut items {
            if i.label.eq_ignore_ascii_case(&d) {
                i.is_default = true;
                i.boost = i.boost.max(1);
            }
        }
    }
    let mut seen = HashSet::new();
    items.retain(|i| seen.insert(i.label.to_ascii_lowercase()));
    (items, complete)
}

/// Values of a type: booleans, enum constants, well-known charsets / locales / media types,
/// examples of durations and sizes.
fn type_items(cx: &Context, ty: &JavaType, typed: &str, items: &mut Vec<BootCompletionItem>) {
    let lower = typed.chars().next().is_some_and(char::is_lowercase);
    match ty {
        JavaType::Scalar(Scalar::Boolean) => {
            items.push(value_item("true", BootItemKind::Keyword, None));
            items.push(value_item("false", BootItemKind::Keyword, None));
        }
        JavaType::Scalar(Scalar::Charset) => {
            items.extend(CHARSETS.iter().map(|c| value_item(*c, BootItemKind::Value, None)))
        }
        JavaType::Scalar(Scalar::Locale) => {
            items.extend(LOCALES.iter().map(|c| value_item(*c, BootItemKind::Value, None)))
        }
        JavaType::Scalar(Scalar::MimeType) => {
            items.extend(MIME_TYPES.iter().map(|c| value_item(*c, BootItemKind::Value, None)))
        }
        JavaType::Scalar(Scalar::Duration) => items.extend(DURATIONS.iter().map(|c| {
            let mut i = value_item(*c, BootItemKind::Value, None);
            i.boost = -5;
            i
        })),
        JavaType::Scalar(Scalar::DataSize) => items.extend(DATA_SIZES.iter().map(|c| {
            let mut i = value_item(*c, BootItemKind::Value, None);
            i.boost = -5;
            i
        })),
        JavaType::Scalar(Scalar::Resource) => {
            for r in cx.project.resources.iter().take(500) {
                items.push(value_item(format!("classpath:{r}"), BootItemKind::File, None));
            }
        }
        JavaType::Class(c) => {
            if let ClassKind::Enum(constants) = cx.oracle.class_kind(c) {
                for k in constants {
                    // Lowercase when the user started lowercase (`ALIASED`: both forms bind).
                    let label = if lower { k.name.to_lowercase().replace('_', "-") } else { k.name.clone() };
                    let mut item = value_item(label, BootItemKind::Enum, k.description);
                    item.detail = Some(crate::types::simple(c).to_owned());
                    items.push(item);
                }
            }
        }
        _ => {}
    }
}

fn import_items(cx: &Context, typed: &str) -> Vec<BootCompletionItem> {
    let rest = typed.strip_prefix("optional:").unwrap_or(typed);
    if let Some(path) = rest.strip_prefix("classpath:") {
        let _ = path;
        let base = &typed[..typed.len() - rest.len()];
        return cx
            .project
            .resources
            .iter()
            .filter(|r| r.ends_with(".yml") || r.ends_with(".yaml") || r.ends_with(".properties"))
            .map(|r| {
                let mut item = value_item(format!("{base}classpath:{r}"), BootItemKind::File, None);
                item.detail = Some("classpath".into());
                item
            })
            .collect();
    }
    let mut items: Vec<BootCompletionItem> = IMPORT_PREFIXES
        .iter()
        .filter(|p| !(typed.starts_with("optional:") && **p == "optional:"))
        .map(|p| {
            let mut i = value_item(format!("{}{p}", &typed[..typed.len() - rest.len()]), BootItemKind::Keyword, None);
            i.boost = 2;
            i
        })
        .collect();
    items.extend(
        cx.project
            .resources
            .iter()
            .filter(|r| r.ends_with(".yml") || r.ends_with(".yaml") || r.ends_with(".properties"))
            .map(|r| {
                let mut item = value_item(format!("classpath:{r}"), BootItemKind::File, None);
                item.detail = Some("classpath".into());
                item
            }),
    );
    items
}

fn placeholder_items(cx: &Context) -> Vec<BootCompletionItem> {
    let mut seen = HashSet::new();
    let mut items = Vec::new();
    for k in &cx.project.keys {
        if seen.insert(k.canonical.clone()) {
            let mut item = BootCompletionItem::new(k.key.clone(), BootItemKind::Property);
            item.detail = k.value.clone().map(|v| {
                if v.chars().count() > 40 { format!("{}…", v.chars().take(40).collect::<String>()) } else { v }
            });
            item.key = Some(k.key.clone());
            item.boost = 3;
            items.push(item);
        }
    }
    for p in cx.index.properties() {
        if removed(p) || !seen.insert(p.key.to_string()) {
            continue;
        }
        let mut item = BootCompletionItem::new(p.name.to_string(), BootItemKind::Property);
        item.detail = p.ty.as_deref().map(crate::types::display_type);
        item.key = Some(p.name.to_string());
        item.deprecated = p.deprecation.is_some();
        items.push(item);
    }
    for r in ["random.int", "random.long", "random.uuid", "random.value"] {
        items.push(value_item(r, BootItemKind::Keyword, None));
    }
    items
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::analysis::fixtures::index;
    use crate::analysis::{Options, ProjectConfig};
    use crate::tests::FakeOracle;

    fn run(format: Format, text_with_caret: &str) -> Option<BootCompletion> {
        let at = text_with_caret.find('|').unwrap();
        let text = text_with_caret.replace('|', "");
        let ix = index();
        let project = ProjectConfig {
            profiles: vec!["dev".into(), "prod".into()],
            resources: vec!["db/x.yml".into()],
            ..Default::default()
        };
        let options = Options::default();
        let cx = Context { index: &ix, oracle: &FakeOracle, project: &project, file_profile: None, options: &options };
        complete(&cx, format, &text, at as u32, true)
    }

    fn labels(c: &BootCompletion) -> Vec<&str> {
        c.items.iter().map(|i| i.label.as_str()).collect()
    }

    #[test]
    fn properties_keys_and_values() {
        let c = run(Format::Properties, "server.p|").unwrap();
        assert_eq!(c.from, 0);
        assert!(labels(&c).contains(&"server.port"));
        assert!(!labels(&c).contains(&"spring.datasource.initialization-mode"));
        let port = c.items.iter().find(|i| i.label == "server.port").unwrap();
        assert_eq!(port.detail.as_deref(), Some("Integer"));
        assert_eq!(port.suffix, BootSuffix::Value);
        let old = c.items.iter().find(|i| i.label == "spring.datasource.old-name").unwrap();
        assert!(old.deprecated);
        assert_eq!(old.replacement.as_deref(), Some("spring.datasource.name"));
        assert_eq!(c.items.iter().find(|i| i.label == "app.servers").unwrap().suffix, BootSuffix::Index);
        assert_eq!(c.items.iter().find(|i| i.label == "logging.level").unwrap().suffix, BootSuffix::Nested);
        assert!(labels(&c).contains(&"logging.level.root"));
        assert!(labels(&c).contains(&"spring.datasource."));

        let c = run(Format::Properties, "spring.jpa.show-sql=|").unwrap();
        assert_eq!(labels(&c), ["true", "false"]);
        assert!(c.items.iter().any(|i| i.label == "false" && i.is_default));
        let c = run(Format::Properties, "server.shutdown=f|").unwrap();
        assert_eq!(labels(&c), ["fast", "slow-start"]);
        let c = run(Format::Properties, "server.shutdown=|").unwrap();
        assert_eq!(labels(&c), ["FAST", "SLOW_START"]);
        let c = run(Format::Properties, "spring.main.banner-mode=|").unwrap();
        assert_eq!(labels(&c), ["off", "console", "log"]);
        let c = run(Format::Properties, "spring.datasource.driver-class-name=|").unwrap();
        assert_eq!(labels(&c), ["org.h2.Driver"]);
        let c = run(Format::Properties, "spring.profiles.active=dev,|").unwrap();
        assert_eq!(labels(&c), ["dev", "prod"]);
        assert_eq!(c.from, "spring.profiles.active=dev,".len() as u32);
        let c = run(Format::Properties, "logging.level.demo=|").unwrap();
        assert_eq!(labels(&c), ["info", "debug"]);
        let c = run(Format::Properties, "a=${serv|").unwrap();
        assert_eq!(c.from, 4);
        assert!(labels(&c).contains(&"server.port"));
        assert!(run(Format::Properties, "# comment |").is_none());
    }

    #[test]
    fn yaml_keys_under_parents() {
        let c = run(Format::Yaml, "spring:\n  datasource:\n    ur|\n").unwrap();
        assert!(labels(&c).contains(&"url"));
        assert!(labels(&c).contains(&"hikari.maximum-pool-size"));
        let y = c.yaml.unwrap();
        assert_eq!(y.parent, "spring.datasource");
        assert_eq!(y.column, 4);
        let c = run(Format::Yaml, "spring:\n  da|\n").unwrap();
        let group = c.items.iter().find(|i| i.label == "datasource").unwrap();
        assert_eq!(group.kind, BootItemKind::Group);
        assert_eq!(group.suffix, BootSuffix::Nested);
        // A root key in a document with `spring:` elsewhere: that mapping is a merge target.
        let c = run(Format::Yaml, "spring:\n  jpa:\n    show-sql: true\nserver:\n  port: 1\nspring.datasource.u|\n")
            .unwrap();
        let y = c.yaml.as_ref().unwrap();
        assert_eq!(y.parent, "");
        let spring = y.paths.iter().find(|p| p.key == "spring").unwrap();
        assert_eq!(spring.indent, 2);
        assert_eq!(spring.at as usize, "spring:\n  jpa:\n    show-sql: true".len());
        assert!(labels(&c).contains(&"spring.datasource.url"));
    }

    #[test]
    fn yaml_values_and_sequences() {
        let c = run(Format::Yaml, "server:\n  shutdown: |\n").unwrap();
        assert_eq!(labels(&c), ["FAST", "SLOW_START"]);
        let c = run(Format::Yaml, "spring:\n  profiles:\n    active:\n      - |\n").unwrap();
        assert_eq!(labels(&c), ["dev", "prod"]);
        let c = run(Format::Yaml, "app:\n  servers:\n    - host: a\n      |\n").unwrap();
        assert_eq!(labels(&c), ["host", "port"]);
        assert!(run(Format::Yaml, "app:\n  servers:\n    - host: a\n    - port: |\n").is_none());
        assert!(run(Format::Yaml, "text: |\n  some |\n").is_none());
    }

    #[test]
    fn parents_with_sequences() {
        let t = "app:\n  servers:\n    - host: a\n      port: 1\n    - host: b\n      x";
        let ls = t.rfind('\n').unwrap() + 1;
        assert_eq!(yaml_parents(t, ls, 6).unwrap(), ["app", "servers", "[1]"]);
        let t = "a:\n  b: 1\n  c:\n    d";
        let ls = t.rfind('\n').unwrap() + 1;
        assert_eq!(yaml_parents(t, ls, 4).unwrap(), ["a", "c"]);
        assert_eq!(yaml_parents(t, ls, 2).unwrap(), ["a"]);
        assert_eq!(yaml_parents(t, ls, 0).unwrap(), Vec::<String>::new());
    }
}
