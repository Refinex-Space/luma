//! Spring features declared by annotations, and the gutter markers IDEA shows for them:
//! application events (`SpringEventListenerAnnotator`: listeners ⇄ `publishEvent` calls),
//! scheduled tasks (`SpringScheduledTasksLineMarker`), cache operations sharing cache names
//! (`SpringCacheableAnnotator`) and test classes' application contexts
//! (`SpringTestConfigurationAnnotator`).
//!
//! Listeners and cache operations are collected with the model (they are looked up from any
//! file); publishers are call sites, which the structure index does not see: the Java language
//! server finds them (`luma.spring.events`) and hands them in as [`EventPublisher`]s.

use super::super::Resolved as JResolved;
use super::annotations::*;
use super::collect::{Ann, resolve_all};
use super::markers::{SpringMarker, SpringMarkerKind, SpringPresence, SpringTarget, file_path, module_label};
use super::matching::same_external;
use super::*;
use ide_core::{IpcPath, Location, Range};

/// An `@EventListener` method, or an `ApplicationListener` implementation.
#[derive(Clone, Debug)]
pub struct Listener {
    pub owner: TypeId,
    /// The method (`onApplicationEvent` of an `ApplicationListener`, when declared).
    pub member: Option<u32>,
    /// Qualified names of the events it hears (as known: a guess for unresolved names).
    pub events: Vec<String>,
}

/// One `@Cacheable` / `@CachePut` / `@CacheEvict` of a method (or of a class: every method).
#[derive(Clone, Debug)]
pub struct CacheOp {
    pub owner: TypeId,
    pub member: Option<u32>,
    /// `Cacheable`, `CachePut` or `CacheEvict`.
    pub kind: &'static str,
    /// Its cache names, or the class's `@CacheConfig(cacheNames)`.
    pub names: Vec<String>,
}

/// A `publishEvent(…)` call, as the Java language server resolved it.
#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct EventPublisher {
    pub path: PathBuf,
    /// Where `publishEvent` is (0-based line, UTF-16 column, length).
    pub line: u32,
    pub col: u32,
    pub len: u32,
    /// The published object's type (erased) and its supertypes, qualified.
    pub event: String,
    pub supertypes: Vec<String>,
    /// The enclosing method: `OrderService.place()`.
    pub method: String,
}

/// The FQN of a type written in `owner` (a guess when the index cannot resolve it).
pub(super) fn qualified(view: &JavaView, owner: TypeId, written: &str) -> String {
    match view.resolve(owner, written) {
        JResolved::Source(id) => view.qualified_name(id).unwrap_or_else(|| written.to_owned()),
        JResolved::External(e) => e,
    }
}

const CACHE_OPS: [(&str, &str); 3] = [(CACHEABLE, "Cacheable"), (CACHE_PUT, "CachePut"), (CACHE_EVICT, "CacheEvict")];

/// The cache operations an annotation list declares: direct ones and those of `@Caching`.
pub(super) fn cache_annotations<'a>(anns: &'a [Ann<'a>]) -> Vec<(&'static str, &'a JavaAnnotation)> {
    let mut out = Vec::new();
    for a in anns {
        if let Some((_, kind)) = CACHE_OPS.iter().find(|(f, _)| *f == a.fqn) {
            out.push((*kind, a.ann));
        } else if a.fqn == CACHING {
            for (key, kind) in [("cacheable", "Cacheable"), ("put", "CachePut"), ("evict", "CacheEvict")] {
                for v in a.ann.arg(key).map(AnnotationValue::items).unwrap_or_default() {
                    if let AnnotationValue::Annotation(nested) = v {
                        out.push((kind, nested.as_ref()));
                    }
                }
            }
        }
    }
    out
}

/// Cache names an operation names itself (`cacheNames` / `value`), non-empty ones.
pub(super) fn own_cache_names(a: &JavaAnnotation) -> Vec<String> {
    strings_of(a, &["cacheNames", "value"]).into_iter().filter(|s| !s.trim().is_empty()).collect()
}

/// `@CacheConfig(cacheNames)` of a class.
pub(super) fn config_cache_names(anns: &[Ann]) -> Vec<String> {
    anns.iter().find(|a| a.fqn == CACHE_CONFIG).map(|a| own_cache_names(a.ann)).unwrap_or_default()
}

/// Collects the listeners and cache operations of every file.
pub(super) fn collect(view: &JavaView, model: &mut SpringModel) {
    let mut listeners = Vec::new();
    let mut ops = Vec::new();
    // Annotations (simple names) that declare either: custom listener annotations included.
    let mut names: HashSet<String> =
        ["Cacheable", "CachePut", "CacheEvict", "Caching"].iter().map(|s| (*s).to_owned()).collect();
    names.extend(model.meta.children(EVENT_LISTENER).into_iter().map(|f| simple(f).to_owned()));
    let named = |list: &[String]| list.iter().any(|a| names.contains(simple(a)));
    for (file, stub) in files(view) {
        for (ti, t) in stub.types.iter().enumerate() {
            if t.kind == JavaTypeKind::Annotation || t.is(ANONYMOUS) {
                continue;
            }
            let listener = t.supers.iter().any(|s| simple(s) == "ApplicationListener");
            if !listener && !named(&t.annotations) && !t.members.iter().any(|m| named(&m.annotations)) {
                continue;
            }
            let owner = TypeId { file, ty: ti as u32 };
            let tanns = resolve_all(view, &model.meta, file, Some(owner), &t.annotation_args);
            let config_names = config_cache_names(&tanns);
            for (kind, a) in cache_annotations(&tanns) {
                let names = own_cache_names(a);
                ops.push(CacheOp {
                    owner,
                    member: None,
                    kind,
                    names: if names.is_empty() { config_names.clone() } else { names },
                });
            }
            // `implements ApplicationListener<E>`.
            if t.kind == JavaTypeKind::Class && !t.is(ABSTRACT) {
                for (si, s) in t.supers.iter().enumerate() {
                    if simple(s) != "ApplicationListener" {
                        continue;
                    }
                    let Some(event) = t.super_args.get(si).and_then(|a| a.first()) else { continue };
                    let member = t
                        .members
                        .iter()
                        .position(|m| m.name == "onApplicationEvent" && m.params.len() == 1)
                        .map(|m| m as u32);
                    listeners.push(Listener { owner, member, events: vec![qualified(view, owner, event)] });
                }
            }
            for (mi, m) in t.members.iter().enumerate() {
                if m.kind != JavaMemberKind::Method || m.annotation_args.is_empty() {
                    continue;
                }
                let manns = resolve_all(view, &model.meta, file, Some(owner), &m.annotation_args);
                if let Some(l) = manns.iter().find(|a| model.meta.is_meta_annotated(&a.fqn, EVENT_LISTENER)) {
                    listeners.push(Listener {
                        owner,
                        member: Some(mi as u32),
                        events: listener_events(view, owner, m, l.ann),
                    });
                }
                for (kind, a) in cache_annotations(&manns) {
                    let names = own_cache_names(a);
                    ops.push(CacheOp {
                        owner,
                        member: Some(mi as u32),
                        kind,
                        names: if names.is_empty() { config_names.clone() } else { names },
                    });
                }
            }
        }
    }
    model.listeners = listeners;
    model.cache_ops = ops;
}

/// The events an `@EventListener` method hears: its `classes` (`value`), else its parameter's type.
fn listener_events(view: &JavaView, owner: TypeId, m: &JavaMember, ann: &JavaAnnotation) -> Vec<String> {
    let classes: Vec<String> = ["classes", "value"]
        .iter()
        .filter_map(|k| ann.arg(k))
        .flat_map(|v| v.classes())
        .map(|c| qualified(view, owner, c))
        .collect();
    if !classes.is_empty() {
        return classes;
    }
    match m.param_details.first() {
        // `PayloadApplicationEvent<Order>` hears `Order` payloads.
        Some(p) if simple(&p.ty) == "PayloadApplicationEvent" && !p.ty_args.is_empty() => {
            vec![qualified(view, owner, &p.ty_args[0])]
        }
        Some(p) if !p.ty.is_empty() => vec![qualified(view, owner, &p.ty)],
        _ => Vec::new(),
    }
}

/// Whether a listener of `events` hears what `p` publishes (the event or one of its supertypes).
pub fn hears(events: &[String], p: &EventPublisher) -> bool {
    events.iter().any(|l| {
        std::iter::once(&p.event).chain(&p.supertypes).any(|t| t == l || same_external(t, l))
            || simple(l) == "Object" && (l == "Object" || l == "java.lang.Object")
    })
}

fn name_range(at: Pos, name: &str) -> Range {
    Range::new(at, Pos::new(at.line, at.col + name.encode_utf16().count() as u32))
}

/// Where a member (or the type) is declared, its label (`Owner.method()`) and its file.
fn declaration(view: &JavaView, owner: TypeId, member: Option<u32>) -> Option<(Range, String, String)> {
    let stub = view.stub(owner.file)?;
    let t = stub.types.get(owner.ty as usize)?;
    let display = stub.display_name(owner.ty);
    Some(match member.and_then(|m| t.members.get(m as usize)) {
        Some(m) => (name_range(m.at, &m.name), format!("{display}.{}()", m.name), m.name.clone()),
        None => (name_range(t.at, &t.name), display, t.name.clone()),
    })
}

struct Cx<'v, 'a> {
    view: &'v JavaView<'a>,
    model: &'v SpringModel,
    path: &'v Path,
    multi: bool,
}

impl Cx<'_, '_> {
    fn target(&self, owner: TypeId, member: Option<u32>, detail: String) -> Option<SpringTarget> {
        let (range, label, _) = declaration(self.view, owner, member)?;
        Some(SpringTarget {
            location: Location { path: IpcPath::from(file_path(self.view, self.path, owner.file)?), range, uri: None },
            label,
            owner: detail,
            module: module_label(self.model, owner.file, self.multi),
            kind: None,
            primary: false,
            fallback: false,
            presence: SpringPresence::Certain,
            handle: None,
        })
    }

    fn publisher_target(&self, p: &EventPublisher) -> SpringTarget {
        let at = Pos::new(p.line, p.col);
        SpringTarget {
            location: Location {
                path: IpcPath::from(p.path.clone()),
                range: Range::new(at, Pos::new(p.line, p.col + p.len)),
                uri: None,
            },
            label: p.method.clone(),
            owner: simple(&p.event).to_owned(),
            module: None,
            kind: None,
            primary: false,
            fallback: false,
            presence: SpringPresence::Certain,
            handle: None,
        }
    }
}

fn marker(line: u32, col: u32, name: String, kind: SpringMarkerKind, targets: Vec<SpringTarget>) -> SpringMarker {
    SpringMarker { line, col, name, kind, resolution: None, targets, detail: None, bean: None, context: None }
}

/// The edited file's event, scheduling, cache and test configuration markers.
pub(super) fn markers(
    view: &JavaView,
    model: &SpringModel,
    path: &Path,
    multi: bool,
    publishers: &[EventPublisher],
    out: &mut Vec<SpringMarker>,
) {
    let Some(file) = view.overlay_file() else { return };
    let cx = Cx { view, model, path, multi };

    // Listeners here → the calls publishing what they hear (none found is a marker too).
    for l in model.listeners.iter().filter(|l| l.owner.file == file) {
        let Some((range, _, name)) = declaration(view, l.owner, l.member) else { continue };
        let targets = publishers.iter().filter(|p| hears(&l.events, p)).map(|p| cx.publisher_target(p)).collect();
        let mut m = marker(range.start.line, range.start.col, name, SpringMarkerKind::EventListener, targets);
        m.detail = Some(l.events.iter().map(|e| simple(e)).collect::<Vec<_>>().join(", "));
        out.push(m);
    }
    // Calls here → the listeners hearing them.
    let canonical = |p: &Path| p.canonicalize().unwrap_or_else(|_| p.to_owned());
    let here = canonical(path);
    for p in publishers.iter().filter(|p| p.path == path || canonical(&p.path) == here) {
        let targets: Vec<SpringTarget> = model
            .listeners
            .iter()
            .filter(|l| hears(&l.events, p))
            .filter_map(|l| {
                cx.target(l.owner, l.member, l.events.iter().map(|e| simple(e)).collect::<Vec<_>>().join(", "))
            })
            .collect();
        let mut m = marker(p.line, p.col, "publishEvent".to_owned(), SpringMarkerKind::EventPublisher, targets);
        m.detail = Some(simple(&p.event).to_owned());
        out.push(m);
    }

    let Some(stub) = view.stub(file) else { return };
    for (ti, t) in stub.types.iter().enumerate() {
        if t.kind == JavaTypeKind::Annotation || t.is(ANONYMOUS) {
            continue;
        }
        let owner = TypeId { file, ty: ti as u32 };
        // Test classes → their application context's configuration.
        if !t.annotation_args.is_empty() {
            let anns = resolve_all(view, &model.meta, file, Some(owner), &t.annotation_args);
            if let Some(targets) = test_context(&cx, owner, &anns) {
                out.push(marker(t.at.line, t.at.col, t.name.clone(), SpringMarkerKind::TestContext, targets));
            }
        }
        for m in &t.members {
            if m.kind != JavaMemberKind::Method || m.annotation_args.is_empty() {
                continue;
            }
            let manns = resolve_all(view, &model.meta, file, Some(owner), &m.annotation_args);
            let scheduled: Vec<&JavaAnnotation> = manns
                .iter()
                .flat_map(|a| {
                    if a.fqn == SCHEDULED {
                        vec![a.ann]
                    } else if a.fqn == SCHEDULES {
                        a.ann
                            .arg("value")
                            .map(AnnotationValue::items)
                            .unwrap_or_default()
                            .iter()
                            .filter_map(|v| match v {
                                AnnotationValue::Annotation(n) => Some(n.as_ref()),
                                _ => None,
                            })
                            .collect()
                    } else {
                        Vec::new()
                    }
                })
                .collect();
            if !scheduled.is_empty() {
                let targets = scheduled
                    .iter()
                    .filter_map(|a| a.arg("scheduler").and_then(AnnotationValue::as_str))
                    .flat_map(|name| beans_named(model, owner, name))
                    .filter_map(|b| super::markers::bean_target(view, model, path, &model.beans[b], multi))
                    .collect();
                let mut mk = marker(m.at.line, m.at.col, m.name.clone(), SpringMarkerKind::Scheduled, targets);
                mk.detail = Some(scheduled.iter().map(|a| schedule_text(a)).collect::<Vec<_>>().join("; "));
                out.push(mk);
            }
        }
    }

    // Cache operations here → the others sharing a cache name.
    let mut seen: HashSet<(Option<u32>, u32)> = HashSet::new();
    for op in model.cache_ops.iter().filter(|o| o.owner.file == file && !o.names.is_empty()) {
        if !seen.insert((op.member, op.owner.ty)) {
            continue;
        }
        let mine: Vec<&CacheOp> =
            model.cache_ops.iter().filter(|o| o.owner == op.owner && o.member == op.member).collect();
        let names: HashSet<&str> = mine.iter().flat_map(|o| o.names.iter().map(String::as_str)).collect();
        let mut targets: Vec<SpringTarget> = Vec::new();
        for other in model.cache_ops.iter().filter(|o| !(o.owner == op.owner && o.member == op.member)) {
            let shared: Vec<&str> = other.names.iter().map(String::as_str).filter(|n| names.contains(n)).collect();
            if shared.is_empty() {
                continue;
            }
            let detail = format!("@{}({})", other.kind, shared.join(", "));
            if let Some(t) = cx.target(other.owner, other.member, detail)
                && !targets.iter().any(|x| x.location == t.location && x.owner == t.owner)
            {
                targets.push(t);
            }
        }
        if targets.is_empty() {
            continue;
        }
        let Some((range, _, name)) = declaration(view, op.owner, op.member) else { continue };
        let mut sorted: Vec<&str> = names.into_iter().collect();
        sorted.sort_unstable();
        let mut m = marker(range.start.line, range.start.col, name, SpringMarkerKind::Cacheable, targets);
        m.detail = Some(sorted.join(", "));
        out.push(m);
    }
}

/// Beans named `name` in the contexts of `owner` (every bean when it has none).
pub(super) fn beans_named(model: &SpringModel, owner: TypeId, name: &str) -> Vec<usize> {
    let contexts = model.contexts_of(owner);
    model
        .beans
        .iter()
        .enumerate()
        .filter(|(i, _)| contexts.is_empty() || contexts.iter().any(|&c| model.contexts[c].beans.contains(i)))
        .filter(|(_, b)| b.name == name || b.aliases.iter().any(|a| a == name))
        .map(|(i, _)| i)
        .collect()
}

/// `cron "0 0 * * * *"`, `fixedRate 5000`, … as written.
fn schedule_text(a: &JavaAnnotation) -> String {
    let value = |v: &AnnotationValue| match v {
        AnnotationValue::Str { text, .. } => format!("\"{text}\""),
        AnnotationValue::Num(n) => n.clone(),
        AnnotationValue::Name(n) => n.clone(),
        _ => "…".to_owned(),
    };
    let mut parts = Vec::new();
    for key in ["cron", "fixedRate", "fixedRateString", "fixedDelay", "fixedDelayString", "initialDelay"] {
        if let Some(v) = a.arg(key) {
            parts.push(format!("{} {}", key.trim_end_matches("String"), value(v)));
        }
    }
    if let Some(zone) = a.arg("zone").and_then(AnnotationValue::as_str) {
        parts.push(format!("zone \"{zone}\""));
    }
    if let Some(unit) = a.arg("timeUnit").and_then(AnnotationValue::name_segment) {
        parts.push(unit.to_lowercase());
    }
    parts.join(", ")
}

/// A test class's application context configuration (`SpringTestConfigurationAnnotator`):
/// `classes` of `@ContextConfiguration` / `@SpringBootTest` / `@SpringJUnitConfig`, else its
/// nested configurations, else (Boot tests) the nearest `@SpringBootConfiguration` above its
/// package. `None` when it is no Spring test.
fn test_context(cx: &Cx, owner: TypeId, anns: &[Ann]) -> Option<Vec<SpringTarget>> {
    let meta = &cx.model.meta;
    let boot = anns.iter().any(|a| a.fqn != CONTEXT_CONFIGURATION && meta.is_meta_annotated(&a.fqn, BOOTSTRAP_WITH));
    let configured = anns.iter().any(|a| meta.is_meta_annotated(&a.fqn, CONTEXT_CONFIGURATION));
    if !boot && !configured {
        return None;
    }
    let view = cx.view;
    let mut classes: Vec<TypeId> = Vec::new();
    for a in anns {
        let keys: &[&str] = match a.fqn.as_str() {
            CONTEXT_CONFIGURATION | SPRING_BOOT_TEST => &["classes"],
            SPRING_JUNIT_CONFIG | SPRING_JUNIT_WEB_CONFIG => &["classes", "value"],
            _ => &[],
        };
        for c in keys.iter().filter_map(|k| a.ann.arg(k)).flat_map(|v| v.classes()) {
            if let JResolved::Source(id) = view.resolve(owner, c) {
                classes.push(id);
            }
        }
    }
    if classes.is_empty() {
        // Nested `@Configuration` classes (Boot: `@TestConfiguration` ones add to the application's).
        let stub = view.stub(owner.file)?;
        let mut replaces = false;
        for (ti, t) in stub.types.iter().enumerate() {
            if t.outer != Some(owner.ty) || !t.is(STATIC) {
                continue;
            }
            let id = TypeId { file: owner.file, ty: ti as u32 };
            let nanns = resolve_all(view, meta, owner.file, Some(id), &t.annotation_args);
            if nanns.iter().any(|a| meta.is_meta_annotated(&a.fqn, CONFIGURATION)) {
                replaces |= !nanns.iter().any(|a| a.fqn == TEST_CONFIGURATION);
                classes.push(id);
            }
        }
        if boot
            && !replaces
            && let Some(app) = nearest_boot_configuration(cx, owner)
        {
            classes.insert(0, app);
        }
    }
    let targets: Vec<SpringTarget> = classes.into_iter().filter_map(|id| cx.target(id, None, String::new())).collect();
    (!targets.is_empty()).then_some(targets)
}

/// Spring Boot's `SpringBootConfigurationFinder`: the `@SpringBootConfiguration` in the test's
/// package or the nearest enclosing package.
fn nearest_boot_configuration(cx: &Cx, owner: TypeId) -> Option<TypeId> {
    let view = cx.view;
    let pkg = view.stub(owner.file)?.package.clone();
    let module = cx.model.module_of(owner.file);
    cx.model
        .contexts
        .iter()
        .filter(|c| c.kind == ContextKind::Boot)
        .filter_map(|c| c.root)
        .filter(|r| {
            let p = view.stub(r.file).map(|s| s.package.as_str()).unwrap_or_default();
            p.is_empty() || pkg == p || pkg.strip_prefix(p).is_some_and(|rest| rest.starts_with('.'))
        })
        // The same module's first, then the longest (nearest) package.
        .max_by_key(|r| {
            let p = view.stub(r.file).map_or(0, |s| s.package.len());
            (cx.model.module_of(r.file) == module, p)
        })
}
