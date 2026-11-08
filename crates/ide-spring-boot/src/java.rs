//! Spring Boot inspections of Java sources (IDEA's Spring › Spring Boot group):
//! `ConfigurationProperties`, `SpringBootApplicationSetup`, `SpringBootReactorHooksOnDebug`,
//! early `@EventListener`s and test constructor parameters without `@Autowired`.

use crate::analysis::BootTextEdit;
use crate::analysis::validate::{BootFix, BootInspection, BootProblem, BootSeverity};
use crate::document::Utf16;
use crate::name;
use ide_index::java::{AnnotationValue, JavaView};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tree_sitter::Node;

/// What the checks need besides the file.
pub struct JavaContext<'a> {
    /// The index with the analyzed file's unsaved declarations.
    pub view: &'a JavaView<'a>,
    pub path: &'a Path,
    /// `(major, minor)` of Spring Boot.
    pub boot: Option<(u32, u32)>,
    pub reactor_tools: bool,
    /// `spring.test.constructor.autowire.mode=all` in `junit-platform.properties` / `spring.properties`.
    pub test_autowire_all: bool,
    /// Text of another source file (registration fixes edit it).
    pub read: &'a dyn Fn(&Path) -> Option<Arc<str>>,
}

const COMPONENTS: [&str; 7] =
    ["Component", "Service", "Repository", "Controller", "RestController", "Configuration", "AutoConfiguration"];

const EARLY_EVENTS: [&str; 5] = [
    "ApplicationStartingEvent",
    "ApplicationEnvironmentPreparedEvent",
    "ApplicationContextInitializedEvent",
    "ApplicationPreparedEvent",
    "BootstrapContextClosedEvent",
];

const TEST_ANNOTATIONS: [&str; 14] = [
    "SpringBootTest",
    "WebMvcTest",
    "WebFluxTest",
    "DataJpaTest",
    "DataJdbcTest",
    "JdbcTest",
    "DataMongoTest",
    "DataRedisTest",
    "JsonTest",
    "RestClientTest",
    "GraphQlTest",
    "SpringJUnitConfig",
    "SpringJUnitWebConfig",
    "DataR2dbcTest",
];

/// JUnit's own constructor parameters.
const JUNIT_PARAMS: [&str; 3] = ["TestInfo", "TestReporter", "RepetitionInfo"];

struct Src<'t> {
    text: &'t str,
    u: Utf16<'t>,
    out: Vec<BootProblem>,
}

impl Src<'_> {
    fn t(&self, n: Node) -> &str {
        &self.text[n.byte_range()]
    }

    fn push(
        &mut self,
        inspection: BootInspection,
        n: Node,
        severity: BootSeverity,
        message: String,
        fixes: Vec<BootFix>,
    ) {
        self.out.push(BootProblem {
            inspection,
            from: self.u.of(n.start_byte()),
            to: self.u.of(n.end_byte()),
            severity,
            message,
            deprecated: false,
            fixes,
        });
    }

    fn edit(&self, from: usize, to: usize, insert: impl Into<String>) -> BootTextEdit {
        BootTextEdit { from: self.u.of(from), to: self.u.of(to), insert: insert.into() }
    }

    /// Removes node `n` with the whitespace after it up to the next token (an annotation on
    /// its own line takes its line).
    fn remove(&self, n: Node) -> BootTextEdit {
        let bytes = self.text.as_bytes();
        let mut end = n.end_byte();
        while end < bytes.len() && matches!(bytes[end], b' ' | b'\t') {
            end += 1;
        }
        let mut start = n.start_byte();
        let line_start = self.text[..start].rfind('\n').map_or(0, |i| i + 1);
        if self.text[line_start..start].trim().is_empty() && end < bytes.len() && bytes[end] == b'\n' {
            start = line_start;
            end += 1;
        }
        self.edit(start, end, "")
    }
}

fn simple(name: &str) -> &str {
    name.rsplit('.').next().unwrap_or(name)
}

/// Annotations of a declaration node: (simple name, node).
fn annotations<'t>(decl: Node<'t>, text: &str) -> Vec<(String, Node<'t>)> {
    let mut out = Vec::new();
    let mut c = decl.walk();
    for m in decl.named_children(&mut c) {
        if m.kind() != "modifiers" {
            continue;
        }
        let mut mc = m.walk();
        for a in m.named_children(&mut mc) {
            if matches!(a.kind(), "annotation" | "marker_annotation")
                && let Some(n) = a.child_by_field_name("name")
            {
                out.push((simple(&text[n.byte_range()]).to_owned(), a));
            }
        }
    }
    out
}

/// Whether an annotation node has arguments.
fn has_args(a: Node) -> bool {
    a.child_by_field_name("arguments").is_some_and(|args| args.named_child_count() > 0)
}

fn walk_types<'t>(n: Node<'t>, out: &mut Vec<Node<'t>>) {
    let mut c = n.walk();
    for child in n.named_children(&mut c) {
        if matches!(
            child.kind(),
            "class_declaration" | "record_declaration" | "interface_declaration" | "enum_declaration"
        ) {
            out.push(child);
        }
        if matches!(
            child.kind(),
            "class_body"
                | "class_declaration"
                | "record_declaration"
                | "enum_body"
                | "interface_body"
                | "enum_declaration"
        ) || child.kind() == "program"
        {
            walk_types(child, out);
        }
    }
}

fn walk_all<'t>(n: Node<'t>, kind: &str, out: &mut Vec<Node<'t>>) {
    if n.kind() == kind {
        out.push(n);
    }
    let mut c = n.walk();
    for child in n.named_children(&mut c) {
        walk_all(child, kind, out);
    }
}

pub fn java_problems(cx: &JavaContext, text: &str, tree: &tree_sitter::Tree) -> Vec<BootProblem> {
    let mut s = Src { text, u: Utf16::new(text), out: Vec::new() };
    let root = tree.root_node();
    let package = {
        let mut c = root.walk();
        root.named_children(&mut c)
            .find(|n| n.kind() == "package_declaration")
            .map(|p| s.t(p).trim_start_matches("package").trim().trim_end_matches(';').trim().to_owned())
            .unwrap_or_default()
    };
    let imports: Vec<String> = {
        let mut c = root.walk();
        root.named_children(&mut c)
            .filter(|n| n.kind() == "import_declaration")
            .map(|n| s.t(n).trim_start_matches("import").trim().trim_end_matches(';').trim().to_owned())
            .collect()
    };
    let mut types = Vec::new();
    walk_types(root, &mut types);
    let boot_22 = cx.boot.is_none_or(|(a, b)| a > 2 || (a == 2 && b >= 2));
    for t in &types {
        let anns = annotations(*t, text);
        let Some(name_node) = t.child_by_field_name("name") else { continue };
        let class_name = s.t(name_node).to_owned();
        let has = |n: &str| anns.iter().find(|(a, _)| a == n).map(|(_, node)| *node);
        // @SpringBootApplication setup.
        if let Some(app) = has("SpringBootApplication") {
            if package.is_empty() {
                s.push(
                    BootInspection::SpringBootApplicationSetup,
                    app,
                    BootSeverity::Error,
                    "@SpringBootApplication in the default package: Spring Boot scans every class on the class path"
                        .into(),
                    Vec::new(),
                );
            }
            for redundant in ["EnableAutoConfiguration", "ComponentScan"] {
                if let Some(a) = has(redundant)
                    && !has_args(a)
                {
                    let fix = BootFix {
                        label: format!("Remove @{redundant}"),
                        edits: vec![s.remove(a)],
                        define: None,
                        workspace: None,
                    };
                    s.push(
                        BootInspection::SpringBootApplicationSetup,
                        a,
                        BootSeverity::Warning,
                        format!("Redundant declaration: @SpringBootApplication already implies @{redundant}"),
                        vec![fix],
                    );
                }
            }
        }
        // @ConfigurationProperties.
        if let Some(cp) = has("ConfigurationProperties") {
            configuration_properties(cx, &mut s, *t, cp, &anns, &class_name, &package, &imports, boot_22);
        }
        // Test constructors.
        let is_test = anns.iter().any(|(a, _)| TEST_ANNOTATIONS.contains(&a.as_str()));
        let all_mode = has("TestConstructor").is_some_and(|a| s.t(a).contains("ALL"));
        if is_test && !all_mode && !cx.test_autowire_all {
            test_constructors(&mut s, *t, &imports, &package);
        }
    }
    // Early @EventListener methods.
    let mut methods = Vec::new();
    walk_all(root, "method_declaration", &mut methods);
    for m in methods {
        let anns = annotations(m, text);
        let Some((_, listener)) = anns.iter().find(|(a, _)| a == "EventListener") else { continue };
        let listener = *listener;
        let mut events: Vec<String> = Vec::new();
        if let Some(params) = m.child_by_field_name("parameters") {
            let mut c = params.walk();
            for p in params.named_children(&mut c).filter(|p| p.kind() == "formal_parameter") {
                if let Some(ty) = p.child_by_field_name("type") {
                    events.push(simple(s.t(ty).split('<').next().unwrap_or("")).to_owned());
                }
            }
        }
        let args = s.t(listener).to_owned();
        for e in EARLY_EVENTS {
            if args.contains(&format!("{e}.class")) {
                events.push(e.to_owned());
            }
        }
        if let Some(e) = events.iter().find(|e| EARLY_EVENTS.contains(&e.as_str())) {
            s.push(
                BootInspection::SpringBootEarlyEventListener,
                listener,
                BootSeverity::Warning,
                format!("@EventListener for {e} is never called: the event is published before beans are created"),
                Vec::new(),
            );
        }
    }
    // Hooks.onOperatorDebug() with reactor-tools.
    if cx.reactor_tools && boot_22 && text.contains("onOperatorDebug") {
        let mut calls = Vec::new();
        walk_all(root, "method_invocation", &mut calls);
        for c in calls {
            let (Some(name), Some(object)) = (c.child_by_field_name("name"), c.child_by_field_name("object")) else {
                continue;
            };
            if s.t(name) != "onOperatorDebug" || simple(s.t(object)) != "Hooks" {
                continue;
            }
            let mut fixes = Vec::new();
            if let Some(stmt) = c.parent().filter(|p| p.kind() == "expression_statement") {
                fixes.push(BootFix {
                    label: "Remove Hooks.onOperatorDebug() call".into(),
                    edits: vec![s.remove(stmt)],
                    define: None,
                    workspace: None,
                });
            }
            s.push(
                BootInspection::SpringBootReactorHooksOnDebug,
                c,
                BootSeverity::Warning,
                "Hooks.onOperatorDebug() is redundant: Spring Boot already initializes the ReactorDebugAgent of reactor-tools".into(),
                fixes,
            );
        }
    }
    s.out
}

#[allow(clippy::too_many_arguments)]
fn configuration_properties(
    cx: &JavaContext,
    s: &mut Src,
    t: Node,
    cp: Node,
    anns: &[(String, Node)],
    class_name: &str,
    package: &str,
    imports: &[String],
    boot_22: bool,
) {
    // The prefix.
    let args = cp.child_by_field_name("arguments");
    let mut prefix: Option<(String, Node)> = None;
    let mut constant = false;
    if let Some(args) = args {
        let mut c = args.walk();
        for a in args.named_children(&mut c) {
            let (key, value) = match a.kind() {
                "element_value_pair" => (
                    a.child_by_field_name("key").map(|k| s.t(k).to_owned()).unwrap_or_default(),
                    a.child_by_field_name("value"),
                ),
                _ => ("value".to_owned(), Some(a)),
            };
            if (key == "prefix" || key == "value")
                && let Some(v) = value
            {
                if v.kind() == "string_literal" {
                    let raw = s.t(v);
                    prefix = Some((raw.trim_matches('"').to_owned(), v));
                } else {
                    constant = true;
                }
            }
        }
    }
    match &prefix {
        None if !constant => {
            let fix = BootFix {
                label: "Add prefix".into(),
                edits: vec![match args {
                    Some(a) => s.edit(a.start_byte(), a.end_byte(), "(prefix = \"\")"),
                    None => s.edit(cp.end_byte(), cp.end_byte(), "(prefix = \"\")"),
                }],
                define: None,
                workspace: None,
            };
            s.push(
                BootInspection::ConfigurationProperties,
                cp,
                BootSeverity::Error,
                "Configuration properties prefix must be specified".into(),
                vec![fix],
            );
        }
        Some((p, node)) if p.is_empty() => {
            s.push(
                BootInspection::ConfigurationProperties,
                *node,
                BootSeverity::Error,
                "Configuration properties prefix must not be empty".into(),
                Vec::new(),
            );
        }
        Some((p, node)) if !name::is_valid_prefix(p) => {
            let canonical: String = p.split('.').map(|e| name::kebab(e).to_lowercase()).collect::<Vec<_>>().join(".");
            let mut fixes = Vec::new();
            if name::is_valid_prefix(&canonical) {
                fixes.push(BootFix {
                    label: format!("Change to '{canonical}'"),
                    edits: vec![s.edit(node.start_byte() + 1, node.end_byte() - 1, canonical.clone())],
                    define: None,
                    workspace: None,
                });
            }
            s.push(
                BootInspection::ConfigurationProperties,
                *node,
                BootSeverity::Error,
                format!("Prefix '{p}' must be in canonical form: kebab-case, lowercase letters and digits"),
                fixes,
            );
        }
        _ => {}
    }
    // Registration (Boot 2.2+ no longer registers @ConfigurationProperties classes itself).
    let component = anns.iter().any(|(a, _)| COMPONENTS.contains(&a.as_str()));
    let abstract_or_interface =
        t.kind() == "interface_declaration" || annotations(t, s.text).is_empty() && s.t(t).starts_with("abstract");
    let Some(name_node) = t.child_by_field_name("name") else { return };
    if component {
        // Constructor binding is not used for Spring components: Spring injects the
        // constructor's parameters as beans.
        if constructor_bound(s, t) {
            s.push(
                BootInspection::ConfigurationProperties,
                name_node,
                BootSeverity::Error,
                "Constructor binding cannot be used on a Spring component: its constructor parameters are injected as beans".into(),
                Vec::new(),
            );
        }
        return;
    }
    if !boot_22 || abstract_or_interface || is_nested_non_static(t, s) {
        return;
    }
    let fqn = if package.is_empty() { class_name.to_owned() } else { format!("{package}.{class_name}") };
    let registration = registration(cx, class_name, &fqn, package);
    if registration.registered {
        return;
    }
    let mut fixes = Vec::new();
    if let Some((path, at)) = &registration.enable
        && let Some(edit) = register_in(cx, path, *at, class_name, &fqn, package)
    {
        fixes.push(BootFix {
            label: "Register via the existing @EnableConfigurationProperties annotation".into(),
            edits: Vec::new(),
            define: None,
            workspace: Some(ide_core::WorkspaceEdit { files: vec![edit], preconditions: Vec::new() }),
        });
    }
    if let Some((path, at)) = &registration.application
        && let Some(edit) = add_enable(cx, path, *at, class_name, &fqn)
    {
        fixes.push(BootFix {
            label: "Create a new @EnableConfigurationProperties annotation and register".into(),
            edits: Vec::new(),
            define: None,
            workspace: Some(ide_core::WorkspaceEdit { files: vec![edit], preconditions: Vec::new() }),
        });
    }
    let _ = imports;
    s.push(
        BootInspection::ConfigurationProperties,
        name_node,
        BootSeverity::Error,
        "Not registered via @EnableConfigurationProperties, marked as Spring component, or scanned via @ConfigurationPropertiesScan".into(),
        fixes,
    );
}

fn is_nested_non_static(t: Node, s: &Src) -> bool {
    let nested = t.parent().is_some_and(|p| p.kind() == "class_body");
    nested && !s.t(t).split('{').next().unwrap_or("").contains("static") && t.kind() == "class_declaration"
}

/// Whether a class binds through its constructor (a record, or one constructor with parameters).
fn constructor_bound(s: &Src, t: Node) -> bool {
    if t.kind() == "record_declaration" {
        return true;
    }
    let Some(body) = t.child_by_field_name("body") else { return false };
    let mut c = body.walk();
    let ctors: Vec<Node> = body.named_children(&mut c).filter(|n| n.kind() == "constructor_declaration").collect();
    if ctors.len() != 1 {
        return false;
    }
    let ctor = ctors[0];
    let params = ctor.child_by_field_name("parameters").map_or(0, |p| p.named_child_count());
    params > 0 && !annotations(ctor, s.text).iter().any(|(a, _)| a == "Autowired")
}

struct Registration {
    registered: bool,
    /// The first `@EnableConfigurationProperties` of the project: file and its `@`.
    enable: Option<(PathBuf, ide_core::Pos)>,
    /// The `@SpringBootApplication` class: file and its `@`.
    application: Option<(PathBuf, ide_core::Pos)>,
}

/// Whether the project registers class `name` (`fqn`): `@EnableConfigurationProperties`
/// naming it, a `@ConfigurationPropertiesScan` covering its package, a `@Bean` method
/// returning it.
fn registration(cx: &JavaContext, name: &str, fqn: &str, package: &str) -> Registration {
    let view = cx.view;
    let mut r = Registration { registered: false, enable: None, application: None };
    let mut files = view.files_mentioning("EnableConfigurationProperties");
    files.extend(view.files_mentioning("ConfigurationPropertiesScan"));
    files.extend(view.files_mentioning("SpringBootApplication"));
    files.extend(view.files_mentioning(name));
    files.sort_unstable();
    files.dedup();
    for f in files {
        let Some(stub) = view.stub(f) else { continue };
        let Some(path) =
            view.path(f).map(Path::to_owned).or_else(|| (Some(f) == view.overlay_file()).then(|| cx.path.to_owned()))
        else {
            continue;
        };
        for t in &stub.types {
            for a in &t.annotation_args {
                match a.simple_name() {
                    "EnableConfigurationProperties" => {
                        let classes = a.arg("value").map(|v| v.classes()).unwrap_or_default();
                        if classes.iter().any(|c| *c == name || *c == fqn || c.ends_with(&format!(".{name}"))) {
                            r.registered = true;
                        }
                        if r.enable.is_none() {
                            r.enable = Some((path.clone(), a.at));
                        }
                    }
                    "ConfigurationPropertiesScan" => {
                        let mut bases: Vec<String> = Vec::new();
                        for key in ["value", "basePackages"] {
                            if let Some(v) = a.arg(key) {
                                bases.extend(v.strings().into_iter().map(str::to_owned));
                            }
                        }
                        if let Some(v) = a.arg("basePackageClasses") {
                            for c in v.classes() {
                                let pkg = c
                                    .rsplit_once('.')
                                    .map(|(p, _)| p.to_owned())
                                    .unwrap_or_else(|| stub.package.clone());
                                bases.push(if c.contains('.') { pkg } else { stub.package.clone() });
                            }
                        }
                        if bases.is_empty() {
                            bases.push(stub.package.clone());
                        }
                        if bases.iter().any(|b| b.is_empty() || package == b || package.starts_with(&format!("{b}."))) {
                            r.registered = true;
                        }
                    }
                    "SpringBootApplication" if r.application.is_none() => r.application = Some((path.clone(), a.at)),
                    _ => {}
                }
            }
            // A @Bean method returning the class registers it.
            if t.members.iter().any(|m| {
                m.annotations.iter().any(|a| a == "Bean") && simple(m.ty.split('<').next().unwrap_or("")) == name
            }) {
                r.registered = true;
            }
            // Imported through @Import.
            if t.annotation_args.iter().any(|a| {
                a.simple_name() == "Import"
                    && a.arg("value").is_some_and(|v| v.classes().iter().any(|c| simple(c) == name))
            }) {
                r.registered = true;
            }
        }
    }
    r
}

/// Byte offset of a position (line, UTF-16 column) in `text`.
fn byte_of(text: &str, pos: ide_core::Pos) -> Option<usize> {
    let start = crate::source::line_start(text, pos.line);
    let line = &text[start..];
    let mut units = 0u32;
    for (i, ch) in line.char_indices() {
        if units >= pos.col {
            return Some(start + i);
        }
        if ch == '\n' {
            return None;
        }
        units += ch.len_utf16() as u32;
    }
    Some(text.len())
}

/// The import edit adding `fqn` to `text` when it needs one (another package, not imported).
fn import_edit(text: &str, fqn: &str) -> Option<(usize, String)> {
    let package_of_text = text
        .lines()
        .find(|l| l.trim_start().starts_with("package "))
        .map(|l| l.trim().trim_start_matches("package").trim().trim_end_matches(';').trim().to_owned())
        .unwrap_or_default();
    let (pkg, _) = fqn.rsplit_once('.')?;
    if pkg == package_of_text || text.contains(&format!("import {fqn};")) || text.contains(&format!("import {pkg}.*;"))
    {
        return None;
    }
    // After the last import, else after the package declaration.
    let at = text
        .match_indices("\nimport ")
        .last()
        .and_then(|(i, _)| text[i + 1..].find('\n').map(|e| i + 1 + e + 1))
        .or_else(|| text.find("package ").and_then(|i| text[i..].find('\n').map(|e| i + e + 1)))
        .unwrap_or(0);
    let lead = if text[..at].contains("\nimport ") || text.starts_with("import ") { "" } else { "\n" };
    Some((at, format!("{lead}import {fqn};\n")))
}

/// Adds `Name.class` to the `@EnableConfigurationProperties` at `at` of file `path`.
fn register_in(
    cx: &JavaContext,
    path: &Path,
    at: ide_core::Pos,
    name: &str,
    fqn: &str,
    _package: &str,
) -> Option<ide_core::FileEdit> {
    let text = (cx.read)(path)?;
    let u = Utf16::new(&text);
    let start = byte_of(&text, at)?;
    let rest = &text[start..];
    let head = "@EnableConfigurationProperties";
    let name_end = start + rest.find("ConfigurationProperties")? + "ConfigurationProperties".len();
    let _ = head;
    let mut edits = Vec::new();
    let after = &text[name_end..];
    if after.trim_start().starts_with('(') {
        let open = name_end + after.find('(')?;
        let close = open + text[open..].find(')')?;
        let inner = text[open + 1..close].trim();
        let insert = if inner.is_empty() {
            (open + 1, open + 1, format!("{name}.class"))
        } else if let Some(brace) = text[open..close].rfind('}') {
            let at = open + brace;
            (at, at, format!(", {name}.class"))
        } else {
            (open + 1, close, format!("{{{inner}, {name}.class}}"))
        };
        edits.push(u.text_edit(insert.0, insert.1, insert.2));
    } else {
        edits.push(u.text_edit(name_end, name_end, format!("({name}.class)")));
    }
    if let Some((at, import)) = import_edit(&text, fqn) {
        edits.push(u.text_edit(at, at, import));
    }
    Some(ide_core::FileEdit::Edit { path: ide_core::IpcPath(path.to_owned()), edits, version: None })
}

/// Adds `@EnableConfigurationProperties(Name.class)` before the annotation at `at` of `path`.
fn add_enable(cx: &JavaContext, path: &Path, at: ide_core::Pos, name: &str, fqn: &str) -> Option<ide_core::FileEdit> {
    let text = (cx.read)(path)?;
    let u = Utf16::new(&text);
    let start = byte_of(&text, at)?;
    let line_start = text[..start].rfind('\n').map_or(0, |i| i + 1);
    let indent = &text[line_start..start];
    let indent = if indent.trim().is_empty() { indent.to_owned() } else { String::new() };
    let mut edits = vec![u.text_edit(start, start, format!("@EnableConfigurationProperties({name}.class)\n{indent}"))];
    let mut imports = String::new();
    let mut import_at = None;
    for f in ["org.springframework.boot.context.properties.EnableConfigurationProperties", fqn] {
        if let Some((at, import)) = import_edit(&text, f) {
            import_at.get_or_insert(at);
            imports.push_str(import.trim_start_matches('\n'));
        }
    }
    if let Some(at) = import_at {
        let lead = if text[..at].contains("\nimport ") || text.starts_with("import ") { "" } else { "\n" };
        edits.push(u.text_edit(at, at, format!("{lead}{imports}")));
    }
    Some(ide_core::FileEdit::Edit { path: ide_core::IpcPath(path.to_owned()), edits, version: None })
}

fn test_constructors(s: &mut Src, t: Node, imports: &[String], _package: &str) {
    let Some(body) = t.child_by_field_name("body") else { return };
    let mut c = body.walk();
    let ctors: Vec<Node> = body.named_children(&mut c).filter(|n| n.kind() == "constructor_declaration").collect();
    let imported = imports.iter().any(|i| {
        i == "org.springframework.beans.factory.annotation.Autowired"
            || i == "org.springframework.beans.factory.annotation.*"
    });
    for ctor in ctors {
        if annotations(ctor, s.text).iter().any(|(a, _)| a == "Autowired") {
            continue;
        }
        let Some(params) = ctor.child_by_field_name("parameters") else { continue };
        let mut pc = params.walk();
        for p in params.named_children(&mut pc).filter(|p| p.kind() == "formal_parameter") {
            let anns = annotations(p, s.text);
            if anns.iter().any(|(a, _)| matches!(a.as_str(), "Autowired" | "Qualifier" | "Value" | "TempDir")) {
                continue;
            }
            let ty = p.child_by_field_name("type").map(|n| simple(s.t(n)).to_owned()).unwrap_or_default();
            if JUNIT_PARAMS.contains(&ty.as_str()) {
                continue;
            }
            let Some(name) = p.child_by_field_name("name") else { continue };
            let mut edits = vec![s.edit(p.start_byte(), p.start_byte(), "@Autowired ")];
            if !imported
                && let Some((at, import)) =
                    import_edit(s.text, "org.springframework.beans.factory.annotation.Autowired")
            {
                edits.push(s.edit(at, at, import));
            }
            let fix =
                BootFix { label: "Annotate parameter with @Autowired".into(), edits, define: None, workspace: None };
            let pname = s.t(name).to_owned();
            s.push(
                BootInspection::SpringBootTestConstructorAutowired,
                name,
                BootSeverity::Warning,
                format!("Constructor parameter '{pname}' of a Spring test class is not autowired"),
                vec![fix],
            );
        }
    }
}

/// `spring.test.constructor.autowire.mode=all` in a properties text.
pub fn autowire_all(text: &str) -> bool {
    text.lines().any(|l| {
        let l = l.trim();
        l.strip_prefix("spring.test.constructor.autowire.mode")
            .map(|rest| rest.trim_start().trim_start_matches(['=', ':']).trim().eq_ignore_ascii_case("all"))
            .unwrap_or(false)
    })
}

#[allow(dead_code)]
fn annotation_classes(v: &AnnotationValue) -> Vec<&str> {
    v.classes()
}

#[cfg(test)]
mod tests {
    use super::*;
    use ide_index::testing::JavaSources;

    fn run(files: &[(&str, &str)], target: &str, reactor: bool) -> Vec<BootProblem> {
        let src = JavaSources::new(files);
        let text = files.iter().find(|(p, _)| *p == target).unwrap().1;
        let tree = ide_java::parse(text).unwrap();
        let texts: std::collections::HashMap<PathBuf, String> =
            files.iter().map(|(p, t)| (PathBuf::from("/p").join(p), (*t).to_owned())).collect();
        let read = |p: &Path| texts.get(p).map(|t| Arc::from(t.as_str()));
        let path = PathBuf::from("/p").join(target);
        src.with_view(|view| {
            let cx = JavaContext {
                view,
                path: &path,
                boot: Some((3, 4)),
                reactor_tools: reactor,
                test_autowire_all: false,
                read: &read,
            };
            java_problems(&cx, text, &tree)
        })
    }

    fn messages(p: &[BootProblem]) -> Vec<&str> {
        p.iter().map(|p| p.message.as_str()).collect()
    }

    const APP: &str = "package demo;\n\nimport org.springframework.boot.autoconfigure.SpringBootApplication;\nimport org.springframework.boot.autoconfigure.EnableAutoConfiguration;\n\n@SpringBootApplication\n@EnableAutoConfiguration\npublic class App {}\n";

    #[test]
    fn configuration_properties_registration() {
        let props = "package demo.cfg;\nimport org.springframework.boot.context.properties.ConfigurationProperties;\n@ConfigurationProperties(prefix = \"app.mail\")\npublic class MailProps { private String host; }\n";
        let bad = "package demo.cfg;\n@ConfigurationProperties(\"appMail\")\npublic class Other {}\n";
        let empty = "package demo.cfg;\n@ConfigurationProperties\n@Component\npublic class Third {}\n";
        let p = run(&[("demo/App.java", APP), ("demo/cfg/MailProps.java", props)], "demo/cfg/MailProps.java", false);
        assert_eq!(
            messages(&p),
            [
                "Not registered via @EnableConfigurationProperties, marked as Spring component, or scanned via @ConfigurationPropertiesScan"
            ]
        );
        // The fix adds @EnableConfigurationProperties to the application class.
        let fix = &p[0].fixes[0];
        let ide_core::FileEdit::Edit { path, edits, .. } = &fix.workspace.as_ref().unwrap().files[0] else { panic!() };
        assert_eq!(path.0, PathBuf::from("/p/demo/App.java"));
        assert!(edits.iter().any(|e| e.new_text == "@EnableConfigurationProperties(MailProps.class)\n"));
        assert!(edits.iter().any(|e| e.new_text.contains("import demo.cfg.MailProps;")));
        // Scanned: no problem.
        let scanned = APP.replace(
            "@SpringBootApplication\n",
            "@SpringBootApplication\n@org.springframework.boot.context.properties.ConfigurationPropertiesScan\n",
        );
        let p =
            run(&[("demo/App.java", &scanned), ("demo/cfg/MailProps.java", props)], "demo/cfg/MailProps.java", false);
        assert!(p.is_empty(), "{p:?}");
        // Registered by @EnableConfigurationProperties.
        let enabled =
            "package demo;\n@Configuration\n@EnableConfigurationProperties(demo.cfg.MailProps.class)\nclass Cfg {}\n";
        let p =
            run(&[("demo/Cfg.java", enabled), ("demo/cfg/MailProps.java", props)], "demo/cfg/MailProps.java", false);
        assert!(p.is_empty());
        let p = run(&[("demo/cfg/Other.java", bad)], "demo/cfg/Other.java", false);
        assert_eq!(
            p[0].message,
            "Prefix 'appMail' must be in canonical form: kebab-case, lowercase letters and digits"
        );
        assert_eq!(p[0].fixes[0].label, "Change to 'app-mail'");
        let p = run(&[("demo/cfg/Third.java", empty)], "demo/cfg/Third.java", false);
        assert_eq!(messages(&p), ["Configuration properties prefix must be specified"]);
    }

    #[test]
    fn application_setup_and_others() {
        let p = run(&[("demo/App.java", APP)], "demo/App.java", false);
        assert_eq!(
            messages(&p),
            ["Redundant declaration: @SpringBootApplication already implies @EnableAutoConfiguration"]
        );
        let edit = &p[0].fixes[0].edits[0];
        let mut fixed = APP.to_owned();
        fixed.replace_range(edit.from as usize..edit.to as usize, "");
        assert!(!fixed.contains("@EnableAutoConfiguration\n"));
        let default_pkg = "@SpringBootApplication\npublic class App {}\n";
        let p = run(&[("App.java", default_pkg)], "App.java", false);
        assert!(p[0].message.starts_with("@SpringBootApplication in the default package"));
        let listener = "package demo;\nclass L {\n  @EventListener\n  void on(ApplicationStartingEvent e) {}\n  @EventListener(ApplicationReadyEvent.class)\n  void ready() {}\n}\n";
        let p = run(&[("demo/L.java", listener)], "demo/L.java", false);
        assert_eq!(
            messages(&p),
            [
                "@EventListener for ApplicationStartingEvent is never called: the event is published before beans are created"
            ]
        );
        let hooks = "package demo;\nclass H {\n  void init() {\n    Hooks.onOperatorDebug();\n  }\n}\n";
        assert_eq!(run(&[("demo/H.java", hooks)], "demo/H.java", true).len(), 1);
        assert!(run(&[("demo/H.java", hooks)], "demo/H.java", false).is_empty());
        let test =
            "package demo;\n\n@SpringBootTest\nclass T {\n  T(Repo repo, TestInfo info, @Autowired Other o) {}\n}\n";
        let p = run(&[("demo/T.java", test)], "demo/T.java", false);
        assert_eq!(messages(&p), ["Constructor parameter 'repo' of a Spring test class is not autowired"]);
        assert!(p[0].fixes[0].edits.iter().any(|e| e.insert == "@Autowired "));
        assert!(autowire_all("spring.test.constructor.autowire.mode = ALL\n"));
    }
}
