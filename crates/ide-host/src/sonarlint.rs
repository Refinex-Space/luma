//! SonarQube for IDE in a project: the languages its engine serves and how it
//! starts. The engine (SonarSource's `sonarlint-ls` and analyzers, downloaded
//! on demand into `<tools>/sonarlint`) runs on a Java 21+ runtime, only while
//! Settings › Tools › SonarQube for IDE is on.

use ide_core::settings::Settings;
use ide_language::LanguageServerConfig;
use serde_json::{Value, json};
use std::path::{Path, PathBuf};

pub(crate) use ide_lsp::sonarlint::SERVER;

/// What the analyzers cover in standalone mode, by Luma language id. Secrets
/// detection makes configuration files worth analyzing too. C and C++ need
/// Sonar's separately downloaded CFamily analyzer, C# OmniSharp: left out.
pub(crate) const LANGUAGES: &[&str] = &[
    "java",
    "jsp",
    "javascript",
    "javascriptreact",
    "typescript",
    "typescriptreact",
    "vue",
    "css",
    "scss",
    "less",
    "html",
    "xml",
    "python",
    "php",
    "go",
    "yaml",
    "json",
    "dockerfile",
    "terraform",
    "properties",
    "dotenv",
    "shellscript",
];

/// The analyzers the engine loads (the set SonarSource's VS Code extension passes, without C#).
const ANALYZERS: &[&str] = &[
    "sonargo.jar",
    "sonarjava.jar",
    "sonarjavasymbolicexecution.jar",
    "sonarjs.jar",
    "sonarphp.jar",
    "sonarpython.jar",
    "sonarhtml.jar",
    "sonarxml.jar",
    "sonartext.jar",
    "sonariac.jar",
];

/// Rule languages of the catalog Luma never analyzes (no analyzer loaded, or no
/// files routed to the engine): left out of the rule list.
pub(crate) const UNANALYZED_RULE_LANGUAGES: &[&str] = &["C", "C++", "C#", "IPython Notebooks", "AzureResourceManager"];

pub(crate) const MIN_JAVA: u32 = 21;

/// Placeholder command: never on `PATH`, so a missing engine reports its install hint.
const NOT_INSTALLED: &str = "sonarlint-ls";
pub(crate) const INSTALL_HINT: &str =
    "The SonarQube for IDE analysis engine is not installed: Settings › Plugins › SonarQube for IDE";
pub(crate) const NO_JAVA: &str =
    "SonarQube for IDE needs Java 21 or newer: Settings › Plugins › SonarQube for IDE › Repair downloads one";

/// The unpacked extension: `server/sonarlint-ls.jar`, `analyzers/`, `eslint-bridge/`.
pub(crate) fn engine_dir(data_dir: &Path) -> PathBuf {
    ide_tools::tools_dir(data_dir).join(SERVER).join("extension")
}

fn server_jar(data_dir: &Path) -> PathBuf {
    engine_dir(data_dir).join("server").join("sonarlint-ls.jar")
}

pub(crate) fn installed(data_dir: &Path) -> bool {
    server_jar(data_dir).is_file()
}

/// The newest installed (or downloaded for language servers) Java 21+.
pub(crate) fn runtime(data_dir: &Path) -> Option<ide_sdk::java::Jdk> {
    ide_sdk::java::jdtls_jdks(MIN_JAVA, data_dir)
        .iter()
        .filter(|j| j.major >= MIN_JAVA && ide_sdk::java::java_executable(&j.home).is_file())
        .max_by_key(|j| j.major)
        .cloned()
}

/// The server definition before [`configure`] fills in the engine.
pub(crate) fn server() -> LanguageServerConfig {
    LanguageServerConfig {
        name: SERVER.to_owned(),
        command: NOT_INSTALLED.to_owned(),
        args: Vec::new(),
        env: Default::default(),
        root_markers: Vec::new(),
        require_root_marker: false,
        initialization_options: None,
        settings: None,
        install_hint: Some(INSTALL_HINT.to_owned()),
        connect: None,
        fallback: false,
        max_java: None,
        launch_error: None,
        tsserver_project: false,
    }
}

/// `servers` of `language` plus the engine while SonarQube for IDE is on.
pub(crate) fn with_engine(
    language: &str,
    mut servers: Vec<LanguageServerConfig>,
    settings: &Settings,
) -> Vec<LanguageServerConfig> {
    if settings.sonarlint.enabled && LANGUAGES.contains(&language) && !servers.iter().any(|s| s.name == SERVER) {
        servers.push(server());
    }
    servers
}

/// The `sonarlint` configuration section (`workspace/configuration`).
fn section(settings: &Settings) -> Value {
    let s = &settings.sonarlint;
    let rules: serde_json::Map<String, Value> = s
        .rules
        .iter()
        .map(|(key, rule)| {
            let mut v = json!({ "level": if rule.level == "off" { "off" } else { "on" } });
            if !rule.parameters.is_empty() {
                v["parameters"] = json!(rule.parameters);
            }
            (key.clone(), v)
        })
        .collect();
    let mut out = json!({
        "rules": rules,
        "testFilePattern": s.test_file_pattern.trim(),
        "analysisExcludesStandalone": s.analysis_excludes.trim(),
        "disableTelemetry": true,
        "focusOnNewCode": false,
        "automaticAnalysis": true,
        "output": { "showVerboseLogs": false, "showAnalyzerLogs": false },
        "connectedMode": { "connections": { "sonarqube": [], "sonarcloud": [] }, "project": {} },
    });
    if !s.node_path.trim().is_empty() {
        out["pathToNodeExecutable"] = json!(s.node_path.trim());
    }
    out
}

fn platform() -> (&'static str, &'static str) {
    let os = match std::env::consts::OS {
        "macos" => "darwin",
        "windows" => "win32",
        other => other,
    };
    let arch = match std::env::consts::ARCH {
        "aarch64" => "arm64",
        "x86_64" => "x64",
        other => other,
    };
    (os, arch)
}

/// What the engine reads at `initialize`, as SonarSource's VS Code client sends it.
fn initialization_options(settings: &Settings, data_dir: &Path, workspace: &str) -> Value {
    let (os, arch) = platform();
    let mut out = json!({
        "productKey": "luma",
        "productName": "Luma",
        "productVersion": env!("CARGO_PKG_VERSION"),
        "workspaceName": workspace,
        "telemetryStorage": ide_tools::tools_dir(data_dir).join(SERVER).join("usage"),
        "firstSecretDetected": false,
        "showVerboseLogs": false,
        "platform": os,
        "architecture": arch,
        "additionalAttributes": {},
        "enableNotebooks": false,
        "eslintBridgeServerPath": engine_dir(data_dir).join("eslint-bridge"),
        "connections": { "sonarqube": [], "sonarcloud": [] },
        "rules": section(settings)["rules"],
        "focusOnNewCode": false,
        "automaticAnalysis": true,
    });
    if !settings.sonarlint.node_path.trim().is_empty() {
        out["clientNodePath"] = json!(settings.sonarlint.node_path.trim());
    }
    out
}

/// `-Xmx2g "-Dkey=a b"` → its arguments.
fn split_vm_args(line: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut current = String::new();
    let mut quoted = false;
    for c in line.chars() {
        match c {
            '"' => quoted = !quoted,
            c if c.is_whitespace() && !quoted => {
                if !current.is_empty() {
                    out.push(std::mem::take(&mut current));
                }
            }
            c => current.push(c),
        }
    }
    if !current.is_empty() {
        out.push(current);
    }
    out
}

/// Points the server at the installed engine and a Java 21+ runtime, with the user's settings.
pub(crate) fn configure(cfg: &mut LanguageServerConfig, data_dir: &Path, root: &Path, settings: &Settings) {
    let workspace = root.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    cfg.settings = Some(json!({ SERVER: section(settings), "files": { "exclude": {} } }));
    cfg.initialization_options = toml::Value::try_from(initialization_options(settings, data_dir, &workspace)).ok();
    let jar = server_jar(data_dir);
    if !jar.is_file() {
        cfg.command = NOT_INSTALLED.to_owned();
        cfg.install_hint = Some(INSTALL_HINT.to_owned());
        return;
    }
    let Some(jdk) = runtime(data_dir) else {
        cfg.command = NOT_INSTALLED.to_owned();
        cfg.install_hint = Some(NO_JAVA.to_owned());
        cfg.launch_error = Some(NO_JAVA.to_owned());
        return;
    };
    let analyzers = engine_dir(data_dir).join("analyzers");
    let mut args = vec!["-Dsonarlint.telemetry.disabled=true".to_owned()];
    args.extend(split_vm_args(&settings.sonarlint.vm_args));
    args.extend(["-jar".to_owned(), jar.to_string_lossy().into_owned(), "-stdio".into(), "-analyzers".into()]);
    args.extend(
        ANALYZERS.iter().map(|a| analyzers.join(a)).filter(|p| p.is_file()).map(|p| p.to_string_lossy().into_owned()),
    );
    cfg.command = ide_sdk::java::java_executable(&jdk.home).to_string_lossy().into_owned();
    cfg.args = args;
    cfg.env.insert("JAVA_HOME".into(), jdk.home.to_string_lossy().into_owned());
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn attaches_to_the_analyzed_languages_only_while_enabled() {
        let mut settings = Settings::default();
        assert!(with_engine("java", Vec::new(), &settings).is_empty());
        settings.sonarlint.enabled = true;
        assert_eq!(with_engine("java", Vec::new(), &settings)[0].name, SERVER);
        assert!(with_engine("rust", Vec::new(), &settings).is_empty());
        // A definition already there (settings overrides) is not doubled.
        assert_eq!(with_engine("python", vec![server()], &settings).len(), 1);
    }

    #[test]
    fn settings_section_carries_rules_and_globs() {
        let mut settings = Settings::default();
        settings.sonarlint.rules.insert(
            "java:S1135".into(),
            ide_core::settings::SonarRuleSetting { level: "off".into(), parameters: Default::default() },
        );
        let mut params = std::collections::BTreeMap::new();
        params.insert("max".to_owned(), "5".to_owned());
        settings.sonarlint.rules.insert(
            "java:S107".into(),
            ide_core::settings::SonarRuleSetting { level: "on".into(), parameters: params },
        );
        settings.sonarlint.analysis_excludes = " **/gen/** ".into();
        let s = section(&settings);
        assert_eq!(s["rules"]["java:S1135"], json!({ "level": "off" }));
        assert_eq!(s["rules"]["java:S107"], json!({ "level": "on", "parameters": { "max": "5" } }));
        assert_eq!(s["analysisExcludesStandalone"], "**/gen/**");
        assert_eq!(s["disableTelemetry"], true);
        assert!(s.get("pathToNodeExecutable").is_none());
    }

    #[test]
    fn missing_engine_reports_the_install_hint() {
        let data = tempfile::tempdir().unwrap();
        let mut cfg = server();
        configure(&mut cfg, data.path(), Path::new("/p/shop"), &Settings::default());
        assert_eq!(cfg.command, NOT_INSTALLED);
        assert_eq!(cfg.install_hint.as_deref(), Some(INSTALL_HINT));
        let init = serde_json::to_value(cfg.initialization_options.unwrap()).unwrap();
        assert_eq!(init["productKey"], "luma");
        assert_eq!(init["workspaceName"], "shop");
        assert!(cfg.settings.unwrap()[SERVER]["rules"].is_object());
    }

    #[test]
    fn vm_args_keep_quoted_spaces() {
        assert_eq!(split_vm_args(r#" -Xmx2g  "-Dname=a b" -Dx"#), vec!["-Xmx2g", "-Dname=a b", "-Dx"]);
        assert!(split_vm_args("  ").is_empty());
    }
}

/// Against SonarSource's real engine: `LUMA_SONAR_DATA=<dir> cargo test -p ide-host
/// --lib sonarlint::real -- --ignored --nocapture` (downloads it into `<dir>` once).
#[cfg(test)]
mod real {
    use super::*;
    use ide_core::{CancellationToken, DocId, IdeEvent, LanguageId};
    use ide_language::LanguageRegistry;
    use ide_lsp::LspManager;
    use parking_lot::Mutex;
    use std::sync::Arc;
    use std::time::{Duration, Instant};

    const JAVA: &str = "package demo;\n\npublic class Demo {\n  // TODO remove this\n  public int f(int a) {\n    int unused = 1;\n    if (a == a) {\n      return 1;\n    }\n    return 0;\n  }\n}\n";
    const JS: &str = "function f(a) {\n  debugger;\n  if (a == a) { return 1; }\n  return 0;\n}\n";
    const PY: &str = "def f(a):\n    if a == a:\n        return 1\n    return 0\n";

    #[tokio::test(flavor = "multi_thread")]
    #[ignore = "downloads SonarSource's engine and runs it on a Java 21+ runtime"]
    async fn analyzes_java_javascript_and_python() {
        let _ = tracing_subscriber::fmt().with_max_level(tracing::Level::WARN).with_test_writer().try_init();
        let data = PathBuf::from(std::env::var("LUMA_SONAR_DATA").expect("LUMA_SONAR_DATA"));
        if !installed(&data) {
            let tools = ide_tools::Tools::new(&data);
            tools
                .install(SERVER, &[], &CancellationToken::new(), &|e| println!("install: {e:?}"))
                .expect("install the engine");
        }
        assert!(runtime(&data).is_some(), "no Java 21+ runtime");

        let dir = tempfile::tempdir().unwrap();
        let root = dunce::canonicalize(dir.path()).unwrap();
        let files = [("src/demo/Demo.java", "java", JAVA), ("web/app.js", "javascript", JS), ("tool.py", "python", PY)];
        for (rel, _, text) in files {
            std::fs::create_dir_all(root.join(rel).parent().unwrap()).unwrap();
            std::fs::write(root.join(rel), text).unwrap();
        }
        let mut settings = Settings::default();
        settings.sonarlint.enabled = true;
        let events: Arc<Mutex<Vec<IdeEvent>>> = Arc::default();
        let sink = {
            let events = events.clone();
            Arc::new(move |e: IdeEvent| events.lock().push(e))
        };
        let mgr = LspManager::new(root.clone(), Arc::new(LanguageRegistry::load(None).unwrap()), sink);
        let s = settings.clone();
        mgr.set_servers_hook(Box::new(move |language, _| with_engine(language.as_str(), Vec::new(), &s)));
        let (d, r, s) = (data.clone(), root.clone(), settings.clone());
        mgr.set_config_hook(Box::new(move |cfg, _| configure(cfg, &d, &r, &s)));
        let docs: Vec<(DocId, PathBuf)> = files
            .iter()
            .map(|(rel, language, text)| {
                let doc = DocId::next();
                mgr.did_open(doc, &root.join(rel), &LanguageId::new(*language), 1, text);
                (doc, root.join(rel))
            })
            .collect();

        let deadline = Instant::now() + Duration::from_secs(90);
        let issues = |path: &Path| {
            events.lock().iter().rev().find_map(|e| match e {
                IdeEvent::Diagnostics { path: p, source, items }
                    if source == SERVER && AsRef::<Path>::as_ref(p) == path && !items.is_empty() =>
                {
                    Some(items.clone())
                }
                _ => None,
            })
        };
        for (_, path) in &docs {
            loop {
                if let Some(items) = issues(path) {
                    for d in &items {
                        println!("{} {:?} {:?}: {}", path.display(), d.range.start, d.code, d.message);
                    }
                    break;
                }
                if Instant::now() > deadline {
                    let statuses: Vec<_> = events
                        .lock()
                        .iter()
                        .filter_map(|e| match e {
                            IdeEvent::LanguageServer { status, message, .. } => Some(format!("{status:?} {message:?}")),
                            _ => None,
                        })
                        .collect();
                    panic!("no issues for {}: {statuses:#?}", path.display());
                }
                tokio::time::sleep(Duration::from_millis(500)).await;
            }
        }
        let java = issues(&docs[0].1).unwrap();
        assert!(java.iter().any(|d| d.code.as_deref() == Some("java:S1135")), "TODO rule");
        assert!(
            issues(&docs[1].1).unwrap().iter().any(|d| d.code.as_deref().is_some_and(|c| c.starts_with("javascript:")))
        );
        assert!(
            issues(&docs[2].1).unwrap().iter().any(|d| d.code.as_deref().is_some_and(|c| c.starts_with("python:")))
        );

        // Quick fixes and the issue's details come back as code actions.
        let todo = java.iter().find(|d| d.code.as_deref() == Some("java:S1135")).unwrap();
        let actions = mgr.code_actions(docs[0].0, todo.range, Vec::new()).await.unwrap();
        for a in &actions {
            println!("action: {} {:?}", a.title, a.command.as_ref().map(|c| &c.command));
        }
        assert!(actions.iter().any(|a| a.command.as_ref().is_some_and(|c| c.command == "SonarLint.DeactivateRule")));
        // "Show issue details" runs in the engine, which answers with the rule for the UI.
        let details = actions
            .iter()
            .find(|a| a.command.as_ref().is_some_and(|c| c.command == "SonarLint.ShowIssueDetailsCodeAction"))
            .unwrap();
        mgr.execute_action_command(
            docs[0].0,
            details.server,
            details.command.clone().unwrap(),
            Vec::new(),
            CancellationToken::new(),
        )
        .await
        .unwrap();
        let shown = Instant::now() + Duration::from_secs(20);
        loop {
            let found = events.lock().iter().any(
                |e| matches!(e, IdeEvent::SonarRuleDescription { rule } if rule.key == "java:S1135" && !rule.tabs.is_empty()),
            );
            if found {
                break;
            }
            assert!(Instant::now() < shown, "no rule description event");
            tokio::time::sleep(Duration::from_millis(200)).await;
        }

        let rules = mgr.sonar_rules().await.unwrap();
        println!("{} rules, {} languages", rules.len(), {
            let mut l: Vec<_> = rules.iter().map(|r| r.language.as_str()).collect();
            l.dedup();
            l.len()
        });
        assert!(rules.iter().any(|r| r.key == "java:S1135"));
        let rule = mgr.sonar_rule_description("java:S1135").await.unwrap();
        println!("{}: {} tabs {:?} {:?}", rule.name, rule.tabs.len(), rule.impacts, rule.clean_code_attribute);
        assert!(!rule.tabs.is_empty() || !rule.html.is_empty());
        tokio::time::timeout(Duration::from_secs(20), mgr.shutdown_all()).await.unwrap();
    }
}
