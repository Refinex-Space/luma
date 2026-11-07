//! Answers for an open file: its Spring gutter markers (IDEA's `SpringAutowiredAnnotator` and
//! `SpringBeanAnnotator`) and the candidates of the injection point at a position.

use super::matching::{Outcome, Resolution, Supers, resolve};
use super::*;
use ide_core::{IpcPath, Location, Range};
use specta::Type;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum SpringMarkerKind {
    /// On a bean (class or `@Bean` method): where it is injected.
    Bean,
    /// On an injection point: the beans it receives.
    Injection,
    /// On an `@EventListener` method / `ApplicationListener`: the calls publishing its events.
    EventListener,
    /// On a `publishEvent` call: the listeners of its event.
    EventPublisher,
    /// On a `@Scheduled` method (`detail`: its schedule): the scheduler bean it names, if any.
    Scheduled,
    /// On a cache operation: the others sharing one of its cache names.
    Cacheable,
    /// On a Spring test class: its application context's configuration classes.
    TestContext,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum SpringPresence {
    Certain,
    /// Depends on a condition or profile not evaluated.
    Conditional,
    /// Its profile is not active.
    Inactive,
}

impl From<Presence> for SpringPresence {
    fn from(p: Presence) -> Self {
        match p {
            Presence::Certain => SpringPresence::Certain,
            Presence::Conditional => SpringPresence::Conditional,
            Presence::Inactive => SpringPresence::Inactive,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum SpringResolution {
    /// One bean is injected (the first target).
    Unique,
    /// Every target is injected (a collection).
    Many,
    /// Several candidates, nothing decides.
    Ambiguous,
    /// Only candidates that depend on a condition or profile.
    Conditional,
    /// No candidate among the beans the model knows.
    None,
}

/// A bean or an injection point a marker navigates to.
#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SpringTarget {
    pub location: Location,
    /// The bean name, or the injection point (`OrderController(orders)`).
    pub label: String,
    /// The type it is in (`Outer.Inner`).
    pub owner: String,
    /// The build module's folder name, when the project has several.
    pub module: Option<String>,
    pub kind: Option<BeanKind>,
    pub primary: bool,
    pub fallback: bool,
    pub presence: SpringPresence,
    /// A library bean: the JDT handle to open it with (`spring_locate`); `location` is empty.
    pub handle: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SpringMarker {
    /// The declaration's name, 0-based line / UTF-16 column.
    pub line: u32,
    pub col: u32,
    pub name: String,
    pub kind: SpringMarkerKind,
    /// Injection markers: how the candidates resolve.
    pub resolution: Option<SpringResolution>,
    pub targets: Vec<SpringTarget>,
    /// Events heard or published, the schedule, the cache names; a bean's name.
    pub detail: Option<String>,
    /// Bean markers: the bean (its id) and a context holding it, for the tool window and graph.
    pub bean: Option<String>,
    pub context: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SpringMarkers {
    pub markers: Vec<SpringMarker>,
}

/// The injection point at a position and the beans it can receive.
#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SpringCandidates {
    pub name: String,
    /// The type looked for, as written.
    pub wanted: String,
    pub resolution: SpringResolution,
    /// Beans may come from where the model cannot see (auto-configuration, `@Enable…`).
    pub unknown_sources: bool,
    pub candidates: Vec<SpringTarget>,
}

pub(super) fn file_path(view: &JavaView, path: &Path, file: u32) -> Option<PathBuf> {
    if Some(file) == view.overlay_file() { Some(path.to_owned()) } else { view.path(file).map(Path::to_path_buf) }
}

pub(super) fn module_label(model: &SpringModel, file: u32, multi: bool) -> Option<String> {
    if !multi {
        return None;
    }
    model.module_of(file).and_then(|m| m.file_name()).map(|n| n.to_string_lossy().into_owned())
}

pub(super) fn bean_target(
    view: &JavaView,
    model: &SpringModel,
    path: &Path,
    b: &BeanDef,
    multi: bool,
) -> Option<SpringTarget> {
    if let BeanOrigin::Library { handle, configuration, jar } = &b.origin {
        return Some(SpringTarget {
            location: Location { path: IpcPath::from(PathBuf::new()), range: Range::default(), uri: None },
            label: b.name.clone(),
            owner: configuration.clone(),
            module: Some(jar.clone()),
            kind: Some(b.kind),
            primary: b.primary,
            fallback: b.fallback,
            presence: b.presence.into(),
            handle: Some(handle.clone()),
        });
    }
    let owner = b.owner?;
    let stub = view.stub(owner.file)?;
    let t = stub.types.get(owner.ty as usize)?;
    let (at, name) = match b.method.and_then(|m| t.members.get(m as usize)) {
        Some(m) => (m.at, m.name.as_str()),
        None => (t.at, t.name.as_str()),
    };
    let end = Pos::new(at.line, at.col + name.encode_utf16().count() as u32);
    let owner_label = match b.method.and_then(|m| t.members.get(m as usize)) {
        Some(m) => format!("{}.{}()", stub.display_name(owner.ty), m.name),
        None => stub.display_name(owner.ty),
    };
    Some(SpringTarget {
        location: Location {
            path: IpcPath::from(file_path(view, path, owner.file)?),
            range: Range::new(at, end),
            uri: None,
        },
        label: b.name.clone(),
        owner: owner_label,
        module: module_label(model, owner.file, multi),
        kind: Some(b.kind),
        primary: b.primary,
        fallback: b.fallback,
        presence: b.presence.into(),
        handle: None,
    })
}

fn injection_target(
    view: &JavaView,
    model: &SpringModel,
    path: &Path,
    i: &InjectionPoint,
    multi: bool,
) -> Option<SpringTarget> {
    let stub = view.stub(i.owner.file)?;
    let t = stub.types.get(i.owner.ty as usize)?;
    let m = t.members.get(i.member as usize)?;
    let label = match (i.param, m.kind) {
        (None, _) => format!("{}.{}", stub.display_name(i.owner.ty), m.name),
        (Some(_), JavaMemberKind::Constructor) => format!("{}({})", stub.display_name(i.owner.ty), i.name),
        (Some(_), _) => format!("{}.{}({})", stub.display_name(i.owner.ty), m.name, i.name),
    };
    let at = i.at(view)?;
    let end = Pos::new(at.line, at.col + i.name.encode_utf16().count() as u32);
    Some(SpringTarget {
        location: Location {
            path: IpcPath::from(file_path(view, path, i.owner.file)?),
            range: Range::new(at, end),
            uri: None,
        },
        owner: label.clone(),
        label,
        module: module_label(model, i.owner.file, multi),
        kind: None,
        primary: false,
        fallback: false,
        presence: SpringPresence::Certain,
        handle: None,
    })
}

pub(super) fn resolution_of(r: &Resolution) -> SpringResolution {
    match r.outcome {
        Outcome::Unique(_) => SpringResolution::Unique,
        Outcome::Many => SpringResolution::Many,
        Outcome::Ambiguous => SpringResolution::Ambiguous,
        Outcome::Conditional => SpringResolution::Conditional,
        Outcome::None => SpringResolution::None,
    }
}

pub(super) fn multi_module(model: &SpringModel) -> bool {
    let mut seen: HashSet<&Path> = HashSet::new();
    for m in model.modules.values().flatten() {
        seen.insert(m);
        if seen.len() > 1 {
            return true;
        }
    }
    false
}

/// The Spring markers of the edited file (`view`'s overlay): on injection points, the beans they
/// receive; on beans, where they are injected (and the bean itself, for its menu); and the event,
/// scheduling, cache and test configuration markers (`publishers`: the project's `publishEvent`
/// calls, as far as known).
pub fn spring_markers(
    view: &JavaView,
    model: &SpringModel,
    path: &Path,
    publishers: &[super::EventPublisher],
) -> SpringMarkers {
    let Some(file) = view.overlay_file() else { return SpringMarkers::default() };
    let multi = multi_module(model);
    let mut supers = Supers::default();
    let mut out: Vec<SpringMarker> = Vec::new();
    // Injection points here → their beans (one marker per line).
    for ip in model.injections.iter().filter(|i| i.owner.file == file) {
        let Some(at) = ip.at(view) else { continue };
        let r = resolve(view, model, ip, &mut supers);
        // The injected bean, or every candidate when it is not decided.
        let shown: &[usize] = match r.outcome {
            Outcome::Unique(_) => &r.beans[..1],
            _ => &r.beans,
        };
        let targets: Vec<SpringTarget> =
            shown.iter().filter_map(|&b| bean_target(view, model, path, &model.beans[b], multi)).collect();
        if targets.is_empty() {
            continue;
        }
        match out.iter_mut().find(|m| m.line == at.line && m.kind == SpringMarkerKind::Injection) {
            Some(m) => {
                for t in targets {
                    if !m.targets.iter().any(|x| x.location == t.location && x.handle == t.handle) {
                        m.targets.push(t);
                    }
                }
                // Several injection points on one line: their candidates together.
                m.resolution = Some(SpringResolution::Many);
            }
            None => out.push(SpringMarker {
                line: at.line,
                col: at.col,
                name: ip.name.clone(),
                kind: SpringMarkerKind::Injection,
                resolution: Some(resolution_of(&r)),
                targets,
                detail: None,
                bean: None,
                context: None,
            }),
        }
    }
    // Beans here → where they are injected.
    let here: Vec<usize> = model
        .beans
        .iter()
        .enumerate()
        .filter(|(_, b)| b.owner.is_some_and(|o| o.file == file))
        .map(|(i, _)| i)
        .collect();
    if !here.is_empty() {
        let names: HashSet<&str> =
            here.iter().flat_map(|&b| model.beans[b].type_names.iter().map(String::as_str)).collect();
        let mut resolved: Vec<(usize, Resolution)> = Vec::new();
        for (ii, ip) in model.injections.iter().enumerate() {
            let wanted = match &ip.wanted.ty {
                super::super::Resolved::Source(id) => view.ty(*id).map_or("", |t| t.name.as_str()),
                super::super::Resolved::External(e) => simple(e),
            };
            if names.contains(wanted) {
                resolved.push((ii, resolve(view, model, ip, &mut supers)));
            }
        }
        for b in here {
            let bean = &model.beans[b];
            let targets: Vec<SpringTarget> = resolved
                .iter()
                .filter(|(_, r)| match r.outcome {
                    Outcome::Unique(u) => u == b,
                    Outcome::Many | Outcome::Ambiguous | Outcome::Conditional => r.beans.contains(&b),
                    Outcome::None => false,
                })
                .filter_map(|(ii, _)| injection_target(view, model, path, &model.injections[*ii], multi))
                .collect();
            let Some(owner) = bean.owner else { continue };
            let Some(t) = view.ty(owner) else { continue };
            let (at, name) = match bean.method.and_then(|m| t.members.get(m as usize)) {
                Some(m) => (m.at, m.name.clone()),
                None => (t.at, t.name.clone()),
            };
            // One bean marker per declaration (a provider may add a second bean for a class).
            if out.iter().any(|m| m.kind == SpringMarkerKind::Bean && m.line == at.line && m.col == at.col) {
                continue;
            }
            out.push(SpringMarker {
                line: at.line,
                col: at.col,
                name,
                kind: SpringMarkerKind::Bean,
                resolution: None,
                targets,
                detail: Some(bean.name.clone()),
                bean: Some(super::bean_id(view, bean)),
                context: model.contexts_of(owner).first().map(|&c| model.contexts[c].id.clone()),
            });
        }
    }
    super::features::markers(view, model, path, multi, publishers, &mut out);
    out.sort_by_key(|m| (m.line, m.col, m.kind == SpringMarkerKind::Injection));
    SpringMarkers { markers: out }
}

/// The injection point whose name is at `pos` in the edited file, with its candidates.
pub fn candidates_at(view: &JavaView, model: &SpringModel, path: &Path, pos: Pos) -> Option<SpringCandidates> {
    let file = view.overlay_file()?;
    let ip = model.injections.iter().find(|i| {
        i.owner.file == file
            && i.at(view).is_some_and(|at| {
                at.line == pos.line && pos.col >= at.col && pos.col <= at.col + i.name.encode_utf16().count() as u32
            })
    })?;
    let mut supers = Supers::default();
    let r = resolve(view, model, ip, &mut supers);
    let multi = multi_module(model);
    let wanted = match &ip.wanted.ty {
        super::super::Resolved::Source(id) => view.qualified_name(*id).unwrap_or_default(),
        super::super::Resolved::External(e) => e.clone(),
    };
    Some(SpringCandidates {
        name: ip.name.clone(),
        wanted,
        resolution: resolution_of(&r),
        unknown_sources: r.unknown_sources,
        candidates: r.beans.iter().filter_map(|&b| bean_target(view, model, path, &model.beans[b], multi)).collect(),
    })
}
