//! SonarQube for IDE: engine status and installation, the rule catalog and rule descriptions.
use crate::Host;
use crate::ops::Channel;
use crate::ops::tools::{join_err, languages, reconfigure_servers, tools};
use crate::rpc::Dispatcher;
use crate::sonarlint;
use ide_core::sonar::{SonarRule, SonarRuleDescription};
use ide_core::{IdeResult, RequestId};
use ide_tools::{InstallEvent, ToolStatus, Tools};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::path::Path;

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SonarStatus {
    /// The analysis engine is installed (SonarSource's package, unpacked).
    pub installed: bool,
    /// Its version (`6.2.0`).
    pub version: Option<String>,
    /// The Java 21+ it runs on: feature version and home.
    pub java: Option<SonarRuntime>,
    /// Node.js for JavaScript / TypeScript / CSS, when found.
    pub node: Option<SonarRuntime>,
}

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SonarRuntime {
    pub version: String,
    pub path: String,
}

/// Node.js the engine would use: the configured one, else the first on `PATH`.
fn node(configured: &str) -> Option<SonarRuntime> {
    let path = match configured.trim() {
        "" => ide_core::tool_path::find_command("node", &ide_core::tool_path::search_path(), Path::new("/"))?,
        p => Path::new(p).to_path_buf(),
    };
    let mut cmd = std::process::Command::new(&path);
    cmd.arg("--version").stdin(std::process::Stdio::null());
    let out = ide_core::process::prepare(&mut cmd).output().ok()?;
    let version = String::from_utf8_lossy(&out.stdout).trim().trim_start_matches('v').to_owned();
    (out.status.success() && !version.is_empty())
        .then(|| SonarRuntime { version, path: path.to_string_lossy().into_owned() })
}

fn status_of(tools: &Tools, langs: &[ide_language::LanguageConfig], data: &Path, node_path: &str) -> SonarStatus {
    let info = tools.info(sonarlint::SERVER, langs).ok();
    let installed = sonarlint::installed(data) && info.as_ref().is_some_and(|i| i.status == ToolStatus::Installed);
    SonarStatus {
        installed,
        version: info.and_then(|i| i.version).filter(|_| installed),
        java: sonarlint::runtime(data)
            .map(|j| SonarRuntime { version: j.major.to_string(), path: j.home.to_string_lossy().into_owned() }),
        node: node(node_path),
    }
}

/// Whether the engine and the runtimes it needs are there.
pub async fn sonar_status(host: &Host, window: &str) -> IdeResult<SonarStatus> {
    let settings = match host.project(window) {
        Ok(project) => project.settings.effective(),
        Err(_) => host.global_settings.effective(),
    };
    let node_path = settings.sonarlint.node_path;
    let (tools, langs, data) = (tools(host, window)?, languages(host, window), host.local_data_dir.clone());
    // The JDK scan and `node --version` touch the disk.
    tokio::task::spawn_blocking(move || status_of(&tools, &langs, &data, &node_path)).await.map_err(join_err)
}

/// Installs (or updates) the engine from Open VSX, then a Java 21 runtime when
/// none is installed, streaming progress; cancel with `cancel_request(request)`.
pub async fn sonar_install(
    host: &Host,
    window: &str,
    request: RequestId,
    on_event: Channel<InstallEvent>,
) -> IdeResult<SonarStatus> {
    let tools = tools(host, window)?;
    let langs = languages(host, window);
    let data = host.local_data_dir.clone();
    let cancel = host.begin_request(request);
    let result = tokio::task::spawn_blocking(move || {
        let emit = |e| {
            let _ = on_event.send(e);
        };
        tools.install(sonarlint::SERVER, &langs, &cancel, &emit)?;
        if sonarlint::runtime(&data).is_none() {
            emit(InstallEvent::Line { text: format!("Downloading a Java {} runtime…", sonarlint::MIN_JAVA) });
            tools.download_java_runtime(
                sonarlint::MIN_JAVA,
                &ide_sdk::java::language_server_runtimes_dir(&data),
                &cancel,
                &emit,
            )?;
            ide_sdk::java::rescan_jdks();
        }
        IdeResult::Ok(())
    })
    .await
    .map_err(join_err);
    host.end_request(request);
    result??;
    reconfigure_servers(host);
    sonar_status(host, window).await
}

/// Every rule of the installed analyzers (starts the engine when it isn't running).
pub async fn sonar_rules(host: &Host, window: &str) -> IdeResult<Vec<SonarRule>> {
    let mut rules = host.project(window)?.lsp.sonar_rules().await?;
    rules.retain(|r| !sonarlint::UNANALYZED_RULE_LANGUAGES.contains(&r.language.as_str()));
    Ok(rules)
}

/// The description of rule `key` (`java:S1135`).
pub async fn sonar_rule_description(host: &Host, window: &str, key: String) -> IdeResult<SonarRuleDescription> {
    host.project(window)?.lsp.sonar_rule_description(&key).await
}

/// Commands of this module the remote server answers.
pub(crate) fn register(d: &mut Dispatcher) {
    d.add("sonar_status", |c| async move { sonar_status(&c.host, &c.window).await });
    d.add("sonar_install", |c| async move {
        sonar_install(&c.host, &c.window, c.arg("request")?, c.sender("onEvent")?).await
    });
    d.add("sonar_rules", |c| async move { sonar_rules(&c.host, &c.window).await });
    d.add("sonar_rule_description", |c| async move { sonar_rule_description(&c.host, &c.window, c.arg("key")?).await });
}
