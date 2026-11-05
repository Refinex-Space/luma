//! A language server's executable chosen in settings (Settings › Language Servers ›
//! Path, or the command of `languageServers.<name>`) that is really another known
//! tool: `tools.jdtls.path` pointing at `sqls.exe` runs sqls with jdtls' arguments,
//! which prints its usage and exits on every restart. Such a choice is reported
//! instead of launched.

use ide_language::LanguageServerConfig;

/// The file name without extension, lowercase (`C:\tools\sqls\bin\sqls.exe` → `sqls`).
fn stem(path: &str) -> Option<String> {
    let name = path.rsplit(['/', '\\']).next()?;
    let stem = match name.rsplit_once('.') {
        Some((stem, ext)) if matches!(ext.to_ascii_lowercase().as_str(), "exe" | "cmd" | "bat" | "ps1" | "sh") => stem,
        _ => name,
    };
    (!stem.is_empty()).then(|| stem.to_ascii_lowercase())
}

/// The known tool `path` runs when it is not server `server`'s own (`defined` is the
/// command its definition launches): its display name.
pub(crate) fn other_tool(server: &str, defined: &str, path: &str) -> Option<&'static str> {
    let stem = stem(path)?;
    let own = [server, defined].iter().filter_map(|c| self::stem(c)).any(|s| s == stem);
    if own {
        return None;
    }
    ide_tools::TOOLS
        .iter()
        .filter(|t| t.name != server && !t.commands[0].ends_with(".jar"))
        .find(|t| self::stem(t.commands[0]).as_deref() == Some(stem.as_str()))
        .map(|t| t.display)
}

/// After the settings overrides: refuses a command that runs another tool.
pub(crate) fn check(cfg: &mut LanguageServerConfig, defined: &str) {
    if cfg.command == defined || cfg.launch_error.is_some() {
        return;
    }
    if let Some(tool) = other_tool(&cfg.name, defined, &cfg.command) {
        cfg.launch_error = Some(format!(
            "The executable set for {name} is {tool} ({path}), not {name}. Choose {name}'s own executable in \
             Settings › Languages & Frameworks › Language Servers › {name}, or clear the path to find it automatically.",
            name = cfg.name,
            path = cfg.command,
        ));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_path_running_another_known_tool_is_refused() {
        assert_eq!(
            other_tool("jdtls", "jdtls", r"C:\Users\u\AppData\Local\luma\tools\sqls\bin\sqls.exe"),
            Some("sqls")
        );
        assert_eq!(other_tool("jdtls", "jdtls", "/opt/homebrew/bin/gopls"), Some("gopls"));
        // Its own launcher, under any extension or location.
        assert_eq!(other_tool("jdtls", "jdtls", r"D:\jdt\bin\jdtls.bat"), None);
        assert_eq!(other_tool("jdtls", "jdtls", "/usr/local/bin/jdtls"), None);
        // A wrapper of one's own, unknown to Luma, is the user's business.
        assert_eq!(other_tool("jdtls", "jdtls", "/home/u/bin/my-java-ls"), None);
        // A server launched under another command name than its own (the definition's).
        assert_eq!(other_tool("vtsls", "vtsls", "/x/vtsls.cmd"), None);
    }

    #[test]
    fn check_sets_the_launch_error_only_for_overridden_commands() {
        let mut cfg: LanguageServerConfig = toml::from_str("name = \"jdtls\"\ncommand = \"jdtls\"").unwrap();
        check(&mut cfg, "jdtls");
        assert!(cfg.launch_error.is_none());
        cfg.command = r"C:\tools\sqls\bin\sqls.exe".into();
        check(&mut cfg, "jdtls");
        let message = cfg.launch_error.unwrap();
        assert!(message.contains(r"is sqls (C:\tools\sqls\bin\sqls.exe), not jdtls"), "{message}");
    }
}
