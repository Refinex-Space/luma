//! The `SpringBootAdditionalConfig` inspection of `additional-spring-configuration-metadata.json`
//! (IDEA's "Invalid additional-spring-configuration-metadata.json"): entries without a name,
//! duplicate entries, classes that cannot be resolved, descriptions not ending with a period,
//! hints for keys that do not exist, invalid deprecation levels.

use crate::TypeOracle;
use crate::analysis::BootTextEdit;
use crate::analysis::validate::{BootFix, BootInspection, BootProblem, BootSeverity};
use crate::document::Utf16;
use crate::metadata::MetadataIndex;
use crate::name;
use std::collections::HashMap;
use tree_sitter::Node;

pub const FILE_NAME: &str = "additional-spring-configuration-metadata.json";

fn parse(text: &str) -> Option<tree_sitter::Tree> {
    let mut p = tree_sitter::Parser::new();
    p.set_language(&tree_sitter_json::LANGUAGE.into()).ok()?;
    p.parse(text, None)
}

struct Out<'t> {
    text: &'t str,
    u: Utf16<'t>,
    problems: Vec<BootProblem>,
}

impl Out<'_> {
    fn push(&mut self, n: Node, severity: BootSeverity, message: String, fixes: Vec<BootFix>) {
        self.problems.push(BootProblem {
            inspection: BootInspection::SpringBootAdditionalConfig,
            from: self.u.of(n.start_byte()),
            to: self.u.of(n.end_byte()),
            severity,
            message,
            deprecated: false,
            fixes,
        });
    }
}

/// The pairs of a JSON object: (key, value node).
fn pairs<'t>(obj: Node<'t>, text: &str) -> Vec<(String, Node<'t>, Node<'t>)> {
    let mut out = Vec::new();
    let mut c = obj.walk();
    for p in obj.named_children(&mut c).filter(|n| n.kind() == "pair") {
        let (Some(k), Some(v)) = (p.child_by_field_name("key"), p.child_by_field_name("value")) else { continue };
        out.push((string(k, text).unwrap_or_default(), k, v));
    }
    out
}

fn string(n: Node, text: &str) -> Option<String> {
    (n.kind() == "string").then(|| serde_json::from_str::<String>(&text[n.byte_range()]).ok()).flatten()
}

/// Qualified class names in a metadata type (`java.util.Map<java.lang.String,a.B>` → all three).
fn class_names(ty: &str) -> Vec<&str> {
    ty.split(['<', '>', ',', '[', ']', ' ', '?'])
        .map(str::trim)
        .filter(|s| s.contains('.') && s.chars().next().is_some_and(char::is_alphabetic))
        .collect()
}

pub fn validate(text: &str, index: &MetadataIndex, oracle: &dyn TypeOracle) -> Vec<BootProblem> {
    let Some(tree) = parse(text) else { return Vec::new() };
    let mut out = Out { text, u: Utf16::new(text), problems: Vec::new() };
    let root = tree.root_node();
    let Some(top) = root.named_child(0).filter(|n| n.kind() == "object") else { return out.problems };
    // Names of this file's properties (hints may refer to them).
    let mut own: Vec<String> = Vec::new();
    for (section, _, v) in pairs(top, text) {
        if section != "properties" || v.kind() != "array" {
            continue;
        }
        let mut c = v.walk();
        for item in v.named_children(&mut c).filter(|n| n.kind() == "object") {
            if let Some(n) =
                pairs(item, text).into_iter().find(|(k, _, _)| k == "name").and_then(|(_, _, v)| string(v, text))
            {
                own.push(name::canonical(&n));
            }
        }
    }
    for (section, _, v) in pairs(top, text) {
        if !matches!(section.as_str(), "groups" | "properties" | "hints") || v.kind() != "array" {
            continue;
        }
        let mut seen: HashMap<String, ()> = HashMap::new();
        let mut c = v.walk();
        for item in v.named_children(&mut c).filter(|n| n.kind() == "object") {
            let fields = pairs(item, text);
            let get = |k: &str| fields.iter().find(|(f, _, _)| f == k);
            let Some((_, _, name_node)) = get("name") else {
                // The object's opening brace.
                let brace = item.child(0).unwrap_or(item);
                out.push(brace, BootSeverity::Error, "Missing required 'name'".into(), Vec::new());
                continue;
            };
            let name_text = string(*name_node, text).unwrap_or_default();
            let key = if section == "groups" {
                format!(
                    "{}#{}",
                    name::canonical(&name_text),
                    get("sourceType").and_then(|(_, _, v)| string(*v, text)).unwrap_or_default()
                )
            } else {
                name::canonical(&name_text)
            };
            if seen.insert(key, ()).is_some() {
                out.push(*name_node, BootSeverity::Error, format!("Duplicate entry for '{name_text}'"), Vec::new());
            }
            for field in ["type", "sourceType"] {
                if let Some((_, _, v)) = get(field)
                    && let Some(ty) = string(*v, text)
                {
                    for class in class_names(&ty) {
                        if oracle.class_exists(class) == Some(false) {
                            out.push(*v, BootSeverity::Error, format!("Cannot resolve class '{class}'"), Vec::new());
                        }
                    }
                }
            }
            if let Some((_, _, v)) = get("description")
                && let Some(d) = string(*v, text)
            {
                let d = d.trim_end();
                if !d.is_empty() && !d.ends_with('.') {
                    // Before the closing quote.
                    let at = v.end_byte() - 1;
                    let fix = BootFix {
                        label: "Add '.'".into(),
                        edits: vec![BootTextEdit { from: out.u.of(at), to: out.u.of(at), insert: ".".into() }],
                        define: None,
                        workspace: None,
                    };
                    out.push(*v, BootSeverity::Warning, "Text should end with '.'".into(), vec![fix]);
                }
            }
            if let Some((_, _, d)) = get("deprecation")
                && d.kind() == "object"
                && let Some((_, _, level)) = pairs(*d, text).into_iter().find(|(k, _, _)| k == "level")
                && let Some(l) = string(level, text)
                && !matches!(l.as_str(), "warning" | "error")
            {
                out.push(
                    level,
                    BootSeverity::Error,
                    format!("Invalid deprecation level '{l}': use 'warning' or 'error'"),
                    Vec::new(),
                );
            }
            if section == "hints" {
                let base =
                    name_text.strip_suffix(".keys").or_else(|| name_text.strip_suffix(".values")).unwrap_or(&name_text);
                let canonical = name::canonical(base);
                if index.property(&canonical).is_none() && !own.contains(&canonical) && !index.is_empty() {
                    out.push(
                        *name_node,
                        BootSeverity::Error,
                        format!("Cannot resolve configuration key reference '{base}'"),
                        Vec::new(),
                    );
                }
            }
        }
    }
    let _ = out.text;
    out.problems
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::analysis::fixtures::index;
    use crate::tests::FakeOracle;

    #[test]
    fn checks_entries() {
        let text = r#"{
  "properties": [
    {"name": "app.a", "type": "demo.Server", "description": "A"},
    {"name": "app.a", "type": "demo.Nope"},
    {"type": "java.lang.String"},
    {"name": "app.b", "deprecation": {"level": "fatal"}}
  ],
  "hints": [
    {"name": "app.b.values", "values": []},
    {"name": "nope.key", "values": []},
    {"name": "server.port", "values": []}
  ]
}"#;
        let p = validate(text, &index(), &FakeOracle);
        let messages: Vec<&str> = p.iter().map(|p| p.message.as_str()).collect();
        assert_eq!(
            messages,
            [
                "Text should end with '.'",
                "Duplicate entry for 'app.a'",
                "Cannot resolve class 'demo.Nope'",
                "Missing required 'name'",
                "Invalid deprecation level 'fatal': use 'warning' or 'error'",
                "Cannot resolve configuration key reference 'nope.key'",
            ]
        );
        let edit = &p[0].fixes[0].edits[0];
        let mut fixed = text.to_owned();
        fixed.insert_str(edit.from as usize, &edit.insert);
        assert!(fixed.contains("\"description\": \"A.\""));
    }
}
