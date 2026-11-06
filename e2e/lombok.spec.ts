import { readFileSync } from "node:fs";
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";

const SHOTS = process.env.LUMA_SHOTS;

// The bundled headless shell is not always installed: the system Chrome renders the same.
if (process.env.LUMA_E2E_CHROME) test.use({ channel: "chrome" });

const PATH = "/dev/acme-api/src/main/java/com/acme/orders/Order.java";
/** A source and what Lombok 1.18.48's delombok (the backend's options) made of it. */
const SOURCE = readFileSync(new URL("./lombok/Order.java", import.meta.url), "utf8");
const DELOMBOKED = readFileSync(new URL("./lombok/Order.delombok.java", import.meta.url), "utf8");

async function shot(page: Page, name: string) {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png`, animations: "disabled" });
}

async function setTheme(page: Page, label: string) {
  await page.keyboard.press("Meta+,");
  const dialog = page.getByRole("dialog", { name: "Settings", exact: true });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("textbox", { name: "Search settings" }).fill("Theme");
  await page.getByRole("button", { name: "Theme", exact: true }).click();
  await page.getByRole("option", { name: label, exact: true }).click();
  await dialog.getByRole("button", { name: "Apply", exact: true }).click();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
}

/**
 * Browser mode has no backend: the Lombok status, delombok and the workspace edit are
 * answered in the page (delombok with its real output of this source).
 */
async function fakeBackend(page: Page) {
  await page.evaluate(
    async ({ output }) => {
      const bindingsPath = "/src/bindings.ts";
      const storePath = "/src/features/lombok/store.ts";
      const apiPath = "/src/editor/api.ts";
      const { commands } = await import(bindingsPath);
      const { useLombok } = await import(storePath);
      const { editorsFor } = await import(apiPath);
      const ok = (data: unknown) => Promise.resolve({ status: "ok", data });
      const c = commands as Record<string, unknown>;
      c.javaResolveLaunch = () => ok({ classPaths: ["/m2/org/projectlombok/lombok/1.18.36/lombok-1.18.36.jar"] });
      c.lombokDelombok = (files: Array<{ path: string }>) =>
        ok(files.map((f) => ({ path: f.path, text: output, error: null })));
      c.applyWorkspaceEdit = (edit: { files: Array<{ path: string; edits: Array<{ new_text: string }> }> }) => {
        for (const f of edit.files) {
          const view = editorsFor(f.path)[0]?.view;
          view?.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: f.edits[0]!.new_text } });
        }
        return ok(null);
      };
      useLombok.setState({
        status: {
          enabled: true,
          agent: {
            path: "/Users/ada/Library/Application Support/space.refinex.luma/tools/lombok/bin/lombok-1.18.48-luma.2.jar",
            version: "1.18.48-luma.2",
            source: "bundled",
          },
          usesLombok: true,
          problem: null,
          bundledVersion: "1.18.48-luma.2",
          configFiles: ["lombok.config", "orders/lombok.config"],
        },
      });
    },
    { output: DELOMBOKED },
  );
}

async function openSource(page: Page) {
  await page.evaluate(async (path) => {
    const module = "/src/workbench/contributions.ts";
    const { editorService } = await import(module);
    await editorService().openFile(path, { focus: true });
  }, PATH);
  await expect(page.getByRole("tab", { name: "Order.java" })).toBeVisible();
  await page.evaluate(async (text) => {
    const module = "/src/editor/api.ts";
    const { activeEditor } = await import(module);
    const view = activeEditor()!.view;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
  }, SOURCE);
  const editor = page.locator(".cm-editor").first();
  await expect(editor.locator(".cm-content")).toContainText("public class Order");
  return editor;
}

const docText = (page: Page) =>
  page.evaluate(async () => {
    const module = "/src/editor/api.ts";
    const { activeEditor } = await import(module);
    return activeEditor()!.view.state.doc.toString();
  });

test("Lombok is a bundled plugin, on by default, with its settings page", async ({ workbench: page }) => {
  for (const theme of ["light", "dark"] as const) {
    if (theme === "dark") {
      await page.reload();
      await expect(page.getByRole("tree", { name: "Project" })).toBeVisible();
      await setTheme(page, "Islands Dark");
    }
    await fakeBackend(page);
    await page.keyboard.press("Meta+,");
    const dialog = page.getByRole("dialog", { name: "Settings", exact: true });
    await dialog.getByRole("textbox", { name: "Search settings" }).fill("Plugins");
    await dialog.getByRole("treeitem", { name: "Plugins", exact: true }).click();
    await dialog.getByRole("textbox", { name: "Filter plugins" }).fill("Lombok");
    const row = dialog.getByRole("list", { name: "Installed plugins" }).getByText("Lombok", { exact: true });
    await row.click();
    const details = dialog.getByLabel("Lombok details");
    await expect(details).toContainText("nothing to download");
    // On by default.
    await expect(details).toContainText("Enabled");
    await expect(details.getByRole("button", { name: "Disable" })).toBeVisible();
    await shot(page, `lombok-plugin-${theme}`);

    await dialog.getByRole("textbox", { name: "Search settings" }).fill("Lombok");
    await dialog.getByRole("treeitem", { name: "Lombok", exact: true }).click();
    await expect(dialog.getByRole("checkbox", { name: "Enable Lombok support" })).toBeChecked();
    await expect(dialog.getByRole("radio", { name: /Bundled/ })).toBeChecked();
    await expect(dialog.getByText("Lombok 1.18.48", { exact: false }).first()).toBeVisible();
    await expect(dialog.getByRole("button", { name: "orders/lombok.config" })).toBeVisible();
    await dialog.getByRole("textbox", { name: "Search settings" }).fill("");
    await shot(page, `lombok-settings-${theme}`);
    // Off: the page keeps only the switch.
    await dialog.getByRole("checkbox", { name: "Enable Lombok support" }).click();
    await expect(dialog.getByRole("radiogroup", { name: "Lombok jar" })).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
  }
});

test("Refactor › Delombok writes out what Lombok generates, in place", async ({ workbench: page }) => {
  await fakeBackend(page);
  const editor = await openSource(page);
  await editor.locator(".cm-content").click({ button: "right", position: { x: 120, y: 200 } });
  const menu = page.getByRole("menu").last();
  await menu.getByRole("menuitem", { name: "Delombok" }).hover();
  const sub = page.getByRole("menu").last();
  for (const name of ["All Lombok Annotations", "@Data", "Constructors", "@Builder"])
    await expect(sub.getByRole("menuitem", { name, exact: true })).toBeVisible();
  await shot(page, "lombok-delombok-menu-light");
  await sub.getByRole("menuitem", { name: "All Lombok Annotations", exact: true }).click();
  await expect.poll(() => docText(page)).toContain("public Long getId() {");
  const text = await docText(page);
  expect(text).not.toMatch(/@Data|@NoArgsConstructor|@AllArgsConstructor|import lombok|@lombok\.Generated/);
  // The rest stays as written: its javadoc and imports.
  expect(text).toContain("/** An order of a customer. */\npublic class Order {\n    private Long id;");
  expect(text).toContain("import java.math.BigDecimal;");
  expect(text).toContain("\n    public Order(final Long id, final String customer, final BigDecimal total) {");
  await expect(page.getByText(/Delomboked 3 annotations in Order\.java/)).toBeVisible();
  await page.evaluate(async () => {
    const module = "/src/editor/api.ts";
    const { activeEditor } = await import(module);
    const view = activeEditor()!.view;
    view.dispatch({ selection: { anchor: view.state.doc.toString().indexOf("public Long getId") } });
    view.focus();
  });
  await shot(page, "lombok-delombok-result-light");
});
