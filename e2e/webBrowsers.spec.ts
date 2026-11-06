import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";

const SHOTS = process.env.LUMA_SHOTS;

async function openSettingsPage(page: Page) {
  await page.keyboard.press("Meta+,");
  const dialog = page.getByRole("dialog", { name: "Settings", exact: true });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("textbox", { name: "Search settings" }).fill("Web Browsers");
  await dialog.getByRole("treeitem", { name: "Web Browsers and Preview" }).click();
  await expect(dialog.getByRole("table", { name: "Browsers" })).toBeVisible();
  await dialog.getByRole("textbox", { name: "Search settings" }).fill("");
  return dialog;
}

async function apply(dialog: ReturnType<Page["getByRole"]>) {
  await dialog.getByRole("button", { name: "OK", exact: true }).click();
  await expect(dialog).toHaveCount(0);
}

async function openText(page: Page, path: string, text: string) {
  await page.evaluate(
    async ({ path, text }) => {
      const contributions = "/src/workbench/contributions.ts";
      const api = "/src/editor/api.ts";
      const { editorService } = await import(contributions);
      await editorService().openFile(path, { focus: true });
      const { activeEditor } = await import(api);
      const view = activeEditor()!.view;
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
    },
    { path, text },
  );
  const editor = page.locator(".cm-editor").first();
  await expect(editor.locator(".cm-content")).toContainText(text.slice(0, 10));
  return editor;
}

const settings = (page: Page) =>
  page.evaluate(async () => {
    const module = "/src/platform/project.ts";
    const { useProject } = await import(module);
    const s = useProject.getState().settings as Record<string, unknown>;
    return {
      webBrowsers: s.webBrowsers as Record<string, unknown>,
      builtInServer: s.builtInServer as Record<string, unknown>,
    };
  });

test("Tools › Web Browsers and Preview edits the browsers, popups, reload behavior and built-in server", async ({
  workbench: page,
}) => {
  const dialog = await openSettingsPage(page);
  const table = dialog.getByRole("table", { name: "Browsers" });
  for (const name of ["Chrome", "Firefox", "Safari", "Opera", "Edge"])
    await expect(table.getByRole("textbox", { name: "Name" }).and(page.locator(`[value="${name}"]`))).toBeVisible();
  // Predefined browsers can be turned off but not removed.
  await table.getByRole("row").nth(1).click();
  await expect(dialog.getByRole("button", { name: /predefined browser/ })).toBeDisabled();
  // External connections need a port below the default one.
  const external = dialog.getByRole("checkbox", { name: "Can accept external connections" });
  await expect(external).toBeDisabled();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/web-browsers-settings-light.png`, animations: "disabled" });

  // A custom browser, the default browser, popups, reload modes and the server.
  await dialog.getByRole("button", { name: "Add", exact: true }).click();
  const names = table.getByRole("textbox", { name: "Name" });
  await expect(names).toHaveCount(6);
  await names.last().fill("Arc");
  await table.getByRole("textbox", { name: "Path of Arc" }).fill("/Applications/Arc.app");
  await dialog.getByRole("checkbox", { name: "Show Opera in the browser lists" }).check();
  await dialog.getByRole("button", { name: "Default browser" }).click();
  await page.getByRole("option", { name: "Arc", exact: true }).click();
  await dialog.getByRole("checkbox", { name: "For XML files" }).check();
  await dialog.getByRole("button", { name: "Reload page in browser" }).click();
  await page.getByRole("option", { name: "On Change", exact: true }).click();
  await dialog
    .getByRole("spinbutton", { name: "Port" })
    .or(dialog.getByRole("textbox", { name: "Port" }))
    .fill("8080");
  await expect(external).toBeEnabled();
  await external.check();
  await apply(dialog);

  const s = await settings(page);
  const browsers = s.webBrowsers.browsers as Array<{ id: string; name: string; path: string; active: boolean }>;
  const arc = browsers.find((b) => b.name === "Arc")!;
  expect(arc.path).toBe("/Applications/Arc.app");
  expect(s.webBrowsers.defaultBrowser).toBe(arc.id);
  expect(browsers.find((b) => b.name === "Opera")!.active).toBe(true);
  expect(s.webBrowsers.showHoverXml).toBe(true);
  expect(s.webBrowsers.serverReloadMode).toBe("onChange");
  expect(s.builtInServer).toMatchObject({ port: 8080, availableExternally: true });
});

test("the editor's browser popup follows the settings for HTML and XML files", async ({ workbench: page }) => {
  const editor = await openText(
    page,
    "/dev/acme-api/web/index.html",
    "<!doctype html>\n<html>\n  <body>\n    <h1>Orders</h1>\n  </body>\n</html>\n",
  );
  const popup = page.getByRole("toolbar", { name: "Open in browser" });
  await editor.hover();
  await expect(popup).toBeVisible();
  for (const name of ["Built-in Preview", "Chrome", "Firefox", "Safari"])
    await expect(popup.getByRole("button", { name, exact: true })).toBeVisible();
  await expect(popup.getByRole("button", { name: "Opera", exact: true })).toHaveCount(0);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/web-browsers-popup-light.png`, animations: "disabled" });

  // XML: no popup until "For XML files" is on.
  const xml = await openText(page, "/dev/acme-api/web/feed.xml", '<?xml version="1.0"?>\n<feed/>\n');
  await xml.hover();
  await expect(popup.filter({ visible: true })).toHaveCount(0);

  const dialog = await openSettingsPage(page);
  await dialog.getByRole("checkbox", { name: "For XML files" }).check();
  await dialog.getByRole("checkbox", { name: "For HTML files" }).uncheck();
  await apply(dialog);
  await xml.hover();
  await expect(popup.filter({ visible: true })).toBeVisible();
  // XML files have no built-in preview.
  await expect(popup.filter({ visible: true }).getByRole("button", { name: "Built-in Preview" })).toHaveCount(0);
});
