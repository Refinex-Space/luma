/**
 * Browsers of Settings › Tools › Web Browsers and Preview, the built-in server's URLs, and
 * per-file preview state.
 */
import { create } from "zustand";
import { executeAction } from "@/platform/actions";
import { call, commands, isTauri } from "@/platform/ipc";
import { webBrowserPrefs, type ConfiguredBrowser, type ReloadMode } from "@/platform/webBrowserSettings";
import { hasIcon } from "@/ui";
import { notifications } from "@/workbench/contributions";

/** Files a browser can show (Open In › Browser). */
export const isWebPath = (path: string) => /\.(html?|xhtml|shtml|svg|xml|xsl|xslt)$/i.test(path);
/** HTML files: the built-in preview, and the browser popup unless turned off. */
export const isHtmlPath = (path: string) => /\.(html?|xhtml|shtml)$/i.test(path);
/** XML files: the browser popup when turned on (IDEA's "For XML files"). */
export const isXmlPath = (path: string) => /\.(xml|xsl|xslt)$/i.test(path);

/** The icon of a browser: its family's, else a known name's, else a globe. */
export function browserIcon(b: Pick<ConfiguredBrowser, "family" | "name">): string {
  const named = b.name.toLowerCase().replace(/[^a-z]/g, "");
  for (const id of [named, b.family ?? ""]) if (id && hasIcon(`browser-${id}`)) return `browser-${id}`;
  return "web";
}

/** Paths shown with the built-in preview beside the editor. */
export const useWebPreview = create<Record<string, boolean>>(() => ({}));

export function togglePreview(path: string, on = !useWebPreview.getState()[path]) {
  useWebPreview.setState({ [path]: on });
}

/** The built-in server's URL for `path`, with the live reload script when `reload` asks for it. */
export function webUrl(path: string, reload: ReloadMode = "disabled"): Promise<string> {
  return call(commands.webUrl(path, reload));
}

/**
 * Saves all documents (the server reads the disk), then opens `path` in `browser` (an id of
 * the list) or the default browser, reloading as Settings › Reload behavior says.
 */
export async function openInBrowser(path: string, browser: string | null = null): Promise<void> {
  try {
    await executeAction("file.save");
    if (!isTauri()) throw new Error("Browsers open from the desktop app");
    const url = await webUrl(path, webBrowserPrefs().serverReloadMode);
    await call(commands.webOpen(url, browser));
  } catch (e) {
    notifications().notify({
      level: "error",
      title: "Cannot open the browser",
      body: e instanceof Error ? e.message : String(e),
      key: "web-open",
      actions: [{ label: "Configure Browsers…", run: () => void executeAction("file.settings", "tools.webBrowsers") }],
    });
  }
}
