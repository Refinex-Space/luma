/**
 * Tools › Web Browsers and Preview (`settings.webBrowsers`, `settings.builtInServer`) with
 * every field present: the Settings dialog edits them, the web feature reads them. Mirrors
 * `ide-core::web_browsers` (IDEA's `WebBrowserManager` and `BuiltInServerOptions`).
 */
import { useMemo } from "react";
import { useProject } from "./project";

export type BrowserFamily = "chrome" | "firefox" | "safari";
export type ReloadMode = "disabled" | "onSave" | "onChange";

export const BROWSER_FAMILIES: readonly BrowserFamily[] = ["chrome", "firefox", "safari"];
export const FAMILY_NAMES: Record<BrowserFamily, string> = { chrome: "Chrome", firefox: "Firefox", safari: "Safari" };
export const RELOAD_MODES: readonly ReloadMode[] = ["disabled", "onSave", "onChange"];

export interface BrowserSpecificSettings {
  /** Chrome: extra command-line options. */
  commandLineOptions: string;
  /** Chrome: start with `--user-data-dir=<userDataDir>`. */
  useCustomProfile: boolean;
  userDataDir: string;
  /** Firefox: `profiles.ini`; empty: the default location. */
  profilesIniPath: string;
  /** Firefox: the profile to start with; empty: the default one. */
  profile: string;
}

export interface ConfiguredBrowser {
  id: string;
  name: string;
  family: BrowserFamily | null;
  /** An executable, or on macOS an application name. */
  path: string;
  active: boolean;
  settings: BrowserSpecificSettings;
}

export interface WebBrowserPrefs {
  browsers: ConfiguredBrowser[];
  /** Id of an active browser with a path; empty: the system default browser. */
  defaultBrowser: string;
  showHover: boolean;
  showHoverXml: boolean;
  serverReloadMode: ReloadMode;
  previewReloadMode: ReloadMode;
}

export interface BuiltInServerPrefs {
  port: number;
  availableExternally: boolean;
  allowUnsignedRequests: boolean;
}

export const CHROME_ID = "98CA6316-2F89-46D9-A9E5-FA9E2B0625B3";
export const FIREFOX_ID = "A7BB68E0-33C0-4D6F-A81A-AAC1FDB870C8";
export const SAFARI_ID = "E5120D43-2C3F-47EF-9F26-65E539E05186";
export const OPERA_ID = "53E2F627-B1A7-4DFA-BFA7-5B83CC034776";
export const EDGE_ID = "37cae5b9-e8b2-4949-9172-aafa37fbc09c";
export const PREDEFINED_IDS: readonly string[] = [CHROME_ID, FIREFOX_ID, SAFARI_ID, OPERA_ID, EDGE_ID];
export const DEFAULT_SERVER_PORT = 63342;
export const MIN_SERVER_PORT = 1024;
export const MAX_SERVER_PORT = 65535;

export const EMPTY_BROWSER_SETTINGS: BrowserSpecificSettings = {
  commandLineOptions: "",
  useCustomProfile: false,
  userDataDir: "",
  profilesIniPath: "",
  profile: "",
};

type Os = "macos" | "windows" | "linux";
function hostOs(): Os {
  const p = typeof navigator === "undefined" ? "" : navigator.platform || navigator.userAgent;
  return /Mac/i.test(p) ? "macos" : /Win/i.test(p) ? "windows" : "linux";
}

/** A family's default path: an application name on macOS, a command elsewhere. */
export function familyPath(family: BrowserFamily, os: Os = hostOs()): string {
  const paths: Record<BrowserFamily, Record<Os, string>> = {
    chrome: { macos: "Google Chrome", windows: "chrome", linux: "google-chrome" },
    firefox: { macos: "Firefox", windows: "firefox", linux: "firefox" },
    safari: { macos: "Safari", windows: "safari", linux: "" },
  };
  return paths[family][os];
}

export function predefinedBrowsers(os: Os = hostOs()): ConfiguredBrowser[] {
  const b = (id: string, family: BrowserFamily, name: string, path: string, active: boolean): ConfiguredBrowser => ({
    id,
    name,
    family,
    path,
    active,
    settings: { ...EMPTY_BROWSER_SETTINGS },
  });
  const edge = os === "windows" ? "msedge" : os === "macos" ? "Microsoft Edge" : "microsoft-edge";
  return [
    b(CHROME_ID, "chrome", "Chrome", familyPath("chrome", os), true),
    b(FIREFOX_ID, "firefox", "Firefox", familyPath("firefox", os), true),
    b(SAFARI_ID, "safari", "Safari", familyPath("safari", os), os === "macos"),
    b(OPERA_ID, "chrome", "Opera", os === "macos" ? "Opera" : "opera", false),
    b(EDGE_ID, "chrome", "Edge", edge, os === "windows"),
  ];
}

export const DEFAULT_WEB_BROWSERS: WebBrowserPrefs = {
  browsers: predefinedBrowsers(),
  defaultBrowser: "",
  showHover: true,
  showHoverXml: false,
  serverReloadMode: "onSave",
  previewReloadMode: "onSave",
};

export const DEFAULT_BUILT_IN_SERVER: BuiltInServerPrefs = {
  port: DEFAULT_SERVER_PORT,
  availableExternally: false,
  allowUnsignedRequests: false,
};

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});
const str = (v: unknown, d = "") => (typeof v === "string" ? v : d);
const bool = (v: unknown, d: boolean) => (typeof v === "boolean" ? v : d);
const mode = (v: unknown, d: ReloadMode): ReloadMode =>
  RELOAD_MODES.includes(v as ReloadMode) ? (v as ReloadMode) : d;

function validateBrowser(raw: unknown): ConfiguredBrowser | null {
  const v = obj(raw);
  const id = str(v.id).trim();
  if (!id) return null;
  const s = obj(v.settings);
  return {
    id,
    name: str(v.name),
    family: BROWSER_FAMILIES.includes(v.family as BrowserFamily) ? (v.family as BrowserFamily) : null,
    path: str(v.path),
    active: bool(v.active, true),
    settings: {
      commandLineOptions: str(s.commandLineOptions),
      useCustomProfile: bool(s.useCustomProfile, false),
      userDataDir: str(s.userDataDir),
      profilesIniPath: str(s.profilesIniPath),
      profile: str(s.profile),
    },
  };
}

export function validateWebBrowsers(raw: unknown): WebBrowserPrefs {
  const v = obj(raw);
  const d = DEFAULT_WEB_BROWSERS;
  const seen = new Set<string>();
  const browsers = Array.isArray(v.browsers)
    ? v.browsers.map(validateBrowser).filter((b): b is ConfiguredBrowser => !!b && !seen.has(b.id) && !!seen.add(b.id))
    : d.browsers.map((b) => ({ ...b, settings: { ...b.settings } }));
  return {
    browsers,
    defaultBrowser: str(v.defaultBrowser),
    showHover: bool(v.showHover, d.showHover),
    showHoverXml: bool(v.showHoverXml, d.showHoverXml),
    serverReloadMode: mode(v.serverReloadMode, d.serverReloadMode),
    previewReloadMode: mode(v.previewReloadMode, d.previewReloadMode),
  };
}

export function validateBuiltInServer(raw: unknown): BuiltInServerPrefs {
  const v = obj(raw);
  const port =
    typeof v.port === "number" && Number.isInteger(v.port) && v.port >= MIN_SERVER_PORT && v.port <= MAX_SERVER_PORT
      ? v.port
      : DEFAULT_SERVER_PORT;
  return {
    port,
    availableExternally: bool(v.availableExternally, false),
    allowUnsignedRequests: bool(v.allowUnsignedRequests, false),
  };
}

/** Browsers offered by Open In › Browser and the editor's browser popup (IDEA's `getActiveBrowsers`). */
export function activeBrowsers(prefs: WebBrowserPrefs): ConfiguredBrowser[] {
  return prefs.browsers.filter((b) => b.active);
}

/** The default browser: the chosen one when active with a path, else `null` (the system default). */
export function defaultBrowser(prefs: WebBrowserPrefs): ConfiguredBrowser | null {
  const b = prefs.defaultBrowser ? prefs.browsers.find((x) => x.id === prefs.defaultBrowser) : undefined;
  return b && b.active && b.path.trim() ? b : null;
}

let cachedRaw: unknown = Symbol("unset");
let cached = DEFAULT_WEB_BROWSERS;

/** The applied settings of this window. */
export function webBrowserPrefs(): WebBrowserPrefs {
  const raw = useProject.getState().settings?.webBrowsers;
  if (raw !== cachedRaw) {
    cachedRaw = raw;
    cached = validateWebBrowsers(raw);
  }
  return cached;
}

/** React hook: the applied settings. */
export function useWebBrowserPrefs(): WebBrowserPrefs {
  const raw = useProject((s) => s.settings?.webBrowsers);
  return useMemo(() => validateWebBrowsers(raw), [raw]);
}
