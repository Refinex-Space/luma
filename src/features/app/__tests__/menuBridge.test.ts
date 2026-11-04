import { afterEach, describe, expect, it, vi } from "vitest";
import { registerAction } from "@/platform/actions";
import { _resetI18nForTests, setLocale } from "@/platform/i18n";
import { useKeymap } from "@/platform/keymap";
import { resetDistractionFree, setDistractionFree } from "@/workbench/distractionFree";
import { registerToolWindow } from "@/workbench/contributions";
import { _reloadLayouts, saveLayout } from "@/workbench/toolwindows/layouts";
import { setContext } from "@/platform/context";
import {
  buildMenuConfig,
  disabledMenuActions,
  dynamicMenuItems,
  menuActionIds,
  menuShortcut,
  routeMenuEvent,
} from "../menuBridge";

describe("menu state from the frontend", () => {
  it("lists registered tool windows by title and saved layouts", () => {
    localStorage.clear();
    _reloadLayouts();
    const offs = [
      registerToolWindow({ id: "zeta", title: "Terminal", icon: "terminal", anchor: "bottom", component: () => null }),
      registerToolWindow({ id: "alpha", title: "Problems", icon: "problems", anchor: "bottom", component: () => null }),
    ];
    saveLayout("Review");
    const dyn = dynamicMenuItems();
    expect(dyn.toolWindows!.map((i) => [i.action, i.label])).toEqual([
      ["toolwindow.alpha", "Problems"],
      ["toolwindow.zeta", "Terminal"],
    ]);
    expect(dyn.toolWindowLayouts).toEqual([{ action: "layout.restore", arg: "Review", label: "Review" }]);
    expect(buildMenuConfig("macos").dynamic).toEqual(dyn);
    offs.forEach((d) => d());
    localStorage.clear();
    _reloadLayouts();
  });

  it("disables the registered actions that cannot run now", () => {
    const offs = [
      registerAction({ id: "test.menu.always", title: "A", run: () => {} }),
      registerAction({ id: "test.menu.whenEditor", title: "B", when: "testMenuEditor", run: () => {} }),
    ];
    const ids = menuActionIds([
      {
        kind: "submenu",
        id: "x",
        label: "X",
        children: [
          { kind: "action", id: "test.menu.whenEditor", label: "B", hint: null, arg: null },
          { kind: "action", id: "test.menu.always", label: "A", hint: null, arg: null },
        ],
      },
      { kind: "action", id: "not.registered", label: "C", hint: null, arg: null },
    ]);
    expect([...ids].sort()).toEqual(["not.registered", "test.menu.always", "test.menu.whenEditor"]);
    // Unregistered ids stay enabled: the action may register later (lazy features).
    expect(disabledMenuActions(ids)).toEqual(["test.menu.whenEditor"]);
    setContext("testMenuEditor", true);
    expect(disabledMenuActions(ids)).toEqual([]);
    setContext("testMenuEditor", false);
    offs.forEach((d) => d());
  });
});

afterEach(() => {
  _resetI18nForTests();
  useKeymap.setState({ overrides: {} });
});

describe("menu event routing", () => {
  it("runs the action named by the event, passing the argument", async () => {
    const run = vi.fn();
    const off = registerAction({ id: "test.menuRoute", title: "Test", run });
    await expect(routeMenuEvent({ action: "test.menuRoute", arg: "/p/luma" })).resolves.toBe(true);
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ arg: "/p/luma" }));
    await routeMenuEvent({ action: "test.menuRoute", arg: null });
    expect(run).toHaveBeenLastCalledWith(expect.objectContaining({ arg: undefined }));
    off();
  });

  it("ignores malformed payloads and unknown actions", async () => {
    const run = vi.fn(async () => true);
    await expect(routeMenuEvent(null, run)).resolves.toBe(false);
    await expect(routeMenuEvent({ id: "x" }, run)).resolves.toBe(false);
    await expect(routeMenuEvent({ action: "" }, run)).resolves.toBe(false);
    expect(run).not.toHaveBeenCalled();
    await expect(routeMenuEvent({ action: "no.such.action" })).resolves.toBe(false);
  });

  it("does not run disabled actions", async () => {
    const run = vi.fn();
    const off = registerAction({ id: "test.gatedMenu", title: "T", when: "neverTrueKey", run });
    await expect(routeMenuEvent({ action: "test.gatedMenu" })).resolves.toBe(false);
    expect(run).not.toHaveBeenCalled();
    off();
  });
});

describe("menu config", () => {
  it("carries keymap shortcuts as display text", () => {
    const mac = buildMenuConfig("macos");
    expect(mac.shortcuts["file.save"]).toBe("⌘S");
    expect(mac.shortcuts["navigate.gotoFile"]).toBe("⇧⌘O");
    expect(mac.shortcuts["navigate.searchEverywhere"]).toBe("⇧⇧");
    expect(buildMenuConfig("windows").shortcuts["navigate.gotoFile"]).toBe("Shift+Meta+O");
  });

  it("follows user keymap overrides", () => {
    useKeymap.setState({ overrides: { "file.save": ["Ctrl+Alt+S"] } });
    expect(buildMenuConfig("macos").shortcuts["file.save"]).toBe("⌃⌥S");
  });

  it("sends localised labels with platform-specific variants", async () => {
    expect(buildMenuConfig("macos").labels["menu.app.quit"]).toBe("Quit Luma");
    expect(buildMenuConfig("windows").labels["menu.app.quit"]).toBe("Exit");
    expect(buildMenuConfig("windows").labels["menu.help.showLog"]).toBe("Show Log in Explorer");
    await setLocale("zh");
    const zh = buildMenuConfig("macos");
    expect(zh.locale).toBe("zh");
    expect(zh.labels["menu.file"]).toBe("文件");
    expect(zh.labels["menu.file.save"]).toBe("全部保存");
  });

  it("formats chords", () => {
    expect(menuShortcut("Meta+Alt+N Meta+Alt+N", "linux")).toBe("Alt+Meta+N, Alt+Meta+N");
    expect(menuShortcut("Shift Shift", "windows")).toBe("Shift, Shift");
  });
});

describe("window-scoped menu labels", () => {
  it("flips Enter / Exit Distraction Free Mode with the window's mode", () => {
    expect(buildMenuConfig("macos").labels["menu.editor.toggleZen"]).toBe("Enter Distraction Free Mode");
    expect(buildMenuConfig("macos").shortcuts["editor.toggleZen"]).toBeUndefined();
    setDistractionFree(true);
    expect(buildMenuConfig("macos").labels["menu.editor.toggleZen"]).toBe("Exit Distraction Free Mode");
    resetDistractionFree();
  });
});
