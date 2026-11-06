//! Web browsers, like IDEA's "Open In › Browser" and the editor's browser popup.
//!
//! [`WebServer`] is the built-in server: it serves project files read-only, by
//! default on `127.0.0.1:63342`, so pages opened from the IDE load relative
//! scripts, styles and ES modules the way they would from a real server. Every
//! URL starts with a random per-run token unless unsigned requests are allowed,
//! and requests whose `Host` is not the server itself are refused (DNS
//! rebinding) unless it accepts external connections. Pages opened with a
//! reload mode get a script that reloads them, or swaps their style sheets,
//! when a file they loaded changes. [`launch`] starts a browser of the list
//! with its family's options and [`open_default`] the system default one.

mod browsers;
mod server;

pub use browsers::{
    FirefoxProfile, FirefoxProfiles, additional_parameters, firefox_profiles, launch, open_command, open_default,
};
pub use server::WebServer;
