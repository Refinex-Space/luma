/**
 * Web browsers (IDEA's Open In › Browser, the editor's browser popup and Settings › Tools ›
 * Web Browsers and Preview): HTML, XML and SVG files open in a browser of the list through
 * the built-in server, HTML files get a built-in preview beside the editor, and pages reload
 * as the settings say. ⌃⇧R in an HTML editor opens the default browser, like IDEA's Run for
 * HTML files.
 */
import { EditorView } from "@codemirror/view";
import { registerActions } from "@/platform/actions";
import { getContext } from "@/platform/context";
import { call, commands, isTauri } from "@/platform/ipc";
import { basename } from "@/platform/project";
import { activeBrowsers, webBrowserPrefs } from "@/platform/webBrowserSettings";
import { registerEditorContribution, whenSynced } from "@/editor/api";
import { lazyComponent, type MenuItem } from "@/ui";
import {
  maybeEditorService,
  registerMenuGroup,
  registerSettingsPage,
  registerTextEditorWrapper,
} from "@/workbench/contributions";
import { browserIcon, isHtmlPath, isWebPath, isXmlPath, openInBrowser, togglePreview, useWebPreview } from "./browsers";
import { tx } from "@/platform/i18n";

export const SETTINGS_PAGE = "tools.webBrowsers";

interface OpenArg {
  path?: string;
  browser?: string;
}

function targetPath(arg: unknown): string | null {
  if (typeof arg === "string") return arg;
  const path = (arg as OpenArg | undefined)?.path ?? getContext().editorPath;
  return typeof path === "string" ? path : null;
}

async function showPreview(path: string) {
  await maybeEditorService()?.openFile(path, { focus: true });
  togglePreview(path, true);
}

/** Open In › Browser: the default browser, the built-in preview (HTML), then the active browsers. */
function browserMenu(path: string): MenuItem {
  return {
    label: "Browser",
    icon: "web",
    submenu: [
      { kind: "action", action: "web.openInBrowser", arg: { path }, label: "Default" },
      { kind: "separator" },
      ...(isHtmlPath(path) ? [{ label: "Built-in Preview", icon: "eye", run: () => void showPreview(path) }] : []),
      ...activeBrowsers(webBrowserPrefs()).map((b): MenuItem => ({
        label: b.name,
        verbatim: true,
        icon: browserIcon(b),
        run: () => void openInBrowser(path, b.id),
      })),
    ],
  };
}

export function activateSettingsPages(): () => void {
  return registerSettingsPage({
    id: SETTINGS_PAGE,
    title: "Web Browsers and Preview",
    group: "Tools",
    order: 603,
    keywords: [
      "browser",
      "chrome",
      "firefox",
      "safari",
      "edge",
      "opera",
      "default browser",
      "browser popup",
      "reload",
      "live reload",
      "preview",
      "built-in server",
      "port",
      "63342",
      "external connections",
      "unsigned requests",
    ],
    component: lazyComponent(() => import("./WebBrowsersSettingsPage").then((m) => m.WebBrowsersSettingsPage)),
  });
}

const SAVE_DELAY = 300;

/**
 * "Reload page: On change": a document a page reloading on change loaded is saved as it is
 * edited (IDEA saves it on every change), so the page reloads with the edit.
 */
const saveOnChange = (ctx: { doc: number; path: string; virtual?: boolean }) => {
  if (ctx.virtual || ctx.doc < 0 || !isTauri()) return [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  return EditorView.updateListener.of((u) => {
    if (!u.docChanged) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      void (async () => {
        if (!(await commands.webTrackedOnChange(ctx.path))) return;
        await whenSynced(u.view);
        await call(commands.docSave(ctx.doc));
      })().catch((e: unknown) => console.warn("web: save on change", e));
    }, SAVE_DELAY);
  });
};

export function activate(): () => void {
  const disposers = [
    activateSettingsPages(),
    registerTextEditorWrapper({
      id: "web.html",
      matches: (path) => isHtmlPath(path) || isXmlPath(path),
      component: lazyComponent(() => import("./WebEditor").then((m) => m.WebEditor)),
    }),
    registerEditorContribution({ id: "web.saveOnChange", order: 200, extensions: saveOnChange }),
    registerActions([
      {
        id: "web.openInBrowser",
        title: "Open in Browser",
        description: "Open the HTML, XML or SVG file in the default browser through the built-in server",
        category: "View",
        icon: "web",
        when: "projectOpen",
        keyWhen: "textEditorActive && editorLangId == html",
        keywords: ["browser", "html", "preview", "chrome", "firefox", "safari", "run"],
        run: ({ arg }) => {
          const path = targetPath(arg);
          if (path && isWebPath(path)) return openInBrowser(path, (arg as OpenArg | undefined)?.browser ?? null);
        },
      },
      {
        id: "web.togglePreview",
        title: "Built-in Preview",
        description: "Show the HTML file rendered beside the editor",
        category: "View",
        icon: "eye",
        when: "textEditorActive && editorLangId == html",
        keywords: ["browser", "html", "preview", "live"],
        toggled: () => {
          const path = getContext().editorPath;
          return typeof path === "string" && !!useWebPreview.getState()[path];
        },
        run: ({ arg }) => {
          const path = targetPath(arg);
          if (path && isHtmlPath(path)) togglePreview(path);
        },
      },
    ]),
    registerMenuGroup({
      id: "web.open",
      menus: ["editor", "editorTab", "projectView"],
      order: 5,
      items: (_menu, { paths, dirs }) => {
        const path = paths.length === 1 && !dirs?.[0] ? paths[0]! : null;
        if (!path || !isHtmlPath(path)) return [];
        return [
          {
            kind: "action",
            action: "web.openInBrowser",
            arg: { path },
            label: tx`Open '${basename(path)}' in Browser`,
            icon: "web",
          },
        ];
      },
    }),
    registerMenuGroup({
      id: "web.openIn",
      menus: ["openIn"],
      items: (_menu, { paths, dirs }) =>
        paths.length === 1 && !dirs?.[0] && isWebPath(paths[0]!) ? [browserMenu(paths[0]!)] : [],
    }),
  ];
  return () => disposers.reverse().forEach((d) => d());
}
