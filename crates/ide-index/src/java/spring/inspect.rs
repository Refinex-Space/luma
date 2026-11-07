//! Spring inspections of an open Java file (IDEA's Spring › Spring Core › Code group), over the
//! Spring model, with their quick fixes as text edits.
//!
//! Problems that depend on the beans of a context (unresolved autowiring, bean references in
//! annotation strings) are reported only when the context is complete: when beans may come
//! from where the model cannot see, a missing bean is never claimed.

use super::super::Resolved as JResolved;
use super::annotations::*;
use super::collect::{Ann, resolve_all};
use super::features::{beans_named, cache_annotations, own_cache_names};
use super::matching::{Outcome, Supers, resolve};
use super::*;
use ide_core::Range;
use specta::Type;
use tree_sitter::{Node, Tree};

/// The inspections (producer `spring-<kebab name>` on the frontend).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum SpringInspection {
    /// Incorrect autowiring in Spring bean components.
    Autowiring,
    /// Non-recommended field injections.
    FieldInjection,
    /// Incorrect Spring component autowiring or injection on a static class member.
    StaticInjection,
    /// Incorrectly referenced bean in @DependsOn annotation.
    DependsOn,
    /// Incorrectly referenced bean in @Lookup annotation of a Spring component.
    Lookup,
    /// Incorrectly referenced bean in @Scheduled annotation.
    ScheduledBean,
    /// Incorrectly configured @Profile expression.
    ProfileExpression,
    /// Unknown init/destroy method in the @Bean annotation.
    BeanMethods,
    /// Incorrect @Async method signature.
    AsyncSignature,
    /// Incorrect @Scheduled method signature.
    ScheduledSignature,
    /// Incorrectly configured @EventListener methods.
    EventListener,
    /// Cache* annotations defined on interfaces/interface methods.
    CacheOnInterface,
    /// Incorrect usage of @CachePut and @Cacheable on the same method.
    CacheableAndCachePut,
    /// Incorrect required cache names definition.
    CacheNames,
    /// Incorrectly configured 'caching' annotation.
    CacheAnnotations,
    /// Incorrect @Transactional propagation on a @TransactionalEventListener method.
    TransactionalEventListener,
    /// Invalid transactional lifecycle method declaration.
    TransactionLifecycle,
    /// Invalid @DirtiesContext 'mode' configuration.
    DirtiesContext,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum SpringProblemSeverity {
    Error,
    Warning,
    WeakWarning,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SpringEdit {
    pub range: Range,
    pub text: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SpringFix {
    /// IDEA's fix text (English; the frontend translates it).
    pub label: String,
    /// Fixes sharing a label are one action choosing between these (`Add qualifier` → a bean).
    pub choice: Option<String>,
    pub edits: Vec<SpringEdit>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SpringProblem {
    pub inspection: SpringInspection,
    pub range: Range,
    pub severity: SpringProblemSeverity,
    /// IDEA's message (English; the frontend translates it).
    pub message: String,
    pub fixes: Vec<SpringFix>,
}

// ---------------------------------------------------------------------------
// Source text: positions ⇄ byte offsets, nodes

struct Src<'t> {
    text: &'t str,
    tree: &'t Tree,
    /// Byte offset of each line start.
    lines: Vec<usize>,
}

impl<'t> Src<'t> {
    fn new(text: &'t str, tree: &'t Tree) -> Self {
        let mut lines = vec![0];
        lines.extend(text.match_indices('\n').map(|(i, _)| i + 1));
        Src { text, tree, lines }
    }

    fn pos(&self, byte: usize) -> Pos {
        let line = self.lines.partition_point(|&s| s <= byte).saturating_sub(1);
        let start = self.lines[line];
        let col = self.text.get(start..byte).map_or(0, |s| s.encode_utf16().count());
        Pos::new(line as u32, col as u32)
    }

    fn byte(&self, p: Pos) -> usize {
        let Some(&start) = self.lines.get(p.line as usize) else { return self.text.len() };
        let mut units = 0u32;
        for (i, c) in self.text[start..].char_indices() {
            if units >= p.col || c == '\n' {
                return start + i;
            }
            units += c.len_utf16() as u32;
        }
        self.text.len()
    }

    fn of(&self, n: Node) -> &'t str {
        self.text.get(n.byte_range()).unwrap_or_default()
    }

    /// The smallest node of `kind` around the name at `at`.
    fn enclosing(&self, at: Pos, kinds: &[&str]) -> Option<Node<'t>> {
        let b = self.byte(at);
        let mut n = self.tree.root_node().descendant_for_byte_range(b, b)?;
        loop {
            if kinds.contains(&n.kind()) {
                return Some(n);
            }
            n = n.parent()?;
        }
    }

    /// Leading whitespace of the line holding `byte`.
    fn indent_at(&self, byte: usize) -> &'t str {
        let line = self.lines.partition_point(|&s| s <= byte).saturating_sub(1);
        let rest = &self.text[self.lines[line]..];
        &rest[..rest.len() - rest.trim_start_matches([' ', '\t']).len()]
    }

    fn edit(&self, from: usize, to: usize, text: impl Into<String>) -> SpringEdit {
        SpringEdit { range: Range::new(self.pos(from), self.pos(to)), text: text.into() }
    }

    /// The annotation node starting at `at` (`@`).
    fn annotation(&self, at: Pos) -> Option<Node<'t>> {
        let b = self.byte(at);
        let mut n = self.tree.root_node().descendant_for_byte_range(b, b)?;
        loop {
            if matches!(n.kind(), "annotation" | "marker_annotation") && n.start_byte() == b {
                return Some(n);
            }
            n = n.parent()?;
        }
    }

    /// Removes a node and the whitespace after it (up to the next token).
    fn remove(&self, n: Node) -> SpringEdit {
        let rest = &self.text[n.end_byte()..];
        let ws = rest.len() - rest.trim_start().len();
        self.edit(n.start_byte(), n.end_byte() + ws, "")
    }
}

fn child_of_kind<'t>(n: Node<'t>, kind: &str) -> Option<Node<'t>> {
    let mut c = n.walk();
    n.children(&mut c).find(|c| c.kind() == kind)
}

/// `import fqn;` when the file cannot name it yet: among the imports in order, else after the
/// package.
fn import_edit(src: &Src, stub: &JavaStub, fqn: &str) -> Option<SpringEdit> {
    let (pkg, name) = fqn.rsplit_once('.')?;
    if stub.package == pkg
        || pkg == "java.lang"
        || stub.imports.iter().any(|i| !i.is_static && (i.path == fqn || i.on_demand && i.path == pkg))
    {
        return None;
    }
    if stub.imports.iter().any(|i| !i.is_static && !i.on_demand && simple(&i.path) == name) {
        return None;
    }
    let root = src.tree.root_node();
    let mut c = root.walk();
    let imports: Vec<Node> = root.children(&mut c).filter(|n| n.kind() == "import_declaration").collect();
    let path_of = |n: &Node| src.of(*n).trim_start_matches("import").trim().trim_end_matches(';').trim().to_owned();
    let regular: Vec<&Node> = imports.iter().filter(|n| !src.of(**n).contains("static ")).collect();
    if let Some(next) = regular.iter().find(|n| path_of(n).as_str() > fqn) {
        return Some(src.edit(next.start_byte(), next.start_byte(), format!("import {fqn};\n")));
    }
    if let Some(last) = regular.last().copied().or(imports.last()) {
        return Some(src.edit(last.end_byte(), last.end_byte(), format!("\nimport {fqn};")));
    }
    let mut c = root.walk();
    Some(match root.children(&mut c).find(|n| n.kind() == "package_declaration") {
        Some(n) => src.edit(n.end_byte(), n.end_byte(), format!("\n\nimport {fqn};")),
        None => src.edit(0, 0, format!("import {fqn};\n\n")),
    })
}

/// Removes `import fqn;` when `removed` were the file's only uses of its simple name.
fn unused_import_edit(src: &Src, fqn: &str, removed: usize) -> Option<SpringEdit> {
    let name = simple(fqn);
    let root = src.tree.root_node();
    let mut c = root.walk();
    let import = root.children(&mut c).find(|n| {
        n.kind() == "import_declaration" && src.of(*n).trim_end_matches(';').trim().ends_with(&format!(" {fqn}"))
    })?;
    let uses = src
        .text
        .match_indices(name)
        .filter(|(i, _)| !(import.start_byte()..import.end_byte()).contains(i))
        .filter(|(i, _)| {
            let before = src.text[..*i].chars().next_back();
            let after = src.text[i + name.len()..].chars().next();
            !before.is_some_and(|c| c.is_alphanumeric() || c == '_' || c == '.')
                && !after.is_some_and(|c| c.is_alphanumeric() || c == '_')
        })
        .count();
    if uses > removed {
        return None;
    }
    let end = if src.text[import.end_byte()..].starts_with('\n') { import.end_byte() + 1 } else { import.end_byte() };
    Some(src.edit(import.start_byte(), end, ""))
}

// ---------------------------------------------------------------------------

struct Cx<'v, 'a, 't> {
    view: &'v JavaView<'a>,
    model: &'v SpringModel,
    src: Src<'t>,
    stub: &'a JavaStub,
    file: u32,
    out: Vec<SpringProblem>,
}

fn name_range(at: Pos, name: &str) -> Range {
    Range::new(at, Pos::new(at.line, at.col + name.encode_utf16().count() as u32))
}

/// The annotation's name (after `@`).
fn ann_range(a: &JavaAnnotation) -> Range {
    let at = Pos::new(a.at.line, a.at.col + 1);
    name_range(at, &a.name)
}

fn str_range(v: &AnnotationValue) -> Option<(Range, &str)> {
    match v {
        AnnotationValue::Str { text, at, end } => Some((Range::new(*at, *end), text.as_str())),
        _ => None,
    }
}

impl Cx<'_, '_, '_> {
    fn report(&mut self, inspection: SpringInspection, range: Range, severity: SpringProblemSeverity, message: String) {
        self.out.push(SpringProblem { inspection, range, severity, message, fixes: Vec::new() });
    }

    fn report_fixed(
        &mut self,
        inspection: SpringInspection,
        range: Range,
        severity: SpringProblemSeverity,
        message: String,
        fixes: Vec<SpringFix>,
    ) {
        self.out.push(SpringProblem { inspection, range, severity, message, fixes });
    }

    /// The contexts of `owner` hold every bean they can have (no unknown sources).
    fn complete(&self, owner: TypeId) -> bool {
        let contexts = self.model.contexts_of(owner);
        !contexts.is_empty() && contexts.iter().all(|&c| !self.model.contexts[c].unknown_sources)
    }

    fn is_bean_class(&self, owner: TypeId) -> bool {
        self.model.beans.iter().any(|b| {
            b.owner == Some(owner)
                && b.method.is_none()
                && matches!(b.origin, BeanOrigin::Scanned { .. } | BeanOrigin::Imported)
        })
    }

    /// Bean names in annotation strings (`@DependsOn("a")`): unresolved ones, when the context is complete.
    fn bean_refs(&mut self, inspection: SpringInspection, owner: TypeId, values: &[&AnnotationValue]) {
        if !self.complete(owner) {
            return;
        }
        for v in values.iter().flat_map(|v| v.items()) {
            let Some((range, name)) = str_range(v) else { continue };
            if name.is_empty() || name.contains("${") || name.contains("#{") {
                continue;
            }
            if beans_named(self.model, owner, name).is_empty() {
                self.report(inspection, range, SpringProblemSeverity::Error, format!("Cannot resolve bean '{name}'"));
            }
        }
    }
}

/// The problems of the edited file (`view`'s overlay), parsed as `tree` from `text`.
pub fn spring_problems(view: &JavaView, model: &SpringModel, tree: &Tree, text: &str) -> Vec<SpringProblem> {
    let Some(file) = view.overlay_file() else { return Vec::new() };
    let Some(stub) = view.stub(file) else { return Vec::new() };
    let mut cx = Cx { view, model, src: Src::new(text, tree), stub, file, out: Vec::new() };
    autowiring(&mut cx);
    for (ti, t) in stub.types.iter().enumerate() {
        if t.kind == JavaTypeKind::Annotation || t.is(ANONYMOUS) {
            continue;
        }
        let owner = TypeId { file, ty: ti as u32 };
        let tanns = resolve_all(view, &model.meta, file, Some(owner), &t.annotation_args);
        type_checks(&mut cx, owner, t, &tanns);
        for m in &t.members {
            if m.annotation_args.is_empty() {
                continue;
            }
            let manns = resolve_all(view, &model.meta, file, Some(owner), &m.annotation_args);
            member_checks(&mut cx, owner, t, &tanns, m, &manns);
        }
    }
    cx.out.sort_by_key(|p| (p.range.start.line, p.range.start.col));
    cx.out
}

// ---------------------------------------------------------------------------
// Autowiring

fn autowiring(cx: &mut Cx) {
    let (view, model, file) = (cx.view, cx.model, cx.file);
    let mut supers = Supers::default();
    for ip in model.injections.iter().filter(|i| i.owner.file == file) {
        let bean_method = ip.kind == InjectionKind::BeanMethodParam;
        if !(bean_method || cx.is_bean_class(ip.owner)) || model.is_test_file(file) || !cx.complete(ip.owner) {
            continue;
        }
        let r = resolve(view, model, ip, &mut supers);
        if r.unknown_sources {
            continue;
        }
        let Some(at) = ip.at(view) else { continue };
        let range = name_range(at, &ip.name);
        let wanted = match &ip.wanted.ty {
            JResolved::Source(id) => view.ty(*id).map_or_else(String::new, |t| t.name.clone()),
            JResolved::External(e) => simple(e).to_owned(),
        };
        match r.outcome {
            Outcome::None if ip.required && ip.shape != Shape::Many => {
                let message = match ip.qualifiers.iter().find_map(|q| q.value.clone()).or(ip.by_name.clone()) {
                    Some(q) => format!("Cannot find bean with qualifier '{q}'"),
                    None => format!("Could not autowire. No beans of '{wanted}' type found."),
                };
                cx.report(SpringInspection::Autowiring, range, SpringProblemSeverity::Error, message);
            }
            Outcome::Ambiguous => {
                let mut names: Vec<String> = r
                    .beans
                    .iter()
                    .map(|&b| &model.beans[b])
                    .filter(|b| b.presence == Presence::Certain)
                    .map(|b| b.name.clone())
                    .collect();
                names.sort();
                names.dedup();
                let fixes = add_qualifier(cx, ip, &names);
                cx.report_fixed(
                    SpringInspection::Autowiring,
                    range,
                    SpringProblemSeverity::Error,
                    format!(
                        "Could not autowire. There is more than one bean of '{wanted}' type. Beans: {}",
                        names.join(", ")
                    ),
                    fixes,
                );
            }
            _ => {}
        }
    }
}

/// `Add qualifier`: `@Qualifier("name")` on the field / parameter, one choice per bean.
fn add_qualifier(cx: &Cx, ip: &InjectionPoint, names: &[String]) -> Vec<SpringFix> {
    let Some(at) = ip.at(cx.view) else { return Vec::new() };
    let src = &cx.src;
    let (start, prefix_sep) = match ip.param {
        Some(_) => match src.enclosing(at, &["formal_parameter"]) {
            Some(p) => (p.start_byte(), " ".to_owned()),
            None => return Vec::new(),
        },
        None => match src.enclosing(at, &["field_declaration"]) {
            Some(f) => (f.start_byte(), format!("\n{}", src.indent_at(f.start_byte()))),
            None => return Vec::new(),
        },
    };
    let import = import_edit(src, cx.stub, QUALIFIER);
    names
        .iter()
        .map(|n| {
            let mut edits = vec![src.edit(start, start, format!("@Qualifier(\"{n}\"){prefix_sep}"))];
            edits.extend(import.clone());
            SpringFix { label: "Add qualifier".to_owned(), choice: Some(n.clone()), edits }
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Type level

fn type_checks(cx: &mut Cx, owner: TypeId, t: &JavaType, anns: &[Ann]) {
    for a in anns {
        match a.fqn.as_str() {
            DEPENDS_ON => {
                let values: Vec<&AnnotationValue> = a.ann.arg("value").into_iter().collect();
                cx.bean_refs(SpringInspection::DependsOn, owner, &values);
            }
            PROFILE => profile_expression(cx, a.ann),
            DIRTIES_CONTEXT if a.ann.arg("methodMode").is_some() => cx.report(
                SpringInspection::DirtiesContext,
                ann_range(a.ann),
                SpringProblemSeverity::Warning,
                "Setting the method mode on an annotated test class has no meaning.  For class-level control, use classMode instead.".to_owned(),
            ),
            _ => {}
        }
    }
    let ops = cache_annotations(anns);
    if t.kind == JavaTypeKind::Interface {
        for (_, a) in &ops {
            cx.report(
                SpringInspection::CacheOnInterface,
                ann_range(a),
                SpringProblemSeverity::Warning,
                "Spring doesn't recommend annotating interface methods with @Cache* annotation".to_owned(),
            );
        }
    }
    let config = anns.iter().find(|a| a.fqn == CACHE_CONFIG).map(|a| a.ann);
    for (_, a) in &ops {
        cache_operation(cx, owner, a, config);
    }
    if let Some(c) = config {
        cache_bean_refs(cx, owner, c);
    }
}

// ---------------------------------------------------------------------------
// Member level

fn has(anns: &[Ann], fqn: &str) -> bool {
    anns.iter().any(|a| a.fqn == fqn)
}

fn find<'a, 'b>(anns: &'b [Ann<'a>], fqns: &[&str]) -> Option<&'b Ann<'a>> {
    anns.iter().find(|a| fqns.contains(&a.fqn.as_str()))
}

fn member_checks(cx: &mut Cx, owner: TypeId, t: &JavaType, tanns: &[Ann], m: &JavaMember, anns: &[Ann]) {
    let name = name_range(m.at, &m.name);
    let injected = find(anns, &[AUTOWIRED]).or_else(|| find(anns, &INJECT));
    let bean_class = cx.is_bean_class(owner);

    // Static members are not injected.
    if m.is(STATIC)
        && matches!(m.kind, JavaMemberKind::Field | JavaMemberKind::Method)
        && let Some(a) = injected
        && (a.fqn == AUTOWIRED || bean_class)
    {
        cx.report(
            SpringInspection::StaticInjection,
            name,
            SpringProblemSeverity::Warning,
            "Don't autowire static members".to_owned(),
        );
    }
    // Field injection.
    if m.kind == JavaMemberKind::Field
        && !m.is(STATIC)
        && bean_class
        && !cx.model.is_test_file(cx.file)
        && let Some(a) = injected
    {
        let fixes = constructor_injection(cx, owner, t, tanns, m, a).into_iter().collect();
        cx.report_fixed(
            SpringInspection::FieldInjection,
            name,
            SpringProblemSeverity::WeakWarning,
            "Field injection is not recommended".to_owned(),
            fixes,
        );
    }
    if m.kind != JavaMemberKind::Method {
        return;
    }

    for a in anns {
        match a.fqn.as_str() {
            DEPENDS_ON => {
                let values: Vec<&AnnotationValue> = a.ann.arg("value").into_iter().collect();
                cx.bean_refs(SpringInspection::DependsOn, owner, &values);
            }
            LOOKUP => {
                let values: Vec<&AnnotationValue> = a.ann.arg("value").into_iter().collect();
                cx.bean_refs(SpringInspection::Lookup, owner, &values);
            }
            PROFILE => profile_expression(cx, a.ann),
            BEAN => bean_methods(cx, owner, m, a.ann),
            DIRTIES_CONTEXT if a.ann.arg("classMode").is_some() => cx.report(
                SpringInspection::DirtiesContext,
                ann_range(a.ann),
                SpringProblemSeverity::Warning,
                "Setting the class mode on an annotated test method has no meaning. For method-level control use methodMode instead.".to_owned(),
            ),
            BEFORE_TRANSACTION | AFTER_TRANSACTION => {
                if !m.params.is_empty() {
                    cx.report(
                        SpringInspection::TransactionLifecycle,
                        name,
                        SpringProblemSeverity::Warning,
                        "Wrong number of arguments".to_owned(),
                    );
                }
                if m.ty != "void" {
                    cx.report(
                        SpringInspection::TransactionLifecycle,
                        name,
                        SpringProblemSeverity::Warning,
                        "Expected method return type is 'void'".to_owned(),
                    );
                }
            }
            _ => {}
        }
    }

    // @Scheduled
    let scheduled: Vec<&JavaAnnotation> = anns
        .iter()
        .flat_map(|a| match a.fqn.as_str() {
            SCHEDULED => vec![a.ann],
            SCHEDULES => a
                .ann
                .arg("value")
                .map(AnnotationValue::items)
                .unwrap_or_default()
                .iter()
                .filter_map(|v| match v {
                    AnnotationValue::Annotation(n) => Some(n.as_ref()),
                    _ => None,
                })
                .collect(),
            _ => Vec::new(),
        })
        .collect();
    if !scheduled.is_empty() {
        let schedulers: Vec<&AnnotationValue> = scheduled.iter().filter_map(|a| a.arg("scheduler")).collect();
        cx.bean_refs(SpringInspection::ScheduledBean, owner, &schedulers);
        if !m.params.is_empty() {
            let fix = cx.src.enclosing(m.at, &["method_declaration"]).and_then(|d| {
                let params = d.child_by_field_name("parameters")?;
                Some(SpringFix {
                    label: format!("Change '{}' to no-arg", m.name),
                    choice: None,
                    edits: vec![cx.src.edit(params.start_byte(), params.end_byte(), "()")],
                })
            });
            cx.report_fixed(
                SpringInspection::ScheduledSignature,
                name,
                SpringProblemSeverity::Warning,
                "@Scheduled methods must not take any arguments".to_owned(),
                fix.into_iter().collect(),
            );
        }
        if m.ty != "void" && !REACTIVE.contains(&simple(&m.ty)) {
            cx.report(
                SpringInspection::ScheduledSignature,
                name,
                SpringProblemSeverity::Warning,
                "@Scheduled methods must not return anything".to_owned(),
            );
        }
    }

    // @Async
    if has(anns, ASYNC) && !future_like(cx, owner, &m.ty) {
        let fix = async_fix(cx, m);
        cx.report_fixed(
            SpringInspection::AsyncSignature,
            name,
            SpringProblemSeverity::Warning,
            "Method annotated with @Async should return 'void' or \"Future-like\" type".to_owned(),
            fix.into_iter().collect(),
        );
    }

    // @EventListener
    if let Some(l) = anns.iter().find(|a| cx.model.meta.is_meta_annotated(&a.fqn, EVENT_LISTENER)) {
        let classes = ["classes", "value"].iter().any(|k| l.ann.arg(k).is_some_and(|v| !v.classes().is_empty()));
        if m.params.len() > 1 {
            cx.report(
                SpringInspection::EventListener,
                name,
                SpringProblemSeverity::Warning,
                "Method must have maximum one parameter".to_owned(),
            );
        } else if m.params.is_empty() && !classes {
            cx.report(
                SpringInspection::EventListener,
                name,
                SpringProblemSeverity::Warning,
                "Event parameter is mandatory for event listener method".to_owned(),
            );
        }
        if m.is(STATIC) {
            cx.report(
                SpringInspection::EventListener,
                name,
                SpringProblemSeverity::Warning,
                "Method annotated with @EventListener must be non-static".to_owned(),
            );
        }
        // @TransactionalEventListener + @Transactional: only REQUIRES_NEW / NOT_SUPPORTED (Spring 6.1).
        if cx.model.meta.is_meta_annotated(&l.fqn, TRANSACTIONAL_EVENT_LISTENER)
            && let Some(tx) = find(anns, &[TRANSACTIONAL])
        {
            let propagation = tx.ann.arg("propagation").and_then(AnnotationValue::name_segment);
            if !matches!(propagation, Some("REQUIRES_NEW" | "NOT_SUPPORTED")) {
                let fixes = propagation_fixes(cx, tx.ann);
                cx.report_fixed(
                    SpringInspection::TransactionalEventListener,
                    ann_range(tx.ann),
                    SpringProblemSeverity::Warning,
                    "@TransactionalEventListener method must not be annotated with @Transactional unless when declared as REQUIRES_NEW or NOT_SUPPORTED".to_owned(),
                    fixes,
                );
            }
        }
    }

    // Caching
    let ops = cache_annotations(anns);
    if !ops.is_empty() {
        if t.kind == JavaTypeKind::Interface {
            for (_, a) in &ops {
                cx.report(
                    SpringInspection::CacheOnInterface,
                    ann_range(a),
                    SpringProblemSeverity::Warning,
                    "Spring doesn't recommend annotating interface methods with @Cache* annotation".to_owned(),
                );
            }
        }
        if ops.iter().any(|(k, _)| *k == "Cacheable") && ops.iter().any(|(k, _)| *k == "CachePut") {
            cx.report(
                SpringInspection::CacheableAndCachePut,
                name,
                SpringProblemSeverity::Warning,
                "Spring doesn't recommend using @CachePut and @Cacheable annotate on the same method".to_owned(),
            );
        }
        if m.is(PRIVATE) {
            cx.report(
                SpringInspection::CacheAnnotations,
                name,
                SpringProblemSeverity::Error,
                "Caching annotations should be defined on public methods".to_owned(),
            );
        }
        let config = tanns.iter().find(|a| a.fqn == CACHE_CONFIG).map(|a| a.ann);
        for (_, a) in &ops {
            cache_operation(cx, owner, a, config);
        }
    }
}

/// Reactive return types `@Scheduled` methods may have (Spring 6.1).
const REACTIVE: &[&str] = &["Mono", "Flux", "Publisher", "Single", "Maybe", "Completable", "Flowable", "Observable"];

const FUTURES: &[&str] =
    &["Future", "CompletableFuture", "ListenableFuture", "ListenableFutureTask", "AsyncResult", "FutureTask"];

/// Whether `ty` (a method's return type) is `void` or a `Future`; unknown library types count as one.
fn future_like(cx: &Cx, owner: TypeId, ty: &str) -> bool {
    if ty == "void" || ty.is_empty() || FUTURES.contains(&simple(ty)) {
        return true;
    }
    if ty.chars().next().is_some_and(char::is_lowercase) || ty.ends_with("[]") {
        return false;
    }
    match cx.view.resolve(owner, ty) {
        JResolved::Source(id) => {
            let mut seen = HashSet::from([id]);
            let mut queue = vec![id];
            while let Some(t) = queue.pop() {
                for s in cx.view.supertypes(t) {
                    match s {
                        JResolved::Source(s) if seen.insert(s) => queue.push(s),
                        JResolved::External(e) if FUTURES.contains(&simple(&e)) || simple(&e) == "Future" => {
                            return true;
                        }
                        // A library supertype may be a Future.
                        JResolved::External(e) if !e.starts_with("java.") => return true,
                        _ => {}
                    }
                }
            }
            false
        }
        JResolved::External(e) => {
            !(e.starts_with("java.lang.")
                || e.starts_with("java.util.") && !e.starts_with("java.util.concurrent.")
                || !e.contains('.') && KNOWN_NOT_FUTURE.contains(&simple(&e)))
        }
    }
}

/// Types the resolver leaves unqualified that are certainly not futures.
const KNOWN_NOT_FUTURE: &[&str] = &[
    "String",
    "Object",
    "Integer",
    "Long",
    "Boolean",
    "Double",
    "Float",
    "Short",
    "Byte",
    "Character",
    "List",
    "Set",
    "Map",
    "Collection",
    "Optional",
    "Iterable",
];

fn boxed(ty: &str) -> &str {
    match ty {
        "int" => "Integer",
        "long" => "Long",
        "boolean" => "Boolean",
        "double" => "Double",
        "float" => "Float",
        "short" => "Short",
        "byte" => "Byte",
        "char" => "Character",
        other => other,
    }
}

/// `Change method to return 'CompletableFuture<T>'`: the return type, each `return x;` of the
/// method's own body wrapped in `CompletableFuture.completedFuture(x)`, the import.
fn async_fix(cx: &Cx, m: &JavaMember) -> Option<SpringFix> {
    let src = &cx.src;
    let d = src.enclosing(m.at, &["method_declaration"])?;
    let ty = d.child_by_field_name("type")?;
    let body = d.child_by_field_name("body")?;
    let written = src.of(ty).trim();
    let wrapped = format!("CompletableFuture<{}>", boxed(written));
    let mut edits = vec![src.edit(ty.start_byte(), ty.end_byte(), wrapped.clone())];
    let mut returns = Vec::new();
    collect_returns(body, &mut returns);
    for r in returns {
        let Some(value) = r.named_child(0) else { continue };
        edits.push(src.edit(
            value.start_byte(),
            value.end_byte(),
            format!("CompletableFuture.completedFuture({})", src.of(value)),
        ));
    }
    edits.extend(import_edit(src, cx.stub, "java.util.concurrent.CompletableFuture"));
    Some(SpringFix { label: format!("Change method to return '{wrapped}'"), choice: None, edits })
}

/// `return` statements of a body, not those of nested lambdas and classes.
fn collect_returns<'t>(n: Node<'t>, out: &mut Vec<Node<'t>>) {
    let mut c = n.walk();
    for child in n.children(&mut c) {
        match child.kind() {
            "return_statement" => out.push(child),
            "lambda_expression" | "class_body" | "class_declaration" => {}
            _ => collect_returns(child, out),
        }
    }
}

fn propagation_fixes(cx: &Cx, tx: &JavaAnnotation) -> Vec<SpringFix> {
    let src = &cx.src;
    let Some(node) = src.annotation(tx.at) else { return Vec::new() };
    let import = import_edit(src, cx.stub, "org.springframework.transaction.annotation.Propagation");
    let mut fixes = Vec::new();
    for value in ["REQUIRES_NEW", "NOT_SUPPORTED"] {
        let constant = format!("Propagation.{value}");
        let edit = match node.child_by_field_name("arguments") {
            None => src.edit(node.end_byte(), node.end_byte(), format!("(propagation = {constant})")),
            Some(args) => {
                let mut c = args.walk();
                let items: Vec<Node> = args.named_children(&mut c).filter(|n| !n.kind().ends_with("comment")).collect();
                let existing = items.iter().find(|p| {
                    p.kind() == "element_value_pair"
                        && p.child_by_field_name("key").is_some_and(|k| src.of(k) == "propagation")
                });
                match (existing, items.as_slice()) {
                    (Some(p), _) => {
                        let Some(v) = p.child_by_field_name("value") else { continue };
                        src.edit(v.start_byte(), v.end_byte(), constant.clone())
                    }
                    (None, []) => src.edit(args.start_byte(), args.end_byte(), format!("(propagation = {constant})")),
                    // `@Transactional("txManager")`: the value gets its name.
                    (None, [only]) if only.kind() != "element_value_pair" => src.edit(
                        args.start_byte(),
                        args.end_byte(),
                        format!("(value = {}, propagation = {constant})", src.of(*only)),
                    ),
                    (None, [.., last]) => {
                        src.edit(last.end_byte(), last.end_byte(), format!(", propagation = {constant}"))
                    }
                }
            }
        };
        let mut edits = vec![edit];
        edits.extend(import.clone());
        fixes.push(SpringFix { label: format!("Set propagation to {value}"), choice: None, edits });
    }
    let mut remove = vec![src.remove(node)];
    remove.extend(unused_import_edit(src, TRANSACTIONAL, 1));
    fixes.push(SpringFix { label: "Remove @Transactional".to_owned(), choice: None, edits: remove });
    fixes
}

// ---------------------------------------------------------------------------
// @Profile, @Bean(initMethod / destroyMethod), caching

fn profile_expression(cx: &mut Cx, a: &JavaAnnotation) {
    let values: Vec<&AnnotationValue> = a.arg("value").map(|v| v.items().iter().collect()).unwrap_or_default();
    if values.is_empty() {
        cx.report(
            SpringInspection::ProfileExpression,
            ann_range(a),
            SpringProblemSeverity::Error,
            "Profile expression must contain text".to_owned(),
        );
        return;
    }
    for v in values {
        let Some((range, text)) = str_range(v) else { continue };
        let message = if text.trim().is_empty() {
            "Profile expression must contain text"
        } else if !profile_well_formed(text) {
            "Malformed profile expression"
        } else {
            continue;
        };
        cx.report(SpringInspection::ProfileExpression, range, SpringProblemSeverity::Error, message.to_owned());
    }
}

/// Spring's `ProfilesParser`: names, `!`, `&`, `|` and parentheses; `&` and `|` are not mixed
/// without parentheses.
pub(super) fn profile_well_formed(expr: &str) -> bool {
    let mut tokens = Vec::new();
    let mut word = String::new();
    for c in expr.chars() {
        if "!&|()".contains(c) || c.is_whitespace() {
            if !word.is_empty() {
                tokens.push(std::mem::take(&mut word));
            }
            if !c.is_whitespace() {
                tokens.push(c.to_string());
            }
        } else {
            word.push(c);
        }
    }
    if !word.is_empty() {
        tokens.push(word);
    }
    fn level(t: &[String], i: &mut usize, nested: bool) -> bool {
        let mut op: Option<&str> = None;
        loop {
            // Operand: `!`* then a name or a parenthesized level.
            while t.get(*i).is_some_and(|s| s == "!") {
                *i += 1;
            }
            match t.get(*i).map(String::as_str) {
                Some("(") => {
                    *i += 1;
                    if !level(t, i, true) {
                        return false;
                    }
                }
                Some(")" | "&" | "|") | None => return false,
                Some(_) => *i += 1,
            }
            match t.get(*i).map(String::as_str) {
                None => return !nested,
                Some(")") => {
                    *i += 1;
                    return nested;
                }
                Some(o @ ("&" | "|")) => {
                    if op.is_some_and(|p| p != o) {
                        return false;
                    }
                    op = Some(if o == "&" { "&" } else { "|" });
                    *i += 1;
                }
                Some(_) => return false,
            }
        }
    }
    let mut i = 0;
    !tokens.is_empty() && level(&tokens, &mut i, false) && i == tokens.len()
}

/// `initMethod` / `destroyMethod` naming no method of the bean's class (when the class and its
/// supertypes are all in the sources).
fn bean_methods(cx: &mut Cx, owner: TypeId, m: &JavaMember, bean: &JavaAnnotation) {
    let JResolved::Source(ty) = cx.view.resolve(owner, &m.ty) else { return };
    let mut methods: HashSet<&str> = HashSet::new();
    let mut seen = HashSet::from([ty]);
    let mut queue = vec![ty];
    while let Some(t) = queue.pop() {
        if let Some(tt) = cx.view.ty(t) {
            methods.extend(tt.members.iter().filter(|x| x.kind == JavaMemberKind::Method).map(|x| x.name.as_str()));
        }
        for s in cx.view.supertypes(t) {
            match s {
                JResolved::Source(s) if seen.insert(s) => queue.push(s),
                JResolved::Source(_) => {}
                // A library supertype may declare it.
                JResolved::External(e) if !matches!(simple(&e), "Object" | "Serializable" | "Cloneable") => return,
                JResolved::External(_) => {}
            }
        }
    }
    for key in ["initMethod", "destroyMethod"] {
        let Some((range, name)) = bean.arg(key).and_then(str_range) else { continue };
        if name.is_empty() || name == "(inferred)" || name.contains("${") || methods.contains(name) {
            continue;
        }
        cx.report(
            SpringInspection::BeanMethods,
            range,
            SpringProblemSeverity::Error,
            "Cannot resolve method".to_owned(),
        );
    }
}

fn cache_operation(cx: &mut Cx, owner: TypeId, a: &JavaAnnotation, config: Option<&JavaAnnotation>) {
    let resolver = |x: &JavaAnnotation| {
        ["cacheResolver", "cacheManager"]
            .iter()
            .any(|k| x.arg(k).and_then(AnnotationValue::as_str).is_some_and(|s| !s.is_empty()))
    };
    let config_names = config.map(own_cache_names).unwrap_or_default();
    if own_cache_names(a).is_empty() && config_names.is_empty() && !resolver(a) && !config.is_some_and(resolver) {
        cx.report(
            SpringInspection::CacheNames,
            ann_range(a),
            SpringProblemSeverity::Warning,
            "At least one non-empty cache name is required per cache operation.".to_owned(),
        );
    }
    let set = |k: &str| a.arg(k).and_then(AnnotationValue::as_str).is_some_and(|s| !s.is_empty());
    if set("key") && set("keyGenerator") {
        cx.report(
            SpringInspection::CacheAnnotations,
            ann_range(a),
            SpringProblemSeverity::Error,
            "Both 'key' and 'keyGenerator' attributes have been set. These attributes are mutually exclusive: either set the SpEL expression used to compute the key at runtime or set the name of the KeyGenerator bean to use.".to_owned(),
        );
    }
    if set("cacheManager") && set("cacheResolver") {
        cx.report(
            SpringInspection::CacheAnnotations,
            ann_range(a),
            SpringProblemSeverity::Error,
            "Both 'cacheManager' and 'cacheResolver' attributes have been set. These attributes are mutually exclusive: the cache manager is used to configure a default cache resolver if none is set. If a cache resolver is set, the cache manager won't be used.".to_owned(),
        );
    }
    cache_bean_refs(cx, owner, a);
}

fn cache_bean_refs(cx: &mut Cx, owner: TypeId, a: &JavaAnnotation) {
    let values: Vec<&AnnotationValue> =
        ["cacheManager", "cacheResolver", "keyGenerator"].iter().filter_map(|k| a.arg(k)).collect();
    cx.bean_refs(SpringInspection::CacheAnnotations, owner, &values);
}

// ---------------------------------------------------------------------------
// Field injection → constructor injection

/// IDEA's `Create constructor: x` / `Add parameter(s) to constructor: x`: the field becomes
/// `final`, loses `@Autowired` (its qualifiers move to the parameter) and is assigned by the
/// constructor; with Lombok's `@RequiredArgsConstructor` making it `final` is enough.
fn constructor_injection(
    cx: &Cx,
    owner: TypeId,
    t: &JavaType,
    tanns: &[Ann],
    m: &JavaMember,
    injected: &Ann,
) -> Option<SpringFix> {
    if !matches!(t.kind, JavaTypeKind::Class)
        || injected.ann.arg("required").and_then(AnnotationValue::as_bool) == Some(false)
    {
        return None;
    }
    let src = &cx.src;
    let field = src.enclosing(m.at, &["field_declaration"])?;
    // `@Autowired private A a, b;`: not split by this fix.
    let mut c = field.walk();
    if field.children_by_field_name("declarator", &mut c).count() != 1 {
        return None;
    }
    let ty = field.child_by_field_name("type")?;
    let modifiers = child_of_kind(field, "modifiers");
    let constructors: Vec<&JavaMember> = t.members.iter().filter(|x| x.kind == JavaMemberKind::Constructor).collect();
    // Lombok generates the constructor (and copies qualifiers only when configured to: they stay).
    let lombok =
        constructors.is_empty() && tanns.iter().any(|a| a.fqn == LOMBOK_REQUIRED_ARGS || a.fqn == LOMBOK_ALL_ARGS);
    let mut edits = Vec::new();
    // Annotations: `@Autowired` / `@Inject` go; qualifiers move to the parameter.
    let mut qualifiers = Vec::new();
    let mut removed_imports: Vec<String> = Vec::new();
    if let Some(mods) = modifiers {
        let mut c = mods.walk();
        for a in mods.children(&mut c) {
            if !matches!(a.kind(), "annotation" | "marker_annotation") {
                continue;
            }
            let start = src.pos(a.start_byte());
            let Some(info) = m.annotation_args.iter().find(|x| x.at == start) else { continue };
            let fqn = annotation_fqn(cx.view, &cx.model.meta, cx.file, Some(owner), &info.name);
            if fqn == AUTOWIRED || INJECT.contains(&fqn.as_str()) {
                edits.push(src.remove(a));
                removed_imports.push(fqn);
            } else if !lombok && cx.model.meta.is_any(&fqn, &[QUALIFIER, QUALIFIER_JSR330[0], QUALIFIER_JSR330[1]]) {
                qualifiers.push(src.of(a).to_owned());
                edits.push(src.remove(a));
            }
        }
    }
    let is_final = modifiers.is_some_and(|mods| {
        let mut c = mods.walk();
        mods.children(&mut c).any(|k| k.kind() == "final")
    });
    if !is_final {
        edits.push(src.edit(ty.start_byte(), ty.start_byte(), "final "));
    }
    let param = format!("{}{} {}", qualifiers.iter().map(|q| format!("{q} ")).collect::<String>(), src.of(ty), m.name);
    let assign = format!("this.{0} = {0};", m.name);
    let field_indent = src.indent_at(field.start_byte()).to_owned();
    let class_indent = src.indent_at(src.byte(t.at)).to_owned();
    let unit = field_indent.strip_prefix(class_indent.as_str()).filter(|u| !u.is_empty()).unwrap_or("    ").to_owned();
    let label = match (constructors.as_slice(), lombok) {
        ([], true) => format!("Add parameter(s) to constructor: {}", m.name),
        ([], _) => {
            // After the last field of the class.
            let body = field.parent()?;
            let mut c = body.walk();
            let last = body.children(&mut c).filter(|n| n.kind() == "field_declaration").last()?;
            let ctor = format!(
                "\n\n{field_indent}public {}({param}) {{\n{field_indent}{unit}{assign}\n{field_indent}}}",
                t.name
            );
            edits.push(src.edit(last.end_byte(), last.end_byte(), ctor));
            format!("Create constructor: {}", m.name)
        }
        ([only], _) => {
            let d = src.enclosing(only.at, &["constructor_declaration"])?;
            let params = d.child_by_field_name("parameters")?;
            let body = d.child_by_field_name("body")?;
            // `this(...)` delegates: the parameter would have to travel along.
            if src.of(body).contains("this(") {
                return None;
            }
            let close = params.end_byte() - 1;
            let sep = if only.params.is_empty() { "" } else { ", " };
            edits.push(src.edit(close, close, format!("{sep}{param}")));
            let ctor_indent = src.indent_at(d.start_byte()).to_owned();
            let mut c = body.walk();
            let last = body.named_children(&mut c).filter(|n| !n.kind().ends_with("comment")).last();
            match last {
                Some(stmt) => {
                    edits.push(src.edit(stmt.end_byte(), stmt.end_byte(), format!("\n{ctor_indent}{unit}{assign}")))
                }
                None => edits.push(src.edit(
                    body.start_byte(),
                    body.end_byte(),
                    format!("{{\n{ctor_indent}{unit}{assign}\n{ctor_indent}}}"),
                )),
            }
            format!("Add parameter(s) to constructor: {}", m.name)
        }
        _ => return None,
    };
    for fqn in removed_imports {
        edits.extend(unused_import_edit(src, &fqn, 1));
    }
    edits.sort_by_key(|e| (e.range.start.line, e.range.start.col));
    Some(SpringFix { label, choice: None, edits })
}
