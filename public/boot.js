/* global document, localStorage, window */
// Runs before the app's CSS loads: restores the last theme (theme.ts stores it)
// so a new window starts in it instead of flashing the light default.
// An external file because the CSP forbids inline scripts.
try {
  const root = document.documentElement;
  const addStyle = (id, css) => {
    const style = document.createElement("style");
    style.id = id;
    style.textContent = css;
    document.head.appendChild(style);
  };
  const last = JSON.parse(localStorage.getItem("luma.theme") ?? "null");
  if (last?.theme) root.dataset.theme = last.theme;
  if (last?.contrast) root.dataset.contrast = last.contrast;
  // A built-in palette theme (Solarized, One) over its light / dark base (tokens.css).
  if (typeof last?.colorTheme === "string" && /^[a-z][a-z0-9-]*$/.test(last.colorTheme))
    root.dataset.colorTheme = last.colorTheme;
  // A plugin theme's stylesheet (plugins/bridge.ts), so the workbench doesn't
  // show the built-in theme until the plugin host answers.
  const plugin = JSON.parse(localStorage.getItem("luma.pluginTheme") ?? "null");
  if (typeof plugin?.id === "string" && typeof plugin.css === "string" && !/[<\\]|url\(/i.test(plugin.css)) {
    addStyle("luma-plugin-theme", plugin.css);
    root.dataset.pluginTheme = plugin.id;
    root.dataset.pluginThemeKind = root.dataset.theme = plugin.kind === "light" ? "light" : "dark";
    delete root.dataset.contrast;
    delete root.dataset.colorTheme;
  }
  // The splash's frame, text and accent colours, resolved by theme.ts (splash.css).
  const colors = [
    ["--boot-frame", last?.frame],
    ["--boot-fg", last?.fg],
    ["--boot-accent", last?.accent],
  ].filter(([, v]) => typeof v === "string" && /^#[0-9a-f]{3,8}$/i.test(v));
  if (colors.length) addStyle("luma-boot-colors", `:root { ${colors.map(([k, v]) => `${k}: ${v};`).join(" ")} }`);
} catch {
  /* storage unavailable */
}
// Settings windows (`settings-<parent>`) load this page too: splash.css drops the logo for them.
if (window.__TAURI_INTERNALS__?.metadata?.currentWindow?.label?.startsWith("settings-")) {
  document.documentElement.dataset.window = "settings";
}
