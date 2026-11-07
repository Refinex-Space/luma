//! .env files support (bundled plugin, on by default, after JetBrains' ".env files"):
//! highlighting and checks of `.env` files, and completion, navigation and usages of the
//! environment variables they, `docker-compose.yml` and Dockerfiles declare.

use serde::{Deserialize, Serialize};
use specta::Type;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(default, rename_all = "camelCase")]
pub struct DotEnvSettings {
    /// Off: `.env` files are highlighted as properties and nothing else is offered.
    pub enabled: bool,
    /// Environment variables are completed in code (`getenv('…')`, `process.env.…`).
    pub completion: bool,
    /// Completion shows each variable's value (`DB_HOST = 127.0.0.1`); off for privacy.
    pub show_values: bool,
    /// Values in `.env` files start folded, as when sharing the screen.
    pub hide_values: bool,
}

impl Default for DotEnvSettings {
    fn default() -> Self {
        Self { enabled: true, completion: true, show_values: true, hide_values: false }
    }
}
