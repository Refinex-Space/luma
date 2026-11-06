//! Hot reload runtimes (Build, Execution, Deployment › Debugger › HotSwap › Hot Reload):
//! JetBrains Runtime — OpenJDK with enhanced class redefinition
//! (`-XX:+AllowEnhancedClassRedefinition`: methods, fields and classes may be added or
//! removed while the JVM runs) — and HotswapAgent, which refreshes framework state after a
//! redefinition (Spring beans and mappings, Spring Boot properties, MyBatis mappers, …).
//! Both are pinned downloads, verified before use; and the JVM options of a hot-reloading
//! launch ([`plan_launch`]), HotswapAgent's or the user's own JRebel agent.

use crate::jdk::{find_jdk_home, jdk_dir_name};
use crate::platform::{Arch, Os, Platform};
use crate::{Emit, Http};
use crate::{InstallEvent, InstallGuard, Tools, archive, clear_quarantine};
use ide_core::error::ErrorKind;
use ide_core::hot_reload::{ENGINE_JREBEL, HotReloadSettings};
use ide_core::{CancellationToken, IdeError, IdeResult, IpcPath};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::path::{Path, PathBuf};

/// A JetBrains Runtime build the IDE downloads.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct JbrRelease {
    pub major: u32,
    pub version: &'static str,
    pub build: &'static str,
    /// Reports of crashes in enhanced redefinition on early builds of this line.
    pub experimental: bool,
}

/// One per Java line hot reload supports, newest builds known to work (JetBrains'
/// `jbrsdk`, the JDK flavour without JCEF).
pub const JBR_RELEASES: &[JbrRelease] = &[
    JbrRelease { major: 17, version: "17.0.14", build: "b1367.22", experimental: false },
    JbrRelease { major: 21, version: "21.0.11", build: "b1163.125", experimental: false },
    JbrRelease { major: 25, version: "25.0.4.1", build: "b635.79", experimental: true },
];

/// The line enabling the plugin downloads first.
pub const DEFAULT_JBR_MAJOR: u32 = 21;

/// A HotswapAgent build, pinned by its SHA-256.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct AgentRelease {
    pub version: &'static str,
    pub url: &'static str,
    pub sha256: &'static str,
}

/// Tried in order. 2.0.4 reloads Spring 7 / Spring Boot 4 beans and mappings (2.0.3 only
/// redefines the classes there).
pub const AGENT_RELEASES: &[AgentRelease] = &[
    AgentRelease {
        version: "2.0.4-SNAPSHOT",
        url: "https://github.com/HotswapProjects/HotswapAgent/releases/download/2.0.4-SNAPSHOT/hotswap-agent-2.0.4-SNAPSHOT.jar",
        sha256: "ef9c1617d5a8ea4d120f7f32d8862a011470a9bc7ec77136d6bee3bf6eb464c3",
    },
    AgentRelease {
        version: "2.0.3",
        url: "https://github.com/HotswapProjects/HotswapAgent/releases/download/RELEASE-2.0.3/hotswap-agent-2.0.3.jar",
        sha256: "4ef49724b7d8523536d2e2a7310f827f4db9f4fed3489224e05d7bf87f0594f9",
    },
];

const JBR_BASE: &str = "https://cache-redirector.jetbrains.com/intellij-jbr";
const JBR_VENDOR: &str = "jbr";
const AGENT_DIR: &str = "hotswap-agent";

/// The JetBrains Runtime that runs an application built for Java `project_major`: the same
/// line, else the next newer one; none before 17 (no enhanced redefinition there) or after
/// the newest line.
pub fn jbr_for(project_major: u32) -> Option<&'static JbrRelease> {
    if project_major < 17 {
        return None;
    }
    JBR_RELEASES.iter().find(|r| r.major >= project_major)
}

pub fn jbr_release(major: u32) -> Option<&'static JbrRelease> {
    JBR_RELEASES.iter().find(|r| r.major == major)
}

/// `osx-aarch64`, `windows-x64`, … as JetBrains names its builds.
pub fn jbr_platform(platform: Platform) -> String {
    let os = match platform.os {
        Os::Mac => "osx",
        Os::Windows => "windows",
        Os::Linux => "linux",
    };
    let arch = match platform.arch {
        Arch::X64 => "x64",
        Arch::Arm64 => "aarch64",
    };
    format!("{os}-{arch}")
}

/// The archive's name and URL (its SHA-512 is at `<url>.checksum`).
pub fn jbr_archive(r: &JbrRelease, platform: Platform) -> (String, String) {
    let name = format!("jbrsdk-{}-{}-{}.tar.gz", r.version, jbr_platform(platform), r.build);
    let url = format!("{JBR_BASE}/{name}");
    (name, url)
}

/// The SHA-512 of a JetBrains `.checksum` file (`<hex>  <name>`, or the bare hex).
pub fn parse_sha512(text: &str) -> Option<String> {
    let hex = text.split_whitespace().next()?;
    (hex.len() == 128 && hex.chars().all(|c| c.is_ascii_hexdigit())).then(|| hex.to_ascii_lowercase())
}

fn sha512_file(path: &Path) -> IdeResult<String> {
    use sha2::Digest;
    let mut f = std::fs::File::open(path)?;
    let mut hasher = sha2::Sha512::new();
    std::io::copy(&mut f, &mut hasher)?;
    Ok(hex::encode(hasher.finalize()))
}

/// `JAVA_VERSION="21.0.10"` of a JDK's `release` file → 21 (`1.8.0_472` → 8).
pub fn java_major_of_release(text: &str) -> Option<u32> {
    let line = text.lines().find_map(|l| l.trim().strip_prefix("JAVA_VERSION="))?;
    let v = line.trim().trim_matches('"');
    let mut parts = v.split(['.', '_', '+', '-']);
    let first: u32 = parts.next()?.parse().ok()?;
    if first == 1 { parts.next()?.parse().ok() } else { Some(first) }
}

pub fn java_major(home: &Path) -> Option<u32> {
    java_major_of_release(&std::fs::read_to_string(home.join("release")).ok()?)
}

/// A JetBrains Runtime line and whether it is installed.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct HotReloadRuntime {
    pub major: u32,
    pub version: String,
    pub build: String,
    pub experimental: bool,
    /// The JDK home once downloaded.
    pub home: Option<IpcPath>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct HotReloadAgent {
    pub version: String,
    pub path: IpcPath,
    /// Chosen in settings rather than downloaded.
    pub custom: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct JrebelAgent {
    pub path: IpcPath,
    /// The file exists and is an agent (`.jar`, or a native library).
    pub valid: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct HotReloadStatus {
    pub engine: String,
    pub agent: Option<HotReloadAgent>,
    pub runtimes: Vec<HotReloadRuntime>,
    /// JetBrains publishes runtimes for this OS and architecture.
    pub platform_supported: bool,
    pub jrebel: Option<JrebelAgent>,
}

/// How to start a JVM that hot-reloads.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(tag = "status", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum HotReloadLaunch {
    /// Launch with `java_exec` (null: the project's JDK, as for JRebel) and `vm_args` first;
    /// `major` is the JetBrains Runtime's Java version (a Gradle toolchain asks for it).
    Ready { engine: String, java_exec: Option<String>, vm_args: Vec<String>, runtime: String, major: Option<u32> },
    /// JetBrains Runtime `major` must be downloaded first.
    NeedsRuntime { major: u32, name: String },
    /// HotswapAgent must be downloaded first.
    NeedsAgent,
    /// Hot reload can't run this application; it launches as usual.
    Unsupported { reason: String },
}

/// What a launch plan looks at.
pub struct LaunchInput<'a> {
    pub settings: &'a HotReloadSettings,
    /// Java feature version the project builds with (its JDK), when known.
    pub project_major: Option<u32>,
    pub debug: bool,
    pub agent: Option<HotReloadAgent>,
    /// The installed JetBrains Runtime of a line.
    pub runtime_home: &'a dyn Fn(&JbrRelease) -> Option<PathBuf>,
    /// Where the agent's generated `hotswap-agent.properties` goes.
    pub properties_file: &'a Path,
    /// Compiler output directories the JVM doesn't load from itself (HotswapAgent `extraClasspath`
    /// and `watchResources`).
    pub class_dirs: &'a [PathBuf],
    pub platform: Platform,
}

/// A launch plan, and the `hotswap-agent.properties` text to write before launching.
pub fn plan_launch(input: &LaunchInput<'_>) -> (HotReloadLaunch, Option<String>) {
    let s = input.settings;
    let mut extra = Vec::new();
    if s.disable_devtools_restart {
        extra.push("-Dspring.devtools.restart.enabled=false".to_owned());
    }
    if s.engine == ENGINE_JREBEL {
        return (jrebel_launch(&s.jrebel_agent_path, extra), None);
    }
    let Some(project) = input.project_major else {
        return (HotReloadLaunch::Unsupported { reason: "The project's Java version is unknown.".into() }, None);
    };
    let Some(release) = jbr_for(project) else {
        let reason = if project < 17 {
            format!(
                "Hot reload needs Java 17 or newer; this project builds with Java {project}. HotSwap still reloads method bodies while debugging."
            )
        } else {
            format!("No JetBrains Runtime supports Java {project} yet.")
        };
        return (HotReloadLaunch::Unsupported { reason }, None);
    };
    let Some(home) = (input.runtime_home)(release) else {
        return (
            HotReloadLaunch::NeedsRuntime {
                major: release.major,
                name: format!("JetBrains Runtime {}", release.major),
            },
            None,
        );
    };
    let Some(agent) = &input.agent else { return (HotReloadLaunch::NeedsAgent, None) };
    let java = home.join("bin").join(input.platform.exe("java"));
    let agent_path = agent.path.to_path_buf();
    let props = input.properties_file;
    let mut vm_args = Vec::new();
    // macOS' native watch service batches FSEvents for ~10–15 s; polling with HotswapAgent's
    // HIGH sensitivity sees a changed class or resource within 2 s.
    if input.platform.os == Os::Mac {
        vm_args.push("-Dwatch.service.polling=true".to_owned());
    }
    vm_args.extend([
        "-XX:+AllowEnhancedClassRedefinition".to_owned(),
        "-XX:HotswapAgent=external".to_owned(),
        format!(
            "-javaagent:{}=autoHotswap={},propertiesFilePath={}",
            agent_path.display(),
            !input.debug,
            forward(props)
        ),
    ]);
    // HotswapAgent prepends `extraClasspath` to the class loaders' `ucp`, which JDK 9+ modules hide.
    if !s.extra_classpath.iter().all(|p| p.trim().is_empty()) || !input.class_dirs.is_empty() {
        vm_args.push("--add-opens=java.base/java.net=ALL-UNNAMED".to_owned());
        vm_args.push("--add-opens=java.base/jdk.internal.loader=ALL-UNNAMED".to_owned());
    }
    vm_args.extend(extra);
    let launch = HotReloadLaunch::Ready {
        engine: s.engine.clone(),
        java_exec: Some(java.to_string_lossy().into_owned()),
        vm_args,
        runtime: format!("JetBrains Runtime {}", release.version),
        major: Some(release.major),
    };
    (launch, Some(agent_properties(s, input.class_dirs)))
}

fn jrebel_launch(path: &str, extra: Vec<String>) -> HotReloadLaunch {
    let path = path.trim();
    if path.is_empty() {
        return HotReloadLaunch::Unsupported {
            reason: "Choose JRebel's agent in Settings › Build, Execution, Deployment › Debugger › HotSwap.".into(),
        };
    }
    let Some(flag) = jrebel_flag(Path::new(path)) else {
        return HotReloadLaunch::Unsupported {
            reason: format!("{path} is not a JRebel agent (jrebel.jar, or libjrebel64.dylib / .so / .dll)."),
        };
    };
    let mut vm_args = vec![flag];
    vm_args.extend(extra);
    HotReloadLaunch::Ready {
        engine: ENGINE_JREBEL.into(),
        java_exec: None,
        vm_args,
        runtime: "JRebel".into(),
        major: None,
    }
}

/// `-agentpath:` for JRebel's native agent, `-javaagent:` for `jrebel.jar`; None when the
/// file is missing or neither.
pub fn jrebel_flag(path: &Path) -> Option<String> {
    if !path.is_file() {
        return None;
    }
    let ext = path.extension()?.to_str()?.to_ascii_lowercase();
    match ext.as_str() {
        "jar" => Some(format!("-javaagent:{}", path.display())),
        "dylib" | "so" | "dll" => Some(format!("-agentpath:{}", path.display())),
        _ => None,
    }
}

/// Forward slashes: `java.util.Properties` reads `\` as an escape, and Java takes `/` on Windows too.
fn forward(p: &Path) -> String {
    p.to_string_lossy().replace('\\', "/")
}

/// Plugin names and paths for a `.properties` value (no line breaks, commas separate).
fn list(items: impl IntoIterator<Item = String>) -> String {
    items
        .into_iter()
        .map(|s| s.trim().replace(['\n', '\r', ','], ""))
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join(",")
}

/// The agent's configuration for a launch (`propertiesFilePath`).
pub fn agent_properties(s: &HotReloadSettings, class_dirs: &[PathBuf]) -> String {
    let level = match s.log_level.trim() {
        l @ ("error" | "warning" | "reload" | "info" | "debug" | "trace") => l,
        _ => "info",
    };
    let classpath = list(
        s.extra_classpath.iter().cloned().chain(class_dirs.iter().map(|d| forward(d))).map(|p| p.replace('\\', "/")),
    );
    // HotswapAgent's `autoHotswap` watches `watchResources` for class files: compiler output
    // outside the JVM's own class path (jdtls' `bin/main` under Gradle) is watched there too.
    let resources =
        list(s.watch_resources.iter().map(|p| p.replace('\\', "/")).chain(class_dirs.iter().map(|d| forward(d))));
    let plugins = list(s.disabled_plugins.iter().cloned());
    format!(
        "# Written by Luma for hot reload (Settings › Build, Execution, Deployment › Debugger › HotSwap); rewritten on every launch.\n\
         LOGGER={level}\n\
         extraClasspath={classpath}\n\
         watchResources={resources}\n\
         disabledPlugins={plugins}\n"
    )
}

impl Tools {
    fn jbr_target(&self, r: &JbrRelease) -> PathBuf {
        self.root().join("jdks").join(jdk_dir_name(JBR_VENDOR, r.version))
    }

    /// The installed JetBrains Runtime of `r`'s line.
    pub fn jbr_home(&self, r: &JbrRelease) -> Option<PathBuf> {
        find_jdk_home(&self.jbr_target(r), self.platform)
    }

    pub fn hot_reload_runtimes(&self) -> Vec<HotReloadRuntime> {
        JBR_RELEASES
            .iter()
            .map(|r| HotReloadRuntime {
                major: r.major,
                version: r.version.into(),
                build: r.build.into(),
                experimental: r.experimental,
                home: self.jbr_home(r).map(Into::into),
            })
            .collect()
    }

    fn agent_file(&self, r: &AgentRelease) -> PathBuf {
        self.root().join(AGENT_DIR).join(format!("hotswap-agent-{}.jar", r.version))
    }

    /// The downloaded HotswapAgent (the first pinned build present).
    pub fn hotswap_agent(&self) -> Option<HotReloadAgent> {
        AGENT_RELEASES.iter().find_map(|r| {
            let path = self.agent_file(r);
            path.is_file().then(|| HotReloadAgent { version: r.version.into(), path: path.into(), custom: false })
        })
    }

    /// Where launches' generated agent configurations go.
    pub fn hot_reload_dir(&self) -> PathBuf {
        self.root().join("hot-reload")
    }

    /// Downloads HotswapAgent (the first pinned build that downloads and verifies).
    pub fn install_hotswap_agent(&self, cancel: &CancellationToken, emit: Emit) -> IdeResult<HotReloadAgent> {
        if let Some(agent) = self.hotswap_agent() {
            emit(InstallEvent::Line { text: format!("HotswapAgent {} is already installed", agent.version) });
            return Ok(agent);
        }
        let _guard = InstallGuard::acquire("hotswap-agent")?;
        let http = Http::new(&self.system_path)?;
        let dir = self.root().join(AGENT_DIR);
        std::fs::create_dir_all(&dir)?;
        let mut last = None;
        for r in AGENT_RELEASES {
            emit(InstallEvent::Line { text: format!("Downloading HotswapAgent {} ({})", r.version, r.url) });
            let part = dir.join(format!(".hotswap-agent-{}.jar.part", r.version));
            let result = (|| {
                http.download(r.url, &part, None, cancel, emit)?;
                let actual = crate::sources::sha256_file(&part)?;
                if actual != r.sha256 {
                    return Err(IdeError::new(
                        ErrorKind::Io,
                        format!(
                            "checksum mismatch for HotswapAgent {}: expected {}, got {actual}",
                            r.version, r.sha256
                        ),
                    ));
                }
                emit(InstallEvent::Line { text: "Checksum verified (SHA-256)".into() });
                let target = self.agent_file(r);
                std::fs::rename(&part, &target)?;
                Ok(HotReloadAgent { version: r.version.into(), path: target.into(), custom: false })
            })();
            let _ = std::fs::remove_file(&part);
            match result {
                Ok(agent) => {
                    emit(InstallEvent::Line { text: format!("HotswapAgent {} installed", agent.version) });
                    return Ok(agent);
                }
                Err(e) if e.kind == ErrorKind::Cancelled => return Err(e),
                Err(e) => {
                    emit(InstallEvent::Line { text: format!("HotswapAgent {}: {}", r.version, e.message) });
                    last = Some(e);
                }
            }
        }
        Err(last.unwrap_or_else(|| IdeError::unavailable("no HotswapAgent build to download")))
    }

    /// Downloads JetBrains Runtime `major` into `<tools>/jdks/jbr-<version>` (where JDK
    /// discovery finds it), verifying its SHA-512. One already there is reused.
    pub fn install_jbr(&self, major: u32, cancel: &CancellationToken, emit: Emit) -> IdeResult<PathBuf> {
        let r =
            jbr_release(major).ok_or_else(|| IdeError::invalid(format!("no JetBrains Runtime for Java {major}")))?;
        if let Some(home) = self.jbr_home(r) {
            emit(InstallEvent::Line { text: format!("JetBrains Runtime {} is already installed", r.version) });
            return Ok(home);
        }
        let _guard = InstallGuard::acquire(&format!("jbr-{major}"))?;
        let http = Http::new(&self.system_path)?;
        let (name, url) = jbr_archive(r, self.platform);
        let target = self.jbr_target(r);
        let location = target.parent().map(Path::to_path_buf).unwrap_or_else(|| self.root().join("jdks"));
        std::fs::create_dir_all(&location)?;
        let staging = location.join(format!(".staging-{}", jdk_dir_name(JBR_VENDOR, r.version)));
        let _ = std::fs::remove_dir_all(&staging);
        std::fs::create_dir_all(&staging)?;
        emit(InstallEvent::Line { text: format!("Downloading {name} ({url})") });
        let result = (|| {
            let expected = parse_sha512(&http.get_text(&format!("{url}.checksum"), cancel)?)
                .ok_or_else(|| IdeError::new(ErrorKind::Protocol, format!("no SHA-512 published for {name}")))?;
            let archive_path = staging.join(&name);
            let size = http.content_length(&url, cancel);
            // A truncated transfer fails the checksum: once more from scratch before giving up.
            let mut verified = false;
            for attempt in 0..2 {
                if attempt > 0 {
                    emit(InstallEvent::Line { text: "Checksum mismatch; downloading again…".into() });
                    let _ = std::fs::remove_file(&archive_path);
                }
                http.download(&url, &archive_path, size, cancel, emit)?;
                if sha512_file(&archive_path)? == expected {
                    verified = true;
                    break;
                }
            }
            if !verified {
                return Err(IdeError::new(ErrorKind::Io, format!("checksum mismatch for {name}")));
            }
            emit(InstallEvent::Line { text: "Checksum verified (SHA-512)".into() });
            emit(InstallEvent::Line { text: "Extracting…".into() });
            let pkg = staging.join("pkg");
            archive::extract(&archive_path, archive::ArchiveKind::from_name(&name), &pkg, "java", cancel)?;
            let home = find_jdk_home(&pkg, self.platform)
                .ok_or_else(|| IdeError::new(ErrorKind::Io, format!("no JDK found in {name}")))?;
            if cancel.is_cancelled() {
                return Err(IdeError::cancelled());
            }
            if target.exists() {
                std::fs::remove_dir_all(&target)?;
            }
            let root = match home.strip_prefix(&pkg).ok().and_then(|rel| rel.components().next()) {
                Some(first) if first.as_os_str() != "Contents" => pkg.join(first),
                _ => pkg.clone(),
            };
            std::fs::rename(root, &target)?;
            clear_quarantine(&target);
            find_jdk_home(&target, self.platform)
                .ok_or_else(|| IdeError::new(ErrorKind::Io, format!("no JDK found in {}", target.display())))
        })();
        let _ = std::fs::remove_dir_all(&staging);
        let home = result?;
        emit(InstallEvent::Line { text: format!("JetBrains Runtime {} installed in {}", r.version, home.display()) });
        Ok(home)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MAC_ARM: Platform = Platform { os: Os::Mac, arch: Arch::Arm64 };
    const WIN_X64: Platform = Platform { os: Os::Windows, arch: Arch::X64 };

    #[test]
    fn picks_the_runtime_line() {
        assert_eq!(jbr_for(11), None);
        assert_eq!(jbr_for(17).unwrap().major, 17);
        assert_eq!(jbr_for(19).unwrap().major, 21);
        assert_eq!(jbr_for(21).unwrap().major, 21);
        assert_eq!(jbr_for(24).unwrap().major, 25);
        assert_eq!(jbr_for(26), None);
        assert!(jbr_release(25).unwrap().experimental);
        assert_eq!(jbr_release(DEFAULT_JBR_MAJOR).unwrap().version, "21.0.11");
    }

    #[test]
    fn names_the_archives() {
        let r = jbr_release(21).unwrap();
        assert_eq!(
            jbr_archive(r, MAC_ARM),
            (
                "jbrsdk-21.0.11-osx-aarch64-b1163.125.tar.gz".into(),
                "https://cache-redirector.jetbrains.com/intellij-jbr/jbrsdk-21.0.11-osx-aarch64-b1163.125.tar.gz"
                    .into()
            )
        );
        assert_eq!(jbr_archive(jbr_release(17).unwrap(), WIN_X64).0, "jbrsdk-17.0.14-windows-x64-b1367.22.tar.gz");
    }

    #[test]
    fn reads_checksums_and_versions() {
        let hex = "4b2769d097547b70df3cd8ff49d137579acb7fea874419052ec3450565665dc3262caa9a7a9f7e9ca611fd02650eb002845b3cd029cebc300eb00dd00ef45c43";
        assert_eq!(parse_sha512(&format!("{hex}  jbrsdk-21.0.11-osx-aarch64-b1163.125.tar.gz\n")).unwrap(), hex);
        assert_eq!(parse_sha512(&hex.to_uppercase()).unwrap(), hex);
        assert_eq!(parse_sha512("abc  x.tar.gz"), None);
        assert_eq!(java_major_of_release("IMPLEMENTOR=\"Azul\"\nJAVA_VERSION=\"21.0.10\"\n"), Some(21));
        assert_eq!(java_major_of_release("JAVA_VERSION=\"1.8.0_472\""), Some(8));
        assert_eq!(java_major_of_release("JAVA_VERSION=\"25\""), Some(25));
        assert_eq!(java_major_of_release("OS_NAME=Darwin"), None);
    }

    fn input<'a>(
        settings: &'a HotReloadSettings,
        project: Option<u32>,
        debug: bool,
        agent: bool,
        home: &'a dyn Fn(&JbrRelease) -> Option<PathBuf>,
        dirs: &'a [PathBuf],
    ) -> LaunchInput<'a> {
        LaunchInput {
            settings,
            project_major: project,
            debug,
            agent: agent.then(|| HotReloadAgent {
                version: "2.0.4-SNAPSHOT".into(),
                path: PathBuf::from("/tools/hotswap-agent/hotswap-agent-2.0.4-SNAPSHOT.jar").into(),
                custom: false,
            }),
            runtime_home: home,
            properties_file: Path::new("/tools/hot-reload/app.properties"),
            class_dirs: dirs,
            platform: MAC_ARM,
        }
    }

    #[test]
    fn plans_a_hotswap_agent_launch() {
        let s = HotReloadSettings { enabled: true, ..Default::default() };
        let installed = |r: &JbrRelease| Some(PathBuf::from(format!("/tools/jdks/jbr-{}/Contents/Home", r.version)));
        let (plan, props) = plan_launch(&input(&s, Some(21), false, true, &installed, &[]));
        assert_eq!(
            plan,
            HotReloadLaunch::Ready {
                engine: "hotswapAgent".into(),
                java_exec: Some("/tools/jdks/jbr-21.0.11/Contents/Home/bin/java".into()),
                vm_args: vec![
                    "-Dwatch.service.polling=true".into(),
                    "-XX:+AllowEnhancedClassRedefinition".into(),
                    "-XX:HotswapAgent=external".into(),
                    "-javaagent:/tools/hotswap-agent/hotswap-agent-2.0.4-SNAPSHOT.jar=autoHotswap=true,propertiesFilePath=/tools/hot-reload/app.properties".into(),
                    "-Dspring.devtools.restart.enabled=false".into(),
                ],
                runtime: "JetBrains Runtime 21.0.11".into(),
                major: Some(21),
            }
        );
        assert!(props.unwrap().contains("LOGGER=info\n"));
        // Gradle bootRun: jdtls' output joins the class path, which needs the class loaders opened.
        let dirs = [PathBuf::from("/work/app/bin/main")];
        let HotReloadLaunch::Ready { vm_args, .. } =
            plan_launch(&input(&s, Some(21), false, true, &installed, &dirs)).0
        else {
            panic!()
        };
        assert!(vm_args.contains(&"--add-opens=java.base/java.net=ALL-UNNAMED".to_owned()), "{vm_args:?}");
        assert!(vm_args.contains(&"--add-opens=java.base/jdk.internal.loader=ALL-UNNAMED".to_owned()));
        // Debugging: java-debug redefines; the agent only refreshes the frameworks.
        let (plan, _) = plan_launch(&input(&s, Some(17), true, true, &installed, &[]));
        let HotReloadLaunch::Ready { vm_args, java_exec, .. } = plan else { panic!("{plan:?}") };
        assert!(vm_args[3].contains("autoHotswap=false"));
        assert!(java_exec.unwrap().contains("jbr-17.0.14"));
    }

    #[test]
    fn asks_for_what_is_missing() {
        let s = HotReloadSettings { enabled: true, ..Default::default() };
        let none = |_: &JbrRelease| None;
        let some = |_: &JbrRelease| Some(PathBuf::from("/jbr"));
        assert_eq!(
            plan_launch(&input(&s, Some(19), false, true, &none, &[])).0,
            HotReloadLaunch::NeedsRuntime { major: 21, name: "JetBrains Runtime 21".into() }
        );
        assert_eq!(plan_launch(&input(&s, Some(21), false, false, &some, &[])).0, HotReloadLaunch::NeedsAgent);
        let HotReloadLaunch::Unsupported { reason } = plan_launch(&input(&s, Some(11), false, true, &some, &[])).0
        else {
            panic!()
        };
        assert!(reason.contains("Java 17 or newer"), "{reason}");
        assert!(matches!(
            plan_launch(&input(&s, None, false, true, &some, &[])).0,
            HotReloadLaunch::Unsupported { .. }
        ));
    }

    #[test]
    fn writes_the_agent_configuration() {
        let s = HotReloadSettings {
            disabled_plugins: vec!["Hibernate".into(), " Thymeleaf ".into(), "".into()],
            extra_classpath: vec!["/work/lib/classes".into()],
            watch_resources: vec!["C:\\work\\src\\main\\resources".into()],
            log_level: "bogus".into(),
            ..Default::default()
        };
        let props = agent_properties(&s, &[PathBuf::from("/work/app/bin/main")]);
        assert!(props.contains("LOGGER=info\n"), "{props}");
        assert!(props.contains("extraClasspath=/work/lib/classes,/work/app/bin/main\n"), "{props}");
        assert!(props.contains("watchResources=C:/work/src/main/resources,/work/app/bin/main\n"), "{props}");
        assert!(props.contains("disabledPlugins=Hibernate,Thymeleaf\n"), "{props}");
    }

    #[test]
    fn plans_a_jrebel_launch() {
        let dir = tempfile::tempdir().unwrap();
        let native = dir.path().join("libjrebel64.dylib");
        std::fs::write(&native, b"").unwrap();
        let jar = dir.path().join("jrebel.jar");
        std::fs::write(&jar, b"").unwrap();
        let none = |_: &JbrRelease| None;
        let mut s = HotReloadSettings {
            enabled: true,
            engine: ENGINE_JREBEL.into(),
            jrebel_agent_path: native.to_string_lossy().into_owned(),
            disable_devtools_restart: false,
            ..Default::default()
        };
        let (plan, props) = plan_launch(&input(&s, Some(11), false, false, &none, &[]));
        assert_eq!(props, None);
        assert_eq!(
            plan,
            HotReloadLaunch::Ready {
                engine: "jrebel".into(),
                java_exec: None,
                vm_args: vec![format!("-agentpath:{}", native.display())],
                runtime: "JRebel".into(),
                major: None,
            }
        );
        s.jrebel_agent_path = jar.to_string_lossy().into_owned();
        let HotReloadLaunch::Ready { vm_args, .. } = plan_launch(&input(&s, None, true, false, &none, &[])).0 else {
            panic!()
        };
        assert_eq!(vm_args, [format!("-javaagent:{}", jar.display())]);
        s.jrebel_agent_path = String::new();
        assert!(matches!(
            plan_launch(&input(&s, None, true, false, &none, &[])).0,
            HotReloadLaunch::Unsupported { .. }
        ));
        s.jrebel_agent_path = dir.path().join("missing.jar").to_string_lossy().into_owned();
        assert!(matches!(
            plan_launch(&input(&s, None, true, false, &none, &[])).0,
            HotReloadLaunch::Unsupported { .. }
        ));
    }
}
