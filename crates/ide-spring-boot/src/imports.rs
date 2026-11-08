//! Auto-configuration registrations: `META-INF/spring/*.imports` (one class per line, `#`
//! comments; IDEA's "Spring Boot Imports" file type) and `META-INF/spring.factories`
//! (properties whose values are comma-separated class lists). Classes are completed, resolved
//! and checked; `EnableAutoConfiguration` in `spring.factories` (no longer read by Boot 3) can
//! move to `AutoConfiguration.imports`.

use crate::TypeOracle;
use crate::analysis::BootTextEdit;
use crate::analysis::validate::{BootFix, BootInspection, BootProblem, BootSeverity};
use crate::document::{Utf16, unescape};
use std::path::{Path, PathBuf};

pub const AUTO_CONFIGURATION_IMPORTS: &str = "org.springframework.boot.autoconfigure.AutoConfiguration.imports";
const ENABLE_AUTO_CONFIGURATION: &str = "org.springframework.boot.autoconfigure.EnableAutoConfiguration";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    /// `META-INF/spring/*.imports`.
    Imports,
    /// `META-INF/spring.factories`.
    Factories,
}

impl Kind {
    pub fn of(path: &Path) -> Option<Kind> {
        let name = path.file_name()?.to_str()?;
        let parent = path.parent()?;
        if name == "spring.factories" && parent.file_name().is_some_and(|n| n == "META-INF") {
            return Some(Kind::Factories);
        }
        if name.ends_with(".imports")
            && parent.file_name().is_some_and(|n| n == "spring")
            && parent.parent().and_then(Path::file_name).is_some_and(|n| n == "META-INF")
        {
            return Some(Kind::Imports);
        }
        None
    }
}

/// A class named in a registration file, with its byte range.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ClassRef {
    pub name: String,
    pub from: usize,
    pub to: usize,
    /// The `spring.factories` key it is listed under.
    pub key: Option<String>,
}

/// A `spring.factories` entry: its key and the line range of the whole entry.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FactoriesEntry {
    pub key: String,
    pub key_from: usize,
    pub key_to: usize,
    pub from: usize,
    pub to: usize,
    pub classes: Vec<ClassRef>,
}

pub fn imports_classes(text: &str) -> Vec<ClassRef> {
    let mut out = Vec::new();
    let mut base = 0;
    for line in text.split_inclusive('\n') {
        let content = line.trim_end_matches(['\r', '\n']);
        let code = content.split('#').next().unwrap_or("");
        let lead = code.len() - code.trim_start().len();
        let name = code.trim();
        if !name.is_empty() {
            out.push(ClassRef { name: name.to_owned(), from: base + lead, to: base + lead + name.len(), key: None });
        }
        base += line.len();
    }
    out
}

pub fn factories_entries(text: &str) -> Vec<FactoriesEntry> {
    let mut out = Vec::new();
    let mut base = 0;
    let mut current: Option<FactoriesEntry> = None;
    let mut continued = false;
    for line in text.split_inclusive('\n') {
        let content = line.trim_end_matches(['\r', '\n']);
        let mut value_part = content;
        let mut value_base = base;
        if !continued {
            if let Some(e) = current.take() {
                out.push(e);
            }
            let trimmed = content.trim_start();
            if trimmed.is_empty() || trimmed.starts_with(['#', '!']) {
                base += line.len();
                continue;
            }
            let lead = content.len() - trimmed.len();
            let sep = trimmed.find(['=', ':']).unwrap_or(trimmed.len());
            let key = unescape(trimmed[..sep].trim_end(), true).unwrap_or_default();
            current = Some(FactoriesEntry {
                key,
                key_from: base + lead,
                key_to: base + lead + trimmed[..sep].trim_end().len(),
                from: base,
                to: base + line.len(),
                classes: Vec::new(),
            });
            value_part = trimmed.get(sep + 1..).unwrap_or("");
            value_base = base + lead + sep + 1;
        }
        continued = content.bytes().rev().take_while(|b| *b == b'\\').count() % 2 == 1;
        let value_part = if continued { &value_part[..value_part.len() - 1] } else { value_part };
        if let Some(e) = current.as_mut() {
            e.to = base + line.len();
            let mut start = value_base;
            for part in value_part.split(',') {
                let lead = part.len() - part.trim_start().len();
                let name = part.trim();
                if !name.is_empty() {
                    e.classes.push(ClassRef {
                        name: name.to_owned(),
                        from: start + lead,
                        to: start + lead + name.len(),
                        key: Some(e.key.clone()),
                    });
                }
                start += part.len() + 1;
            }
        }
        base += line.len();
    }
    if let Some(e) = current {
        out.push(e);
    }
    out
}

/// The classes of a registration file.
pub fn classes(kind: Kind, text: &str) -> Vec<ClassRef> {
    match kind {
        Kind::Imports => imports_classes(text),
        Kind::Factories => factories_entries(text).into_iter().flat_map(|e| e.classes).collect(),
    }
}

/// The class named at byte `at`.
pub fn class_at(kind: Kind, text: &str, at: usize) -> Option<ClassRef> {
    classes(kind, text).into_iter().find(|c| c.from <= at && at <= c.to)
}

/// Problems of a registration file: classes that do not exist, and `EnableAutoConfiguration`
/// in `spring.factories` with Boot 3 or later (with a fix moving it to
/// `AutoConfiguration.imports`, `imports_text` being that file's current text if it exists).
pub fn validate(
    kind: Kind,
    path: &Path,
    text: &str,
    oracle: &dyn TypeOracle,
    boot_major: Option<u32>,
    imports_text: Option<&str>,
) -> Vec<BootProblem> {
    let u = Utf16::new(text);
    let mut out = Vec::new();
    for c in classes(kind, text) {
        // `$` nested classes and inner names are written in binary form.
        if oracle.class_exists(&c.name) == Some(false) {
            out.push(BootProblem {
                inspection: BootInspection::SpringBootImports,
                from: u.of(c.from),
                to: u.of(c.to),
                severity: BootSeverity::Error,
                message: format!("Cannot resolve class '{}'", c.name),
                deprecated: false,
                fixes: Vec::new(),
            });
        }
    }
    if kind == Kind::Factories && boot_major.is_some_and(|m| m >= 3) {
        for e in factories_entries(text) {
            if e.key != ENABLE_AUTO_CONFIGURATION {
                continue;
            }
            let imports = path.parent().map(|p| p.join("spring").join(AUTO_CONFIGURATION_IMPORTS));
            let mut fixes = Vec::new();
            if let Some(imports) = imports {
                let names: Vec<&str> = e.classes.iter().map(|c| c.name.as_str()).collect();
                let existing = imports_text.unwrap_or("");
                let mut add = String::new();
                if !existing.is_empty() && !existing.ends_with('\n') {
                    add.push('\n');
                }
                for n in &names {
                    if !imports_classes(existing).iter().any(|c| c.name == *n) {
                        add.push_str(n);
                        add.push('\n');
                    }
                }
                let eu = Utf16::new(existing);
                let mut files = Vec::new();
                if imports_text.is_none() {
                    files.push(ide_core::FileEdit::Create {
                        path: ide_core::IpcPath(imports.clone()),
                        overwrite: false,
                    });
                }
                files.push(ide_core::FileEdit::Edit {
                    path: ide_core::IpcPath(imports.clone()),
                    edits: vec![eu.text_edit(existing.len(), existing.len(), add)],
                    version: None,
                });
                fixes.push(BootFix {
                    label: "Move to AutoConfiguration.imports".into(),
                    edits: vec![BootTextEdit { from: u.of(e.from), to: u.of(e.to), insert: String::new() }],
                    define: None,
                    workspace: Some(ide_core::WorkspaceEdit { files, preconditions: Vec::new() }),
                });
            }
            out.push(BootProblem {
                inspection: BootInspection::SpringBootImports,
                from: u.of(e.key_from),
                to: u.of(e.key_to),
                severity: BootSeverity::Error,
                message: "EnableAutoConfiguration in spring.factories is not supported: register auto-configurations in AutoConfiguration.imports".into(),
                deprecated: false,
                fixes,
            });
        }
    }
    out
}

/// Where `fqn` is registered: (file, byte range) of each line naming it in `files`.
pub fn registrations(fqn: &str, files: &[(PathBuf, String)]) -> Vec<(PathBuf, usize, usize)> {
    let mut out = Vec::new();
    for (path, text) in files {
        let Some(kind) = Kind::of(path) else { continue };
        for c in classes(kind, text) {
            if c.name == fqn || c.name.replace('$', ".") == fqn {
                out.push((path.clone(), c.from, c.to));
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tests::FakeOracle;

    #[test]
    fn kinds() {
        assert_eq!(Kind::of(Path::new("/r/META-INF/spring/a.b.AutoConfiguration.imports")), Some(Kind::Imports));
        assert_eq!(Kind::of(Path::new("/r/META-INF/spring.factories")), Some(Kind::Factories));
        assert_eq!(Kind::of(Path::new("/r/spring/x.imports")), None);
    }

    #[test]
    fn parses_files() {
        let text = "# auto\ndemo.Server\n  demo.Mode # inline\n\n";
        let c = imports_classes(text);
        assert_eq!(c.iter().map(|c| c.name.as_str()).collect::<Vec<_>>(), ["demo.Server", "demo.Mode"]);
        assert_eq!(&text[c[1].from..c[1].to], "demo.Mode");
        let f = "a.Key=x.A,\\\n  x.B\nother=y.C\n";
        let e = factories_entries(f);
        assert_eq!(e.len(), 2);
        assert_eq!(e[0].classes.iter().map(|c| c.name.as_str()).collect::<Vec<_>>(), ["x.A", "x.B"]);
        assert_eq!(&f[e[0].classes[1].from..e[0].classes[1].to], "x.B");
        assert_eq!(e[0].to, "a.Key=x.A,\\\n  x.B\n".len());
        assert_eq!(e[1].key, "other");
    }

    #[test]
    fn validates() {
        let p = validate(
            Kind::Imports,
            Path::new("/r/META-INF/spring/x.imports"),
            "demo.Server\ndemo.Nope\n",
            &FakeOracle,
            Some(3),
            None,
        );
        assert_eq!(p.len(), 1);
        assert_eq!(p[0].message, "Cannot resolve class 'demo.Nope'");
        let f = "org.springframework.boot.autoconfigure.EnableAutoConfiguration=demo.Server\n";
        let p = validate(
            Kind::Factories,
            Path::new("/r/META-INF/spring.factories"),
            f,
            &FakeOracle,
            Some(3),
            Some("demo.Mode"),
        );
        assert_eq!(p.len(), 1);
        let fix = &p[0].fixes[0];
        let ws = fix.workspace.as_ref().unwrap();
        let ide_core::FileEdit::Edit { path, edits, .. } = &ws.files[0] else { panic!() };
        assert_eq!(edits[0].new_text, "\ndemo.Server\n");
        assert!(path.0.ends_with("META-INF/spring/org.springframework.boot.autoconfigure.AutoConfiguration.imports"));
        assert!(
            validate(Kind::Factories, Path::new("/r/META-INF/spring.factories"), f, &FakeOracle, Some(2), None)
                .is_empty()
        );
        let r =
            registrations("demo.Server", &[(PathBuf::from("/r/META-INF/spring/a.imports"), "demo.Server\n".into())]);
        assert_eq!(r.len(), 1);
    }
}
