/**
 * IDEA's Refactor › Lombok and Refactor › Delombok submenus: in a Java editor's context menu
 * (both: Lombok works on the class at the caret, Delombok on the file) and the Project
 * view's (Delombok on the selected Java files and directories).
 */
import { getAction } from "@/platform/actions";
import { lombokPrefs } from "@/platform/lombokSettings";
import { registerMenuGroup, type MenuGroupContext } from "@/workbench/contributions";
import type { MenuItem } from "@/ui";
import { DELOMBOK_TARGETS } from "./delombok";
import { delombokAction } from "./delombokActions";
import { importsLombok, lombokActive } from "./store";

/** Refactor › Lombok, IDEA's order (actions of the Java part, `lombok.add*`). */
export const LOMBOK_ACTIONS: ReadonlyArray<{ action: string; label: string }> = [
  { action: "lombok.addData", label: "@Data" },
  { action: "lombok.addGetter", label: "@Getter" },
  { action: "lombok.addSetter", label: "@Setter" },
  { action: "lombok.addEqualsAndHashCode", label: "@EqualsAndHashCode" },
  { action: "lombok.addToString", label: "@ToString" },
  { action: "lombok.addLogger", label: "@Log" },
];

function delombokMenu(arg: string[]): MenuItem {
  return {
    label: "Delombok",
    icon: "lombok",
    submenu: DELOMBOK_TARGETS.map((t, i) => [
      { kind: "action" as const, action: delombokAction(t.id), arg, label: t.label },
      ...(i === 0 ? [{ kind: "separator" as const }] : []),
    ]).flat(),
  };
}

export function lombokMenuItems(menu: string, { paths, dirs, text }: MenuGroupContext): MenuItem[] {
  if (!lombokPrefs().enabled || !paths.length) return [];
  if (menu === "editor") {
    const path = paths[0]!;
    // Java files of a project using Lombok, or importing it.
    if (!path.endsWith(".java") || !lombokActive(importsLombok(text ?? ""))) return [];
    const lombok = LOMBOK_ACTIONS.filter((a) => getAction(a.action)).map((a): MenuItem => ({
      kind: "action",
      action: a.action,
      label: a.label,
    }));
    return [...(lombok.length ? [{ label: "Lombok", icon: "lombok", submenu: lombok }] : []), delombokMenu([path])];
  }
  // Project view: Java files and directories that may hold them, in a project using Lombok.
  if (!lombokActive()) return [];
  const fit = paths.every((p, i) => dirs?.[i] || p.endsWith(".java"));
  return fit ? [delombokMenu(paths)] : [];
}

export function registerLombokMenus(): () => void {
  return registerMenuGroup({ id: "lombok", menus: ["editor", "projectView"], order: 40, items: lombokMenuItems });
}
