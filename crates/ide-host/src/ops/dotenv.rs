//! .env files support (bundled plugin): the files of a project that declare environment
//! variables — `.env` files, `docker-compose.yml` and Dockerfiles. The UI parses them.
//!
//! `.env` files are usually git-ignored, so the project index (which honours `.gitignore`)
//! misses them. Besides the indexed files, the folders that hold one (or a module manifest
//! such as `package.json`) and the roots are listed for `.env` files, ignored ones included.
use crate::Host;
use crate::rpc::Dispatcher;
use ide_core::{IdeResult, IpcPath};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

/// A file declaring environment variables, with its modification time (to re-read on change).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DotEnvSource {
    pub path: IpcPath,
    /// Milliseconds since the epoch; `None` when unknown.
    pub mtime_ms: Option<f64>,
}

/// Extensions after `.env.` that make a source file (`.env.d.ts`, `.env.js`), not an env file.
const CODE_EXTENSIONS: &[&str] =
    &["js", "mjs", "cjs", "ts", "mts", "cts", "json", "py", "php", "rb", "go", "rs", "sh", "yml", "yaml", "toml"];

/// `.env`, `.env.local`, `.env.example`, `prod.env`, `.flaskenv` (the `dotenv` language's files).
pub fn is_dotenv_name(name: &str) -> bool {
    if name == ".env" || name == ".flaskenv" {
        return true;
    }
    if let Some(rest) = name.strip_prefix(".env.") {
        let ext = rest.rsplit('.').next().unwrap_or(rest);
        return !rest.is_empty() && !CODE_EXTENSIONS.contains(&ext.to_ascii_lowercase().as_str());
    }
    name.len() > 4 && name.ends_with(".env")
}

/// `docker-compose.yml`, `docker-compose.prod.yaml`, `compose.yml`.
pub fn is_compose_name(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    let Some(stem) = lower.strip_suffix(".yml").or_else(|| lower.strip_suffix(".yaml")) else { return false };
    let rest = stem.strip_prefix("docker-").unwrap_or(stem);
    rest == "compose" || rest.starts_with("compose.") || rest.starts_with("compose-")
}

/// `Dockerfile`, `Dockerfile.dev`, `api.Dockerfile`, `Containerfile`.
pub fn is_dockerfile_name(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    lower == "dockerfile"
        || lower == "containerfile"
        || lower.starts_with("dockerfile.")
        || (lower.len() > 11 && lower.ends_with(".dockerfile"))
}

fn is_declaration_name(name: &str) -> bool {
    is_dotenv_name(name) || is_compose_name(name) || is_dockerfile_name(name)
}

/// Manifests of folders an application runs from (and loads its `.env` from).
const MODULE_MARKERS: &[&str] = &[
    "package.json",
    "composer.json",
    "artisan",
    "pyproject.toml",
    "requirements.txt",
    "setup.py",
    "manage.py",
    "Pipfile",
    "go.mod",
    "Gemfile",
    "Cargo.toml",
    "pom.xml",
    "build.gradle",
    "build.gradle.kts",
    "mix.exs",
    "pubspec.yaml",
    "Package.swift",
    "deno.json",
];

/// Folders listed for ignored `.env` files at most (a monorepo has a few dozen modules).
const MAX_LISTED_DIRS: usize = 2000;

fn mtime_ms(path: &Path) -> Option<f64> {
    let t = std::fs::metadata(path).ok()?.modified().ok()?;
    Some(t.duration_since(UNIX_EPOCH).ok()?.as_millis() as f64)
}

/// The declaration files among `indexed` (paths of indexed declaration files and module
/// manifests) plus the `.env` files of their folders and of `roots`, sorted.
pub fn collect_sources(roots: &[PathBuf], indexed: Vec<PathBuf>) -> Vec<DotEnvSource> {
    let mut files: BTreeSet<PathBuf> = BTreeSet::new();
    let mut dirs: BTreeSet<PathBuf> = roots.iter().cloned().collect();
    for path in indexed {
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else { continue };
        if let Some(dir) = path.parent() {
            dirs.insert(dir.to_path_buf());
        }
        if is_declaration_name(name) {
            files.insert(path);
        }
    }
    for dir in dirs.iter().take(MAX_LISTED_DIRS) {
        let Ok(entries) = std::fs::read_dir(dir) else { continue };
        for e in entries.flatten() {
            if e.file_name().to_str().is_some_and(is_dotenv_name) && e.file_type().is_ok_and(|t| t.is_file()) {
                files.insert(e.path());
            }
        }
    }
    files.into_iter().map(|p| DotEnvSource { mtime_ms: mtime_ms(&p), path: p.into() }).collect()
}

/// The project's files declaring environment variables.
pub async fn dotenv_files(host: &Host, window: &str) -> IdeResult<Vec<DotEnvSource>> {
    let project = host.project(window)?;
    let mut roots = vec![project.root.clone()];
    roots.extend(project.content_roots());
    let index = project.index.clone();
    host.blocking(move || {
        let indexed = index.files_named(|name| is_declaration_name(name) || MODULE_MARKERS.contains(&name));
        Ok(collect_sources(&roots, indexed))
    })
    .await
}

pub(crate) fn register(d: &mut Dispatcher) {
    d.add("dotenv_files", |c| async move { dotenv_files(&c.host, &c.window).await });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names() {
        for n in [".env", ".env.local", ".env.example", ".env.production.local", "prod.env", ".flaskenv"] {
            assert!(is_dotenv_name(n), "{n}");
        }
        for n in ["env", ".env.", ".env.d.ts", ".env.js", ".envrc", "environment.ts", ".env.json"] {
            assert!(!is_dotenv_name(n), "{n}");
        }
        for n in ["docker-compose.yml", "docker-compose.prod.yaml", "compose.yaml", "compose-dev.yml"] {
            assert!(is_compose_name(n), "{n}");
        }
        for n in ["composer.json", "composer.yml", "docker-compose.json", "decompose.yml"] {
            assert!(!is_compose_name(n), "{n}");
        }
        for n in ["Dockerfile", "Dockerfile.dev", "api.Dockerfile", "Containerfile", "app.dockerfile"] {
            assert!(is_dockerfile_name(n), "{n}");
        }
        for n in ["Dockerfiles", ".dockerfile", "dockerfile-notes.md"] {
            assert!(!is_dockerfile_name(n), "{n}");
        }
    }

    #[test]
    fn finds_ignored_env_files_next_to_modules() {
        let tmp = tempfile::tempdir().unwrap();
        let root = dunce::canonicalize(tmp.path()).unwrap();
        let write = |rel: &str| {
            let p = root.join(rel);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(&p, "A=1\n").unwrap();
            p
        };
        let env = write(".env");
        let example = write("api/.env.example");
        let api_env = write("api/.env");
        let manifest = write("web/package.json");
        let web_env = write("web/.env.local");
        let compose = write("docker-compose.yml");
        write("other/.env"); // no module, nothing indexed there
        write("web/.env.d.ts");
        let found: Vec<PathBuf> =
            collect_sources(std::slice::from_ref(&root), vec![example.clone(), manifest, compose.clone()])
                .into_iter()
                .map(|s| {
                    assert!(s.mtime_ms.is_some());
                    s.path.into_path_buf()
                })
                .collect();
        assert_eq!(found, vec![env, api_env, example, compose, web_env]);
    }
}
