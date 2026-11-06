//! Build, Execution, Deployment › Debugger › HotSwap › Hot Reload: JRebel-class reloading of
//! running JVM applications (JetBrains Runtime's enhanced class redefinition with HotswapAgent,
//! or the user's own JRebel agent). A bundled plugin, off by default: nothing is downloaded or
//! injected into a launch while `enabled` is false.

use serde::{Deserialize, Serialize};
use specta::Type;

/// The engine that reloads: HotswapAgent on JetBrains Runtime (managed downloads).
pub const ENGINE_HOTSWAP_AGENT: &str = "hotswapAgent";
/// The user's own JRebel agent on the project's JDK.
pub const ENGINE_JREBEL: &str = "jrebel";

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(default, rename_all = "camelCase")]
pub struct HotReloadSettings {
    pub enabled: bool,
    /// [`ENGINE_HOTSWAP_AGENT`] | [`ENGINE_JREBEL`].
    pub engine: String,
    /// An own HotswapAgent jar; empty: the one the IDE downloads.
    pub agent_path: String,
    /// JRebel's agent: `libjrebel64.dylib` / `.so` / `.dll` (`-agentpath:`) or `jrebel.jar` (`-javaagent:`).
    pub jrebel_agent_path: String,
    /// HotswapAgent plugins not to load (`Hibernate`, `Thymeleaf`…).
    pub disabled_plugins: Vec<String>,
    /// More class directories to watch and load from (HotswapAgent `extraClasspath`).
    pub extra_classpath: Vec<String>,
    /// More resource directories to watch (HotswapAgent `watchResources`).
    pub watch_resources: Vec<String>,
    /// Spring Boot DevTools' restart class loader fights class redefinition: turned off for the run.
    pub disable_devtools_restart: bool,
    /// The editor's reload chip.
    pub editor_feedback: bool,
    /// Plain Run / Debug of Spring Boot configurations use hot reload.
    pub spring_boot_default: bool,
    /// HotswapAgent's `LOGGER` level: `error` | `warning` | `reload` | `info` | `debug`.
    pub log_level: String,
}

impl Default for HotReloadSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            engine: ENGINE_HOTSWAP_AGENT.into(),
            agent_path: String::new(),
            jrebel_agent_path: String::new(),
            disabled_plugins: Vec::new(),
            extra_classpath: Vec::new(),
            watch_resources: Vec::new(),
            disable_devtools_restart: true,
            editor_feedback: true,
            spring_boot_default: false,
            log_level: "info".into(),
        }
    }
}
