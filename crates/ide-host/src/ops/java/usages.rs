//! "N usages" above Java declarations (IDEA's usages inlay), counted incrementally.
//!
//! A count is kept per referencing file: the declaring file itself, and every other file that
//! mentions one of the declaration's names (the structure index's identifier index, narrowed by
//! the declaration's accessibility). Each file's count is valid while its content hash is, and
//! while nothing it resolves against changed: the type hierarchy and the declarations sharing
//! one of the names (see `ProjectIndex::java_dependency_hash`). Opening a file shows the counts
//! known from any earlier session at once; only the files changed since are counted again, by
//! JDT, in one batched search per few declarations.
//!
//! Like IDEA (`UnusedSymbolUtil.processUsages`), a declaration whose name occurs in very many
//! files is costly to count; IDEA shows no count for it. Here the cheap ones are counted first
//! and the costly ones ([`UsagePass::Full`]) afterwards, one by one, then kept up to date
//! incrementally like the others.

use crate::Host;
use crate::Project;
use ide_core::{DocId, IdeError, IdeResult, Pos, RequestId};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

/// Files a declaration may be counted in during the cheap pass (IDEA counts none beyond 10).
const CHEAP_FILES: usize = 150;
/// Declarations per JDT search, and searches at once.
const BATCH: usize = 12;
const PARALLEL: usize = 3;
/// 2: counts follow IDEA's usages inlay (a method's override family), Luma's engine first.
const STORE_VERSION: u32 = 2;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum UsagePass {
    /// Only what is known: no search.
    Cached,
    /// Counts the declarations whose (re)count is cheap.
    Cheap,
    /// Counts every one.
    Full,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum UsageCountState {
    /// Up to date.
    Fresh,
    /// Known from before files changed; a recount is needed (`count` is the last one).
    Stale,
    /// Costly to count: left for a [`UsagePass::Full`] pass (`count` may be a stale one).
    Costly,
    /// Not a declaration the server resolves.
    None,
}

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct UsageCount {
    pub count: Option<u32>,
    pub state: UsageCountState,
}

impl UsageCount {
    const NONE: Self = Self { count: None, state: UsageCountState::None };
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
struct Entry {
    /// `java_dependency_hash` of the declaration's names when counted.
    deps: u64,
    /// Count in the declaring file, for its text hash.
    local: Option<(u64, u32)>,
    /// Counts in other files, for their content hash (0: a file outside the index).
    files: HashMap<PathBuf, (u64, u32)>,
}

impl Entry {
    fn total(&self) -> Option<u32> {
        let local = self.local?.1;
        Some(local + self.files.values().map(|(_, n)| n).sum::<u32>())
    }
}

#[derive(Default, Serialize, Deserialize)]
struct Store {
    version: u32,
    /// `<declaring file>\n<declaration key>` → counts.
    entries: HashMap<String, Entry>,
}

/// The counts of a project, persisted in its cache folder.
pub struct UsageCounts {
    file: PathBuf,
    store: Mutex<Option<Store>>,
    /// Declarations JDT is counting in the background (their keys).
    inflight: Mutex<std::collections::HashSet<String>>,
}

fn short(hash: &[u8; 32]) -> u64 {
    u64::from_le_bytes(hash[..8].try_into().unwrap_or_default())
}

impl UsageCounts {
    pub fn new(cache_dir: &Path) -> Self {
        Self { file: cache_dir.join("java-usages.json"), store: Mutex::new(None), inflight: Mutex::default() }
    }

    fn with<R>(&self, f: impl FnOnce(&mut Store) -> R) -> R {
        let mut guard = self.store.lock();
        let store = guard.get_or_insert_with(|| {
            std::fs::read(&self.file)
                .ok()
                .and_then(|b| serde_json::from_slice::<Store>(&b).ok())
                .filter(|s| s.version == STORE_VERSION)
                .unwrap_or(Store { version: STORE_VERSION, entries: HashMap::new() })
        });
        f(store)
    }

    fn save(&self) {
        let bytes = self.with(|s| serde_json::to_vec(s));
        let Ok(bytes) = bytes else { return };
        let tmp = self.file.with_extension("json.tmp");
        let result = self
            .file
            .parent()
            .map_or(Ok(()), std::fs::create_dir_all)
            .and_then(|_| std::fs::write(&tmp, bytes))
            .and_then(|_| std::fs::rename(&tmp, &self.file));
        if let Err(e) = result {
            tracing::debug!("java usage counts: cannot save {}: {e}", self.file.display());
        }
    }
}

/// Per declaration (plan index): the files counted (`None`: all of its scope) and the counts per
/// file (`None`: not a declaration the server resolves).
type CountRow = (usize, Option<Vec<PathBuf>>, Option<HashMap<PathBuf, u32>>);
/// Engine counts of one file: per query, the count when decided.
type FileCounts = (PathBuf, Vec<(usize, Option<u32>)>);

/// Per target, the counts per file (`None`: not a declaration JDT resolves).
type Counted = IdeResult<Vec<Option<HashMap<PathBuf, u32>>>>;

/// What one declaration needs.
#[derive(Clone, Debug)]
struct Plan {
    key: String,
    pos: Pos,
    deps: u64,
    /// Files of the scope with their content hash.
    files: Vec<(PathBuf, u64)>,
    /// `None`: a whole count; else the files to recount (the declaring file among them when its
    /// own count is out of date).
    recount: Option<Vec<PathBuf>>,
    cost: usize,
}

/// Usage counts of the Java declarations named at `positions` in `doc` (see the module docs).
pub async fn java_usage_counts(
    host: &Host,
    window: &str,
    request: RequestId,
    doc: DocId,
    positions: Vec<Pos>,
    pass: UsagePass,
) -> IdeResult<Vec<UsageCount>> {
    let project = host.project(window)?;
    let cancel = host.begin_request(request);
    let result = count(&project, doc, positions, pass, cancel).await;
    host.end_request(request);
    result
}

async fn count(
    project: &Arc<Project>,
    doc: DocId,
    positions: Vec<Pos>,
    pass: UsagePass,
    cancel: ide_core::CancellationToken,
) -> IdeResult<Vec<UsageCount>> {
    let info = project.documents.snapshot(doc)?;
    if info.language.as_str() != "java" {
        return Err(IdeError::new(ide_core::error::ErrorKind::Unavailable, "usage counts are for Java files"));
    }
    let path: PathBuf = info.path.0.clone();
    let version = info.version;
    let declaring_text = info.text.clone();
    let (plans, mut out) = {
        let project = project.clone();
        let path = path.clone();
        super::super::doc::blocking(move || Ok(plan(&project, &path, &info.text, &positions))).await?
    };
    let plans: Vec<Option<Plan>> = plans;
    let todo: Vec<usize> = plans
        .iter()
        .enumerate()
        .filter_map(|(i, p)| Some((i, p.as_ref()?)))
        .filter(|(_, p)| p.recount.as_ref().is_none_or(|r| !r.is_empty()))
        .filter(|(_, p)| match pass {
            UsagePass::Cached => false,
            UsagePass::Cheap => p.cost <= CHEAP_FILES,
            UsagePass::Full => true,
        })
        .map(|(i, _)| i)
        .collect();
    if !todo.is_empty() {
        // Luma's engine first: a file whose every occurrence it decides is counted in process;
        // files with undecided occurrences (and declarations it cannot resolve) go to JDT.
        let engine_items: Vec<(usize, Pos, Vec<PathBuf>)> = todo
            .iter()
            .filter_map(|&i| {
                let p = plans[i].as_ref()?;
                let files = match &p.recount {
                    Some(r) => r.clone(),
                    None => p.files.iter().map(|(f, _)| f.clone()).chain(std::iter::once(path.clone())).collect(),
                };
                Some((i, p.pos, files))
            })
            .collect();
        let engine: HashMap<usize, EngineCount> = {
            let (project, path, text) = (project.clone(), path.clone(), declaring_text.clone());
            let cancel = cancel.clone();
            super::super::doc::blocking(move || Ok(engine_counts(&project, &path, &text, &engine_items, &cancel)))
                .await
                .unwrap_or_default()
        };
        if cancel.is_cancelled() {
            return Err(IdeError::cancelled());
        }
        // Learn the module's class path from jdtls for the next passes (library types decide
        // more occurrences), without waiting for it.
        if !project.java_engine.fresh(&path) {
            let (project, path) = (project.clone(), path.clone());
            tokio::spawn(async move {
                project.java_engine.refresh(&project.lsp, &path).await;
            });
        }
        // The modules of files left undecided may be undescribed yet: learn their class paths
        // (the next pass decides more of them).
        let undecided: Vec<PathBuf> = engine.values().flat_map(|ec| ec.undecided.iter().cloned()).collect();
        project.java_engine.refresh_all(project.lsp.clone(), undecided);
        // What JDT must count: files with undecided occurrences, and declarations the engine
        // could not resolve.
        let jdt: Vec<(Plan, Option<Vec<PathBuf>>, bool)> = todo
            .iter()
            .filter_map(|&i| {
                let p = plans[i].as_ref()?;
                match engine.get(&i) {
                    None => Some((p.clone(), p.recount.clone(), false)),
                    Some(ec) if ec.undecided.is_empty() => None,
                    Some(ec) => Some((p.clone(), Some(ec.undecided.clone()), true)),
                }
            })
            .collect();
        // The engine's counts now: decided files are stored at once, the rest stays stale
        // until JDT has counted it in the background.
        let rows: Vec<CountRow> = todo
            .iter()
            .filter_map(|&i| {
                let p = plans[i].as_ref()?;
                let ec = engine.get(&i)?;
                let counted = if p.recount.is_none() && ec.undecided.is_empty() {
                    None
                } else {
                    Some(ec.decided.keys().cloned().collect())
                };
                Some((i, counted, Some(ec.decided.clone())))
            })
            .collect();
        // The declaring file's count is only kept for the text it was counted in.
        let unchanged = project.documents.snapshot(doc).is_ok_and(|d| d.version == version);
        let local_hash = short(blake3::hash(project.documents.snapshot(doc)?.text.as_bytes()).as_bytes());
        project.java_usages.with(|store| {
            for (i, counted, found) in rows {
                if let Some(p) = &plans[i] {
                    apply_row(store, p, counted.as_deref(), found, &path, unchanged.then_some(local_hash));
                }
            }
        });
        if !jdt.is_empty() {
            count_with_jdt(project.clone(), doc, path.clone(), version, jdt);
        }
        if cancel.is_cancelled() {
            return Err(IdeError::cancelled());
        }
        let counts = project.clone();
        let _ = super::super::doc::blocking(move || {
            counts.java_usages.save();
            Ok(())
        })
        .await;
        // Answer from the store as updated.
        let project = project.clone();
        let positions: Vec<Pos> = out.iter().map(|(p, _)| *p).collect();
        let text = project.documents.snapshot(doc)?.text;
        out = super::super::doc::blocking(move || Ok(plan(&project, &path, &text, &positions).1)).await?;
    }
    Ok(out.into_iter().map(|(_, c)| c).collect())
}

/// Stores what was counted for plan `p`: `counted` the files counted (`None`: all of its
/// scope), `found` the counts per file (`None`: not a declaration).
fn apply_row(
    store: &mut Store,
    p: &Plan,
    counted: Option<&[PathBuf]>,
    found: Option<HashMap<PathBuf, u32>>,
    path: &Path,
    local_hash: Option<u64>,
) {
    let Some(found) = found else {
        store.entries.remove(&p.key);
        return;
    };
    let entry = store.entries.entry(p.key.clone()).or_default();
    match counted {
        None => {
            *entry = Entry { deps: p.deps, local: None, files: HashMap::new() };
            for (f, hash) in &p.files {
                entry.files.insert(f.clone(), (*hash, found.get(f).copied().unwrap_or(0)));
            }
            for (f, n) in &found {
                if f != path && !entry.files.contains_key(f) {
                    entry.files.insert(f.clone(), (0, *n));
                }
            }
            if let Some(h) = local_hash {
                entry.local = Some((h, found.get(path).copied().unwrap_or(0)));
            }
        }
        Some(files) => {
            entry.deps = p.deps;
            let hashes: HashMap<&PathBuf, u64> = p.files.iter().map(|(f, h)| (f, *h)).collect();
            for f in files {
                let n = found.get(f).copied().unwrap_or(0);
                if f == path {
                    if let Some(h) = local_hash {
                        entry.local = Some((h, n));
                    }
                } else {
                    entry.files.insert(f.clone(), (hashes.get(f).copied().unwrap_or(0), n));
                }
            }
        }
    }
}

/// Counts with JDT, in the background, what the engine left undecided: `jobs` are (plan,
/// files to count — `None` for all, whether the engine counted the rest). The store is updated
/// and the editors asked to refresh their usage lenses when done. A declaration already being
/// counted is not counted twice; a failure (jdtls not running) leaves the counts stale, to be
/// tried again on the next pass.
fn count_with_jdt(
    project: Arc<Project>,
    doc: DocId,
    path: PathBuf,
    version: u32,
    jobs: Vec<(Plan, Option<Vec<PathBuf>>, bool)>,
) {
    let jobs: Vec<(Plan, Option<Vec<PathBuf>>, bool)> = {
        let mut inflight = project.java_usages.inflight.lock();
        jobs.into_iter().filter(|(p, _, _)| inflight.insert(p.key.clone())).collect()
    };
    if jobs.is_empty() {
        return;
    }
    tokio::spawn(async move {
        use futures::StreamExt;
        let cancel = ide_core::CancellationToken::new();
        let lsp = project.lsp.clone();
        let batches: Vec<Vec<usize>> =
            (0..jobs.len()).collect::<Vec<_>>().chunks(BATCH).map(<[usize]>::to_vec).collect();
        let results: Vec<(Vec<usize>, Counted)> = futures::stream::iter(batches.into_iter().map(|indices| {
            let targets: Vec<(Pos, Option<Vec<PathBuf>>)> =
                indices.iter().map(|&j| (jobs[j].0.pos, jobs[j].1.clone())).collect();
            let (lsp, cancel) = (lsp.clone(), cancel.clone());
            async move { (indices, lsp.java_usage_counts(doc, &targets, cancel).await) }
        }))
        .buffer_unordered(PARALLEL)
        .collect()
        .await;
        let unchanged = project.documents.snapshot(doc).is_ok_and(|d| d.version == version);
        let local_hash = project
            .documents
            .snapshot(doc)
            .ok()
            .map(|d| short(blake3::hash(d.text.as_bytes()).as_bytes()))
            .filter(|_| unchanged);
        let mut learned = false;
        project.java_usages.with(|store| {
            for (indices, result) in results {
                let Ok(rows) = result else { continue };
                for (j, row) in indices.into_iter().zip(rows) {
                    let (plan, files, engine_counted) = &jobs[j];
                    match (row, engine_counted) {
                        // JDT says it is no declaration, but the engine resolved it: keep the engine's.
                        (None, true) => {}
                        (row, _) => {
                            apply_row(store, plan, files.as_deref(), row, &path, local_hash);
                            learned = true;
                        }
                    }
                }
            }
        });
        {
            let mut inflight = project.java_usages.inflight.lock();
            for (p, _, _) in &jobs {
                inflight.remove(&p.key);
            }
        }
        if learned {
            let counts = project.clone();
            let _ = tokio::task::spawn_blocking(move || counts.java_usages.save()).await;
            project.sink.emit(ide_core::IdeEvent::LspRefresh {
                server: ide_core::ServerId(0),
                kind: ide_core::event::LspRefreshKind::CodeLens,
            });
        }
    });
}

/// What Luma's engine decided about one declaration: counts of the files where every
/// occurrence was decided, and the files left to JDT.
#[derive(Clone, Debug, Default)]
struct EngineCount {
    decided: HashMap<PathBuf, u32>,
    undecided: Vec<PathBuf>,
}

/// The byte offset of `pos` (UTF-16 column) in `text`.
pub(crate) fn byte_of(text: &str, pos: Pos) -> Option<usize> {
    let mut line_start = 0;
    for _ in 0..pos.line {
        line_start += text[line_start..].find('\n')? + 1;
    }
    let line = &text[line_start..];
    let mut units = 0u32;
    for (i, c) in line.char_indices() {
        if units >= pos.col || c == '\n' {
            return Some(line_start + i);
        }
        units += c.len_utf16() as u32;
    }
    Some(line_start + line.len())
}

/// The open Java files with unsaved edits but `except`: path and editor text.
pub(crate) fn unsaved_java(project: &Project, except: &Path) -> Vec<(PathBuf, String)> {
    project
        .documents
        .open_documents()
        .into_iter()
        .filter(|&d| project.documents.is_dirty(d).unwrap_or(false))
        .filter_map(|d| project.documents.snapshot(d).ok())
        .filter(|d| d.path.0 != except && d.path.0.extension().is_some_and(|e| e == "java"))
        .map(|d| (d.path.0, d.text))
        .collect()
}

/// Counts usages of the declarations at `items` (plan index, position, files to count) with
/// Luma's engine. Declarations it cannot resolve are left out (JDT counts them).
fn engine_counts(
    project: &Project,
    path: &Path,
    text: &str,
    items: &[(usize, Pos, Vec<PathBuf>)],
    cancel: &ide_core::CancellationToken,
) -> HashMap<usize, EngineCount> {
    use ide_java::model::Model;
    use ide_java::resolve::FileAnalysis;
    use ide_java::search::UsageQuery;
    use rayon::prelude::*;
    let cp = crate::java_engine::classpath_for(project, path);
    let visibility = project.java_engine.visibility(path);
    crate::java_engine::warm_classpaths(project, items.iter().flat_map(|(_, _, files)| files));
    // Open files with unsaved edits: analyzed from their editor text, their declarations too.
    let unsaved = unsaved_java(project, path);
    let unsaved_text: HashMap<&Path, &str> = unsaved.iter().map(|(p, t)| (p.as_path(), t.as_str())).collect();
    project
        .index
        .with_java_edits(path, text, &unsaved, |view| {
            let Some(me) = view.overlay_file() else { return HashMap::new() };
            let Some(tree) = ide_java::parse(text) else { return HashMap::new() };
            let model = Model::new(view, &cp).with_visibility(visibility.clone());
            let fa = FileAnalysis::new(&model, &tree, text, me);
            let queries: Vec<(usize, UsageQuery, &[PathBuf])> = items
                .iter()
                .filter_map(|(i, pos, files)| {
                    let ident = fa.identifier_at(byte_of(text, *pos)?)?;
                    let target = fa.declared_target(ident)?;
                    Some((*i, UsageQuery::new(&model, &target, true), files.as_slice()))
                })
                .collect();
            let mut by_file: HashMap<&PathBuf, Vec<usize>> = HashMap::new();
            for (qi, (_, _, files)) in queries.iter().enumerate() {
                for f in *files {
                    by_file.entry(f).or_default().push(qi);
                }
            }
            let per_file: Vec<FileCounts> = by_file
                .into_par_iter()
                .map(|(f, qs)| {
                    let undecided = |qs: &[usize]| qs.iter().map(|&q| (q, None)).collect::<Vec<_>>();
                    if cancel.is_cancelled() {
                        return (f.clone(), undecided(&qs));
                    }
                    let (file_text, slot) = if f == path {
                        (std::borrow::Cow::Borrowed(text), Some(me))
                    } else if let Some(t) = unsaved_text.get(f.as_path()) {
                        (std::borrow::Cow::Borrowed(*t), view.file_slot(f))
                    } else {
                        let Ok(t) = std::fs::read_to_string(f) else { return (f.clone(), undecided(&qs)) };
                        // The index must describe this text.
                        let hash = *blake3::hash(t.as_bytes()).as_bytes();
                        if view.indexed_hash(f) != Some(hash) {
                            return (f.clone(), undecided(&qs));
                        }
                        (std::borrow::Cow::Owned(t), view.file_slot(f))
                    };
                    let (Some(slot), Some(tree)) = (slot, ide_java::parse(&file_text)) else {
                        return (f.clone(), undecided(&qs));
                    };
                    // Each file with its own module's class path and visibility (IDEA resolves a
                    // file in its module's scope).
                    let file_cp = if f == path { cp.clone() } else { crate::java_engine::classpath_for(project, f) };
                    let file_visibility =
                        if f == path { visibility.clone() } else { project.java_engine.visibility(f) };
                    let model = Model::new(view, &file_cp).with_visibility(file_visibility);
                    let fa = FileAnalysis::new(&model, &tree, &file_text, slot);
                    let counts = qs
                        .iter()
                        .map(|&q| {
                            let u = fa.usages(&queries[q].1);
                            (q, u.decided().then_some(u.usages.len() as u32))
                        })
                        .collect();
                    (f.clone(), counts)
                })
                .collect();
            let mut out: HashMap<usize, EngineCount> =
                queries.iter().map(|(i, _, _)| (*i, EngineCount::default())).collect();
            for (f, counts) in per_file {
                for (q, n) in counts {
                    let e = out.entry(queries[q].0).or_default();
                    match n {
                        Some(n) => {
                            e.decided.insert(f.clone(), n);
                        }
                        None => e.undecided.push(f.clone()),
                    }
                }
            }
            out
        })
        .unwrap_or_default()
}

/// What each declaration needs, and what is known of it now.
fn plan(project: &Project, path: &Path, text: &str, positions: &[Pos]) -> (Vec<Option<Plan>>, Vec<(Pos, UsageCount)>) {
    // Other files with unsaved edits: counted by their editor text (which may mention names
    // their saved text does not).
    let edits = unsaved_java(project, path);
    let scopes = project.index.java_usage_scopes(path, text, &edits, positions);
    let unsaved: HashMap<PathBuf, u64> =
        edits.iter().map(|(p, t)| (p.clone(), short(blake3::hash(t.as_bytes()).as_bytes()))).collect();
    let local_hash = short(blake3::hash(text.as_bytes()).as_bytes());
    let classpath = crate::java_engine::classpath_stamp(project, path);
    let prefix = format!("{}\n", path.display());
    project.java_usages.with(|store| {
        let mut plans = Vec::new();
        let mut out = Vec::new();
        for (&pos, scope) in positions.iter().zip(scopes) {
            let Some(scope) = scope else {
                plans.push(None);
                out.push((pos, UsageCount::NONE));
                continue;
            };
            let key = format!("{prefix}{}", scope.key);
            // What the count depends on: the declarations it resolves against, and the class
            // path it was resolved with.
            let deps = project.index.java_dependency_hash(&scope.words) as u64 ^ classpath;
            let files: Vec<(PathBuf, u64)> = scope
                .files
                .iter()
                .map(|(f, h)| (f.clone(), unsaved.get(f).copied().unwrap_or_else(|| short(h))))
                .collect();
            let entry = store.entries.get_mut(&key);
            let (recount, count) = match entry {
                Some(e) if e.deps == deps => {
                    // Files that no longer mention a name have no usage left.
                    let current: HashMap<&PathBuf, u64> = files.iter().map(|(f, h)| (f, *h)).collect();
                    e.files.retain(|f, (h, _)| *h == 0 || current.contains_key(f));
                    let mut stale: Vec<PathBuf> = files
                        .iter()
                        .filter(|(f, h)| e.files.get(f).is_none_or(|(old, _)| old != h))
                        .map(|(f, _)| f.clone())
                        .collect();
                    if e.local.is_none_or(|(h, _)| h != local_hash) {
                        stale.push(path.to_owned());
                    }
                    (Some(stale), e.total())
                }
                Some(e) => (None, e.total()),
                None => (None, None),
            };
            let cost = match &recount {
                Some(r) => r.len(),
                None if scope.local => 1,
                None => files.len() + 1,
            };
            // A private declaration is counted in its file only.
            let recount = match recount {
                None if scope.local => Some(vec![path.to_owned()]),
                r => r,
            };
            let state = match &recount {
                Some(r) if r.is_empty() => UsageCountState::Fresh,
                _ if cost > CHEAP_FILES => UsageCountState::Costly,
                _ => UsageCountState::Stale,
            };
            out.push((pos, UsageCount { count, state }));
            plans.push(Some(Plan { key, pos, deps, files, recount, cost }));
        }
        (plans, out)
    })
}

#[cfg(test)]
mod engine_tests {
    use super::*;
    use crate::{Host, HostConfig};
    use std::time::Duration;

    #[tokio::test(flavor = "multi_thread")]
    async fn the_engine_counts_without_a_language_server() {
        let temp = tempfile::tempdir().unwrap();
        let base = dunce::canonicalize(temp.path()).unwrap();
        let root = base.join("project");
        let src = root.join("src/main/java/s");
        std::fs::create_dir_all(&src).unwrap();
        let files = [
            // Project types only: no JDK is assumed here (a signature with a type the engine
            // does not know cannot be compared, which leaves occurrences undecided).
            ("Order.java", "package s; public class Order {}"),
            ("Service.java", "package s; public interface Service { void place(Order o); }"),
            ("Impl.java", "package s;\npublic class Impl implements Service {\n  public void place(Order o) {}\n}\n"),
            ("Other.java", "package s; public class Other implements Service { public void place(Order o) {} }"),
            (
                "Use.java",
                "package s; class Use { void m(Service s, Impl i, Other o, Order x) { s.place(x); i.place(x); o.place(x); } }",
            ),
            (
                "Bean.java",
                "package s;\npublic class Bean {\n  private int size;\n  public int getSize() { return size; }\n  public void setSize(int s) { size = s; }\n}\n",
            ),
            ("BeanUse.java", "package s; class BeanUse { void m(Bean b) { b.setSize(b.getSize() + 1); } }"),
        ];
        for (name, text) in files {
            std::fs::write(src.join(name), text).unwrap();
        }
        let host = Host::new(HostConfig {
            config_dir: base.join("config"),
            data_dir: base.join("data"),
            local_data_dir: base.join("data"),
            languages: Arc::new(ide_language::LanguageRegistry::load(None).unwrap()),
            syntax: Arc::default(),
            sink_for: Box::new(|_| Arc::new(ide_core::NullSink)),
            owner: |w| w,
            runtime: tokio::runtime::Handle::current(),
            project_environment: false,
        });
        let project = host.open_project("main", &root).unwrap();
        assert!(project.index.wait_idle(Duration::from_secs(30)));
        let all: Vec<PathBuf> = files.iter().map(|(n, _)| src.join(n)).collect();
        let cancel = ide_core::CancellationToken::new();

        let impl_path = src.join("Impl.java");
        let text = std::fs::read_to_string(&impl_path).unwrap();
        let counts = engine_counts(&project, &impl_path, &text, &[(0, Pos::new(2, 14), all.clone())], &cancel);
        let c = &counts[&0];
        assert!(c.undecided.is_empty(), "undecided: {:?}", c.undecided);
        // IDEA's inlay: every call of the family rooted at Service.place.
        assert_eq!(c.decided[&src.join("Use.java")], 3);
        assert_eq!(c.decided[&impl_path], 0);

        let bean = src.join("Bean.java");
        let text = std::fs::read_to_string(&bean).unwrap();
        let counts = engine_counts(&project, &bean, &text, &[(7, Pos::new(2, 14), all)], &cancel);
        let c = &counts[&7];
        assert!(c.undecided.is_empty(), "undecided: {:?}", c.undecided);
        // The field in its accessors, and the accessor calls.
        assert_eq!(c.decided[&bean], 2);
        assert_eq!(c.decided[&src.join("BeanUse.java")], 2);
        assert_eq!(c.decided[&src.join("Use.java")], 0);

        assert_eq!(byte_of("ab\ncd😀e", Pos::new(1, 4)), Some(9));

        // Find Usages: the same usages, with the field's read / write classification.
        let text = std::fs::read_to_string(&bean).unwrap();
        let refs = super::super::find::engine_find_usages(&project, &bean, &text, Pos::new(2, 14), false).unwrap();
        assert_eq!(refs.locations.len(), 4);
        let mut kinds: Vec<String> = refs
            .classified
            .iter()
            .map(|c| {
                format!("{:?}/{:?}@{}", c.kind, c.access, c.location.path.0.file_name().unwrap().to_string_lossy())
            })
            .collect();
        kinds.sort();
        assert_eq!(
            kinds,
            [
                "Field/Some(Read)@Bean.java",
                "Field/Some(Write)@Bean.java",
                "Getter/Some(Read)@BeanUse.java",
                "Setter/Some(Write)@BeanUse.java",
            ]
        );
        let text = std::fs::read_to_string(&impl_path).unwrap();
        let refs = super::super::find::engine_find_usages(&project, &impl_path, &text, Pos::new(2, 14), false).unwrap();
        assert_eq!(refs.locations.len(), 3, "the inlay's three usages");
        assert!(refs.classified.is_empty());

        // Go to Definition from a use in another file.
        let use_path = src.join("BeanUse.java");
        let text = std::fs::read_to_string(&use_path).unwrap();
        let at = text.find("getSize").unwrap();
        let loc = super::super::find::engine_definition(&project, &use_path, &text, Pos::new(0, at as u32)).unwrap();
        assert_eq!(loc.path.0, bean);
        assert_eq!(loc.range.start, Pos::new(3, 13));

        // Unsaved edits in other open files are counted from their editor text (IDEA's PSI of
        // every open document), not handed to the language server: BeanUse gains a call and a
        // new unsaved subtype of Service in Use.java calls place() once more.
        let bean_use = project.documents.open(&use_path).unwrap();
        project
            .documents
            .replace_all(
                bean_use.id,
                "package s; class BeanUse { void m(Bean b) { b.setSize(b.getSize() + b.getSize()); } }",
            )
            .unwrap();
        let use_doc = project.documents.open(&src.join("Use.java")).unwrap();
        project
            .documents
            .replace_all(
                use_doc.id,
                "package s; class Use { void m(Service s, Impl i, Other o, Order x) { s.place(x); i.place(x); o.place(x); new Late().place(x); } }\nclass Late implements Service { public void place(Order o) {} }",
            )
            .unwrap();
        let text = std::fs::read_to_string(&bean).unwrap();
        let all: Vec<PathBuf> = files.iter().map(|(n, _)| src.join(n)).collect();
        let counts = engine_counts(&project, &bean, &text, &[(7, Pos::new(2, 14), all.clone())], &cancel);
        let c = &counts[&7];
        assert!(c.undecided.is_empty(), "undecided: {:?}", c.undecided);
        assert_eq!(c.decided[&src.join("BeanUse.java")], 3);
        let text = std::fs::read_to_string(&impl_path).unwrap();
        let counts = engine_counts(&project, &impl_path, &text, &[(0, Pos::new(2, 14), all)], &cancel);
        assert!(counts[&0].undecided.is_empty(), "undecided: {:?}", counts[&0].undecided);
        assert_eq!(counts[&0].decided[&src.join("Use.java")], 4);
        // Stored counts depend on the editor text of the files in scope.
        let (plans, _) = plan(&project, &impl_path, &text, &[Pos::new(2, 14)]);
        let use_text = project.documents.snapshot(use_doc.id).unwrap().text;
        let in_scope = plans[0].as_ref().unwrap().files.iter().find(|(f, _)| *f == src.join("Use.java")).map(|f| f.1);
        assert_eq!(in_scope, Some(short(blake3::hash(use_text.as_bytes()).as_bytes())));
        let refs = super::super::find::engine_find_usages(&project, &impl_path, &text, Pos::new(2, 14), false).unwrap();
        assert_eq!(refs.locations.len(), 4, "Find Usages sees the unsaved call too");
    }
}
