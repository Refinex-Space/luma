//! Luma's Java engine in a project (`ide-java`): the class path each module compiles against,
//! known at once from a persisted snapshot (IDEA restores its project model from
//! `WorkspaceModelCache` the same way), refreshed from jdtls's view in the background; until a
//! module has been seen, only the project JDK.

use ide_java::classpath::{ClassPath, jdk_roots};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;

const SNAPSHOT_VERSION: u32 = 1;

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
struct ModuleClassPath {
    /// The module's root (jdtls's project root).
    root: PathBuf,
    /// Class path entries in order: output folders and jars.
    entries: Vec<PathBuf>,
    java_home: Option<PathBuf>,
    /// Compliance level (`17`).
    #[serde(default)]
    source_level: Option<String>,
    /// Modification time (ms) of the module's build files when recorded.
    #[serde(default)]
    build_stamp: u64,
}

/// The newest modification time (ms) of the build files of the module at `root`.
fn build_stamp(root: &Path) -> u64 {
    ["pom.xml", "build.gradle", "build.gradle.kts"]
        .iter()
        .filter_map(|f| std::fs::metadata(root.join(f)).ok()?.modified().ok())
        .filter_map(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .max()
        .unwrap_or(0)
}

/// A module's class path before jdtls describes it.
struct Fallback {
    root: PathBuf,
    hash: u64,
    cp: Arc<ClassPath>,
    entries: Vec<PathBuf>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct Snapshot {
    version: u32,
    modules: Vec<ModuleClassPath>,
}

pub struct JavaEngine {
    file: PathBuf,
    snapshot: Mutex<Snapshot>,
    /// Built class paths by module root (the JDK-only one under the empty path).
    classpaths: Mutex<HashMap<PathBuf, Arc<ClassPath>>>,
    /// Module roots refreshed from jdtls this session (or being refreshed).
    refreshed: Mutex<HashSet<PathBuf>>,
    /// Class paths of modules jdtls has not described yet (from the last Maven sync, else
    /// worked out from the POMs): module root, hash of the entries, class path, entries.
    fallback: Mutex<Vec<Fallback>>,
    /// Roots of the build's modules (from the build model), for the visibility of modules
    /// jdtls has not described.
    module_roots: Mutex<Vec<PathBuf>>,
    /// The POM resolver of the project, kept with the build model's stamp it was made for.
    static_classpath: Mutex<Option<(u64, ide_build::maven::StaticClasspath)>>,
    /// The detected JDK used while none is configured, with the build stamp it was picked for.
    detected_jdk: Mutex<Option<(u64, Option<PathBuf>)>>,
    /// A [`JavaEngine::refresh_all`] batch is running.
    refreshing_all: std::sync::atomic::AtomicBool,
    /// Folders whose module class path was asked for this session.
    attempted: Mutex<HashSet<PathBuf>>,
    /// The project's build model with the root build file's stamp, for the Maven fallback.
    build_model: Mutex<Option<(u64, Arc<ide_build::BuildModel>)>>,
}

impl JavaEngine {
    pub fn new(cache_dir: &Path) -> Self {
        let file = cache_dir.join("java-classpath.json");
        let snapshot = std::fs::read(&file)
            .ok()
            .and_then(|b| serde_json::from_slice::<Snapshot>(&b).ok())
            .filter(|s| s.version == SNAPSHOT_VERSION)
            .unwrap_or_default();
        Self {
            file,
            snapshot: Mutex::new(snapshot),
            classpaths: Mutex::default(),
            refreshed: Mutex::default(),
            fallback: Mutex::default(),
            module_roots: Mutex::default(),
            static_classpath: Mutex::default(),
            detected_jdk: Mutex::default(),
            refreshing_all: Default::default(),
            attempted: Mutex::default(),
            build_model: Mutex::default(),
        }
    }

    /// The module whose root is the longest prefix of `path`.
    fn module_of(&self, path: &Path) -> Option<ModuleClassPath> {
        self.snapshot
            .lock()
            .modules
            .iter()
            .filter(|m| path.starts_with(&m.root))
            .max_by_key(|m| m.root.as_os_str().len())
            .cloned()
    }

    /// Which source files the module of `path` sees, in which order (see
    /// [`ide_java::model::SourceVisibility`]): its own first, then those of the modules whose
    /// output folders are on its class path, by position. `None` while the module is unknown.
    pub fn visibility(&self, path: &Path) -> Option<ide_java::model::SourceVisibility> {
        let snapshot = self.snapshot.lock();
        let Some(module) =
            snapshot.modules.iter().filter(|m| path.starts_with(&m.root)).max_by_key(|m| m.root.as_os_str().len())
        else {
            drop(snapshot);
            return self.fallback_visibility(path);
        };
        let roots: Vec<PathBuf> = snapshot.modules.iter().map(|m| m.root.clone()).collect();
        let ranks: Vec<(PathBuf, usize)> = roots
            .iter()
            .filter_map(|r| {
                if *r == module.root || module.root.starts_with(r) {
                    return Some((r.clone(), 0));
                }
                let at = module.entries.iter().position(|e| e.starts_with(r))?;
                Some((r.clone(), at + 1))
            })
            .collect();
        Some(std::sync::Arc::new(move |file: &Path| {
            let owner = roots.iter().filter(|r| file.starts_with(r)).max_by_key(|r| r.as_os_str().len());
            match owner {
                None => Some(0),
                Some(o) => ranks.iter().find(|(r, _)| r == o).map(|(_, rank)| *rank),
            }
        }))
    }

    /// The JDK the project at `root` compiles against while no Project JDK is set: the installed
    /// one matching the release its build targets (what External Libraries shows, and close to
    /// what jdtls picks), so a first open resolves `String` or `List` without jdtls.
    pub fn detected_jdk(&self, root: &Path) -> Option<PathBuf> {
        let stamp = build_stamp(root);
        let mut slot = self.detected_jdk.lock();
        match &*slot {
            Some((s, jdk)) if *s == stamp => jdk.clone(),
            _ => {
                let jdks = ide_sdk::java::installed_jdks();
                let jdk =
                    ide_sdk::java::pick_jdk(&jdks, ide_sdk::java::project_java_version(root)).map(|j| j.home.clone());
                *slot = Some((stamp, jdk.clone()));
                jdk
            }
        }
    }

    /// Records the roots of the build's modules.
    pub fn set_module_roots(&self, roots: Vec<PathBuf>) {
        let mut current = self.module_roots.lock();
        if *current != roots {
            *current = roots;
        }
    }

    /// [`JavaEngine::visibility`] of a module jdtls has not described, from its fallback class
    /// path: its own sources first, then the modules whose output folders are on it by position,
    /// the other modules after them.
    fn fallback_visibility(&self, path: &Path) -> Option<ide_java::model::SourceVisibility> {
        let roots = self.module_roots.lock().clone();
        let owner_of = move |roots: &[PathBuf], file: &Path| -> Option<PathBuf> {
            roots.iter().filter(|r| file.starts_with(r)).max_by_key(|r| r.as_os_str().len()).cloned()
        };
        let mine = owner_of(&roots, path)?;
        let entries = self.fallback.lock().iter().find(|f| f.root == mine).map(|f| f.entries.clone())?;
        let ranks: Vec<(PathBuf, usize)> = roots
            .iter()
            .map(|r| {
                let rank = if *r == mine {
                    0
                } else {
                    entries.iter().position(|e| e.starts_with(r)).map_or(usize::MAX / 2, |at| at + 1)
                };
                (r.clone(), rank)
            })
            .collect();
        Some(Arc::new(move |file: &Path| match owner_of(&roots, file) {
            None => Some(0),
            Some(o) => ranks.iter().find(|(r, _)| *r == o).map(|(_, rank)| *rank),
        }))
    }

    /// The build model of the project at `root`, loaded with `load` when its root build file
    /// changed since the last load.
    pub fn build_model(&self, root: &Path, load: impl FnOnce() -> ide_build::BuildModel) -> Arc<ide_build::BuildModel> {
        let stamp = build_stamp(root);
        if let Some((s, m)) = &*self.build_model.lock()
            && *s == stamp
        {
            return m.clone();
        }
        let model = Arc::new(load());
        *self.build_model.lock() = Some((stamp, model.clone()));
        model
    }

    /// A fingerprint of the class path `path` is analyzed with: counts made with another one
    /// (a JDK-only class path before jdtls described the module) are counted again.
    pub fn stamp(&self, path: &Path) -> u64 {
        use std::hash::{Hash, Hasher};
        let mut h = std::collections::hash_map::DefaultHasher::new();
        match self.module_of(path) {
            Some(m) => {
                m.root.hash(&mut h);
                m.entries.hash(&mut h);
                m.java_home.hash(&mut h);
            }
            None => {
                let fallback = self
                    .fallback
                    .lock()
                    .iter()
                    .filter(|f| path.starts_with(&f.root))
                    .max_by_key(|f| f.root.as_os_str().len())
                    .map(|f| f.hash);
                fallback.hash(&mut h);
            }
        }
        h.finish()
    }

    /// The root of the module `path` belongs to, as known.
    pub fn module_root(&self, path: &Path) -> Option<PathBuf> {
        self.module_of(path).map(|m| m.root)
    }

    /// Whether the class path of `path`'s module is known (from jdtls, now or in a past session).
    pub fn knows(&self, path: &Path) -> bool {
        self.module_of(path).is_some()
    }

    /// Whether `path`'s module was refreshed from jdtls in this session, and its build files
    /// have not changed since.
    pub fn fresh(&self, path: &Path) -> bool {
        self.module_of(path).is_some_and(|m| {
            if build_stamp(&m.root) != m.build_stamp {
                self.refreshed.lock().remove(&m.root);
                return false;
            }
            self.refreshed.lock().contains(&m.root)
        })
    }

    /// The class path to analyze `path` with: its module's, else the one `fallback` derives for
    /// `module` (the build tool's module root of `path`), else the JDK at `jdk` only.
    pub fn classpath_or(
        &self,
        path: &Path,
        jdk: Option<&Path>,
        module: Option<&Path>,
        fallback: impl FnOnce() -> Option<Vec<PathBuf>>,
    ) -> Arc<ClassPath> {
        if self.module_of(path).is_some() {
            return self.classpath(path, jdk);
        }
        let Some(module) = module else { return self.classpath(path, jdk) };
        let known = self.fallback.lock().iter().find(|f| f.root == module).map(|f| f.cp.clone());
        if let Some(cp) = known {
            return cp;
        }
        // Derived with no lock held: opening the class path runs in parallel (rayon), and a
        // worker waiting on a lock its own stolen job holds would never wake. Callers analyzing
        // files in parallel warm their modules first ([`warm_classpaths`]); a rare race derives
        // twice and keeps the first.
        match fallback() {
            Some(entries) => {
                use std::hash::{Hash, Hasher};
                let mut h = std::collections::hash_map::DefaultHasher::new();
                entries.hash(&mut h);
                let mut all: Vec<PathBuf> = jdk.map(jdk_roots).unwrap_or_default();
                all.extend(entries.iter().cloned());
                let cp = Arc::new(ClassPath::open(&all));
                let mut fallback = self.fallback.lock();
                if let Some(first) = fallback.iter().find(|f| f.root == module) {
                    return first.cp.clone();
                }
                fallback.push(Fallback { root: module.to_owned(), hash: h.finish(), cp: cp.clone(), entries });
                cp
            }
            None => self.classpath(path, jdk),
        }
    }

    /// The class path of the Maven module `project` worked out from the POMs (Maven's
    /// mediation rules over the local repository, see [`ide_build::maven::StaticClasspath`]):
    /// what a project opened for the first time — nothing synced, jdtls still importing —
    /// is analyzed with.
    pub fn static_entries(
        &self,
        maven: &ide_build::maven::MavenModel,
        root: &Path,
        repo: &Path,
        project: &ide_build::maven::MavenProject,
    ) -> Vec<PathBuf> {
        let reactor: HashMap<String, PathBuf> = maven.projects.iter().map(|p| (p.key(), root.join(&p.dir))).collect();
        let stamp = build_stamp(root);
        let mut resolver = self.static_classpath.lock();
        match &mut *resolver {
            Some((s, r)) if *s == stamp => r.of(&root.join(&project.pom), &reactor),
            _ => {
                let mut r = ide_build::maven::StaticClasspath::new(Some(repo.to_owned()));
                let entries = r.of(&root.join(&project.pom), &reactor);
                *resolver = Some((stamp, r));
                entries
            }
        }
    }

    /// The class path to analyze `path` with: its module's, else the JDK at `jdk` only.
    pub fn classpath(&self, path: &Path, jdk: Option<&Path>) -> Arc<ClassPath> {
        let module = self.module_of(path);
        let key = module.as_ref().map(|m| m.root.clone()).unwrap_or_default();
        if let Some(cp) = self.classpaths.lock().get(&key) {
            return cp.clone();
        }
        let mut entries: Vec<PathBuf> = Vec::new();
        let home = module.as_ref().and_then(|m| m.java_home.clone()).or_else(|| jdk.map(Path::to_owned));
        if let Some(home) = home {
            entries.extend(jdk_roots(&home));
        }
        if let Some(m) = &module {
            entries.extend(m.entries.iter().cloned());
        }
        let cp = Arc::new(ClassPath::open(&entries));
        self.classpaths.lock().insert(key, cp.clone());
        cp
    }

    /// SonarQube for IDE's Java configuration of `path` (`sonarlint/getJavaConfig`), from the
    /// snapshot: `None` while its module is unknown.
    pub fn sonar_config(&self, path: &Path) -> Option<serde_json::Value> {
        let m = self.module_of(path)?;
        let rel = path.strip_prefix(&m.root).unwrap_or(path).to_string_lossy().replace('\\', "/");
        let is_test = rel.starts_with("src/test/") || rel.contains("/src/test/") || rel.starts_with("test/");
        Some(serde_json::json!({
            "projectRoot": m.root.to_string_lossy(),
            "sourceLevel": m.source_level,
            "classpath": m.entries.iter().map(|e| e.to_string_lossy()).collect::<Vec<_>>(),
            "isTest": is_test,
            "vmLocation": m.java_home.as_ref().map(|h| h.to_string_lossy()),
        }))
    }

    /// Records jdtls's class path of the module containing `path`.
    pub fn record(
        &self,
        root: PathBuf,
        entries: Vec<PathBuf>,
        java_home: Option<PathBuf>,
        source_level: Option<String>,
    ) {
        let changed = {
            let mut s = self.snapshot.lock();
            s.version = SNAPSHOT_VERSION;
            let stamp = build_stamp(&root);
            let new = ModuleClassPath { root: root.clone(), entries, java_home, source_level, build_stamp: stamp };
            match s.modules.iter_mut().find(|m| m.root == root) {
                Some(m)
                    if m.entries == new.entries
                        && m.java_home == new.java_home
                        && m.source_level == new.source_level =>
                {
                    let changed = m.build_stamp != stamp;
                    m.build_stamp = stamp;
                    changed
                }
                Some(m) => {
                    *m = new;
                    true
                }
                None => {
                    s.modules.push(new);
                    true
                }
            }
        };
        self.refreshed.lock().insert(root.clone());
        // jdtls's view replaces what the Maven sync suggested.
        self.fallback.lock().retain(|f| !f.root.starts_with(&root) && !root.starts_with(&f.root));
        if changed {
            self.classpaths.lock().remove(&root);
            // The JDK-only class path served files of this module until now.
            self.save();
        }
    }

    fn save(&self) {
        let bytes = serde_json::to_vec(&*self.snapshot.lock());
        let Ok(bytes) = bytes else { return };
        let tmp = self.file.with_extension("json.tmp");
        let result = self
            .file
            .parent()
            .map_or(Ok(()), std::fs::create_dir_all)
            .and_then(|_| std::fs::write(&tmp, bytes))
            .and_then(|_| std::fs::rename(&tmp, &self.file));
        if let Err(e) = result {
            tracing::debug!("java class path snapshot: {e}");
        }
    }

    /// Learns, in the background, the class paths of the modules of `paths` jdtls has not
    /// described this session (one batch at a time; a path whose module a previous refresh
    /// described is skipped).
    pub fn refresh_all(self: &Arc<Self>, lsp: Arc<ide_lsp::LspManager>, paths: Vec<PathBuf>) {
        // A folder already asked about this session (jdtls answered nothing for it) is not asked again.
        let pending: Vec<PathBuf> = {
            let mut attempted = self.attempted.lock();
            paths
                .into_iter()
                .filter(|p| !self.fresh(p))
                .filter(|p| p.parent().is_some_and(|d| attempted.insert(d.to_owned())))
                .collect()
        };
        if pending.is_empty() || self.refreshing_all.swap(true, std::sync::atomic::Ordering::AcqRel) {
            return;
        }
        let me = self.clone();
        tokio::spawn(async move {
            for p in pending {
                if !me.fresh(&p) {
                    me.refresh(&lsp, &p).await;
                }
            }
            me.refreshing_all.store(false, std::sync::atomic::Ordering::Release);
        });
    }

    /// Asks jdtls for the class path of `path`'s module, once per module and session. Returns
    /// whether something was learned.
    pub async fn refresh(&self, lsp: &ide_lsp::LspManager, path: &Path) -> bool {
        if let Some(m) = self.module_of(path)
            && !self.refreshed.lock().insert(m.root.clone())
        {
            return false;
        }
        let cancel = ide_core::CancellationToken::new();
        let cp = match lsp.java_classpath(path, true, &cancel).await {
            Ok(cp) => cp,
            Err(e) => {
                tracing::debug!("java engine: no class path for {}: {e}", path.display());
                if let Some(m) = self.module_of(path) {
                    self.refreshed.lock().remove(&m.root);
                }
                return false;
            }
        };
        let java_home = lsp.java_vm_location(path, &cancel).await.ok().flatten();
        let source_level = lsp.java_compliance(path, &cancel).await.ok().flatten();
        let Some(root) = cp.project_root.map(|r| r.0) else { return false };
        let entries = cp.class_paths.into_iter().chain(cp.module_paths).map(PathBuf::from).collect();
        self.record(root, entries, java_home, source_level);
        true
    }
}

/// The Maven project whose directory is the longest prefix of `path`.
pub(crate) fn maven_project<'m>(
    maven: &'m ide_build::maven::MavenModel,
    root: &Path,
    path: &Path,
) -> Option<&'m ide_build::maven::MavenProject> {
    let rel = path.strip_prefix(root).ok()?;
    maven.projects.iter().filter(|p| p.dir.is_empty() || rel.starts_with(&p.dir)).max_by_key(|p| p.dir.len())
}

/// The class path of the Maven module `project` from the last Maven sync (`dependency:tree`,
/// exact versions), as the jars of its dependencies in the local repository `repo` that exist.
/// `None` without a sync.
pub(crate) fn maven_entries(
    maven: &ide_build::maven::MavenModel,
    project: &ide_build::maven::MavenProject,
    repo: &Path,
) -> Option<Vec<PathBuf>> {
    maven.synced_at?;
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    let mut stack: Vec<&ide_build::maven::MavenDependency> = project.dependencies.iter().rev().collect();
    while let Some(d) = stack.pop() {
        if !d.resolved() || !seen.insert(format!("{}:{}:{:?}", d.group_id, d.artifact_id, d.classifier)) {
            continue;
        }
        stack.extend(d.children.iter().rev());
        let Some(version) = &d.version else { continue };
        if d.kind == "pom" {
            continue;
        }
        let classifier = match (d.kind.as_str(), &d.classifier) {
            (_, Some(c)) => format!("-{c}"),
            ("test-jar", None) => "-tests".to_owned(),
            _ => String::new(),
        };
        let mut jar = repo.to_owned();
        jar.extend(d.group_id.split('.'));
        jar.push(&d.artifact_id);
        jar.push(version);
        jar.push(format!("{}-{version}{classifier}.jar", d.artifact_id));
        if jar.is_file() {
            out.push(jar);
        }
    }
    Some(out)
}

/// The class path to analyze `path` of `project` with (see [`JavaEngine::classpath_or`]):
/// jdtls's, else the last Maven sync's, else the one the POMs give.
pub(crate) fn classpath_for(project: &crate::Project, path: &Path) -> Arc<ClassPath> {
    let settings = project.settings.effective();
    let engine = &project.java_engine;
    let jdk = ide_sdk::apply::project_jdk(&project.root, &settings)
        .map(|j| j.home)
        .or_else(|| engine.detected_jdk(&project.root));
    if engine.knows(path) {
        return engine.classpath(path, jdk.as_deref());
    }
    // The build model once per session (and build file change): parsing every POM for each
    // file of an undescribed module would cost seconds.
    let model = engine
        .build_model(&project.root, || crate::ops::build::load(&project.root, &project.build_cache_dir(), &settings));
    let Some(maven) = model.maven.as_ref() else { return engine.classpath(path, jdk.as_deref()) };
    engine.set_module_roots(maven.projects.iter().map(|p| project.root.join(&p.dir)).collect());
    let module = maven_project(maven, &project.root, path);
    let dir = module.map(|m| project.root.join(&m.dir));
    engine.classpath_or(path, jdk.as_deref(), dir.as_deref(), || {
        let module = module?;
        let repo = ide_sdk::apply::maven_local_repository(&project.root, &settings)
            .or_else(ide_build::maven::default_local_repo)?;
        maven_entries(maven, module, &repo).or_else(|| Some(engine.static_entries(maven, &project.root, &repo, module)))
    })
}

/// Works out the class path of every Maven module of the project (see [`classpath_for`]),
/// stopping when the project closes.
pub(crate) fn prewarm(project: &std::sync::Weak<crate::Project>) {
    let started = std::time::Instant::now();
    let modules: Vec<PathBuf> = {
        let Some(p) = project.upgrade() else { return };
        let settings = p.settings.effective();
        let model =
            p.java_engine.build_model(&p.root, || crate::ops::build::load(&p.root, &p.build_cache_dir(), &settings));
        let Some(maven) = model.maven.as_ref() else { return };
        maven.projects.iter().filter(|m| m.packaging != "pom").map(|m| p.root.join(&m.dir).join("pom.xml")).collect()
    };
    for pom in &modules {
        let Some(p) = project.upgrade() else { return };
        classpath_for(&p, pom);
    }
    tracing::debug!("java engine: class paths of {} modules in {:?}", modules.len(), started.elapsed());
}

/// Works out, one module at a time, the class paths of the modules of `files` — before files
/// are analyzed in parallel, so that the parallel work only reads them.
pub(crate) fn warm_classpaths<'f>(project: &crate::Project, files: impl IntoIterator<Item = &'f PathBuf>) {
    let mut dirs = HashSet::new();
    for f in files {
        if f.parent().is_some_and(|d| dirs.insert(d.to_owned())) {
            classpath_for(project, f);
        }
    }
}

/// [`JavaEngine::stamp`] of `path` once its class path has been worked out.
pub(crate) fn classpath_stamp(project: &crate::Project, path: &Path) -> u64 {
    classpath_for(project, path);
    project.java_engine.stamp(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snapshots_persist_and_answer_sonar() {
        let dir = tempfile::tempdir().unwrap();
        let cache = dir.path().join("cache");
        let root = dir.path().join("proj");
        let module = root.join("core");
        std::fs::create_dir_all(&module).unwrap();
        std::fs::write(module.join("pom.xml"), "<project/>").unwrap();
        let jar = dir.path().join("lib.jar");
        {
            let engine = JavaEngine::new(&cache);
            assert!(!engine.knows(&module.join("src/main/java/A.java")));
            // Unknown module: the JDK only (none here), still a usable class path.
            assert!(engine.classpath(&module.join("A.java"), None).roots().is_empty());
            engine.record(root.clone(), vec![], None, None);
            engine.record(module.clone(), vec![jar.clone()], Some(PathBuf::from("/jdk")), Some("17".into()));
            assert!(engine.fresh(&module.join("src/main/java/A.java")));
        }
        let engine = JavaEngine::new(&cache);
        let main = module.join("src/main/java/a/A.java");
        assert!(engine.knows(&main), "restored from the snapshot");
        assert!(!engine.fresh(&main), "not refreshed in this session yet");
        let config = engine.sonar_config(&main).unwrap();
        // The longest module root wins over the aggregator.
        assert_eq!(config["projectRoot"], module.to_string_lossy().as_ref());
        assert_eq!(config["sourceLevel"], "17");
        assert_eq!(config["classpath"][0], jar.to_string_lossy().as_ref());
        assert_eq!(config["isTest"], false);
        assert_eq!(config["vmLocation"], "/jdk");
        assert_eq!(engine.sonar_config(&module.join("src/test/java/a/ATest.java")).unwrap()["isTest"], true);

        // A changed build file makes the module stale again.
        engine.record(module.clone(), vec![jar.clone()], Some(PathBuf::from("/jdk")), Some("17".into()));
        assert!(engine.fresh(&main));
        std::thread::sleep(std::time::Duration::from_millis(20));
        std::fs::write(module.join("pom.xml"), "<project><!-- edited --></project>").unwrap();
        let later = std::time::SystemTime::now() + std::time::Duration::from_secs(5);
        std::fs::File::options().write(true).open(module.join("pom.xml")).unwrap().set_modified(later).unwrap();
        assert!(!engine.fresh(&main));
    }

    #[test]
    fn maven_sync_gives_exact_jars() {
        use ide_build::maven::{MavenDependency, MavenModel, MavenProject, Omission};
        let dir = tempfile::tempdir().unwrap();
        let repo = dir.path().join("repo");
        let root = dir.path().join("proj");
        let jar = |g: &str, a: &str, v: &str, c: &str| {
            let mut p = repo.clone();
            p.extend(g.split('.'));
            p.push(a);
            p.push(v);
            std::fs::create_dir_all(&p).unwrap();
            p.push(format!("{a}-{v}{c}.jar"));
            std::fs::write(&p, b"").unwrap();
            p
        };
        let spring = jar("org.springframework", "spring-core", "6.1.0", "");
        let jcl = jar("org.springframework", "spring-jcl", "6.1.0", "");
        let fixtures = jar("com.acme", "fixtures", "1.0", "-tests");
        jar("org.springframework", "spring-jcl", "5.0.0", "");
        let dep = |g: &str, a: &str, v: &str| MavenDependency {
            group_id: g.into(),
            artifact_id: a.into(),
            version: Some(v.into()),
            kind: "jar".into(),
            scope: "compile".into(),
            ..Default::default()
        };
        let mut core = dep("org.springframework", "spring-core", "6.1.0");
        core.children.push(dep("org.springframework", "spring-jcl", "6.1.0"));
        let mut old = dep("org.springframework", "spring-jcl", "5.0.0");
        old.omitted = Some(Omission::Conflict);
        let mut tests = dep("com.acme", "fixtures", "1.0");
        tests.kind = "test-jar".into();
        let mut bom = dep("com.acme", "bom", "1.0");
        bom.kind = "pom".into();
        let model = ide_build::BuildModel {
            maven: Some(MavenModel {
                projects: vec![
                    MavenProject { dir: String::new(), ..Default::default() },
                    MavenProject { dir: "app".into(), dependencies: vec![core, old, tests, bom], ..Default::default() },
                ],
                synced_at: Some(1.0),
                ..Default::default()
            }),
            gradle: None,
        };
        let maven = model.maven.as_ref().unwrap();
        let module = maven_project(maven, &root, &root.join("app/src/main/java/A.java")).unwrap();
        assert_eq!(module.dir, "app");
        assert_eq!(maven_entries(maven, module, &repo).unwrap(), [spring, jcl, fixtures]);
        assert_eq!(maven_project(maven, &root, &root.join("pom.xml")).unwrap().dir, "");
        // Without a sync (static POMs only): the POMs' own class path is worked out instead.
        let mut unsynced = maven.clone();
        unsynced.synced_at = None;
        assert!(maven_entries(&unsynced, module, &repo).is_none());
    }

    #[test]
    fn first_open_class_path_comes_from_the_poms_per_module() {
        let dir = tempfile::tempdir().unwrap();
        let repo = dir.path().join("repo");
        let root = dir.path().join("proj");
        let jar = |a: &str| {
            let p = repo.join("x").join(a).join("1.0");
            std::fs::create_dir_all(&p).unwrap();
            std::fs::write(
                p.join(format!("{a}-1.0.pom")),
                format!("<project><groupId>x</groupId><artifactId>{a}</artifactId><version>1.0</version></project>"),
            )
            .unwrap();
            std::fs::write(p.join(format!("{a}-1.0.jar")), b"").unwrap();
            p.join(format!("{a}-1.0.jar"))
        };
        let (lib, other) = (jar("lib"), jar("other"));
        let pom = |deps: &str, art: &str| {
            format!(
                "<project><groupId>p</groupId><artifactId>{art}</artifactId><version>1</version><dependencies>{deps}</dependencies></project>"
            )
        };
        let dep = |a: &str| {
            format!("<dependency><groupId>x</groupId><artifactId>{a}</artifactId><version>1.0</version></dependency>")
        };
        std::fs::create_dir_all(root.join("app")).unwrap();
        std::fs::write(root.join("pom.xml"), pom(&dep("other"), "root")).unwrap();
        std::fs::write(root.join("app/pom.xml"), pom(&dep("lib"), "app")).unwrap();
        let maven = ide_build::maven::MavenModel {
            projects: vec![
                ide_build::maven::MavenProject {
                    pom: "pom.xml".into(),
                    artifact_id: "root".into(),
                    group_id: "p".into(),
                    ..Default::default()
                },
                ide_build::maven::MavenProject {
                    pom: "app/pom.xml".into(),
                    dir: "app".into(),
                    artifact_id: "app".into(),
                    group_id: "p".into(),
                    ..Default::default()
                },
            ],
            ..Default::default()
        };
        let engine = JavaEngine::new(&dir.path().join("cache"));
        let derive = |file: &str| {
            let path = root.join(file);
            let module = maven_project(&maven, &root, &path).unwrap();
            let entries = engine.static_entries(&maven, &root, &repo, module);
            engine.classpath_or(&path, None, Some(&root.join(&module.dir)), || Some(entries));
            (engine.stamp(&path), engine.static_entries(&maven, &root, &repo, module))
        };
        let (root_stamp, root_entries) = derive("src/main/java/R.java");
        assert_eq!(root_entries, [other]);
        // The root module's class path does not serve the files of its modules.
        let (app_stamp, app_entries) = derive("app/src/main/java/A.java");
        assert_eq!(app_entries, [lib]);
        assert_ne!(root_stamp, app_stamp);
        // jdtls's view replaces it.
        engine.record(root.join("app"), vec![], None, None);
        assert_ne!(engine.stamp(&root.join("app/src/main/java/A.java")), app_stamp);
    }

    #[test]
    fn modules_jdtls_has_not_described_see_their_own_sources_first() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path();
        let engine = JavaEngine::new(&p.join("cache"));
        engine.set_module_roots(vec![p.to_owned(), p.join("a"), p.join("b"), p.join("app")]);
        // app's class path (from its POM): b's output folder, not built yet.
        let app = p.join("app/src/main/java/App.java");
        engine.classpath_or(&app, None, Some(&p.join("app")), || Some(vec![p.join("b/target/classes")]));
        let v = engine.visibility(&app).unwrap();
        assert_eq!(v(&p.join("app/src/main/java/W.java")), Some(0));
        assert_eq!(v(&p.join("b/src/main/java/W.java")), Some(1));
        assert!(v(&p.join("a/src/main/java/W.java")).unwrap() > 1, "not on its class path: after the others");
        // A module without a class path yet: nothing to rank by.
        assert!(engine.visibility(&p.join("a/src/main/java/A.java")).is_none());
    }

    #[test]
    fn module_visibility_follows_the_class_path_order() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path();
        let engine = JavaEngine::new(&p.join("cache"));
        for m in ["a", "b", "c"] {
            engine.record(p.join(m), vec![], None, None);
        }
        engine.record(
            p.join("app"),
            vec![p.join("b/target/classes"), p.join("lib.jar"), p.join("a/target/classes")],
            None,
            None,
        );
        let v = engine.visibility(&p.join("app/src/main/java/App.java")).unwrap();
        assert_eq!(v(&p.join("app/src/main/java/X.java")), Some(0));
        assert_eq!(v(&p.join("b/src/main/java/X.java")), Some(1));
        assert_eq!(v(&p.join("a/src/main/java/X.java")), Some(3));
        assert_eq!(v(&p.join("c/src/main/java/X.java")), None, "not a dependency");
        assert!(engine.visibility(&p.join("elsewhere/X.java")).is_none());
    }
}
