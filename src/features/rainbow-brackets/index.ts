/**
 * Rainbow Brackets, shipped as a bundled plugin (after JetBrains' plugin of that name) and on
 * by default: brackets, the `<>` of type arguments, HTML / XML / JSX tags and indent guides
 * coloured by nesting depth (cm/rainbowBrackets.ts, cm/indentGuides.ts).
 *
 * Settings: `editor.rainbowBrackets` (on / off) and `editor.rainbow.{round, square, curly,
 * angle, tags, indentGuides}` (Editor › Rainbow Brackets); colours: Color Scheme ›
 * Language Defaults › Rainbow brackets › Level 1–5.
 */
import { registerActions } from "@/platform/actions";
import { editorPrefs, useEditorPrefs } from "@/platform/editorSettings";
import { call, commands, isTauri } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { registerBundledPlugin } from "@/workbench/contributions";
import { RAINBOW_BRACKETS_PAGE } from "@/features/settings/pages/editor/rainbowBrackets";

async function setEnabled(on: boolean) {
  if (!isTauri()) return;
  useProject.setState({
    settings: await call(commands.settingsSet("global", "editor.rainbowBrackets", JSON.stringify(on))),
  });
}

function registerPlugin(): () => void {
  return registerBundledPlugin({
    id: "rainbowBrackets",
    name: "Rainbow Brackets",
    description:
      "Colors matching brackets, the angle brackets of generics, HTML and XML tags and indent guides by nesting depth, so nested code reads at a glance.",
    icon: "rainbow-brackets",
    features: [
      "Round, square and curly brackets colored by depth",
      "Angle brackets of type arguments, never comparisons",
      "HTML, XML and JSX tags colored by element depth",
      "Rainbow indent guides; unmatched brackets in the error color",
    ],
    settingsPage: RAINBOW_BRACKETS_PAGE,
    useEnabled: () => useEditorPrefs().rainbowBrackets,
    setEnabled,
  });
}

/** The Settings window: the bundled plugin entry. */
export function activateSettingsPages(): () => void {
  return registerPlugin();
}

export function activate(): () => void {
  const disposers = [
    registerPlugin(),
    registerActions([
      {
        id: "view.toggleRainbowBrackets",
        title: "Rainbow Brackets",
        category: "View",
        keywords: ["rainbow", "brackets", "bracket pair colorization", "nesting colors"],
        toggled: () => editorPrefs().rainbowBrackets,
        run: () => void setEnabled(!editorPrefs().rainbowBrackets),
      },
    ]),
  ];
  return () => disposers.reverse().forEach((d) => d());
}
