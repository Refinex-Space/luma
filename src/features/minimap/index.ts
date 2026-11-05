/**
 * Minimap: the editor's scaled-down file overview (cm/minimap.ts), shipped as a bundled plugin.
 * Here: its settings writes, the View › Appearance › Minimap toggle, its context menu and its
 * entry in Settings › Plugins › Installed › Bundled.
 *
 * Settings: `editor.minimap.{enabled, width, style, showMarkers}` (Editor › General › Minimap).
 */
import type { EditorView } from "@codemirror/view";
import { configureMinimap, MINIMAP_WIDTH } from "@/editor/core/cm/minimap";
import { executeAction, registerActions } from "@/platform/actions";
import { editorPrefs, useEditorPrefs } from "@/platform/editorSettings";
import { call, commands, isTauri } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { notifications, registerBundledPlugin } from "@/workbench/contributions";
import { showContextMenu, type MenuItem } from "@/ui";

export const MINIMAP_SETTINGS_PAGE = "editor.general.minimap";
export const TOGGLE_MINIMAP = "view.toggleMinimap";

type MinimapSettings = ReturnType<typeof editorPrefs>["minimap"];

async function setMinimap<K extends keyof MinimapSettings>(key: K, value: MinimapSettings[K]) {
  if (!isTauri()) return;
  useProject.setState({
    settings: await call(commands.settingsSet("global", `editor.minimap.${key}`, JSON.stringify(value))),
  });
}

const current = () => editorPrefs().minimap;

function hide() {
  void setMinimap("enabled", false);
  notifications().notify({
    level: "info",
    title: "Minimap hidden",
    body: "Show it again from View › Appearance › Minimap.",
    key: "minimap.hidden",
    actions: [{ label: "Undo", run: () => void setMinimap("enabled", true) }],
  });
}

function menu(_view: EditorView, e: MouseEvent) {
  const m = current();
  const items: MenuItem[] = [
    {
      label: "Characters",
      checked: m.style !== "blocks",
      run: () => void setMinimap("style", "characters"),
    },
    { label: "Blocks", checked: m.style === "blocks", run: () => void setMinimap("style", "blocks") },
    { kind: "separator" },
    { label: "Show Markers", checked: m.showMarkers, run: () => void setMinimap("showMarkers", !m.showMarkers) },
    {
      label: "Reset Width",
      disabled: m.width === MINIMAP_WIDTH.initial,
      run: () => void setMinimap("width", MINIMAP_WIDTH.initial),
    },
    { kind: "separator" },
    { label: "Hide Minimap", run: hide },
    { label: "Minimap Settings…", run: () => void executeAction("file.settings", MINIMAP_SETTINGS_PAGE) },
  ];
  showContextMenu({ x: e.clientX, y: e.clientY }, items);
}

function registerPlugin(): () => void {
  return registerBundledPlugin({
    id: "minimap",
    name: "Minimap",
    description:
      "A scaled-down view of the whole file beside the scrollbar, with the visible part highlighted. Click to jump, drag to scroll.",
    icon: "minimap",
    features: [
      "Syntax-coloured overview of the file",
      "Click to jump, drag the slider to scroll",
      "Errors, changes and search results at a glance",
      "Drag its left edge to resize",
    ],
    settingsPage: MINIMAP_SETTINGS_PAGE,
    useEnabled: () => useEditorPrefs().minimap.enabled,
    setEnabled: (on) => setMinimap("enabled", on),
  });
}

/** The Settings window: the bundled plugin entry. */
export function activateSettingsPages(): () => void {
  return registerPlugin();
}

export function activate(): () => void {
  configureMinimap({ persistWidth: (w) => void setMinimap("width", w), menu });
  const disposers = [
    registerPlugin(),
    registerActions([
      {
        id: TOGGLE_MINIMAP,
        title: "Minimap",
        category: "View",
        keywords: ["code overview", "code map", "scroll map", "codeglance", "thumbnail"],
        toggled: () => current().enabled,
        run: () => void setMinimap("enabled", !current().enabled),
      },
    ]),
  ];
  return () => disposers.reverse().forEach((d) => d());
}
