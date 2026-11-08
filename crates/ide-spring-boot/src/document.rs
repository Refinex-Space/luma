//! The semantic view of a Spring Boot configuration file (`application.properties`,
//! `application.yml`): its documents (`---`, `#---`), the entries of each with their full
//! keys and values, and each document's profile activation. A syntax view, not a YAML
//! evaluator: anchors, aliases and merge keys are left alone.

use crate::name;
use tree_sitter::Node;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Format {
    Properties,
    Yaml,
}

impl Format {
    pub fn of(path: &str) -> Option<Format> {
        let ext = path.rsplit('.').next()?.to_ascii_lowercase();
        match ext.as_str() {
            "properties" => Some(Format::Properties),
            "yml" | "yaml" => Some(Format::Yaml),
            _ => None,
        }
    }
}

/// A byte range of the file text.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Span {
    pub from: usize,
    pub to: usize,
}

impl Span {
    pub fn new(from: usize, to: usize) -> Self {
        Self { from, to }
    }

    pub fn contains(&self, at: usize) -> bool {
        self.from <= at && at <= self.to
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ValueKind {
    /// A scalar (plain, quoted, or a properties value).
    Scalar,
    /// A literal or folded block (`|`, `>`).
    Block,
    /// A YAML sequence; `items` holds its scalar items.
    Sequence,
    /// A YAML mapping (the entry has children).
    Mapping,
    /// An alias, a tagged node, or anything else not checked.
    Other,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Value {
    pub kind: ValueKind,
    /// Unquoted, unescaped text (scalars and blocks).
    pub text: String,
    pub span: Span,
    pub quoted: bool,
    /// The scalar items of a sequence.
    pub items: Vec<Value>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Entry {
    /// The full key as written (`spring.datasource.url`, `my.list[0].name`).
    pub key: String,
    pub canonical: String,
    /// The key text of this entry in the file: the whole key in properties, the pair's own
    /// key in YAML.
    pub key_span: Span,
    /// Where the part of `key` written by parents ends (YAML), so that `key[prefix..]` is
    /// this entry's own key.
    pub prefix_len: usize,
    pub value: Option<Value>,
    /// Nesting depth (YAML; 0 for properties).
    pub depth: usize,
    /// The whole pair / line.
    pub span: Span,
}

impl Entry {
    /// Whether this entry is where a value is written (not a YAML parent of other entries).
    pub fn is_leaf(&self) -> bool {
        !matches!(self.value.as_ref().map(|v| v.kind), Some(ValueKind::Mapping))
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Document {
    pub span: Span,
    pub entries: Vec<Entry>,
    /// `spring.config.activate.on-profile`'s value.
    pub on_profile: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ConfigFile {
    pub format: Format,
    pub documents: Vec<Document>,
}

const ON_PROFILE: &str = "spring.config.activate.onprofile";

impl ConfigFile {
    pub fn parse(format: Format, text: &str) -> ConfigFile {
        let mut documents = match format {
            Format::Properties => properties(text),
            Format::Yaml => yaml(text),
        };
        for d in &mut documents {
            d.on_profile = d
                .entries
                .iter()
                .find(|e| e.canonical == ON_PROFILE)
                .and_then(|e| e.value.as_ref())
                .map(|v| if v.kind == ValueKind::Sequence { join_items(v) } else { v.text.clone() });
        }
        ConfigFile { format, documents }
    }

    /// The document containing byte offset `at`.
    pub fn document_at(&self, at: usize) -> Option<&Document> {
        self.documents.iter().find(|d| d.span.contains(at)).or(self.documents.last())
    }

    pub fn entries(&self) -> impl Iterator<Item = &Entry> {
        self.documents.iter().flat_map(|d| d.entries.iter())
    }
}

/// A sequence's items joined with `,` (a profile list written as a YAML sequence).
pub fn join_items(v: &Value) -> String {
    v.items.iter().map(|i| i.text.as_str()).collect::<Vec<_>>().join(",")
}

// ---------------------------------------------------------------------------
// .properties

fn properties(text: &str) -> Vec<Document> {
    let mut docs = vec![Document { span: Span::new(0, text.len()), ..Default::default() }];
    let mut logical = String::new();
    // Byte offset in `text` of each byte of `logical`.
    let mut offsets: Vec<usize> = Vec::new();
    let mut base = 0;
    let mut start_of_line = 0;
    let mut prev_comment = false;
    for line in text.split_inclusive('\n') {
        let physical = line.trim_end_matches(['\r', '\n']);
        let lead = physical.len() - physical.trim_start_matches([' ', '\t', '\u{c}']).len();
        let slice = &physical[lead..];
        if logical.is_empty() {
            start_of_line = base;
            // A document separator: `#---` or `!---` alone on a line, not after a comment.
            if (physical == "#---" || physical == "!---") && !prev_comment {
                let last = docs.last_mut().unwrap();
                last.span.to = base;
                docs.push(Document { span: Span::new(base, text.len()), ..Default::default() });
                base += line.len();
                prev_comment = false;
                continue;
            }
            if slice.is_empty() || slice.starts_with(['#', '!']) {
                prev_comment = slice.starts_with(['#', '!']);
                base += line.len();
                continue;
            }
            prev_comment = false;
        }
        let continued = slice.bytes().rev().take_while(|b| *b == b'\\').count() % 2 == 1;
        let begin = lead;
        let end = physical.len() - usize::from(continued);
        for (i, ch) in physical[begin..end].char_indices() {
            for b in 0..ch.len_utf8() {
                offsets.push(base + begin + i + b);
            }
            logical.push(ch);
        }
        if !continued || base + line.len() == text.len() {
            if let Some(entry) = property_entry(&logical, &offsets, start_of_line, base + physical.len()) {
                docs.last_mut().unwrap().entries.push(entry);
            }
            logical.clear();
            offsets.clear();
        }
        base += line.len();
    }
    docs
}

fn property_entry(logical: &str, offsets: &[usize], line_start: usize, line_end: usize) -> Option<Entry> {
    let bytes = logical.as_bytes();
    let mut i = 0;
    let mut escaped = false;
    while i < bytes.len() {
        let b = bytes[i];
        if escaped {
            escaped = false;
        } else if b == b'\\' {
            escaped = true;
        } else if matches!(b, b'=' | b':' | b' ' | b'\t' | 0x0c) {
            break;
        }
        i += 1;
    }
    let key_end = i;
    if key_end == 0 {
        return None;
    }
    let key = unescape(&logical[..key_end], true)?;
    // Separator: whitespace, then optionally one `=` or `:`, then whitespace.
    let mut j = key_end;
    while j < bytes.len() && matches!(bytes[j], b' ' | b'\t' | 0x0c) {
        j += 1;
    }
    if j < bytes.len() && matches!(bytes[j], b'=' | b':') {
        j += 1;
        while j < bytes.len() && matches!(bytes[j], b' ' | b'\t' | 0x0c) {
            j += 1;
        }
    }
    let raw_value = &logical[j..];
    let value_from = offsets.get(j).copied().unwrap_or(line_end);
    let value_to = if raw_value.is_empty() { value_from } else { offsets[logical.len() - 1] + 1 };
    let has_separator = j > key_end;
    let value = has_separator.then(|| Value {
        kind: ValueKind::Scalar,
        text: unescape(raw_value, false).unwrap_or_else(|| raw_value.to_owned()),
        span: Span::new(value_from, value_to),
        quoted: false,
        items: Vec::new(),
    });
    let key_span = Span::new(offsets[0], offsets[key_end - 1] + 1);
    Some(Entry {
        canonical: name::canonical(&key),
        key,
        key_span,
        prefix_len: 0,
        value,
        depth: 0,
        span: Span::new(line_start, line_end.max(value_to)),
    })
}

/// Unescapes a properties key or value (`\uXXXX`, `\t`, `\=`…).
pub fn unescape(raw: &str, _key: bool) -> Option<String> {
    let mut chars = raw.chars();
    let mut out = String::with_capacity(raw.len());
    while let Some(ch) = chars.next() {
        if ch != '\\' {
            out.push(ch);
            continue;
        }
        match chars.next() {
            Some('u') => {
                let hex: String = chars.by_ref().take(4).collect();
                if hex.len() != 4 {
                    return None;
                }
                out.push(char::from_u32(u32::from_str_radix(&hex, 16).ok()?)?);
            }
            Some('t') => out.push('\t'),
            Some('n') => out.push('\n'),
            Some('r') => out.push('\r'),
            Some('f') => out.push('\u{c}'),
            Some(ch) => out.push(ch),
            None => {}
        }
    }
    Some(out)
}

/// Escapes text as a properties key (`a b` → `a\ b`).
pub fn escape_key(key: &str) -> String {
    let mut out = String::with_capacity(key.len());
    for ch in key.chars() {
        match ch {
            ' ' | '=' | ':' | '#' | '!' | '\\' => {
                out.push('\\');
                out.push(ch);
            }
            '\t' => out.push_str("\\t"),
            '\n' => out.push_str("\\n"),
            _ => out.push(ch),
        }
    }
    out
}

// ---------------------------------------------------------------------------
// YAML

pub(crate) fn parse_yaml(text: &str) -> Option<tree_sitter::Tree> {
    let mut parser = tree_sitter::Parser::new();
    parser.set_language(&tree_sitter_yaml::LANGUAGE.into()).ok()?;
    parser.parse(text, None)
}

fn yaml(text: &str) -> Vec<Document> {
    let Some(tree) = parse_yaml(text) else {
        return vec![Document { span: Span::new(0, text.len()), ..Default::default() }];
    };
    let root = tree.root_node();
    let mut docs = Vec::new();
    let mut cursor = root.walk();
    let children: Vec<Node> = root.named_children(&mut cursor).filter(|n| n.kind() == "document").collect();
    if children.is_empty() {
        return vec![Document { span: Span::new(0, text.len()), ..Default::default() }];
    }
    for (i, doc) in children.iter().enumerate() {
        let from = if i == 0 { 0 } else { doc.start_byte() };
        let to = children.get(i + 1).map_or(text.len(), |n| n.start_byte());
        let mut d = Document { span: Span::new(from, to), ..Default::default() };
        walk(*doc, "", text, &mut d.entries, 0);
        docs.push(d);
    }
    docs
}

fn key_text(raw: &str) -> Option<String> {
    if raw.contains('\n') {
        return None;
    }
    let name = if raw.starts_with('\'') && raw.ends_with('\'') && raw.len() >= 2 {
        raw[1..raw.len() - 1].replace("''", "'")
    } else if raw.starts_with('"') {
        serde_json::from_str::<String>(raw).ok()?
    } else {
        if raw.contains(['{', '[', '*', '&', '!']) && !raw.contains("[") || raw == "<<" {
            return None;
        }
        if raw.starts_with(['*', '&', '!', '{']) || raw == "<<" {
            return None;
        }
        raw.to_owned()
    };
    (!name.is_empty()).then_some(name)
}

fn walk(node: Node<'_>, prefix: &str, text: &str, out: &mut Vec<Entry>, depth: usize) {
    if depth > 64 || out.len() >= 50_000 {
        return;
    }
    match node.kind() {
        "block_mapping_pair" | "flow_pair" => {
            let Some(key) = node.child_by_field_name("key") else { return };
            let Some(own) = key_text(&text[key.byte_range()]) else { return };
            let full = if prefix.is_empty() {
                own.clone()
            } else if own.starts_with('[') {
                format!("{prefix}{own}")
            } else {
                format!("{prefix}.{own}")
            };
            if full.len() > 2048 {
                return;
            }
            let value_node = node.child_by_field_name("value");
            let value = value_node.map(|v| value_of(v, text));
            let prefix_len = full.len() - own.len();
            out.push(Entry {
                canonical: name::canonical(&full),
                key: full.clone(),
                key_span: Span::new(key.start_byte(), key.end_byte()),
                prefix_len,
                value,
                depth,
                span: Span::new(node.start_byte(), node.end_byte()),
            });
            if let Some(v) = value_node {
                walk(v, &full, text, out, depth + 1);
            }
        }
        "block_sequence" | "flow_sequence" => {
            let mut cursor = node.walk();
            let items: Vec<Node> = node.named_children(&mut cursor).filter(|n| n.kind() != "comment").collect();
            for (i, child) in items.into_iter().enumerate() {
                walk(child, &format!("{prefix}[{i}]"), text, out, depth + 1);
            }
        }
        "stream"
        | "document"
        | "block_node"
        | "flow_node"
        | "block_mapping"
        | "flow_mapping"
        | "block_sequence_item" => {
            let mut cursor = node.walk();
            for child in node.named_children(&mut cursor) {
                walk(child, prefix, text, out, depth);
            }
        }
        _ => {}
    }
}

/// The node under `block_node` / `flow_node` wrappers (and sequence items).
fn inner(node: Node<'_>) -> Node<'_> {
    let mut n = node;
    loop {
        match n.kind() {
            "block_node" | "flow_node" | "block_sequence_item" => {
                let mut cursor = n.walk();
                let children: Vec<Node> = n.named_children(&mut cursor).filter(|c| c.kind() != "comment").collect();
                // A tag or anchor before the content makes the value something not checked.
                if children.iter().any(|c| matches!(c.kind(), "tag" | "anchor")) {
                    return n;
                }
                match children.last() {
                    Some(c) => n = *c,
                    None => return n,
                }
            }
            _ => return n,
        }
    }
}

fn value_of(node: Node<'_>, text: &str) -> Value {
    let n = inner(node);
    let span = Span::new(n.start_byte(), n.end_byte());
    let raw = &text[n.byte_range()];
    match n.kind() {
        "plain_scalar" => {
            Value { kind: ValueKind::Scalar, text: fold_plain(raw), span, quoted: false, items: Vec::new() }
        }
        "single_quote_scalar" => Value {
            kind: ValueKind::Scalar,
            text: raw.get(1..raw.len().saturating_sub(1)).unwrap_or("").replace("''", "'"),
            span,
            quoted: true,
            items: Vec::new(),
        },
        "double_quote_scalar" => Value {
            kind: ValueKind::Scalar,
            text: serde_json::from_str::<String>(raw)
                .unwrap_or_else(|_| raw.get(1..raw.len().saturating_sub(1)).unwrap_or("").to_owned()),
            span,
            quoted: true,
            items: Vec::new(),
        },
        "block_scalar" => {
            Value { kind: ValueKind::Block, text: block_text(raw), span, quoted: false, items: Vec::new() }
        }
        "block_sequence" | "flow_sequence" => {
            let mut cursor = n.walk();
            let items = n
                .named_children(&mut cursor)
                .filter(|c| c.kind() != "comment")
                .map(|c| value_of(c, text))
                .filter(|v| matches!(v.kind, ValueKind::Scalar | ValueKind::Block))
                .collect();
            Value { kind: ValueKind::Sequence, text: String::new(), span, quoted: false, items }
        }
        "block_mapping" | "flow_mapping" => {
            Value { kind: ValueKind::Mapping, text: String::new(), span, quoted: false, items: Vec::new() }
        }
        _ => Value { kind: ValueKind::Other, text: raw.to_owned(), span, quoted: false, items: Vec::new() },
    }
}

/// A multi-line plain scalar folds its lines with single spaces.
fn fold_plain(raw: &str) -> String {
    if !raw.contains('\n') {
        return raw.to_owned();
    }
    raw.lines().map(str::trim).filter(|l| !l.is_empty()).collect::<Vec<_>>().join(" ")
}

fn block_text(raw: &str) -> String {
    let mut lines = raw.lines();
    let _header = lines.next();
    let body: Vec<&str> = lines.collect();
    let indent =
        body.iter().filter(|l| !l.trim().is_empty()).map(|l| l.len() - l.trim_start().len()).min().unwrap_or(0);
    body.iter().map(|l| l.get(indent..).unwrap_or("")).collect::<Vec<_>>().join("\n")
}

/// Byte offset → UTF-16 offset conversion for one text.
pub struct Utf16<'a> {
    text: &'a str,
    ascii: bool,
}

impl<'a> Utf16<'a> {
    pub fn new(text: &'a str) -> Self {
        Self { text, ascii: text.is_ascii() }
    }

    pub fn of(&self, byte: usize) -> u32 {
        if self.ascii {
            return byte.min(self.text.len()) as u32;
        }
        let mut b = byte.min(self.text.len());
        while !self.text.is_char_boundary(b) {
            b -= 1;
        }
        self.text[..b].encode_utf16().count() as u32
    }

    /// Line and UTF-16 column of byte `byte`.
    pub fn pos(&self, byte: usize) -> ide_core::Pos {
        let mut b = byte.min(self.text.len());
        while !self.text.is_char_boundary(b) {
            b -= 1;
        }
        let line_start = self.text[..b].rfind('\n').map_or(0, |i| i + 1);
        let line = self.text[..line_start].matches('\n').count() as u32;
        ide_core::Pos::new(line, self.text[line_start..b].encode_utf16().count() as u32)
    }

    /// An LSP-style edit of byte range `from`–`to`.
    pub fn text_edit(&self, from: usize, to: usize, insert: impl Into<String>) -> ide_core::TextEdit {
        ide_core::TextEdit { range: ide_core::Range::new(self.pos(from), self.pos(to)), new_text: insert.into() }
    }

    /// UTF-16 offset → byte offset.
    pub fn byte(&self, utf16: u32) -> usize {
        if self.ascii {
            return (utf16 as usize).min(self.text.len());
        }
        let mut units = 0u32;
        for (i, ch) in self.text.char_indices() {
            if units >= utf16 {
                return i;
            }
            units += ch.len_utf16() as u32;
        }
        self.text.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn keys(f: &ConfigFile) -> Vec<(String, Option<String>)> {
        f.entries().map(|e| (e.key.clone(), e.value.as_ref().map(|v| v.text.clone()))).collect()
    }

    #[test]
    fn properties_documents_and_values() {
        let text = "# c\nserver.port=8080\napp.name : Demo \\\n   App\n#---\nspring.config.activate.on-profile=dev\nkey value\nempty\n";
        let f = ConfigFile::parse(Format::Properties, text);
        assert_eq!(f.documents.len(), 2);
        assert_eq!(
            keys(&f),
            [
                ("server.port".into(), Some("8080".into())),
                ("app.name".into(), Some("Demo App".into())),
                ("spring.config.activate.on-profile".into(), Some("dev".into())),
                ("key".into(), Some("value".into())),
                ("empty".into(), None),
            ]
        );
        assert_eq!(f.documents[1].on_profile.as_deref(), Some("dev"));
        let port = f.entries().next().unwrap();
        assert_eq!(&text[port.key_span.from..port.key_span.to], "server.port");
        let v = port.value.as_ref().unwrap();
        assert_eq!(&text[v.span.from..v.span.to], "8080");
    }

    #[test]
    fn separator_after_comment_is_a_comment() {
        let f = ConfigFile::parse(Format::Properties, "a=1\n# note\n#---\nb=2\n");
        assert_eq!(f.documents.len(), 1);
    }

    #[test]
    fn yaml_entries_values_documents() {
        let text = "server:\n  port: 8080\n  'ssl': {enabled: true}\napp:\n  hosts:\n    - a\n    - \"b\"\n  users:\n    - name: x\n  text: |\n    line1\n    line2\n---\nspring:\n  config:\n    activate:\n      on-profile: prod\n";
        let f = ConfigFile::parse(Format::Yaml, text);
        assert_eq!(f.documents.len(), 2);
        let ks: Vec<String> = f.entries().map(|e| e.key.clone()).collect();
        assert_eq!(
            ks,
            [
                "server",
                "server.port",
                "server.ssl",
                "server.ssl.enabled",
                "app",
                "app.hosts",
                "app.users",
                "app.users[0].name",
                "app.text",
                "spring",
                "spring.config",
                "spring.config.activate",
                "spring.config.activate.on-profile"
            ]
        );
        let hosts = f.entries().find(|e| e.key == "app.hosts").unwrap();
        let v = hosts.value.as_ref().unwrap();
        assert_eq!(v.kind, ValueKind::Sequence);
        assert_eq!(v.items.iter().map(|i| i.text.as_str()).collect::<Vec<_>>(), ["a", "b"]);
        let text_entry = f.entries().find(|e| e.key == "app.text").unwrap();
        assert_eq!(text_entry.value.as_ref().unwrap().text, "line1\nline2");
        assert_eq!(f.documents[1].on_profile.as_deref(), Some("prod"));
        let port = f.entries().find(|e| e.key == "server.port").unwrap();
        assert_eq!(&text[port.key_span.from..port.key_span.to], "port");
        assert_eq!(port.prefix_len, "server.".len());
        assert!(!f.entries().find(|e| e.key == "server").unwrap().is_leaf());
    }

    #[test]
    fn utf16_offsets() {
        let t = "a: 😀\nb: 1\n";
        let u = Utf16::new(t);
        let b = t.find("b").unwrap();
        assert_eq!(u.of(b), 6);
        assert_eq!(u.byte(6), b);
    }
}
