//! Spring (bundled plugin): whether the project uses Spring, and the Spring model's answers for
//! open Java files (gutter markers, autowiring candidates). The model itself lives in the
//! structure index (`ide_index::java::spring`).
use crate::Host;
use crate::rpc::Dispatcher;
use ide_core::{CancellationToken, DocId, IdeEvent, IdeResult, Location, Pos};
use ide_index::java::spring::{
    EventPublisher, LibraryModel, SpringBeanDetail, SpringBeanInfo, SpringCandidates, SpringContextInfo, SpringGraph,
    SpringMarkers, SpringOptions, SpringProblem,
};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock};
use std::time::{Duration, Instant};

/// Why the Spring support is (not) active for the project.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum SpringActivation {
    /// The build declares Spring (`spring-context`, `spring-beans` or `spring-core`).
    Dependency,
    /// No build model, but the sources import Spring.
    Sources,
    /// Neither.
    None,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SpringStatus {
    pub active: bool,
    pub activation: SpringActivation,
    /// `org.springframework:spring-context`'s version, when the build says.
    pub spring_version: Option<String>,
    pub boot_version: Option<String>,
}

/// Spring Framework artifacts that make a project a Spring project.
const FRAMEWORK: &[&str] = &["spring-context", "spring-beans", "spring-core"];

pub(crate) fn status_of(
    coordinates: &[ide_build::DependencyCoordinate],
    uses_spring: impl FnOnce() -> bool,
) -> SpringStatus {
    let framework = coordinates
        .iter()
        .filter(|c| c.group_id == "org.springframework" && FRAMEWORK.contains(&c.artifact_id.as_str()))
        .min_by_key(|c| FRAMEWORK.iter().position(|a| *a == c.artifact_id));
    let boot = coordinates.iter().find(|c| c.group_id == "org.springframework.boot" && c.artifact_id == "spring-boot");
    if let Some(f) = framework {
        return SpringStatus {
            active: true,
            activation: SpringActivation::Dependency,
            spring_version: Some(f.version.clone()),
            boot_version: boot.map(|b| b.version.clone()),
        };
    }
    if boot.is_some() || uses_spring() {
        return SpringStatus {
            active: true,
            activation: SpringActivation::Sources,
            spring_version: None,
            boot_version: boot.map(|b| b.version.clone()),
        };
    }
    SpringStatus { active: false, activation: SpringActivation::None, spring_version: None, boot_version: None }
}

/// Whether the project uses Spring (from its build model, else its sources).
pub async fn spring_status(host: &Host, window: &str) -> IdeResult<SpringStatus> {
    let project = host.project(window)?;
    let (root, cache, settings) = (project.root.clone(), project.build_cache_dir(), project.settings.effective());
    let index = project.index.clone();
    forget_libraries(&root);
    if let Some(e) = EVENTS.lock().get_mut(&root) {
        e.fetched = None;
    }
    host.blocking(move || {
        let model = crate::ops::build::load(&root, &cache, &settings);
        let coordinates = ide_build::dependency_coordinates(&root, &model);
        Ok(status_of(&coordinates, || index.uses_spring()))
    })
    .await
}

// ---------------------------------------------------------------------------
// Library models (auto-configuration beans), per project and build module

#[derive(Default)]
struct ProjectLibraries {
    /// Bumped whenever a module's model changes (part of the Spring model's cache key).
    revision: u64,
    modules: HashMap<PathBuf, LibraryEntry>,
}

#[derive(Default)]
struct LibraryEntry {
    model: Option<Arc<LibraryModel>>,
    /// The answer as received, to tell a changed classpath from an unchanged one.
    raw: Option<String>,
    fetching: bool,
    fetched: Option<Instant>,
}

static LIBRARIES: LazyLock<Mutex<HashMap<PathBuf, ProjectLibraries>>> = LazyLock::new(Default::default);

/// How old a library model may get before it is asked again (the extension answers from its
/// own cache unless the classpath changed, so this is cheap).
const REFRESH: Duration = Duration::from_secs(30);

fn options(host: &Host, window: &str) -> IdeResult<SpringOptions> {
    let project = host.project(window)?;
    let settings = project.settings.effective();
    let mut active_profiles: Vec<String> =
        settings.spring.active_profiles.iter().map(|p| p.trim().to_owned()).filter(|p| !p.is_empty()).collect();
    active_profiles.sort();
    active_profiles.dedup();
    let (libraries, library_revision) = if settings.spring.library_beans {
        let all = LIBRARIES.lock();
        match all.get(&project.root) {
            Some(p) => {
                (p.modules.iter().filter_map(|(m, e)| Some((m.clone(), e.model.clone()?))).collect(), p.revision)
            }
            None => (Vec::new(), 0),
        }
    } else {
        (Vec::new(), u64::MAX)
    };
    Ok(SpringOptions { active_profiles, libraries, library_revision })
}

/// Asks the Java language server for the library models of the Boot applications' modules
/// not known (or not refreshed) yet, in the background; tells the window when one arrives.
fn ensure_libraries(host: &Host, window: &str, apps: Vec<(PathBuf, PathBuf)>) {
    let Ok(project) = host.project(window) else { return };
    if apps.is_empty() || !project.settings.effective().spring.library_beans {
        return;
    }
    let root = project.root.clone();
    let due: Vec<(PathBuf, PathBuf)> = {
        let mut all = LIBRARIES.lock();
        let libs = all.entry(root.clone()).or_default();
        apps.into_iter()
            .filter(|(module, _)| {
                let e = libs.modules.entry(module.clone()).or_default();
                let due = !e.fetching && e.fetched.is_none_or(|t| t.elapsed() > REFRESH);
                e.fetching |= due;
                due
            })
            .collect()
    };
    for (module, file) in due {
        let (lsp, sink, root) = (project.lsp.clone(), project.sink.clone(), root.clone());
        host.runtime.spawn(async move {
            let answer = lsp.spring_library(&file, &CancellationToken::new()).await;
            let changed = {
                let mut all = LIBRARIES.lock();
                let libs = all.entry(root).or_default();
                let mut changed = false;
                if let Some(e) = libs.modules.get_mut(&module) {
                    e.fetching = false;
                    e.fetched = Some(Instant::now());
                    match answer {
                        Ok(Some(value)) => {
                            let raw = value.to_string();
                            if e.raw.as_deref() != Some(raw.as_str()) {
                                match serde_json::from_value::<LibraryModel>(value) {
                                    Ok(model) => {
                                        e.model = Some(Arc::new(model));
                                        e.raw = Some(raw);
                                        changed = true;
                                    }
                                    Err(err) => tracing::warn!("luma.spring.library answer: {err}"),
                                }
                            }
                        }
                        Ok(None) => tracing::debug!("the Java extension has no luma.spring.library"),
                        Err(err) => tracing::debug!("luma.spring.library for {}: {err}", module.display()),
                    }
                }
                if changed {
                    libs.revision += 1;
                }
                changed
            };
            if changed {
                sink.emit(IdeEvent::SpringModelChanged);
            }
        });
    }
}

// ---------------------------------------------------------------------------
// Event publishers (`publishEvent` calls), per project

#[derive(Default)]
struct EventsEntry {
    publishers: Arc<Vec<EventPublisher>>,
    raw: Option<String>,
    fetching: bool,
    fetched: Option<Instant>,
}

static EVENTS: LazyLock<Mutex<HashMap<PathBuf, EventsEntry>>> = LazyLock::new(Default::default);

/// How often the calls are asked again while files are being edited (the extension re-reads
/// only changed files, so this is cheap).
const EVENTS_REFRESH: Duration = Duration::from_secs(3);

fn publishers(root: &Path) -> Arc<Vec<EventPublisher>> {
    EVENTS.lock().get(root).map(|e| e.publishers.clone()).unwrap_or_default()
}

/// Asks the Java language server for the project's `publishEvent` calls in the background
/// (when the last answer is older than [`EVENTS_REFRESH`]); tells the window when they change.
fn ensure_events(host: &Host, window: &str, file: PathBuf) {
    let Ok(project) = host.project(window) else { return };
    let root = project.root.clone();
    {
        let mut all = EVENTS.lock();
        let e = all.entry(root.clone()).or_default();
        if e.fetching || e.fetched.is_some_and(|t| t.elapsed() < EVENTS_REFRESH) {
            return;
        }
        e.fetching = true;
    }
    let (lsp, sink) = (project.lsp.clone(), project.sink.clone());
    host.runtime.spawn(async move {
        let answer = lsp.spring_events(&file, &CancellationToken::new()).await;
        let changed = {
            let mut all = EVENTS.lock();
            let e = all.entry(root).or_default();
            e.fetching = false;
            e.fetched = Some(Instant::now());
            match answer {
                Ok(Some(mut value)) => {
                    let list = value.get_mut("publishers").map(serde_json::Value::take).unwrap_or_default();
                    let raw = list.to_string();
                    if e.raw.as_deref() == Some(raw.as_str()) {
                        false
                    } else {
                        match serde_json::from_value::<Vec<EventPublisher>>(list) {
                            Ok(list) => {
                                e.publishers = Arc::new(list);
                                e.raw = Some(raw);
                                true
                            }
                            Err(err) => {
                                tracing::warn!("luma.spring.events answer: {err}");
                                false
                            }
                        }
                    }
                }
                Ok(None) => false,
                Err(err) => {
                    tracing::debug!("luma.spring.events: {err}");
                    false
                }
            }
        };
        if changed {
            sink.emit(IdeEvent::SpringModelChanged);
        }
    });
}

/// Forgets when the project's library models were read (its build may have changed): they
/// are asked again the next time they are needed.
fn forget_libraries(root: &Path) {
    if let Some(p) = LIBRARIES.lock().get_mut(root) {
        for e in p.modules.values_mut() {
            e.fetched = None;
        }
    }
}

/// Spring gutter markers of an open Java file: beans and where they are injected, injection
/// points and the beans they receive. Library models of the project's Boot applications are
/// fetched in the background; `SpringModelChanged` tells when they arrive.
pub async fn spring_markers(host: &Host, window: &str, doc: DocId) -> IdeResult<SpringMarkers> {
    let project = host.project(window)?;
    let options = options(host, window)?;
    let calls = publishers(&project.root);
    let (markers, apps, path) = super::doc::blocking(move || {
        let info = project.documents.snapshot(doc)?;
        if info.language.as_str() != "java" || info.large {
            return Ok((SpringMarkers::default(), Vec::new(), None));
        }
        let path = info.path.0.clone();
        let (markers, apps) = project
            .index
            .with_spring(&path, &info.text, &options, |v, m| {
                (ide_index::java::spring::spring_markers(v, m, &path, &calls), m.boot_applications(v))
            })
            .unwrap_or_default();
        Ok((markers, apps, Some(path)))
    })
    .await?;
    ensure_libraries(host, window, apps);
    if let Some(path) = path {
        ensure_events(host, window, path);
    }
    Ok(markers)
}

/// The Spring inspection problems of an open Java file, with their fixes.
pub async fn spring_problems(host: &Host, window: &str, doc: DocId) -> IdeResult<Vec<SpringProblem>> {
    let project = host.project(window)?;
    let options = options(host, window)?;
    super::doc::blocking(move || {
        let info = project.documents.snapshot(doc)?;
        if info.language.as_str() != "java" || info.large {
            return Ok(Vec::new());
        }
        Ok(project.index.spring_problems(&info.path.0, &info.text, &options))
    })
    .await
}

/// Opens a library bean: its location from the Java language server (`luma.spring.locate`),
/// a class file shown as a virtual document.
pub async fn spring_locate(host: &Host, window: &str, doc: DocId, handle: String) -> IdeResult<Option<Location>> {
    let project = host.project(window)?;
    let path = project.documents.snapshot(doc)?.path.0;
    project.lsp.spring_locate(&path, &handle).await
}

/// Opens a library bean from the tool window or the graph: `path` is a Java file of the
/// project (its context's application class) choosing the language server.
pub async fn spring_locate_at(
    host: &Host,
    window: &str,
    path: ide_core::IpcPath,
    handle: String,
) -> IdeResult<Option<Location>> {
    let project = host.project(window)?;
    project.lsp.spring_locate(&path.0, &handle).await
}

/// The injection point at `pos` of an open Java file and the beans it can receive.
pub async fn spring_candidates(host: &Host, window: &str, doc: DocId, pos: Pos) -> IdeResult<Option<SpringCandidates>> {
    let project = host.project(window)?;
    let options = options(host, window)?;
    super::doc::blocking(move || {
        let info = project.documents.snapshot(doc)?;
        if info.language.as_str() != "java" || info.large {
            return Ok(None);
        }
        Ok(project.index.spring_candidates(&info.path.0, &info.text, &options, pos))
    })
    .await
}

// ---------------------------------------------------------------------------
// SpEL: the members of a type (completion and navigation)

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SpringTypeMember {
    pub name: String,
    /// `method` or `field`.
    pub kind: String,
    #[serde(rename = "static")]
    pub is_static: bool,
    /// Parameter types, simple.
    pub params: Vec<String>,
    #[serde(default)]
    pub param_names: Vec<String>,
    /// The erased, qualified return / field type.
    pub returns: String,
    pub declaring: String,
    /// JDT handle (`spring_locate`).
    pub handle: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SpringTypeMembers {
    pub fqn: String,
    pub handle: String,
    #[serde(default)]
    pub interface: bool,
    pub members: Vec<SpringTypeMember>,
}

/// The public members of type `fqn` (source or library) as the Java language server sees it
/// from an open file's project; `None` when it does not know the type.
pub async fn spring_members(
    host: &Host,
    window: &str,
    doc: DocId,
    fqn: String,
) -> IdeResult<Option<SpringTypeMembers>> {
    let project = host.project(window)?;
    let path = project.documents.snapshot(doc)?.path.0;
    let Some(value) = project.lsp.spring_members(&path, &fqn).await? else { return Ok(None) };
    Ok(serde_json::from_value(value).ok())
}

// ---------------------------------------------------------------------------
// The Spring tool window and the Bean dependency graph (the indexed state, no open file)

/// Nodes a dependency graph shows at most.
const GRAPH_LIMIT: usize = 400;

/// The application contexts of the project. Asks for the libraries of its Boot applications
/// (`SpringModelChanged` when they arrive).
pub async fn spring_contexts(host: &Host, window: &str) -> IdeResult<Vec<SpringContextInfo>> {
    let project = host.project(window)?;
    let options = options(host, window)?;
    let (contexts, apps) = host
        .blocking(move || {
            Ok(project.index.with_spring_model(&options, |v, m| (m.context_infos(v), m.boot_applications(v))))
        })
        .await?;
    ensure_libraries(host, window, apps);
    Ok(contexts)
}

/// The beans of a context (every bean when `context` is `None`).
pub async fn spring_beans(host: &Host, window: &str, context: Option<String>) -> IdeResult<Vec<SpringBeanInfo>> {
    let project = host.project(window)?;
    let options = options(host, window)?;
    host.blocking(move || Ok(project.index.with_spring_model(&options, |v, m| m.bean_infos(v, context.as_deref()))))
        .await
}

/// A bean (by its id) with its dependencies and dependents.
pub async fn spring_bean_detail(
    host: &Host,
    window: &str,
    context: Option<String>,
    bean: String,
) -> IdeResult<Option<SpringBeanDetail>> {
    let project = host.project(window)?;
    let options = options(host, window)?;
    host.blocking(move || {
        Ok(project.index.with_spring_model(&options, |v, m| m.bean_detail(v, context.as_deref(), &bean)))
    })
    .await
}

/// The dependency graph of a context, around `roots` (bean ids) up to `depth` steps, or whole.
pub async fn spring_graph(
    host: &Host,
    window: &str,
    context: Option<String>,
    roots: Vec<String>,
    depth: u32,
    libraries: bool,
) -> IdeResult<SpringGraph> {
    let project = host.project(window)?;
    let options = options(host, window)?;
    host.blocking(move || {
        Ok(project.index.with_spring_model(&options, |v, m| {
            m.graph(v, context.as_deref(), &roots, depth.min(8), libraries, GRAPH_LIMIT)
        }))
    })
    .await
}

pub(crate) fn register(d: &mut Dispatcher) {
    d.add("spring_members", |c| async move { spring_members(&c.host, &c.window, c.arg("doc")?, c.arg("fqn")?).await });
    d.add("spring_locate_at", |c| async move {
        spring_locate_at(&c.host, &c.window, c.arg("path")?, c.arg("handle")?).await
    });
    d.add("spring_contexts", |c| async move { spring_contexts(&c.host, &c.window).await });
    d.add("spring_beans", |c| async move { spring_beans(&c.host, &c.window, c.arg("context")?).await });
    d.add("spring_bean_detail", |c| async move {
        spring_bean_detail(&c.host, &c.window, c.arg("context")?, c.arg("bean")?).await
    });
    d.add("spring_graph", |c| async move {
        spring_graph(&c.host, &c.window, c.arg("context")?, c.arg("roots")?, c.arg("depth")?, c.arg("libraries")?).await
    });
    d.add("spring_status", |c| async move { spring_status(&c.host, &c.window).await });
    d.add("spring_markers", |c| async move { spring_markers(&c.host, &c.window, c.arg("doc")?).await });
    d.add("spring_problems", |c| async move { spring_problems(&c.host, &c.window, c.arg("doc")?).await });
    d.add("spring_locate", |c| async move { spring_locate(&c.host, &c.window, c.arg("doc")?, c.arg("handle")?).await });
    d.add(
        "spring_candidates",
        |c| async move { spring_candidates(&c.host, &c.window, c.arg("doc")?, c.arg("pos")?).await },
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dep(group: &str, artifact: &str, version: &str) -> ide_build::DependencyCoordinate {
        ide_build::DependencyCoordinate {
            gradle: false,
            group_id: group.into(),
            artifact_id: artifact.into(),
            version: version.into(),
        }
    }

    #[test]
    fn activation() {
        let s = status_of(
            &[
                dep("org.springframework", "spring-core", "6.2.1"),
                dep("org.springframework", "spring-context", "6.2.1"),
                dep("org.springframework.boot", "spring-boot", "3.4.0"),
            ],
            || panic!("the build decides"),
        );
        assert_eq!(
            (s.active, s.activation, s.spring_version.as_deref(), s.boot_version.as_deref()),
            (true, SpringActivation::Dependency, Some("6.2.1"), Some("3.4.0"))
        );
        assert_eq!(status_of(&[], || true).activation, SpringActivation::Sources);
        assert!(!status_of(&[dep("org.projectlombok", "lombok", "1.18")], || false).active);
    }
}
