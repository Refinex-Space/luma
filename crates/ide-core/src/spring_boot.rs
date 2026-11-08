//! Spring Boot (bundled plugin, on by default, after IDEA's Spring Boot plugin): configuration
//! file intelligence, Boot inspections, run configuration options and the Actuator views.

use serde::{Deserialize, Serialize};
use specta::Type;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(default, rename_all = "camelCase")]
pub struct SpringBootSettings {
    /// Off: no configuration file support, Boot checks or runtime views.
    pub enabled: bool,
    /// Names of configuration files besides `application` (IDEA's `spring.config.name` of
    /// Customize Spring Boot): `{name}.yml`, `{name}-{profile}.properties`.
    pub config_names: Vec<String>,
    /// More configuration files, project-relative (IDEA's custom configuration files).
    pub config_files: Vec<String>,
    /// Connects to running Boot applications with Actuator for their beans, health,
    /// mappings and environment.
    pub live_data: bool,
    /// Seconds between refreshes of the Health tab.
    pub health_refresh: u32,
    /// New Spring Boot run configurations disable the launch optimization.
    pub disable_launch_optimization: bool,
}

impl Default for SpringBootSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            config_names: Vec::new(),
            config_files: Vec::new(),
            live_data: true,
            health_refresh: 15,
            disable_launch_optimization: false,
        }
    }
}
