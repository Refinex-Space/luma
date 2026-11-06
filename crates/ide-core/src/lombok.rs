//! Lombok (bundled plugin, on by default): the agent jdtls runs with, `lombok.config`
//! support and the Lombok inspections and refactorings of Java editors.

use serde::{Deserialize, Serialize};
use specta::Type;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(default, rename_all = "camelCase")]
pub struct LombokSettings {
    /// Off: jdtls runs without Luma's agent (an own `-javaagent` in its VM options still
    /// applies) and the editors offer no Lombok support.
    pub enabled: bool,
    /// A Lombok jar to use instead of the bundled one (jdtls agent and Delombok); empty: bundled.
    pub agent_path: String,
}

impl Default for LombokSettings {
    fn default() -> Self {
        Self { enabled: true, agent_path: String::new() }
    }
}
