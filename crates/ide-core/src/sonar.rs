//! SonarQube for IDE: its settings and the rules its analyzers report.

use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::BTreeMap;

/// Tools › SonarQube for IDE. The analysis engine is SonarSource's language
/// server, downloaded on demand; nothing runs while `enabled` is false.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, Type)]
#[serde(default, rename_all = "camelCase")]
pub struct SonarLintSettings {
    pub enabled: bool,
    /// Rules whose activation or parameters differ from Sonar's way, by key (`java:S1135`).
    pub rules: BTreeMap<String, SonarRuleSetting>,
    /// Glob of test files (`**/test/**`); empty: the analyzers' own detection.
    pub test_file_pattern: String,
    /// Comma-separated globs of files never analyzed.
    pub analysis_excludes: String,
    /// Node.js (22.12+) for JavaScript, TypeScript and CSS; empty: found on `PATH`.
    pub node_path: String,
    /// Extra JVM options of the analysis engine (`-Xmx2g`).
    pub vm_args: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(default, rename_all = "camelCase")]
pub struct SonarRuleSetting {
    /// `on` | `off`.
    pub level: String,
    pub parameters: BTreeMap<String, String>,
}

impl Default for SonarRuleSetting {
    fn default() -> Self {
        Self { level: "on".into(), parameters: BTreeMap::new() }
    }
}

/// One rule of the analyzers (`sonarlint/listAllRules`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SonarRule {
    pub key: String,
    pub name: String,
    /// The analyzer's language name (`Java`, `JavaScript`).
    pub language: String,
    pub active_by_default: bool,
}

/// A rule's description, as the engine renders it (`sonarlint/showRuleDescription`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SonarRuleDescription {
    pub key: String,
    pub name: String,
    /// Language key (`java`).
    pub language: String,
    /// The whole description when it has no tabs.
    pub html: String,
    /// "Why is this an issue?", "How can I fix it?", "More info".
    pub tabs: Vec<SonarRuleTab>,
    /// Standard mode: `BUG` | `VULNERABILITY` | `CODE_SMELL` | `SECURITY_HOTSPOT`.
    pub kind: Option<String>,
    /// Standard mode: `BLOCKER` … `INFO`.
    pub severity: Option<String>,
    /// Multi-quality mode: the clean code attribute (`CONVENTIONAL`) and its category.
    pub clean_code_attribute: Option<String>,
    pub clean_code_category: Option<String>,
    pub impacts: Vec<SonarImpact>,
    pub parameters: Vec<SonarRuleParameter>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SonarRuleTab {
    pub title: String,
    pub html: String,
    /// Framework-specific variants of the tab (`spring`, `jakarta`).
    pub contexts: Vec<SonarRuleContext>,
    pub default_context: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SonarRuleContext {
    pub key: String,
    pub name: String,
    pub html: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SonarImpact {
    /// `MAINTAINABILITY` | `RELIABILITY` | `SECURITY`.
    pub quality: String,
    /// `BLOCKER` | `HIGH` | `MEDIUM` | `LOW` | `INFO`.
    pub severity: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SonarRuleParameter {
    pub name: String,
    pub description: Option<String>,
    pub default_value: Option<String>,
}
