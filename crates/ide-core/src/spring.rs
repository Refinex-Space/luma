//! Spring (bundled plugin, on by default, after IDEA's Spring plugin): the Spring model of a
//! project's sources: beans, application contexts and autowiring, with their gutter navigation.

use serde::{Deserialize, Serialize};
use specta::Type;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(default, rename_all = "camelCase")]
pub struct SpringSettings {
    /// Off: no Spring model, gutter icons or checks.
    pub enabled: bool,
    /// Profiles the IDE analyses with (IDEA's "Change Active Spring Profiles"); empty: every
    /// profile may be active. Affects analysis only, not runs.
    pub active_profiles: Vec<String>,
    /// Beans of the libraries (auto-configuration), read from the classpath by the Java
    /// language server's Luma extension.
    pub library_beans: bool,
}

impl Default for SpringSettings {
    fn default() -> Self {
        Self { enabled: true, active_profiles: Vec::new(), library_beans: true }
    }
}
