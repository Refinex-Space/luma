//! Lombok (bundled plugin): the agent jdtls runs with and Delombok, which runs the
//! Lombok jar's own `delombok` on editor text.
use crate::Host;
use crate::ops::project::settings;
use crate::ops::tools::join_err;
use crate::rpc::Dispatcher;
use ide_core::{IdeError, IdeResult, RequestId};
use ide_sdk::lombok::LombokAgent;
use ide_tools::Method;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::path::{Path, PathBuf};
use std::process::Stdio;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct LombokAgentInfo {
    pub path: String,
    /// `1.18.48`; `None` when the jar's name doesn't say.
    pub version: Option<String>,
    /// `bundled`, `custom` (Lombok settings), `vmArgs` (jdtls' VM options) or `cache` (Maven / Gradle).
    pub source: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct LombokStatus {
    pub enabled: bool,
    /// The agent jdtls runs with; `None` without one.
    pub agent: Option<LombokAgentInfo>,
    /// The project uses Lombok (its build, an inherited parent, `lombok.config`, imports).
    pub uses_lombok: bool,
    /// Why Lombok-generated members may be missing in the editor.
    pub problem: Option<String>,
    /// The Lombok version bundled with Luma (`1.18.48-luma.2`).
    pub bundled_version: String,
    /// `lombok.config` files of the project, relative to its root.
    pub config_files: Vec<String>,
}

/// A source file for Delombok: its path (for its package directory) and editor text.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DelombokInput {
    pub path: String,
    pub text: String,
}

/// Delombok's output of one file, or why there is none.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DelombokOutput {
    pub path: String,
    pub text: Option<String>,
    pub error: Option<String>,
}

fn bundled_version() -> String {
    match ide_tools::registry::find("lombok").map(|s| &s.method) {
        Some(Method::Bundled { version, .. }) => (*version).to_owned(),
        _ => String::new(),
    }
}

/// Directories never holding a project's own `lombok.config`.
const SKIP: [&str; 7] = ["target", "build", "node_modules", "out", "bin", ".gradle", ".git"];

fn config_files(root: &Path) -> Vec<String> {
    fn walk(root: &Path, dir: &Path, depth: usize, out: &mut Vec<String>) {
        let Ok(entries) = std::fs::read_dir(dir) else { return };
        for e in entries.flatten() {
            if out.len() >= 50 {
                return;
            }
            let name = e.file_name().to_string_lossy().into_owned();
            let Ok(ty) = e.file_type() else { continue };
            if ty.is_dir() {
                if depth > 0 && !name.starts_with('.') && !SKIP.contains(&name.as_str()) {
                    walk(root, &e.path(), depth - 1, out);
                }
            } else if name == "lombok.config" {
                let rel = e.path().strip_prefix(root).map(Path::to_path_buf).unwrap_or_else(|_| e.path());
                out.push(rel.to_string_lossy().replace('\\', "/"));
            }
        }
    }
    let mut out = Vec::new();
    walk(root, root, 8, &mut out);
    out.sort();
    out
}

/// The Lombok jar of the project's settings: the custom one, else the bundled one (installed on demand).
fn lombok_jar(data_dir: &Path, custom: &str) -> IdeResult<PathBuf> {
    match custom.trim() {
        "" => ide_tools::managed_bundle(data_dir, "lombok")
            .ok_or_else(|| IdeError::not_found("the bundled Lombok jar could not be installed")),
        jar if Path::new(jar).is_file() => Ok(PathBuf::from(jar)),
        jar => Err(IdeError::not_found(format!(
            "Lombok jar {jar} does not exist; choose another in Settings › Languages & Frameworks › Lombok"
        ))),
    }
}

/// The agent jdtls runs with, whether the project uses Lombok and its `lombok.config` files.
pub async fn lombok_status(host: &Host, window: &str) -> IdeResult<LombokStatus> {
    let s = settings(host, window);
    let root = host.project(window)?.root.clone();
    let data_dir = host.local_data_dir.clone();
    tokio::task::spawn_blocking(move || {
        let own = ide_sdk::lombok::agent_in_args(s.languages.java.jdtls_vm_args.split_whitespace());
        let managed = if s.lombok.enabled && s.lombok.agent_path.trim().is_empty() {
            ide_tools::managed_bundle(&data_dir, "lombok")
        } else {
            None
        };
        let source = if own.is_some() {
            "vmArgs"
        } else if !s.lombok.agent_path.trim().is_empty() {
            "custom"
        } else if managed.is_some() {
            "bundled"
        } else {
            "cache"
        };
        let repo = ide_sdk::apply::maven_local_repository(&root, &s);
        let agent = ide_sdk::lombok::configured_agent(
            &root,
            s.lombok.enabled,
            &s.lombok.agent_path,
            own,
            managed,
            repo.clone(),
        );
        let bundled = bundled_version();
        let info = match &agent {
            LombokAgent::Found { jar, version } => Some(LombokAgentInfo {
                path: jar.to_string_lossy().into_owned(),
                version: version.clone().or_else(|| (source == "bundled").then(|| bundled.clone())),
                source: source.to_owned(),
            }),
            _ => None,
        };
        let uses_lombok = match agent {
            LombokAgent::Unused => false,
            LombokAgent::Missing | LombokAgent::Disabled => true,
            // An agent is attached whether or not the project needs it.
            LombokAgent::Found { .. } => ide_sdk::lombok::uses_lombok(&root, repo.as_deref()),
        };
        LombokStatus {
            enabled: s.lombok.enabled,
            problem: agent.problem(),
            agent: info,
            uses_lombok,
            bundled_version: bundled,
            config_files: config_files(&root),
        }
    })
    .await
    .map_err(join_err)
}

/// `-c` of delombok: the module's classpath (types it resolves while generating).
fn classpath_arg(classpath: &[String]) -> Option<String> {
    let entries: Vec<&str> = classpath.iter().map(String::as_str).filter(|p| !p.is_empty()).collect();
    (!entries.is_empty()).then(|| entries.join(if cfg!(windows) { ";" } else { ":" }))
}

/// Where a source file goes under delombok's input directory: its package path when the
/// text declares one, so delombok resolves its own package.
fn package_path(text: &str, path: &str) -> PathBuf {
    let file = Path::new(path).file_name().map_or_else(|| "Source.java".into(), |n| n.to_owned());
    let package = text.lines().map(str::trim).find_map(|l| {
        let rest = l.strip_prefix("package ")?;
        Some(rest.trim_end_matches(';').trim().to_owned())
    });
    let mut out = PathBuf::new();
    for part in package.iter().flat_map(|p| p.split('.')).filter(|p| !p.is_empty()) {
        out.push(part);
    }
    out.join(file)
}

/// Runs the Lombok jar's `delombok` on `files` (their editor text) with the module's
/// `classpath`: every Lombok annotation replaced by the code it generates. The output keeps
/// Lombok's `@lombok.Generated` marks (the editor takes those members) and leaves out the
/// delombok comment, `@SuppressWarnings("all")` and `java.lang.` prefixes, as IDEA's Delombok.
pub async fn lombok_delombok(
    host: &Host,
    window: &str,
    files: Vec<DelombokInput>,
    classpath: Vec<String>,
    request: RequestId,
) -> IdeResult<Vec<DelombokOutput>> {
    let s = settings(host, window);
    let root = host.project(window)?.root.clone();
    let jar = lombok_jar(&host.local_data_dir, &s.lombok.agent_path)?;
    let java = ide_sdk::apply::project_jdk(&root, &s)
        .map(|j| ide_sdk::java::java_executable(&j.home))
        .or_else(|| {
            ide_sdk::java::pick_jdk(&ide_sdk::java::installed_jdks(), None)
                .map(|j| ide_sdk::java::java_executable(&j.home))
        })
        .unwrap_or_else(|| PathBuf::from("java"));
    let cancel = host.begin_request(request);
    let result = run_delombok(&java, &jar, &files, &classpath, &cancel).await;
    host.end_request(request);
    result
}

/// `java -jar <jar> delombok` on `files` (see [`lombok_delombok`]). A file javac can't
/// parse stops the whole run (every file comes back as it was), so a batch with an
/// unchanged file runs again file by file; a file still unchanged is reported with
/// javac's messages.
async fn run_delombok(
    java: &Path,
    jar: &Path,
    files: &[DelombokInput],
    classpath: &[String],
    cancel: &ide_core::CancellationToken,
) -> IdeResult<Vec<DelombokOutput>> {
    let (mut out, stderr) = delombok_once(java, jar, files, classpath, cancel).await?;
    let unchanged = |o: &DelombokOutput, f: &DelombokInput| o.text.as_deref().is_none_or(|t| t == f.text);
    let rerun = files.len() > 1;
    for (o, f) in out.iter_mut().zip(files) {
        if !unchanged(o, f) {
            continue;
        }
        let err = if rerun {
            let (mut one, err) = delombok_once(java, jar, std::slice::from_ref(f), classpath, cancel).await?;
            *o = one.remove(0);
            err
        } else {
            stderr.clone()
        };
        if unchanged(o, f) {
            *o = failed(f, &err);
        }
    }
    Ok(out)
}

fn failed(f: &DelombokInput, stderr: &str) -> DelombokOutput {
    let error = if stderr.is_empty() { "delombok changed nothing".to_owned() } else { stderr.to_owned() };
    DelombokOutput { path: f.path.clone(), text: None, error: Some(error) }
}

async fn delombok_once(
    java: &Path,
    jar: &Path,
    files: &[DelombokInput],
    classpath: &[String],
    cancel: &ide_core::CancellationToken,
) -> IdeResult<(Vec<DelombokOutput>, String)> {
    let tmp = tempfile::tempdir()?;
    let (input, output) = (tmp.path().join("in"), tmp.path().join("out"));
    let mut placed = Vec::new();
    for f in files {
        let rel = package_path(&f.text, &f.path);
        let at = input.join(&rel);
        if let Some(dir) = at.parent() {
            std::fs::create_dir_all(dir)?;
        }
        std::fs::write(&at, &f.text)?;
        placed.push(rel);
    }
    let mut cmd = tokio::process::Command::new(java);
    // javac's messages in English, whatever the system locale.
    cmd.args(["-Duser.language=en", "-Duser.country=US"]).arg("-jar").arg(jar).arg("delombok");
    for format in ["generateDelombokComment:skip", "suppressWarnings:skip", "javaLangAsFQN:skip"] {
        cmd.arg(format!("--format={format}"));
    }
    cmd.arg("--encoding=UTF-8");
    if let Some(cp) = classpath_arg(classpath) {
        cmd.arg("-c").arg(cp);
    }
    cmd.arg("-d").arg(&output).arg(&input);
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
    let child = cmd.spawn().map_err(|e| IdeError::not_found(format!("cannot run {}: {e}", java.display())))?;
    let out = tokio::select! {
        r = child.wait_with_output() => r?,
        _ = cancel.cancelled() => return Err(IdeError::cancelled()),
    };
    let stderr = String::from_utf8_lossy(&out.stderr).trim().to_owned();
    let outputs = files
        .iter()
        .zip(placed)
        .map(|(f, rel)| match std::fs::read_to_string(output.join(rel)) {
            Ok(text) => DelombokOutput { path: f.path.clone(), text: Some(text), error: None },
            Err(_) => failed(f, &stderr),
        })
        .collect();
    Ok((outputs, stderr))
}

/// Commands of this module the remote server answers.
pub(crate) fn register(d: &mut Dispatcher) {
    d.add("lombok_status", |c| async move { lombok_status(&c.host, &c.window).await });
    d.add("lombok_delombok", |c| async move {
        lombok_delombok(&c.host, &c.window, c.arg("files")?, c.arg("classpath")?, c.arg("request")?).await
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn places_sources_by_package() {
        assert_eq!(package_path("package demo.model;\nclass A {}", "/p/src/A.java"), Path::new("demo/model/A.java"));
        assert_eq!(package_path("class A {}", "/p/A.java"), Path::new("A.java"));
        assert_eq!(classpath_arg(&["".into()]), None);
    }

    /// The bundled jar on a real JVM (skipped without `java` on PATH).
    #[tokio::test]
    async fn delomboks_with_the_bundled_jar() {
        let Some(java) = std::env::var_os("PATH")
            .and_then(|p| std::env::split_paths(&p).map(|d| d.join("java")).find(|j| j.is_file()))
        else {
            return;
        };
        let jar = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../plugins/lombok/lombok-1.18.48-luma.2.jar");
        let files = vec![
            DelombokInput {
                path: "/p/src/main/java/demo/A.java".into(),
                text: "package demo;\n\nimport lombok.Getter;\n\n@Getter\npublic class A {\n    private int x;\n}\n"
                    .into(),
            },
            DelombokInput { path: "/p/B.java".into(), text: "class B { this is not java }".into() },
        ];
        let out = run_delombok(&java, &jar, &files, &[], &ide_core::CancellationToken::new()).await.unwrap();
        let a = out[0].text.as_deref().unwrap();
        assert!(a.contains("@lombok.Generated\n    public int getX() {"), "{a}");
        assert!(!a.contains("SuppressWarnings") && !a.contains("Generated by delombok"), "{a}");
        // The file javac can't parse is reported, and didn't stop the other one.
        assert!(out[1].text.is_none() && out[1].error.as_deref().is_some_and(|e| e.contains("error")), "{:?}", out[1]);
    }

    #[test]
    fn finds_config_files_outside_build_output() {
        let tmp = tempfile::tempdir().unwrap();
        for p in ["lombok.config", "api/lombok.config", "target/lombok.config", "api/src/main/java/lombok.config"] {
            let at = tmp.path().join(p);
            std::fs::create_dir_all(at.parent().unwrap()).unwrap();
            std::fs::write(at, "").unwrap();
        }
        assert_eq!(config_files(tmp.path()), ["api/lombok.config", "api/src/main/java/lombok.config", "lombok.config"]);
    }
}
