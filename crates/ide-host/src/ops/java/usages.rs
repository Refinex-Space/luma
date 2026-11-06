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
const STORE_VERSION: u32 = 1;

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
}

fn short(hash: &[u8; 32]) -> u64 {
    u64::from_le_bytes(hash[..8].try_into().unwrap_or_default())
}

impl UsageCounts {
    pub fn new(cache_dir: &Path) -> Self {
        Self { file: cache_dir.join("java-usages.json"), store: Mutex::new(None) }
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

/// A batch of plans (their indices) with what JDT is asked for each: position, files to count.
type Batch = (Vec<usize>, Vec<(Pos, Option<Vec<PathBuf>>)>);
/// Per target, the counts per file (`None`: not a declaration JDT resolves).
type Counted = IdeResult<Vec<Option<HashMap<PathBuf, u32>>>>;

/// What one declaration needs.
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
        let lsp = project.lsp.clone();
        let batches: Vec<Batch> = todo
            .chunks(BATCH)
            .map(|chunk| {
                let targets =
                    chunk.iter().filter_map(|&i| plans[i].as_ref().map(|p| (p.pos, p.recount.clone()))).collect();
                (chunk.to_vec(), targets)
            })
            .collect();
        use futures::StreamExt;
        let results: Vec<(Vec<usize>, Counted)> =
            futures::stream::iter(batches.into_iter().map(|(indices, targets)| {
                let lsp = lsp.clone();
                let cancel = cancel.clone();
                async move { (indices, lsp.java_usage_counts(doc, &targets, cancel).await) }
            }))
            .buffer_unordered(PARALLEL)
            .collect()
            .await;
        // The declaring file's count is only kept for the text it was counted in.
        let unchanged = project.documents.snapshot(doc).is_ok_and(|d| d.version == version);
        let local_hash = short(blake3::hash(project.documents.snapshot(doc)?.text.as_bytes()).as_bytes());
        let mut first_error = None;
        project.java_usages.with(|store| {
            for (batch, result) in results {
                let rows = match result {
                    Ok(rows) => rows,
                    Err(e) => {
                        first_error.get_or_insert(e);
                        continue;
                    }
                };
                for (i, row) in batch.into_iter().zip(rows) {
                    let Some(p) = &plans[i] else { continue };
                    let Some(found) = row else {
                        store.entries.remove(&p.key);
                        continue;
                    };
                    let entry = store.entries.entry(p.key.clone()).or_default();
                    match &p.recount {
                        None => {
                            *entry = Entry { deps: p.deps, local: None, files: HashMap::new() };
                            for (f, hash) in &p.files {
                                entry.files.insert(f.clone(), (*hash, found.get(f).copied().unwrap_or(0)));
                            }
                            for (f, n) in &found {
                                if *f != path && !entry.files.contains_key(f) {
                                    entry.files.insert(f.clone(), (0, *n));
                                }
                            }
                            if unchanged {
                                entry.local = Some((local_hash, found.get(&path).copied().unwrap_or(0)));
                            }
                        }
                        Some(files) => {
                            entry.deps = p.deps;
                            let hashes: HashMap<&PathBuf, u64> = p.files.iter().map(|(f, h)| (f, *h)).collect();
                            for f in files {
                                let n = found.get(f).copied().unwrap_or(0);
                                if *f == path {
                                    if unchanged {
                                        entry.local = Some((local_hash, n));
                                    }
                                } else {
                                    entry.files.insert(f.clone(), (hashes.get(f).copied().unwrap_or(0), n));
                                }
                            }
                        }
                    }
                }
            }
        });
        if let Some(e) = first_error
            && e.kind != ide_core::error::ErrorKind::Cancelled
        {
            return Err(e);
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

/// What each declaration needs, and what is known of it now.
fn plan(project: &Project, path: &Path, text: &str, positions: &[Pos]) -> (Vec<Option<Plan>>, Vec<(Pos, UsageCount)>) {
    let scopes = project.index.java_usage_scopes(path, text, positions);
    // Other files with unsaved edits: the server counts their editor text.
    let unsaved: HashMap<PathBuf, u64> = project
        .documents
        .open_documents()
        .into_iter()
        .filter(|&d| project.documents.is_dirty(d).unwrap_or(false))
        .filter_map(|d| project.documents.snapshot(d).ok())
        .filter(|d| d.path.0 != path)
        .map(|d| (d.path.0, short(blake3::hash(d.text.as_bytes()).as_bytes())))
        .collect();
    let local_hash = short(blake3::hash(text.as_bytes()).as_bytes());
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
            let deps = project.index.java_dependency_hash(&scope.words) as u64;
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
