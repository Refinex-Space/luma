import { describe, expect, it } from "vitest";
import {
  CHROME_ID,
  EDGE_ID,
  FIREFOX_ID,
  SAFARI_ID,
  activeBrowsers,
  defaultBrowser,
  predefinedBrowsers,
  validateBuiltInServer,
  validateWebBrowsers,
} from "./webBrowserSettings";

describe("web browser settings", () => {
  it("defaults to IDEA's predefined browsers for the platform", () => {
    const mac = predefinedBrowsers("macos");
    expect(mac.map((b) => [b.name, b.path, b.active])).toEqual([
      ["Chrome", "Google Chrome", true],
      ["Firefox", "Firefox", true],
      ["Safari", "Safari", true],
      ["Opera", "Opera", false],
      ["Edge", "Microsoft Edge", false],
    ]);
    const win = predefinedBrowsers("windows");
    expect(win.find((b) => b.id === SAFARI_ID)!.active).toBe(false);
    expect(win.find((b) => b.id === EDGE_ID)).toMatchObject({ path: "msedge", active: true, family: "chrome" });
    expect(predefinedBrowsers("linux").find((b) => b.id === CHROME_ID)!.path).toBe("google-chrome");
  });

  it("validates stored values and keeps the user's list", () => {
    const v = validateWebBrowsers({
      browsers: [
        { id: "a", name: "Arc", family: "chrome", path: "/Applications/Arc.app" },
        { id: "a", name: "duplicate" },
        { name: "no id" },
        { id: "b", name: "Lynx", family: "lynx", active: false, settings: { commandLineOptions: "-x" } },
      ],
      serverReloadMode: "onChange",
      previewReloadMode: "sometimes",
      showHoverXml: true,
    });
    expect(v.browsers.map((b) => [b.id, b.family, b.active])).toEqual([
      ["a", "chrome", true],
      ["b", null, false],
    ]);
    expect(v.browsers[1]!.settings.commandLineOptions).toBe("-x");
    expect(v.serverReloadMode).toBe("onChange");
    expect(v.previewReloadMode).toBe("onSave");
    expect(v.showHover && v.showHoverXml).toBe(true);
    expect(validateWebBrowsers(undefined).browsers.length).toBe(5);
  });

  it("uses a chosen default browser only while it is active and has a path", () => {
    const prefs = validateWebBrowsers({ defaultBrowser: FIREFOX_ID });
    expect(defaultBrowser(prefs)?.name).toBe("Firefox");
    const off = { ...prefs, browsers: prefs.browsers.map((b) => (b.id === FIREFOX_ID ? { ...b, active: false } : b)) };
    expect(defaultBrowser(off)).toBeNull();
    expect(activeBrowsers(off).some((b) => b.id === FIREFOX_ID)).toBe(false);
    expect(defaultBrowser(validateWebBrowsers({}))).toBeNull();
  });

  it("keeps the built-in server port in range", () => {
    expect(validateBuiltInServer({ port: 8080, availableExternally: true })).toEqual({
      port: 8080,
      availableExternally: true,
      allowUnsignedRequests: false,
    });
    expect(validateBuiltInServer({ port: 80 }).port).toBe(63342);
    expect(validateBuiltInServer({ port: 70000 }).port).toBe(63342);
    expect(validateBuiltInServer({ port: 8080.5 }).port).toBe(63342);
  });
});
