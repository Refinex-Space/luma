//! Spring Boot (bundled plugin): the configuration metadata each Boot module sees, and the
//! analysis of its configuration files (`ide_spring_boot`): completion, documentation,
//! inspections, navigation, and "Define configuration key".
//!
//! A module's index is built from its class path (Luma's Java engine: jdtls's view, else the
//! last sync, else the POMs), the metadata of its output and resource folders, and metadata
//! worked out from its `@ConfigurationProperties` sources. It is rebuilt when any of those
//! change; until then answers come from the last one.

use crate::Project;
use crate::rpc::Dispatcher;
use ide_core::{IdeResult, IpcPath, Location, Pos, Range};
use ide_java::model::Model;
use ide_spring_boot::analysis::complete::BootCompletion;
use ide_spring_boot::analysis::hover::{BootHover, Target};
use ide_spring_boot::analysis::validate::BootProblem;
use ide_spring_boot::analysis::{Context, KnownKey, Options, ProjectConfig, PropertyDoc};
use ide_spring_boot::document::{ConfigFile, Format, Utf16};
use ide_spring_boot::metadata::{MetadataIndex, RawMetadata};
use ide_spring_boot::source::JavaTypes;
use ide_spring_boot::{module, name};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock};
use std::time::{Duration, Instant};

// ---------------------------------------------------------------------------
// Modules

/// What a Boot module's class path has.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct BootFeatures {
    pub actuator: bool,
    pub devtools: bool,
    pub web: bool,
    pub reactor_tools: bool,
}

struct BootModule {
    root: PathBuf,
    classpath: Vec<PathBuf>,
    resources: Vec<PathBuf>,
    boot_version: Option<String>,
    features: BootFeatures,
    index: Arc<MetadataIndex>,
    /// Inputs of the index: metadata files and the sources it was worked out from.
    fingerprint: u64,
    sources_key: u64,
    sources: Arc<Vec<(PathBuf, RawMetadata)>>,
    checked: Instant,
}

type Modules = HashMap<PathBuf, (Instant, Option<Arc<BootModule>>)>;

/// Boot modules by module root (`None`: checked, not a Boot module).
static MODULES: LazyLock<Mutex<Modules>> = LazyLock::new(Default::default);

/// How long a module is answered from without looking at its inputs again.
const RECHECK: Duration = Duration::from_secs(2);

const BUILD_FILES: [&str; 4] = ["pom.xml", "build.gradle", "build.gradle.kts", "build.xml"];

/// The build module of `path`: the engine's, else the nearest folder with a build file.
fn module_root(project: &Project, path: &Path) -> PathBuf {
    if let Some(r) = project.java_engine.module_root(path) {
        return r;
    }
    let mut dir = path.parent();
    while let Some(d) = dir {
        if BUILD_FILES.iter().any(|f| d.join(f).is_file()) {
            return d.to_owned();
        }
        if d == project.root {
            break;
        }
        dir = d.parent();
    }
    project.root.clone()
}

fn resource_dirs(root: &Path, path: &Path) -> Vec<PathBuf> {
    let mut out = vec![root.join("src/main/resources")];
    if path.starts_with(root.join("src/test")) {
        out.push(root.join("src/test/resources"));
    }
    // A configuration file outside the standard layout: its folder is a resource root.
    if let Some(dir) = path.parent()
        && !out.iter().any(|r| dir.starts_with(r))
        && path.extension().is_some_and(|e| e != "java")
    {
        out.push(if dir.file_name().is_some_and(|n| n == "config") {
            dir.parent().unwrap_or(dir).to_owned()
        } else {
            dir.to_owned()
        });
    }
    out.retain(|d| d.is_dir());
    out
}

/// Open editors' text of files matching `pred`.
fn unsaved(project: &Project, pred: impl Fn(&Path) -> bool) -> Vec<(PathBuf, String)> {
    project
        .documents
        .open_documents()
        .into_iter()
        .filter(|&d| project.documents.is_dirty(d).unwrap_or(false))
        .filter_map(|d| project.documents.snapshot(d).ok())
        .filter(|d| pred(&d.path.0))
        .map(|d| (d.path.0, d.text))
        .collect()
}

/// Reads a file's text, an open editor's first.
fn reader(project: &Project) -> impl Fn(&Path) -> Option<Arc<str>> + '_ {
    let open: HashMap<PathBuf, String> =
        unsaved(project, |p| p.extension().is_some_and(|e| e == "java")).into_iter().collect();
    move |p: &Path| match open.get(p) {
        Some(t) => Some(Arc::from(t.as_str())),
        None => std::fs::read_to_string(p).ok().map(Arc::from),
    }
}

/// The Boot module of `path` with a current index; `None` outside Boot modules.
fn module_for(project: &Project, path: &Path) -> Option<Arc<BootModule>> {
    let root = module_root(project, path);
    if let Some((at, m)) = MODULES.lock().get(&root)
        && at.elapsed() < RECHECK
    {
        return m.clone();
    }
    let cp = crate::java_engine::classpath_for(project, path);
    let classpath: Vec<PathBuf> = cp
        .roots()
        .iter()
        .map(|r| r.path().to_owned())
        .filter(|p| p.file_name().is_some_and(|n| n != "modules"))
        .collect();
    let boot_version = module::boot_version(&classpath);
    let settings = project.settings.effective();
    if boot_version.is_none() || !settings.spring_boot.enabled {
        MODULES.lock().insert(root, (Instant::now(), None));
        return None;
    }
    let resources = resource_dirs(&root, path);
    let mut inputs =
        module::Inputs { classpath: classpath.clone(), resources: resources.clone(), ..Default::default() };
    inputs.unsaved =
        unsaved(project, |p| p.ends_with("additional-spring-configuration-metadata.json")).into_iter().collect();
    let fingerprint = module::fingerprint(&inputs);
    let java_unsaved = unsaved(project, |p| p.extension().is_some_and(|e| e == "java"));
    let visibility = project.java_engine.visibility(path);
    let visible = |p: &Path| match &visibility {
        Some(v) => v(p).is_some(),
        None => p.starts_with(&root),
    };
    // The sources declaring configuration properties, and their state.
    let (files, sources_key) = project.index.with_java_state(&java_unsaved, |view| {
        use std::hash::{Hash, Hasher};
        let mut h = std::collections::hash_map::DefaultHasher::new();
        let files: Vec<u32> = view
            .files_mentioning("ConfigurationProperties")
            .into_iter()
            .filter(|&f| view.path(f).is_some_and(visible))
            .collect();
        for &f in &files {
            if let Some(p) = view.path(f) {
                p.hash(&mut h);
                view.indexed_hash(p).hash(&mut h);
            }
        }
        for (p, t) in &java_unsaved {
            if visible(p) {
                p.hash(&mut h);
                t.hash(&mut h);
            }
        }
        (files, h.finish())
    });
    let previous = MODULES.lock().get(&root).and_then(|(_, m)| m.clone());
    if let Some(prev) = &previous
        && prev.fingerprint == fingerprint
        && prev.sources_key == sources_key
        && prev.classpath == classpath
    {
        MODULES.lock().insert(root, (Instant::now(), Some(prev.clone())));
        return Some(prev.clone());
    }
    let started = Instant::now();
    let sources = match &previous {
        Some(prev) if prev.sources_key == sources_key => prev.sources.clone(),
        _ => {
            let read = reader(project);
            Arc::new(project.index.with_java_state(&java_unsaved, |view| {
                let model = Model::new(view, &cp).with_visibility(visibility.clone());
                let types = JavaTypes::new(&model, &read);
                ide_spring_boot::source::derive(&types, &files)
            }))
        }
    };
    let index = Arc::new(module::build(&inputs, &sources));
    tracing::debug!(
        "spring boot: {} indexed ({} properties, {} from sources) in {:?}",
        root.display(),
        index.properties().len(),
        sources.iter().map(|(_, r)| r.properties.len()).sum::<usize>(),
        started.elapsed()
    );
    let features = BootFeatures {
        actuator: module::has_artifact(&classpath, "spring-boot-actuator"),
        devtools: module::has_artifact(&classpath, "spring-boot-devtools"),
        web: module::has_artifact(&classpath, "spring-webmvc") || module::has_artifact(&classpath, "spring-webflux"),
        reactor_tools: module::has_artifact(&classpath, "reactor-tools"),
    };
    let m = Arc::new(BootModule {
        root: root.clone(),
        classpath,
        resources,
        boot_version,
        features,
        index,
        fingerprint,
        sources_key,
        sources,
        checked: Instant::now(),
    });
    let _ = m.checked;
    MODULES.lock().insert(root, (Instant::now(), Some(m.clone())));
    Some(m)
}

// ---------------------------------------------------------------------------
// Configuration files

/// Base names of configuration files (`application` and the configured ones).
fn config_names(project: &Project) -> Vec<String> {
    let mut names = vec!["application".to_owned()];
    for n in project.settings.effective().spring_boot.config_names {
        let n = n.trim().to_owned();
        if !n.is_empty() && !names.contains(&n) {
            names.push(n);
        }
    }
    names
}

/// Whether `path` is a Spring Boot configuration file, and its profile (`application-dev.yml`).
fn config_file(project: &Project, path: &Path) -> Option<(Format, Option<String>)> {
    let file = path.file_name()?.to_str()?;
    let format = Format::of(file)?;
    let stem = file.rsplit_once('.')?.0;
    let settings = project.settings.effective();
    let explicit = settings.spring_boot.config_files.iter().any(|f| {
        let p = Path::new(f);
        if p.is_absolute() { p == path } else { project.root.join(p) == path }
    });
    for n in config_names(project) {
        if stem == n {
            return Some((format, None));
        }
        if let Some(profile) = stem.strip_prefix(&n).and_then(|r| r.strip_prefix('-')).filter(|p| !p.is_empty()) {
            return Some((format, Some(profile.to_owned())));
        }
    }
    explicit.then_some((format, None))
}

/// The module's configuration files: in its resource folders and their `config/` folders.
fn module_config_files(project: &Project, m: &BootModule) -> Vec<PathBuf> {
    let mut out = Vec::new();
    for r in &m.resources {
        for dir in [r.clone(), r.join("config")] {
            let Ok(entries) = std::fs::read_dir(&dir) else { continue };
            for e in entries.flatten() {
                let p = e.path();
                if p.is_file() && config_file(project, &p).is_some() {
                    out.push(p);
                }
            }
        }
    }
    for f in project.settings.effective().spring_boot.config_files {
        let p = if Path::new(&f).is_absolute() { PathBuf::from(&f) } else { project.root.join(&f) };
        if p.is_file() && !out.contains(&p) {
            out.push(p);
        }
    }
    out.sort();
    out
}

/// Class path resources of the module (relative, `/`-separated), at most a few thousand.
fn module_resources(m: &BootModule) -> Vec<String> {
    let mut out = Vec::new();
    fn walk(dir: &Path, base: &Path, depth: usize, out: &mut Vec<String>) {
        let Ok(entries) = std::fs::read_dir(dir) else { return };
        for e in entries.flatten() {
            if out.len() >= 5000 {
                return;
            }
            let p = e.path();
            let Ok(t) = e.file_type() else { continue };
            if t.is_dir() && depth < 8 {
                walk(&p, base, depth + 1, out);
            } else if t.is_file()
                && let Ok(rel) = p.strip_prefix(base)
            {
                out.push(rel.to_string_lossy().replace('\\', "/"));
            }
        }
    }
    for r in &m.resources {
        walk(r, r, 0, &mut out);
    }
    out.sort();
    out.dedup();
    out
}

struct ConfigEntry {
    stamp: (Option<std::time::SystemTime>, u64),
    keys: Vec<KnownKey>,
    profiles: Vec<String>,
}

static CONFIGS: LazyLock<Mutex<HashMap<PathBuf, ConfigEntry>>> = LazyLock::new(Default::default);

/// Keys and profiles of a configuration file (an open editor's text first).
fn file_keys(path: &Path, text: Option<&str>, file_profile: Option<&str>) -> (Vec<KnownKey>, Vec<String>) {
    let Some(format) = path.to_str().and_then(Format::of) else { return Default::default() };
    let owned;
    let text = match text {
        Some(t) => t,
        None => {
            let meta = std::fs::metadata(path).ok();
            let stamp = (meta.as_ref().and_then(|m| m.modified().ok()), meta.as_ref().map_or(0, |m| m.len()));
            if let Some(e) = CONFIGS.lock().get(path)
                && e.stamp == stamp
            {
                return (e.keys.clone(), e.profiles.clone());
            }
            owned = std::fs::read_to_string(path).unwrap_or_default();
            let (keys, profiles) = parse_keys(path, format, &owned, file_profile);
            CONFIGS
                .lock()
                .insert(path.to_owned(), ConfigEntry { stamp, keys: keys.clone(), profiles: profiles.clone() });
            return (keys, profiles);
        }
    };
    parse_keys(path, format, text, file_profile)
}

fn parse_keys(path: &Path, format: Format, text: &str, file_profile: Option<&str>) -> (Vec<KnownKey>, Vec<String>) {
    let file = ConfigFile::parse(format, text);
    let u = Utf16::new(text);
    let mut keys = Vec::new();
    let mut profiles: Vec<String> = file_profile.map(str::to_owned).into_iter().collect();
    for doc in &file.documents {
        let profile = doc.on_profile.clone().or_else(|| file_profile.map(str::to_owned));
        if let Some(p) = &doc.on_profile {
            profiles.extend(profile_names(p));
        }
        for e in &doc.entries {
            if !e.is_leaf() {
                continue;
            }
            let value = e.value.as_ref().map(|v| {
                if v.kind == ide_spring_boot::document::ValueKind::Sequence {
                    ide_spring_boot::document::join_items(v)
                } else {
                    v.text.clone()
                }
            });
            if name::is_under(&e.canonical, "spring.profiles.group") {
                if let Some(g) = e.key.rsplit(['.', '[']).next() {
                    profiles.push(g.trim_end_matches(']').to_owned());
                }
                if let Some(v) = &value {
                    profiles.extend(profile_names(v));
                }
            }
            if matches!(
                e.canonical.as_str(),
                "spring.profiles.active" | "spring.profiles.include" | "spring.profiles.default"
            ) && let Some(v) = &value
            {
                profiles.extend(profile_names(v));
            }
            let line = text[..e.key_span.from].matches('\n').count() as u32;
            keys.push(KnownKey {
                key: e.key.clone(),
                canonical: e.canonical.clone(),
                value,
                path: path.to_owned(),
                offset: u.of(e.key_span.from),
                line,
                profile: profile.clone(),
            });
        }
    }
    (keys, profiles)
}

/// Profile names of a profile expression or list (`dev & !local`, `a,b`).
fn profile_names(expr: &str) -> Vec<String> {
    expr.split(|c: char| matches!(c, ',' | '&' | '|' | '!' | '(' | ')') || c.is_whitespace())
        .map(str::trim)
        .filter(|p| !p.is_empty() && !p.contains("${"))
        .map(str::to_owned)
        .collect()
}

fn project_config(project: &Project, m: &BootModule, current: &Path, current_text: &str) -> ProjectConfig {
    let open: HashMap<PathBuf, String> =
        unsaved(project, |p| Format::of(&p.to_string_lossy()).is_some()).into_iter().collect();
    let mut cfg = ProjectConfig::default();
    let mut files = module_config_files(project, m);
    if !files.iter().any(|f| f == current) {
        files.push(current.to_owned());
    }
    for f in &files {
        let profile = config_file(project, f).and_then(|(_, p)| p);
        let text = if f == current { Some(current_text) } else { open.get(f).map(String::as_str) };
        let (keys, profiles) = file_keys(f, text, profile.as_deref());
        cfg.keys.extend(keys);
        cfg.profiles.extend(profiles);
    }
    cfg.profiles.extend(project.settings.effective().spring.active_profiles.iter().cloned());
    cfg.profiles.extend(spring_profiles(project));
    cfg.profiles.sort();
    cfg.profiles.dedup();
    cfg.profiles.retain(|p| !p.is_empty() && p != "default");
    cfg.profiles.insert(0, "default".to_owned());
    cfg.resources = module_resources(m);
    cfg
}

/// Profiles named in `@Profile` annotations of the sources.
fn spring_profiles(project: &Project) -> Vec<String> {
    project.index.with_java_state(&[], |view| {
        let mut out = Vec::new();
        for f in view.files_mentioning("Profile") {
            let Some(stub) = view.stub(f) else { continue };
            for t in &stub.types {
                let all = t.annotation_args.iter().chain(t.members.iter().flat_map(|m| m.annotation_args.iter()));
                for a in all.filter(|a| a.simple_name() == "Profile") {
                    if let Some(v) = a.arg("value") {
                        for s in v.strings() {
                            out.extend(profile_names(s));
                        }
                    }
                }
            }
        }
        out
    })
}

fn options(m: &BootModule) -> Options {
    Options {
        replacement_tokens: true,
        boot_major: m.boot_version.as_deref().and_then(|v| v.split('.').next()?.parse().ok()),
    }
}

/// Runs `f` with the analysis context of configuration file `path` (`text`: its content).
fn with_context<R>(
    project: &Project,
    path: &Path,
    text: &str,
    beans: bool,
    f: impl FnOnce(&Context, Format) -> R,
) -> Option<R> {
    let (format, profile) = config_file(project, path)?;
    let m = module_for(project, path)?;
    let cfg = project_config(project, &m, path, text);
    let options = options(&m);
    let cp = crate::java_engine::classpath_for(project, path);
    let java_unsaved = unsaved(project, |p| p.extension().is_some_and(|e| e == "java"));
    let visibility = project.java_engine.visibility(path);
    let read = reader(project);
    let bean_list = if beans { spring_beans(project) } else { Vec::new() };
    Some(project.index.with_java_state(&java_unsaved, |view| {
        let model = Model::new(view, &cp).with_visibility(visibility);
        let mut types = JavaTypes::new(&model, &read);
        types.beans = bean_list;
        let cx = Context {
            index: &m.index,
            oracle: &types,
            project: &cfg,
            file_profile: profile.as_deref(),
            options: &options,
        };
        f(&cx, format)
    }))
}

/// The beans of the Spring model (name, qualified type), for `spring-bean-reference` values.
fn spring_beans(project: &Project) -> Vec<(String, String)> {
    let options = ide_index::java::spring::SpringOptions::default();
    project
        .index
        .with_spring_model(&options, |v, m| m.bean_infos(v, None).into_iter().map(|b| (b.name, b.type_fqn)).collect())
}

// ---------------------------------------------------------------------------
// Commands

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct BootFileStatus {
    /// The module root.
    pub module: IpcPath,
    pub boot_version: Option<String>,
    /// The file is one of the module's Spring Boot configuration files.
    pub config_file: bool,
    /// Its profile (from the file name).
    pub profile: Option<String>,
    pub features: BootFeatures,
    pub properties: u32,
    /// Some metadata could not be read: unknown keys are not reported.
    pub incomplete: bool,
}

/// Whether `path` belongs to a Spring Boot module, and what is known about it.
pub async fn spring_boot_status(host: &crate::Host, window: &str, path: IpcPath) -> IdeResult<Option<BootFileStatus>> {
    let project = host.project(window)?;
    host.blocking(move || {
        let path = path.0;
        let Some(m) = module_for(&project, &path) else { return Ok(None) };
        let cf = config_file(&project, &path);
        Ok(Some(BootFileStatus {
            module: IpcPath(m.root.clone()),
            boot_version: m.boot_version.clone(),
            config_file: cf.is_some(),
            profile: cf.and_then(|(_, p)| p),
            features: m.features.clone(),
            properties: m.index.properties().len() as u32,
            incomplete: m.index.incomplete,
        }))
    })
    .await
}

pub async fn spring_boot_complete(
    host: &crate::Host,
    window: &str,
    path: IpcPath,
    text: String,
    offset: u32,
    explicit: bool,
) -> IdeResult<Option<BootCompletion>> {
    let project = host.project(window)?;
    host.blocking(move || {
        if let Some(kind) = ide_spring_boot::imports::Kind::of(&path.0) {
            return Ok(imports_complete(&project, &path.0, kind, &text, offset));
        }
        Ok(with_context(&project, &path.0, &text, true, |cx, format| {
            ide_spring_boot::analysis::complete::complete(cx, format, &text, offset, explicit)
        })
        .flatten())
    })
    .await
}

/// Keys of `spring.factories` Spring Boot reads.
const FACTORIES_KEYS: [&str; 10] = [
    "org.springframework.boot.env.EnvironmentPostProcessor",
    "org.springframework.boot.env.PropertySourceLoader",
    "org.springframework.boot.SpringApplicationRunListener",
    "org.springframework.boot.diagnostics.FailureAnalyzer",
    "org.springframework.boot.autoconfigure.AutoConfigurationImportFilter",
    "org.springframework.boot.autoconfigure.AutoConfigurationImportListener",
    "org.springframework.boot.autoconfigure.template.TemplateAvailabilityProvider",
    "org.springframework.context.ApplicationContextInitializer",
    "org.springframework.context.ApplicationListener",
    "org.springframework.boot.context.config.ConfigDataLocationResolver",
];

/// Class names in `.imports` lines and `spring.factories` values (packages to continue with).
fn imports_complete(
    project: &Project,
    path: &Path,
    kind: ide_spring_boot::imports::Kind,
    text: &str,
    offset: u32,
) -> Option<ide_spring_boot::analysis::complete::BootCompletion> {
    use ide_spring_boot::analysis::complete::{BootCompletion, BootCompletionItem, BootItemKind};
    let u = Utf16::new(text);
    let at = u.byte(offset);
    let line_start = text[..at].rfind('\n').map_or(0, |i| i + 1);
    let before = &text[line_start..at];
    if before.trim_start().starts_with(['#', '!']) {
        return None;
    }
    let item = |label: String, kind: BootItemKind| BootCompletionItem {
        label,
        kind,
        detail: None,
        insert: None,
        key: None,
        deprecated: false,
        replacement: None,
        description: None,
        elements: Vec::new(),
        suffix: ide_spring_boot::analysis::complete::BootSuffix::None,
        boost: 0,
        is_default: false,
    };
    let continuation = line_start >= 2 && text[..line_start - 1].trim_end_matches('\r').ends_with('\\');
    let (from, typed) = match kind {
        ide_spring_boot::imports::Kind::Imports => {
            let lead = before.len() - before.trim_start().len();
            (line_start + lead, before.trim_start())
        }
        ide_spring_boot::imports::Kind::Factories => {
            if !continuation && !before.contains(['=', ':']) {
                let lead = before.len() - before.trim_start().len();
                let items = FACTORIES_KEYS.iter().map(|k| item((*k).to_owned(), BootItemKind::Class)).collect();
                return Some(BootCompletion {
                    from: u.of(line_start + lead),
                    to: offset,
                    items,
                    yaml: None,
                    complete: true,
                });
            }
            let cut = before.rfind([',', '=', ':']).map_or(0, |i| i + 1);
            let token = &before[cut..];
            let lead = token.len() - token.trim_start().len();
            (line_start + cut + lead, token.trim_start())
        }
    };
    let cp = crate::java_engine::classpath_for(project, path);
    let read = reader(project);
    let names = project.index.with_java_state(&[], |view| {
        let model = Model::new(view, &cp).with_visibility(project.java_engine.visibility(path));
        let types = JavaTypes::new(&model, &read);
        use ide_spring_boot::TypeOracle;
        types.logger_names(typed, 300)
    });
    let items: Vec<BootCompletionItem> = names
        .into_iter()
        .map(|n| {
            let class = n.rsplit('.').next().is_some_and(|s| s.chars().next().is_some_and(char::is_uppercase));
            item(n, if class { BootItemKind::Class } else { BootItemKind::Logger })
        })
        .collect();
    (!items.is_empty()).then(|| BootCompletion { from: u.of(from), to: offset, items, yaml: None, complete: false })
}

pub async fn spring_boot_hover(
    host: &crate::Host,
    window: &str,
    path: IpcPath,
    text: String,
    offset: u32,
) -> IdeResult<Option<BootHover>> {
    let project = host.project(window)?;
    host.blocking(move || {
        Ok(with_context(&project, &path.0, &text, false, |cx, format| {
            ide_spring_boot::analysis::hover::hover(cx, format, &text, offset)
        })
        .flatten())
    })
    .await
}

/// Documentation of a property (or group) for the completion side panel.
pub async fn spring_boot_describe(
    host: &crate::Host,
    window: &str,
    path: IpcPath,
    key: String,
) -> IdeResult<Option<PropertyDoc>> {
    let project = host.project(window)?;
    host.blocking(move || {
        Ok(with_context(&project, &path.0, "", false, |cx, _| ide_spring_boot::analysis::hover::describe(cx, &key))
            .flatten())
    })
    .await
}

/// Inspection problems of a file of a Boot module: a configuration file, an auto-configuration
/// registration file (`.imports`, `spring.factories`), or a Java source.
/// `replacement_tokens`: values with Maven resource filtering tokens (`@project.version@`)
/// are not checked (the inspections' Replacement tokens option).
pub async fn spring_boot_problems(
    host: &crate::Host,
    window: &str,
    path: IpcPath,
    text: String,
    replacement_tokens: bool,
) -> IdeResult<Vec<BootProblem>> {
    let project = host.project(window)?;
    host.blocking(move || {
        let path = path.0;
        if path.extension().is_some_and(|e| e == "java") {
            return Ok(java_problems(&project, &path, &text));
        }
        if let Some(kind) = ide_spring_boot::imports::Kind::of(&path) {
            return Ok(imports_problems(&project, &path, kind, &text));
        }
        if path.file_name().is_some_and(|n| n == ide_spring_boot::additional::FILE_NAME) {
            return Ok(additional_problems(&project, &path, &text));
        }
        Ok(with_context(&project, &path, &text, false, |cx, format| {
            let options = Options { replacement_tokens, ..cx.options.clone() };
            let cx = Context { options: &options, ..*cx };
            ide_spring_boot::analysis::validate::validate(&cx, format, &text)
        })
        .unwrap_or_default())
    })
    .await
}

fn boot_version(m: &BootModule) -> Option<(u32, u32)> {
    let v = m.boot_version.as_deref()?;
    let mut parts = v.split('.');
    Some((parts.next()?.parse().ok()?, parts.next().and_then(|p| p.parse().ok()).unwrap_or(0)))
}

/// `spring.test.constructor.autowire.mode=all` in the module's test resources.
fn test_autowire_all(m: &BootModule) -> bool {
    ["src/test/resources/junit-platform.properties", "src/test/resources/spring.properties"]
        .iter()
        .filter_map(|f| std::fs::read_to_string(m.root.join(f)).ok())
        .any(|t| ide_spring_boot::java::autowire_all(&t))
}

fn java_problems(project: &Project, path: &Path, text: &str) -> Vec<BootProblem> {
    let Some(m) = module_for(project, path) else { return Vec::new() };
    let Some(tree) = ide_java::parse(text) else { return Vec::new() };
    let read = reader(project);
    let others = unsaved(project, |p| p != path && p.extension().is_some_and(|e| e == "java"));
    project
        .index
        .with_java_edits(path, text, &others, |view| {
            let cx = ide_spring_boot::java::JavaContext {
                view,
                path,
                boot: boot_version(&m),
                reactor_tools: m.features.reactor_tools,
                test_autowire_all: test_autowire_all(&m),
                read: &read,
            };
            ide_spring_boot::java::java_problems(&cx, text, &tree)
        })
        .unwrap_or_default()
}

/// The text of a file: an open editor's, else the disk's.
fn text_of(project: &Project, path: &Path) -> Option<String> {
    unsaved(project, |p| p == path).into_iter().next().map(|(_, t)| t).or_else(|| std::fs::read_to_string(path).ok())
}

/// `additional-spring-configuration-metadata.json`: checked against the module's metadata
/// (hints may name keys of the libraries) and its classes.
fn additional_problems(project: &Project, path: &Path, text: &str) -> Vec<BootProblem> {
    let Some(m) = module_for(project, path) else { return Vec::new() };
    let cp = crate::java_engine::classpath_for(project, path);
    let read = reader(project);
    project.index.with_java_state(&[], |view| {
        let model = Model::new(view, &cp).with_visibility(project.java_engine.visibility(path));
        let types = JavaTypes::new(&model, &read);
        ide_spring_boot::additional::validate(text, &m.index, &types)
    })
}

fn imports_problems(
    project: &Project,
    path: &Path,
    kind: ide_spring_boot::imports::Kind,
    text: &str,
) -> Vec<BootProblem> {
    let Some(m) = module_for(project, path) else { return Vec::new() };
    let cp = crate::java_engine::classpath_for(project, path);
    let read = reader(project);
    let imports_path =
        path.parent().map(|p| p.join("spring").join(ide_spring_boot::imports::AUTO_CONFIGURATION_IMPORTS));
    let imports_text = imports_path.as_deref().and_then(|p| text_of(project, p));
    project.index.with_java_state(&[], |view| {
        let model = Model::new(view, &cp).with_visibility(project.java_engine.visibility(path));
        let types = JavaTypes::new(&model, &read);
        ide_spring_boot::imports::validate(
            kind,
            path,
            text,
            &types,
            boot_version(&m).map(|v| v.0),
            imports_text.as_deref(),
        )
    })
}

// ---------------------------------------------------------------------------
// Java gutter markers

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum BootMarkerKind {
    /// A `@ConfigurationProperties` class or property: its keys in configuration files.
    ConfigProperties,
    /// An auto-configuration class: where `.imports` / `spring.factories` register it.
    Registration,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct BootMarker {
    pub kind: BootMarkerKind,
    pub line: u32,
    pub name: String,
    pub targets: Vec<Location>,
}

/// Gutter markers of a Java file of a Boot module.
pub async fn spring_boot_markers(
    host: &crate::Host,
    window: &str,
    path: IpcPath,
    text: String,
) -> IdeResult<Vec<BootMarker>> {
    let project = host.project(window)?;
    host.blocking(move || {
        let path = path.0;
        let Some(m) = module_for(&project, &path) else { return Ok(Vec::new()) };
        let cfg = project_config(&project, &m, &path, "");
        let registration_files: Vec<(PathBuf, String)> = project
            .index
            .files_named(|n| n.ends_with(".imports") || n == "spring.factories")
            .into_iter()
            .filter(|p| ide_spring_boot::imports::Kind::of(p).is_some())
            .filter_map(|p| Some((p.clone(), text_of(&project, &p)?)))
            .collect();
        let markers = project
            .index
            .with_java(&path, &text, |view| {
                let mut out = Vec::new();
                let Some(file) = view.overlay_file() else { return out };
                let Some(stub) = view.stub(file) else { return out };
                for (ti, t) in stub.types.iter().enumerate() {
                    if let Some(a) = t.annotation_args.iter().find(|a| a.simple_name() == "ConfigurationProperties")
                        && let Some(prefix) = a.arg("prefix").or_else(|| a.arg("value")).and_then(|v| v.as_str())
                    {
                        let prefix = name::canonical(prefix);
                        let under = |key: &str| {
                            cfg.keys
                                .iter()
                                .filter(|k| k.canonical == key || name::is_under(&k.canonical, key))
                                .filter(|k| k.path != path)
                                .map(|k| location_of(&project, &k.path, k.line, k.offset, &k.key))
                                .collect::<Vec<_>>()
                        };
                        let targets = under(&prefix);
                        if !targets.is_empty() {
                            out.push(BootMarker {
                                kind: BootMarkerKind::ConfigProperties,
                                line: t.at.line,
                                name: t.name.clone(),
                                targets,
                            });
                        }
                        for mem in t.members.iter().filter(|x| x.kind == ide_index::java::JavaMemberKind::Field) {
                            let key = name::join(&prefix, &name::uniform(&mem.name));
                            let targets = under(&key);
                            if !targets.is_empty() {
                                out.push(BootMarker {
                                    kind: BootMarkerKind::ConfigProperties,
                                    line: mem.at.line,
                                    name: mem.name.clone(),
                                    targets,
                                });
                            }
                        }
                    }
                    let auto = t.annotations.iter().any(|a| a == "AutoConfiguration");
                    if auto || t.annotations.iter().any(|a| a == "Configuration") {
                        let mut fqn =
                            if stub.package.is_empty() { String::new() } else { format!("{}.", stub.package) };
                        // Nested classes register with `$`.
                        let mut chain = vec![t.name.clone()];
                        let mut outer = t.outer;
                        while let Some(o) = outer {
                            chain.push(stub.types[o as usize].name.clone());
                            outer = stub.types[o as usize].outer;
                        }
                        chain.reverse();
                        fqn.push_str(&chain.join("$"));
                        let regs = ide_spring_boot::imports::registrations(&fqn, &registration_files);
                        if !regs.is_empty() {
                            let targets = regs
                                .into_iter()
                                .filter_map(|(p, from, to)| {
                                    let t = registration_files.iter().find(|(f, _)| *f == p)?.1.as_str();
                                    let u = Utf16::new(t);
                                    Some(Location {
                                        path: IpcPath(p),
                                        range: Range::new(u.pos(from), u.pos(to)),
                                        uri: None,
                                    })
                                })
                                .collect();
                            out.push(BootMarker {
                                kind: BootMarkerKind::Registration,
                                line: t.at.line,
                                name: t.name.clone(),
                                targets,
                            });
                        }
                    }
                    let _ = ti;
                }
                out
            })
            .unwrap_or_default();
        Ok(markers)
    })
    .await
}

/// Where a key, value or placeholder at `offset` leads: the definitions of a `${…}` key, the
/// files and documents of a profile, imported files, classes and enum constants, the
/// `@ConfigurationProperties` source of a key.
pub async fn spring_boot_navigate(
    host: &crate::Host,
    window: &str,
    path: IpcPath,
    text: String,
    offset: u32,
) -> IdeResult<Vec<Location>> {
    let project = host.project(window)?;
    host.blocking(move || {
        let path = path.0;
        if let Some(kind) = ide_spring_boot::imports::Kind::of(&path) {
            let at = Utf16::new(&text).byte(offset);
            return Ok(ide_spring_boot::imports::class_at(kind, &text, at)
                .map(|c| class_location(&project, &path, &c.name.replace('$', ".")))
                .unwrap_or_default());
        }
        let Some((format, _)) = config_file(&project, &path) else { return Ok(Vec::new()) };
        let Some(m) = module_for(&project, &path) else { return Ok(Vec::new()) };
        let u = Utf16::new(&text);
        let at = u.byte(offset);
        let file = ConfigFile::parse(format, &text);
        let Some(target) = ide_spring_boot::analysis::hover::target_at(&file, &text, at) else { return Ok(Vec::new()) };
        let cfg = project_config(&project, &m, &path, &text);
        let mut out = Vec::new();
        match target {
            Target::Placeholder { key, .. } => {
                let canonical = name::canonical(&key);
                for k in cfg.keys.iter().filter(|k| k.canonical == canonical) {
                    out.push(location_of(&project, &k.path, k.line, k.offset, &k.key));
                }
                if out.is_empty() {
                    out.extend(property_source(&project, &m, &path, &key));
                }
            }
            Target::Key { key, .. } => out.extend(property_source(&project, &m, &path, &key)),
            Target::Value { key, value, .. } => {
                let canonical = name::canonical(&key);
                let profile_key = matches!(
                    canonical.as_str(),
                    "spring.profiles.active"
                        | "spring.profiles.include"
                        | "spring.profiles.default"
                        | "spring.config.activate.onprofile"
                ) || name::is_under(&canonical, "spring.profiles.group");
                if profile_key {
                    out.extend(profile_targets(&project, &m, &value));
                } else if canonical == "spring.config.import" {
                    let rest = value.trim_start_matches("optional:");
                    if let Some(p) = rest.strip_prefix("classpath:") {
                        for r in &m.resources {
                            let f = r.join(p.trim_start_matches('/'));
                            if f.is_file() {
                                out.push(Location { path: IpcPath(f), range: Range::default(), uri: None });
                            }
                        }
                    } else {
                        let f = Path::new(rest.trim_start_matches("file:"));
                        let f = if f.is_absolute() { f.to_owned() } else { m.root.join(f) };
                        if f.is_file() {
                            out.push(Location { path: IpcPath(f), range: Range::default(), uri: None });
                        }
                    }
                } else if value.contains('.') && !value.contains(char::is_whitespace) {
                    out.extend(class_location(&project, &path, &value));
                }
            }
        }
        Ok(out)
    })
    .await
}

fn location_of(project: &Project, path: &Path, line: u32, _offset: u32, key: &str) -> Location {
    let _ = project;
    let text = std::fs::read_to_string(path).unwrap_or_default();
    let line_text = text.lines().nth(line as usize).unwrap_or("");
    let last = key.rsplit('.').next().unwrap_or(key);
    let col = line_text.find(last).or_else(|| line_text.find(key)).map_or(0, |b| line_text[..b].encode_utf16().count());
    let start = Pos::new(line, col as u32);
    Location { path: IpcPath(path.to_owned()), range: Range::new(start, start), uri: None }
}

/// The `application-{p}.*` files and `on-profile: p` documents of profile `name`.
fn profile_targets(project: &Project, m: &BootModule, name: &str) -> Vec<Location> {
    let mut out = Vec::new();
    for f in module_config_files(project, m) {
        if config_file(project, &f).and_then(|(_, p)| p).as_deref() == Some(name) {
            out.push(Location { path: IpcPath(f.clone()), range: Range::default(), uri: None });
            continue;
        }
        let Some(format) = f.to_str().and_then(Format::of) else { continue };
        let Ok(text) = std::fs::read_to_string(&f) else { continue };
        let file = ConfigFile::parse(format, &text);
        for doc in &file.documents {
            if doc.on_profile.as_deref().is_some_and(|p| profile_names(p).iter().any(|n| n == name))
                && let Some(e) = doc.entries.iter().find(|e| e.canonical == "spring.config.activate.onprofile")
            {
                let line = text[..e.key_span.from].matches('\n').count() as u32;
                out.push(location_of(project, &f, line, 0, &e.key));
            }
        }
    }
    out
}

/// The source of a class (a project class) by qualified name.
fn class_location(project: &Project, path: &Path, fqn: &str) -> Vec<Location> {
    let cp = crate::java_engine::classpath_for(project, path);
    project.index.with_java_state(&[], |view| {
        let model = Model::new(view, &cp);
        let Some(key) = model.by_dotted(fqn) else { return Vec::new() };
        let Some(id) = model.source_type(&key) else { return Vec::new() };
        let (Some(p), Some(t)) = (view.path(id.file), view.ty(id)) else { return Vec::new() };
        vec![Location { path: IpcPath(p.to_owned()), range: Range::new(t.at, t.at), uri: None }]
    })
}

/// The Java member a key binds to, when its `@ConfigurationProperties` class is a project source
/// (library members are answered by jdtls's configuration navigation).
fn property_source(project: &Project, m: &BootModule, path: &Path, key: &str) -> Vec<Location> {
    let canonical = name::canonical(key);
    let (source_type, member) = match m.index.property(&canonical) {
        Some(p) => (p.source_type.clone(), p.name.rsplit('.').next().map(str::to_owned)),
        None => match m.index.groups_named(&canonical).next() {
            Some(g) => (g.source_type.clone(), None),
            None => return Vec::new(),
        },
    };
    let Some(source_type) = source_type else { return Vec::new() };
    let cp = crate::java_engine::classpath_for(project, path);
    project.index.with_java_state(&[], |view| {
        let model = Model::new(view, &cp);
        let Some(k) = model.by_dotted(&source_type.replace('$', ".")) else { return Vec::new() };
        let Some(id) = model.source_type(&k) else { return Vec::new() };
        let (Some(p), Some(t)) = (view.path(id.file), view.ty(id)) else { return Vec::new() };
        let want = member.as_deref().map(name::uniform);
        let at = want
            .and_then(|w| {
                t.members
                    .iter()
                    .find(|x| x.kind == ide_index::java::JavaMemberKind::Field && name::uniform(&x.name) == w)
            })
            .map_or(t.at, |x| x.at);
        vec![Location { path: IpcPath(p.to_owned()), range: Range::new(at, at), uri: None }]
    })
}

/// The additional metadata file a new key goes to, and its content with the key added.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DefinedKey {
    pub path: IpcPath,
    /// The file does not exist yet.
    pub created: bool,
    /// The whole new content.
    pub text: String,
    /// UTF-16 range of the new entry's description value (selected for typing).
    pub select_from: u32,
    pub select_to: u32,
}

/// "Define configuration key": adds `name` to the module's
/// `META-INF/additional-spring-configuration-metadata.json` (created in its first resource
/// folder when missing). `current` is the file's current text when an editor has it open.
pub async fn spring_boot_define_key(
    host: &crate::Host,
    window: &str,
    path: IpcPath,
    name: String,
    ty: String,
    current: Option<String>,
) -> IdeResult<DefinedKey> {
    let project = host.project(window)?;
    host.blocking(move || {
        let m = module_for(&project, &path.0).ok_or_else(|| ide_core::IdeError::invalid("Not a Spring Boot module"))?;
        let root = m.resources.first().cloned().unwrap_or_else(|| m.root.join("src/main/resources"));
        let file = root.join("META-INF/additional-spring-configuration-metadata.json");
        let existing = current.or_else(|| std::fs::read_to_string(&file).ok());
        let created = existing.is_none();
        let (text, from, to) = define_key_text(existing.as_deref(), &name, &ty)?;
        Ok(DefinedKey { path: IpcPath(file), created, text, select_from: from, select_to: to })
    })
    .await
}

/// Adds a property entry to metadata JSON text (keeping the rest as written when possible).
fn define_key_text(existing: Option<&str>, name: &str, ty: &str) -> IdeResult<(String, u32, u32)> {
    let entry = |indent: &str| {
        format!(
            "{indent}{{\n{indent}  \"name\": {},\n{indent}  \"type\": {},\n{indent}  \"description\": \"\"\n{indent}}}",
            serde_json::to_string(name).unwrap_or_default(),
            serde_json::to_string(ty).unwrap_or_default()
        )
    };
    let text = match existing.map(str::trim).filter(|t| !t.is_empty()) {
        None => format!("{{\n  \"properties\": [\n{}\n  ]\n}}\n", entry("    ")),
        Some(_) => {
            let src = existing.unwrap_or_default();
            serde_json::from_str::<serde_json::Value>(src).map_err(|e| {
                ide_core::IdeError::invalid(format!("The additional metadata file is not valid JSON: {e}"))
            })?;
            // Insert into an existing "properties" array, else add one.
            if let Some(at) = src.find("\"properties\"")
                && let Some(open) = src[at..].find('[').map(|i| at + i)
            {
                let after = &src[open + 1..];
                let empty = after.trim_start().starts_with(']');
                let insert = if empty { format!("\n{}\n  ", entry("    ")) } else { format!("\n{},", entry("    ")) };
                format!("{}{}{}", &src[..open + 1], insert, after)
            } else {
                let open = src.find('{').unwrap_or(0);
                let rest = &src[open + 1..];
                let empty = rest.trim_start().starts_with('}');
                let insert = format!("\n  \"properties\": [\n{}\n  ]{}", entry("    "), if empty { "\n" } else { "," });
                format!("{}{}{}", &src[..open + 1], insert, rest)
            }
        }
    };
    let marker = format!("\"name\": {}", serde_json::to_string(name).unwrap_or_default());
    let at = text.find(&marker).unwrap_or(0);
    let desc = text[at..].find("\"description\": \"").map(|i| at + i + "\"description\": \"".len()).unwrap_or(0);
    let u = Utf16::new(&text);
    Ok((text.clone(), u.of(desc), u.of(desc)))
}

/// The project source of class `fqn` (a runtime bean's or a mapping handler's type); `None` for
/// library classes.
pub async fn spring_boot_locate_class(host: &crate::Host, window: &str, fqn: String) -> IdeResult<Option<Location>> {
    let project = host.project(window)?;
    host.blocking(move || {
        let root = project.root.clone();
        Ok(class_location(&project, &root.join("pom.xml"), &fqn.replace('$', ".")).into_iter().next())
    })
    .await
}

pub(crate) fn register(d: &mut Dispatcher) {
    d.add(
        "spring_boot_locate_class",
        |c| async move { spring_boot_locate_class(&c.host, &c.window, c.arg("fqn")?).await },
    );
    d.add("spring_boot_status", |c| async move { spring_boot_status(&c.host, &c.window, c.arg("path")?).await });
    d.add("spring_boot_complete", |c| async move {
        spring_boot_complete(&c.host, &c.window, c.arg("path")?, c.arg("text")?, c.arg("offset")?, c.arg("explicit")?)
            .await
    });
    d.add("spring_boot_hover", |c| async move {
        spring_boot_hover(&c.host, &c.window, c.arg("path")?, c.arg("text")?, c.arg("offset")?).await
    });
    d.add("spring_boot_describe", |c| async move {
        spring_boot_describe(&c.host, &c.window, c.arg("path")?, c.arg("key")?).await
    });
    d.add("spring_boot_problems", |c| async move {
        spring_boot_problems(&c.host, &c.window, c.arg("path")?, c.arg("text")?, c.arg("replacementTokens")?).await
    });
    d.add("spring_boot_markers", |c| async move {
        spring_boot_markers(&c.host, &c.window, c.arg("path")?, c.arg("text")?).await
    });
    d.add("spring_boot_navigate", |c| async move {
        spring_boot_navigate(&c.host, &c.window, c.arg("path")?, c.arg("text")?, c.arg("offset")?).await
    });
    d.add("spring_boot_define_key", |c| async move {
        spring_boot_define_key(&c.host, &c.window, c.arg("path")?, c.arg("name")?, c.arg("ty")?, c.arg("current")?)
            .await
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defines_keys() {
        let (t, from, _) = define_key_text(None, "app.x", "java.lang.Integer").unwrap();
        let v: serde_json::Value = serde_json::from_str(&t).unwrap();
        assert_eq!(v["properties"][0]["name"], "app.x");
        assert_eq!(&t[from as usize..from as usize + 1], "\"");
        let (t, _, _) =
            define_key_text(Some("{\n  \"properties\": [\n    {\"name\": \"a\"}\n  ]\n}\n"), "b", "java.lang.String")
                .unwrap();
        let v: serde_json::Value = serde_json::from_str(&t).unwrap();
        assert_eq!(v["properties"].as_array().unwrap().len(), 2);
        let (t, _, _) = define_key_text(Some("{\"hints\": []}"), "b", "java.lang.String").unwrap();
        let v: serde_json::Value = serde_json::from_str(&t).unwrap();
        assert_eq!(v["properties"][0]["name"], "b");
        assert!(define_key_text(Some("{broken"), "b", "x").is_err());
        let (t, _, _) = define_key_text(Some("{\"properties\": []}"), "c", "java.lang.String").unwrap();
        assert!(serde_json::from_str::<serde_json::Value>(&t).is_ok());
    }

    #[test]
    fn profile_expressions() {
        assert_eq!(profile_names("dev & !local | (prod)"), ["dev", "local", "prod"]);
        assert_eq!(profile_names("a,b"), ["a", "b"]);
    }
}
