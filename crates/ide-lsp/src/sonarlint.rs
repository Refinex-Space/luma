//! SonarQube for IDE: the client side of SonarSource's language server
//! (`sonarlint-ls`), standalone mode. Answers its `sonarlint/*` requests (which
//! files to analyze, the Java classpath from jdtls), turns its progress into
//! tasks, and asks it for the rule catalog and rule descriptions.

use crate::LspManager;
use crate::server::{Running, Server};
use crate::uri::{path_to_uri_string, uri_to_path};
use globset::{GlobBuilder, GlobSet, GlobSetBuilder};
use ide_core::sonar::{
    SonarImpact, SonarRule, SonarRuleContext, SonarRuleDescription, SonarRuleParameter, SonarRuleTab,
};
use ide_core::{CancellationToken, IdeError, IdeEvent, IdeResult, LanguageId};
use serde_json::{Value, json};
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

pub const SERVER: &str = "sonarlint";

/// A Java file's configuration: the analyzer waits a minute at most.
const JAVA_CONFIG_TIMEOUT: Duration = Duration::from_secs(50);
/// Starting the engine (a JVM loading every analyzer) before the first answer.
const READY_TIMEOUT: Duration = Duration::from_secs(90);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
/// `language/eventNotification` type of jdtls' classpath changes.
const JDTLS_CLASSPATH_UPDATED: u64 = 100;

const COMPLIANCE: &str = "org.eclipse.jdt.core.compiler.compliance";
const VM_LOCATION: &str = "org.eclipse.jdt.ls.core.vm.location";

/// The `sonarlint` settings section the server was configured with.
fn section(server: &Server) -> Value {
    let all = crate::handler::all_settings(&server.effective_config());
    all.get(SERVER).cloned().unwrap_or(Value::Null)
}

/// Comma-separated globs (`**/generated/**, *.min.js`); relative ones match below the root.
fn glob_set(patterns: &str) -> Option<GlobSet> {
    let mut builder = GlobSetBuilder::new();
    let mut any = false;
    for p in patterns.split(',').map(str::trim).filter(|p| !p.is_empty()) {
        let anchored = if p.starts_with('/') || p.starts_with("**") { p.to_owned() } else { format!("**/{p}") };
        if let Ok(glob) = GlobBuilder::new(&anchored).literal_separator(true).build() {
            builder.add(glob);
            any = true;
        }
    }
    any.then(|| builder.build().ok()).flatten()
}

fn excluded(set: Option<&GlobSet>, root: &Path, path: &Path) -> bool {
    let Some(set) = set else { return false };
    set.is_match(path) || path.strip_prefix(root).is_ok_and(|rel| set.is_match(rel))
}

/// Files of `uris` not matching the analysis excludes.
pub(crate) fn not_excluded(server: &Server, uris: Vec<String>) -> Vec<String> {
    let patterns = section(server)["analysisExcludesStandalone"].as_str().unwrap_or_default().to_owned();
    let set = glob_set(&patterns);
    uris.into_iter().filter(|u| uri_to_path(u).is_none_or(|p| !excluded(set.as_ref(), &server.root, &p))).collect()
}

/// Ignored by Git: the `.gitignore` files from the repository root down to the
/// file, and `.git/info/exclude`. Outside a repository, nothing is.
pub(crate) fn ignored_by_scm(path: &Path) -> bool {
    let Some(repo) = path.ancestors().skip(1).find(|d| d.join(".git").exists()) else { return false };
    let mut builder = ignore::gitignore::GitignoreBuilder::new(repo);
    let _ = builder.add(repo.join(".git").join("info").join("exclude"));
    let mut dirs: Vec<&Path> = path.ancestors().skip(1).take_while(|d| d.starts_with(repo)).collect();
    dirs.reverse();
    for dir in dirs {
        let file = dir.join(".gitignore");
        if file.is_file() {
            let _ = builder.add(file);
        }
    }
    builder.build().is_ok_and(|g| g.matched_path_or_any_parents(path, false).is_ignore())
}

/// `sonarlint/showRuleDescription` → the UI's description.
pub(crate) fn rule_description(v: &Value) -> Option<SonarRuleDescription> {
    let s = |v: &Value, k: &str| v.get(k).and_then(Value::as_str).map(str::to_owned);
    let tabs = v
        .get("htmlDescriptionTabs")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .map(|t| {
            let contexts: Vec<SonarRuleContext> = t
                .get("ruleDescriptionTabContextual")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .map(|c| SonarRuleContext {
                    key: s(c, "contextKey").unwrap_or_default(),
                    name: s(c, "displayName").unwrap_or_default(),
                    html: s(c, "htmlContent").unwrap_or_default(),
                })
                .collect();
            SonarRuleTab {
                title: s(t, "title").unwrap_or_default(),
                html: t.get("ruleDescriptionTabNonContextual").and_then(|n| s(n, "htmlContent")).unwrap_or_default(),
                default_context: s(t, "defaultContextKey").filter(|_| !contexts.is_empty()),
                contexts,
            }
        })
        .collect();
    let details = v.get("severityDetails").cloned().unwrap_or(Value::Null);
    let mut impacts: Vec<SonarImpact> = details
        .get("impacts")
        .and_then(Value::as_object)
        .into_iter()
        .flatten()
        .filter_map(|(quality, severity)| {
            Some(SonarImpact { quality: quality.clone(), severity: severity.as_str()?.to_owned() })
        })
        .collect();
    impacts.sort_by(|a, b| a.quality.cmp(&b.quality));
    Some(SonarRuleDescription {
        key: s(v, "key")?,
        name: s(v, "name").unwrap_or_default(),
        language: s(v, "languageKey").unwrap_or_default(),
        html: s(v, "htmlDescription").unwrap_or_default(),
        tabs,
        kind: s(&details, "type"),
        severity: s(&details, "severity"),
        clean_code_attribute: s(&details, "cleanCodeAttribute"),
        clean_code_category: s(&details, "cleanCodeAttributeCategory"),
        impacts,
        parameters: v
            .get("parameters")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|p| {
                Some(SonarRuleParameter {
                    name: s(p, "name")?,
                    description: s(p, "description").filter(|d| !d.is_empty()),
                    default_value: s(p, "defaultValue").filter(|d| !d.is_empty()),
                })
            })
            .collect(),
    })
}

/// `sonarlint/listAllRules`: rules by language name.
pub(crate) fn rules(v: &Value) -> Vec<SonarRule> {
    let mut out: Vec<SonarRule> = v
        .as_object()
        .into_iter()
        .flatten()
        .flat_map(|(language, list)| {
            list.as_array().into_iter().flatten().filter_map(move |r| {
                Some(SonarRule {
                    key: r.get("key")?.as_str()?.to_owned(),
                    name: r.get("name").and_then(Value::as_str).unwrap_or_default().to_owned(),
                    language: language.clone(),
                    active_by_default: r.get("activeByDefault").and_then(Value::as_bool).unwrap_or(false),
                })
            })
        })
        .collect();
    out.sort_by(|a, b| (&a.language, &a.name, &a.key).cmp(&(&b.language, &b.name, &b.key)));
    out
}

/// A request whose only parameter is a string (a file URI): lsp4j sends it as `["…"]`.
fn single_str(params: &Value) -> Option<&str> {
    params.as_str().or_else(|| params.as_array()?.first()?.as_str())
}

impl LspManager {
    /// A `sonarlint/*` request of the engine; `None` for one Luma doesn't know.
    pub(crate) fn sonar_request(&self, server: &Server, method: &str, params: Value) -> Option<Value> {
        Some(match method {
            "sonarlint/shouldAnalyseFile" => {
                let uri = params.get("uri").and_then(Value::as_str).unwrap_or_default().to_owned();
                let open = uri_to_path(&uri).is_some_and(|p| self.docs.lock().values().any(|d| d.path == p));
                if !open {
                    json!({ "shouldBeAnalysed": false, "reason": "Skipping analysis of a file not open in the editor: " })
                } else {
                    let analyse = !not_excluded(server, vec![uri]).is_empty();
                    json!({ "shouldBeAnalysed": analyse, "reason": "Skipping analysis of an excluded file: " })
                }
            }
            "sonarlint/filterOutExcludedFiles" => {
                let uris: Vec<String> = params
                    .get("fileUris")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect();
                json!({ "fileUris": not_excluded(server, uris) })
            }
            "sonarlint/isIgnoredByScm" => {
                json!(single_str(&params).and_then(uri_to_path).is_some_and(|p| ignored_by_scm(&p)))
            }
            "sonarlint/isOpenInEditor" => {
                let path = single_str(&params).and_then(uri_to_path);
                json!(path.is_some_and(|p| self.docs.lock().values().any(|d| d.path == p)))
            }
            "sonarlint/getJavaConfig" => {
                let path = single_str(&params).and_then(uri_to_path)?;
                // The project model's view first: the analyzer must not wait for jdtls's import.
                let hook = self.java_config_hook.read().clone();
                if let Some(config) = hook.and_then(|h| h(&path)) {
                    return Some(config);
                }
                self.runtime.block_on(async {
                    tokio::time::timeout(JAVA_CONFIG_TIMEOUT, self.sonar_java_config(&path))
                        .await
                        .ok()
                        .flatten()
                        .unwrap_or(Value::Null)
                })
            }
            // Connected-mode binding files: none, Luma runs the engine standalone.
            "sonarlint/listFilesInFolder" => json!({ "foundFiles": [] }),
            // Node.js too old or missing for JavaScript: say so (once per message).
            "sonarlint/canShowMissingRequirementsNotification" => json!("full"),
            "sonarlint/hasJoinedIdeLabs" | "sonarlint/askSslCertificateConfirmation" => json!(false),
            "sonarlint/getTokenForServer" => Value::Null,
            _ => return None,
        })
    }

    /// What `sonarlint/getJavaConfig` answers for `path`: jdtls' view of its project.
    async fn sonar_java_config(&self, path: &Path) -> Option<Value> {
        let cancel = CancellationToken::new();
        let uri = path_to_uri_string(path);
        let is_test = self
            .jdtls_project_command(path, "java.project.isTestFile", vec![json!(uri)], &cancel)
            .await
            .ok()
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        let settings = self
            .jdtls_project_command(
                path,
                "java.project.getSettings",
                vec![json!(uri), json!([COMPLIANCE, VM_LOCATION])],
                &cancel,
            )
            .await
            .unwrap_or(Value::Null);
        let options = json!({ "scope": if is_test { "test" } else { "runtime" } }).to_string();
        let classpath = self
            .jdtls_project_command(path, "java.project.getClasspaths", vec![json!(uri), json!(options)], &cancel)
            .await
            .map_err(|e| tracing::debug!("{SERVER}: no classpath for {}: {e}", path.display()))
            .ok()?;
        Some(json!({
            "projectRoot": classpath.get("projectRoot"),
            "sourceLevel": settings.get(COMPLIANCE),
            "classpath": classpath.get("classpaths").cloned().unwrap_or_else(|| json!([])),
            "isTest": is_test,
            "vmLocation": settings.get(VM_LOCATION).filter(|v| v.as_str().is_some_and(|s| !s.is_empty())),
        }))
    }

    /// `sonarlint/showRuleDescription`: answers whoever asked for that rule, else the UI shows it.
    pub(crate) fn sonar_rule_shown(&self, params: &Value) {
        let Some(rule) = rule_description(params) else { return };
        let waiting = self.sonar_rule_waiters.lock().remove(&rule.key).unwrap_or_default();
        if waiting.is_empty() {
            self.sink.emit(IdeEvent::SonarRuleDescription { rule });
            return;
        }
        for tx in waiting {
            let _ = tx.send(rule.clone());
        }
    }

    /// jdtls changed a project's classpath: the engine re-reads it.
    pub(crate) fn sonar_classpath_updated(&self, params: &Value) {
        if params.get("eventType").and_then(Value::as_u64) != Some(JDTLS_CLASSPATH_UPDATED) {
            return;
        }
        let Some(project) = params.get("data").and_then(Value::as_str) else { return };
        for server in self.servers.lock().iter().filter(|s| s.name == SERVER) {
            if let Some(run) = server.running() {
                let _ = run.peer.notify("sonarlint/didClasspathUpdate", json!({ "projectUri": project }));
            }
        }
    }

    /// The engine serving this project, started if needed: it runs while
    /// SonarQube for IDE is on, attached to the languages it analyzes.
    async fn sonar(&self) -> IdeResult<(Arc<Server>, Running)> {
        let existing = self.servers.lock().iter().find(|s| s.name == SERVER && s.root == self.project_root).cloned();
        let server = match existing {
            Some(s) => s,
            None => {
                let found = self.languages.all().into_iter().find_map(|l| {
                    let language: LanguageId = l.id;
                    let cfg = self.language_servers(&language).into_iter().find(|c| c.name == SERVER)?;
                    Some(self.server_for(&cfg, &language, &self.project_root))
                });
                found.ok_or_else(|| IdeError::unavailable("SonarQube for IDE is turned off"))?
            }
        };
        self.ensure_started(&server);
        match server.wait_ready(READY_TIMEOUT).await {
            Some(run) => Ok((server, run)),
            None => Err(IdeError::unavailable(
                server.status_message().unwrap_or_else(|| "SonarQube for IDE is not running".to_owned()),
            )),
        }
    }

    /// Starts this project's engine in the background: loading every analyzer takes the JVM
    /// seconds, which the first file opened should not wait for.
    pub fn prewarm_sonar(&self) {
        let Some(me) = self.me.upgrade() else { return };
        self.runtime.spawn(async move {
            match me.sonar().await {
                Ok(_) => tracing::debug!("{SERVER}: prewarmed"),
                Err(e) => tracing::debug!("{SERVER}: not prewarmed: {}", e.message),
            }
        });
    }

    /// Every rule of the installed analyzers.
    pub async fn sonar_rules(&self) -> IdeResult<Vec<SonarRule>> {
        let (server, run) = self.sonar().await?;
        let v = tokio::time::timeout(
            REQUEST_TIMEOUT,
            run.peer.request::<_, Value>("sonarlint/listAllRules", json!({}), None),
        )
        .await
        .unwrap_or(Err(ide_jsonrpc::RpcError::Timeout))
        .map_err(|e| crate::rpc_err(&server.name, "sonarlint/listAllRules", e))?;
        Ok(rules(&v))
    }

    /// The description of rule `key` (`java:S1135`).
    pub async fn sonar_rule_description(&self, key: &str) -> IdeResult<SonarRuleDescription> {
        let (server, run) = self.sonar().await?;
        let (tx, rx) = tokio::sync::oneshot::channel();
        self.sonar_rule_waiters.lock().entry(key.to_owned()).or_default().push(tx);
        let params = json!({ "command": "SonarLint.OpenStandaloneRuleDesc", "arguments": [key] });
        let sent = tokio::time::timeout(
            REQUEST_TIMEOUT,
            run.peer.request::<_, Value>("workspace/executeCommand", params, None),
        )
        .await
        .unwrap_or(Err(ide_jsonrpc::RpcError::Timeout));
        if let Err(e) = sent {
            self.sonar_rule_waiters.lock().remove(key);
            return Err(crate::rpc_err(&server.name, "workspace/executeCommand", e));
        }
        match tokio::time::timeout(REQUEST_TIMEOUT, rx).await {
            Ok(Ok(rule)) => Ok(rule),
            _ => {
                self.sonar_rule_waiters.lock().remove(key);
                Err(IdeError::not_found(format!("SonarQube for IDE has no rule `{key}`")))
            }
        }
    }
}

/// Paths below `root` in `paths`, for tests.
#[cfg(test)]
fn under(root: &Path, paths: &[&str]) -> Vec<std::path::PathBuf> {
    paths.iter().map(|p| root.join(p)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn single_string_parameters_come_bare_or_wrapped() {
        assert_eq!(single_str(&json!("file:///a")), Some("file:///a"));
        assert_eq!(single_str(&json!(["file:///a"])), Some("file:///a"));
        assert_eq!(single_str(&json!({})), None);
    }

    #[test]
    fn excludes_match_relative_and_absolute_globs() {
        let root = Path::new("/p");
        let set = glob_set("**/generated/**, *.min.js ,, /abs/**");
        let [gen_file, min, abs, kept] =
            under(root, &["a/generated/X.java", "web/app.min.js", "x", "src/A.java"]).try_into().unwrap();
        assert!(excluded(set.as_ref(), root, &gen_file));
        assert!(excluded(set.as_ref(), root, &min));
        assert!(!excluded(set.as_ref(), root, &abs));
        assert!(excluded(set.as_ref(), root, Path::new("/abs/y.py")));
        assert!(!excluded(set.as_ref(), root, &kept));
        assert!(!excluded(glob_set(" ").as_ref(), root, &kept));
    }

    #[test]
    fn gitignore_rules_from_the_repository_down() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join(".git/info")).unwrap();
        std::fs::create_dir_all(root.join("web/dist")).unwrap();
        std::fs::write(root.join(".gitignore"), "target/\n").unwrap();
        std::fs::write(root.join("web/.gitignore"), "dist/\n").unwrap();
        std::fs::write(root.join(".git/info/exclude"), "*.local\n").unwrap();
        assert!(ignored_by_scm(&root.join("target/A.class")));
        assert!(ignored_by_scm(&root.join("web/dist/app.js")));
        assert!(ignored_by_scm(&root.join("notes.local")));
        assert!(!ignored_by_scm(&root.join("web/src/app.js")));
        assert!(!ignored_by_scm(&std::env::temp_dir().join("luma-no-repo/a.js")));
    }

    #[test]
    fn reads_rule_descriptions_in_both_modes() {
        let mqr = json!({
            "key": "java:S1135", "name": "Track uses of \"TODO\" tags", "languageKey": "java",
            "htmlDescription": "", "isTaint": false,
            "htmlDescriptionTabs": [
                { "title": "Why is this an issue?", "ruleDescriptionTabNonContextual": { "htmlContent": "<p>why</p>" },
                  "hasContextualInformation": false },
                { "title": "How can I fix it?", "hasContextualInformation": true, "defaultContextKey": "spring",
                  "ruleDescriptionTabContextual": [{ "htmlContent": "<p>spring</p>", "contextKey": "spring", "displayName": "Spring" }] }
            ],
            "parameters": [{ "name": "max", "description": "", "defaultValue": "10" }],
            "severityDetails": { "cleanCodeAttribute": "COMPLETE", "cleanCodeAttributeCategory": "INTENTIONAL",
                                 "impacts": { "MAINTAINABILITY": "INFO" } }
        });
        let d = rule_description(&mqr).unwrap();
        assert_eq!((d.key.as_str(), d.language.as_str()), ("java:S1135", "java"));
        assert_eq!(d.tabs.len(), 2);
        assert_eq!(d.tabs[0].html, "<p>why</p>");
        assert_eq!(d.tabs[0].default_context, None);
        assert_eq!(d.tabs[1].contexts[0].name, "Spring");
        assert_eq!(d.tabs[1].default_context.as_deref(), Some("spring"));
        assert_eq!(d.clean_code_attribute.as_deref(), Some("COMPLETE"));
        assert_eq!(d.impacts, vec![SonarImpact { quality: "MAINTAINABILITY".into(), severity: "INFO".into() }]);
        assert_eq!(d.parameters[0].description, None);
        assert_eq!(d.parameters[0].default_value.as_deref(), Some("10"));

        let standard = json!({ "key": "py:S1", "name": "n", "htmlDescription": "<p>x</p>",
                               "severityDetails": { "type": "BUG", "severity": "MAJOR" } });
        let d = rule_description(&standard).unwrap();
        assert_eq!((d.kind.as_deref(), d.severity.as_deref()), (Some("BUG"), Some("MAJOR")));
        assert!(d.impacts.is_empty() && d.tabs.is_empty());
        assert!(rule_description(&json!({ "name": "no key" })).is_none());
    }

    #[test]
    fn lists_rules_by_language_and_name() {
        let v = json!({
            "Python": [{ "key": "python:S2", "name": "B", "activeByDefault": false }],
            "Java": [{ "key": "java:S9", "name": "Z", "activeByDefault": true }, { "key": "java:S1", "name": "A" }],
        });
        let keys: Vec<_> = rules(&v).into_iter().map(|r| (r.language, r.key, r.active_by_default)).collect();
        assert_eq!(
            keys,
            vec![
                ("Java".into(), "java:S1".into(), false),
                ("Java".into(), "java:S9".into(), true),
                ("Python".into(), "python:S2".into(), false),
            ]
        );
    }
}
