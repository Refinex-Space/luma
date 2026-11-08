//! Maven tool window actions that run Maven in the background (IDEA's "Generate
//! Sources and Update Folders", "Download Sources / Documentation", "Show Effective
//! POM"), the user files it opens or creates (`settings.xml`, `toolchains.xml`) and
//! what Settings › Maven shows about the Maven installation.

use crate::maven::{self, MavenModel, MavenProject};
use crate::process;
use crate::sync::{SyncOptions, SyncProgress, error_summary};
use ide_core::{CancellationToken, IdeError, IdeResult};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::path::{Path, PathBuf};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum MavenTaskKind {
    /// Runs the Importing page's "Phase to be used for folders update".
    UpdateFolders,
    DownloadSources,
    DownloadDocs,
    DownloadSourcesAndDocs,
}

/// A dependency selected in the tool window (Download for the selected artifacts).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactFilter {
    pub group_id: String,
    pub artifact_id: String,
}

/// `maven-dependency-plugin` goals, pinned like the sync's `dependency:tree`.
/// `sources` is deprecated in favour of `resolve-sources` since 3.7.
const SOURCES: &str = "org.apache.maven.plugins:maven-dependency-plugin:3.8.1:resolve-sources";
const RESOLVE: &str = "org.apache.maven.plugins:maven-dependency-plugin:3.8.1:resolve";

/// The goals of `kind` (`phase`: the folders update phase).
pub fn task_goals(kind: MavenTaskKind, phase: &str, artifacts: &[ArtifactFilter], offline: bool) -> Vec<Vec<String>> {
    let filter = |mut args: Vec<String>| {
        if !artifacts.is_empty() {
            let join = |f: fn(&ArtifactFilter) -> &str| {
                let mut v: Vec<&str> = artifacts.iter().map(f).collect();
                v.sort_unstable();
                v.dedup();
                v.join(",")
            };
            args.push(format!("-DincludeGroupIds={}", join(|a| &a.group_id)));
            args.push(format!("-DincludeArtifactIds={}", join(|a| &a.artifact_id)));
        }
        args
    };
    let sources = || filter(vec![if offline { "dependency:sources".into() } else { SOURCES.into() }]);
    let docs = || {
        filter(vec![if offline { "dependency:resolve".into() } else { RESOLVE.into() }, "-Dclassifier=javadoc".into()])
    };
    match kind {
        MavenTaskKind::UpdateFolders => {
            vec![vec![if phase.trim().is_empty() { "process-resources".into() } else { phase.trim().to_owned() }]]
        }
        MavenTaskKind::DownloadSources => vec![sources()],
        MavenTaskKind::DownloadDocs => vec![docs()],
        MavenTaskKind::DownloadSourcesAndDocs => vec![sources(), docs()],
    }
}

/// Reactor roots to run on and the `-pl` of the selected modules below each (empty = all).
fn targets<'a>(model: &'a MavenModel, poms: &[String]) -> Vec<(&'a MavenProject, Vec<String>)> {
    let tops: Vec<&MavenProject> = model.projects.iter().filter(|p| !p.aggregated && !p.ignored).collect();
    if poms.is_empty() {
        return tops.into_iter().map(|t| (t, Vec::new())).collect();
    }
    let mut out: Vec<(&MavenProject, Vec<String>)> = Vec::new();
    for pom in poms {
        let Some(project) = model.projects.iter().find(|p| p.pom == *pom) else { continue };
        let Some(top) = tops.iter().copied().find(|t| t.pom == project.pom || reactor_contains(model, t, &project.pom))
        else {
            continue;
        };
        // `-pl` takes the module's directory relative to the reactor root.
        let pl = (top.pom != project.pom).then(|| {
            if top.dir.is_empty() {
                project.dir.clone()
            } else {
                project.dir.strip_prefix(&format!("{}/", top.dir)).unwrap_or(&project.dir).to_owned()
            }
        });
        match (out.iter_mut().find(|(t, _)| t.pom == top.pom), pl) {
            // An empty list already runs the whole reactor.
            (Some((_, list)), Some(pl)) if !list.is_empty() => list.push(pl),
            (Some(_), Some(_)) => {}
            (Some((_, list)), None) => list.clear(),
            (None, pl) => out.push((top, pl.into_iter().collect())),
        }
    }
    out
}

fn reactor_contains(model: &MavenModel, top: &MavenProject, pom: &str) -> bool {
    let mut stack: Vec<&str> = top.modules.iter().map(String::as_str).collect();
    while let Some(m) = stack.pop() {
        if m == pom {
            return true;
        }
        if let Some(p) = model.projects.iter().find(|p| p.pom == m) {
            stack.extend(p.modules.iter().map(String::as_str));
        }
    }
    false
}

/// Runs `kind` on the selected projects (`poms`, empty = all), streaming the console
/// on `progress`. Returns the error summary of a failed run (Maven's own failure).
#[allow(clippy::too_many_arguments)]
pub fn run_maven_task(
    root: &Path,
    model: &MavenModel,
    options: &SyncOptions,
    kind: MavenTaskKind,
    poms: &[String],
    artifacts: &[ArtifactFilter],
    cancel: &CancellationToken,
    progress: &dyn Fn(SyncProgress),
) -> IdeResult<Option<String>> {
    let phase = &options.maven_settings.importing.update_folders_phase;
    let title = match kind {
        MavenTaskKind::UpdateFolders => "Updating folders",
        MavenTaskKind::DownloadSources => "Downloading Maven sources",
        MavenTaskKind::DownloadDocs => "Downloading Maven documentation",
        MavenTaskKind::DownloadSourcesAndDocs => "Downloading Maven sources and documentation",
    };
    let mut errors = Vec::new();
    for (top, pl) in targets(model, poms) {
        for goals in task_goals(kind, phase, artifacts, options.offline) {
            let mut args: Vec<String> = vec!["-B".into(), "-Dstyle.color=never".into()];
            args.extend(options.maven_options.iter().cloned());
            if options.offline {
                args.push("-o".into());
            }
            if !options.profiles.is_empty() {
                args.push(format!("-P{}", options.profiles.join(",")));
            }
            if !pl.is_empty() {
                args.extend(["-pl".into(), pl.join(","), "-am".into()]);
            }
            args.extend(goals);
            let message = format!("{title}: {}", top.display_name);
            progress(SyncProgress { message: message.clone(), fraction: None, output: None });
            let command = options.maven_command.as_deref().unwrap_or(&top.command);
            let out = process::run(command, &args, &root.join(&top.dir), &options.env, cancel, |_, line| {
                progress(SyncProgress { message: message.clone(), fraction: None, output: Some(line.to_owned()) });
            })?;
            if !out.success {
                errors.push(error_summary(&out.text));
            }
        }
    }
    Ok((!errors.is_empty()).then(|| errors.join("\n")))
}

/// Writes the effective POM of `project` to `<cache>/effective/<artifactId>-effective-pom.xml`.
pub fn effective_pom(
    root: &Path,
    cache_dir: &Path,
    project: &MavenProject,
    options: &SyncOptions,
    cancel: &CancellationToken,
) -> IdeResult<PathBuf> {
    let dir = cache_dir.join("effective");
    std::fs::create_dir_all(&dir)?;
    let file = dir.join(format!("{}-effective-pom.xml", project.artifact_id));
    let _ = std::fs::remove_file(&file);
    let mut args: Vec<String> = vec!["-B".into(), "-N".into(), "-Dstyle.color=never".into()];
    args.extend(options.maven_options.iter().cloned());
    if options.offline {
        args.push("-o".into());
    }
    if !options.profiles.is_empty() {
        args.push(format!("-P{}", options.profiles.join(",")));
    }
    args.extend(["help:effective-pom".into(), format!("-Doutput={}", file.to_string_lossy())]);
    let command = options.maven_command.as_deref().unwrap_or(&project.command);
    let out = process::run(command, &args, &root.join(&project.dir), &options.env, cancel, |_, _| {})?;
    if !out.success || !file.is_file() {
        return Err(IdeError::internal(format!("Failed to evaluate effective pom.\n{}", error_summary(&out.text))));
    }
    Ok(file)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum MavenUserFile {
    Settings,
    Toolchains,
}

const SETTINGS_TEMPLATE: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<settings xmlns="http://maven.apache.org/SETTINGS/1.2.0"
          xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
          xsi:schemaLocation="http://maven.apache.org/SETTINGS/1.2.0 https://maven.apache.org/xsd/settings-1.2.0.xsd">
</settings>
"#;

const TOOLCHAINS_TEMPLATE: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<toolchains xmlns="http://maven.apache.org/TOOLCHAINS/1.1.0"
            xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
            xsi:schemaLocation="http://maven.apache.org/TOOLCHAINS/1.1.0 https://maven.apache.org/xsd/toolchains-1.1.0.xsd">
</toolchains>
"#;

/// The user `settings.xml` (the configured one, else `~/.m2/settings.xml`) or `~/.m2/toolchains.xml`.
pub fn user_file_path(kind: MavenUserFile, user_settings: Option<&Path>) -> Option<PathBuf> {
    match kind {
        MavenUserFile::Settings => {
            user_settings.map(Path::to_path_buf).or_else(|| Some(dirs::home_dir()?.join(".m2/settings.xml")))
        }
        MavenUserFile::Toolchains => Some(dirs::home_dir()?.join(".m2/toolchains.xml")),
    }
}

/// Creates the user file from IDEA's template when it does not exist yet.
pub fn create_user_file(path: &Path, kind: MavenUserFile) -> IdeResult<()> {
    if path.exists() {
        return Ok(());
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(path, if kind == MavenUserFile::Settings { SETTINGS_TEMPLATE } else { TOOLCHAINS_TEMPLATE })?;
    Ok(())
}

/// What Settings › Maven shows about the installation and the overridable defaults.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct MavenEnvironment {
    /// The Maven version (`3.9.9`), when it can be read.
    pub version: Option<String>,
    /// The home that runs: the configured one, the wrapper's distribution, else `mvn` on `PATH`.
    pub home: Option<String>,
    /// The project has a Maven wrapper (`mvnw`).
    pub wrapper: bool,
    /// The user settings file used when none is configured.
    pub default_user_settings: String,
    /// The local repository used when none is configured (for the given settings file).
    pub default_local_repository: String,
    /// The project's `.mvn/maven.config` exists.
    pub maven_config: bool,
}

/// `maven-core-3.9.9.jar` in `<home>/lib` → `3.9.9` (IDEA's `MavenUtil.getMavenVersion`).
pub fn home_version(home: &Path) -> Option<String> {
    std::fs::read_dir(home.join("lib")).ok()?.flatten().find_map(|e| {
        let name = e.file_name().to_string_lossy().into_owned();
        name.strip_prefix("maven-core-")?.strip_suffix(".jar").map(str::to_owned)
    })
}

/// The Maven home of an `mvn` launcher (`<home>/bin/mvn`, symlinks resolved).
fn home_of_launcher(launcher: &Path) -> Option<PathBuf> {
    let real = dunce::canonicalize(launcher).ok()?;
    let home = real.parent()?.parent()?.to_path_buf();
    home.join("lib").is_dir().then_some(home)
}

/// `apache-maven-3.9.6-bin.zip` of `.mvn/wrapper/maven-wrapper.properties` → `3.9.6`.
pub fn wrapper_version(root: &Path) -> Option<String> {
    let text = std::fs::read_to_string(root.join(".mvn/wrapper/maven-wrapper.properties")).ok()?;
    let url = text.lines().find_map(|l| l.trim().strip_prefix("distributionUrl="))?;
    let file = url.rsplit('/').next()?;
    file.strip_prefix("apache-maven-")?.split("-bin").next().map(str::to_owned)
}

pub fn environment(root: &Path, home: Option<&Path>, user_settings: Option<&Path>) -> MavenEnvironment {
    let wrapper = root.join("mvnw").is_file() || root.join("mvnw.cmd").is_file();
    let resolved_home = match home {
        Some(h) if h.is_file() => home_of_launcher(h),
        Some(h) => Some(h.to_path_buf()),
        None if wrapper => None,
        None => {
            let launcher = process::program_path(if cfg!(windows) { "mvn.cmd" } else { "mvn" }, &Default::default());
            if launcher.is_absolute() { home_of_launcher(&launcher) } else { None }
        }
    };
    let version = match (&resolved_home, home) {
        (Some(h), _) => home_version(h),
        (None, None) if wrapper => wrapper_version(root),
        _ => None,
    };
    let default_settings = dirs::home_dir().map(|h| h.join(".m2/settings.xml")).unwrap_or_default();
    let settings_file = user_settings.map(Path::to_path_buf).unwrap_or_else(|| default_settings.clone());
    let local = maven::local_repository_of(&settings_file)
        .or_else(|| resolved_home.as_ref().and_then(|h| maven::local_repository_of(&h.join("conf/settings.xml"))))
        .or_else(|| dirs::home_dir().map(|h| h.join(".m2/repository")))
        .unwrap_or_default();
    MavenEnvironment {
        version,
        home: resolved_home.map(|h| h.to_string_lossy().into_owned()),
        wrapper,
        default_user_settings: default_settings.to_string_lossy().into_owned(),
        default_local_repository: local.to_string_lossy().into_owned(),
        maven_config: root.join(".mvn/maven.config").is_file(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn project(pom: &str, dir: &str, modules: &[&str], aggregated: bool) -> MavenProject {
        MavenProject {
            pom: pom.into(),
            dir: dir.into(),
            artifact_id: dir.rsplit('/').next().unwrap_or("root").into(),
            modules: modules.iter().map(|m| (*m).into()).collect(),
            aggregated,
            ..Default::default()
        }
    }

    #[test]
    fn selected_modules_run_in_their_reactor() {
        let model = MavenModel {
            projects: vec![
                project("pom.xml", "", &["core/pom.xml", "app/pom.xml"], false),
                project("core/pom.xml", "core", &[], true),
                project("app/pom.xml", "app", &[], true),
                project("tools/pom.xml", "tools", &[], false),
            ],
            ..Default::default()
        };
        let all: Vec<(String, Vec<String>)> =
            targets(&model, &[]).into_iter().map(|(t, pl)| (t.pom.clone(), pl)).collect();
        assert_eq!(all, [("pom.xml".into(), vec![]), ("tools/pom.xml".into(), vec![])]);
        let some: Vec<(String, Vec<String>)> = targets(&model, &["core/pom.xml".into(), "app/pom.xml".into()])
            .into_iter()
            .map(|(t, pl)| (t.pom.clone(), pl))
            .collect();
        assert_eq!(some, [("pom.xml".into(), vec!["core".to_owned(), "app".to_owned()])]);
        let whole: Vec<(String, Vec<String>)> = targets(&model, &["app/pom.xml".into(), "pom.xml".into()])
            .into_iter()
            .map(|(t, pl)| (t.pom.clone(), pl))
            .collect();
        assert_eq!(whole, [("pom.xml".into(), vec![])]);
    }

    #[test]
    fn goals_of_each_task() {
        assert_eq!(task_goals(MavenTaskKind::UpdateFolders, "", &[], false), [["process-resources"]]);
        assert_eq!(task_goals(MavenTaskKind::UpdateFolders, "generate-sources", &[], false), [["generate-sources"]]);
        let both = task_goals(
            MavenTaskKind::DownloadSourcesAndDocs,
            "",
            &[ArtifactFilter { group_id: "g".into(), artifact_id: "a".into() }],
            false,
        );
        assert_eq!(both[0], [SOURCES, "-DincludeGroupIds=g", "-DincludeArtifactIds=a"]);
        assert_eq!(both[1], [RESOLVE, "-Dclassifier=javadoc", "-DincludeGroupIds=g", "-DincludeArtifactIds=a"]);
        assert_eq!(task_goals(MavenTaskKind::DownloadSources, "", &[], true), [["dependency:sources"]]);
    }

    #[test]
    fn reads_versions_of_homes_and_wrappers() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(tmp.path().join("lib")).unwrap();
        std::fs::write(tmp.path().join("lib/maven-core-3.9.9.jar"), "").unwrap();
        assert_eq!(home_version(tmp.path()).as_deref(), Some("3.9.9"));
        std::fs::create_dir_all(tmp.path().join(".mvn/wrapper")).unwrap();
        std::fs::write(
            tmp.path().join(".mvn/wrapper/maven-wrapper.properties"),
            "distributionUrl=https://repo.maven.apache.org/maven2/org/apache/maven/apache-maven/3.9.6/apache-maven-3.9.6-bin.zip\n",
        )
        .unwrap();
        assert_eq!(wrapper_version(tmp.path()).as_deref(), Some("3.9.6"));
    }

    #[test]
    fn creates_user_files_from_templates_once() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("m2/settings.xml");
        create_user_file(&path, MavenUserFile::Settings).unwrap();
        assert!(std::fs::read_to_string(&path).unwrap().contains("<settings"));
        std::fs::write(&path, "mine").unwrap();
        create_user_file(&path, MavenUserFile::Settings).unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "mine");
    }
}
