import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";

const SHOTS = process.env.LUMA_SHOTS;

// The bundled headless shell is not always installed: the system Chrome renders the same.
if (process.env.LUMA_E2E_CHROME) test.use({ channel: "chrome" });

const PATH = "/dev/acme-api/lombok.config";

const TEXT = [
  "# Lombok settings of acme-api",
  "config.stopBubbling = true",
  "lombok.accessors.chain = true",
  "lombok.toString.callSuper = CALL",
  "lombok.copyableAnnotations += org.springframework.beans.factory.annotation.Qualifier",
  "lombok.acessors.fluent = true",
  "lombok.getter.noIsPrefix = yes",
  "clear lombok.log.fieldName",
  "",
].join("\n");

/** Opens a `lombok.config` in the editor (browser memory) with `TEXT`. */
async function openConfig(page: Page) {
  await page.evaluate(async (path) => {
    const module = "/src/workbench/contributions.ts";
    const { editorService } = await import(module);
    await editorService().openFile(path, { focus: true });
  }, PATH);
  const editor = page.locator(".cm-editor").first();
  await expect(page.getByRole("tab", { name: "lombok.config" })).toBeVisible();
  const content = editor.locator(".cm-content");
  await page.evaluate(async (text) => {
    const module = "/src/editor/api.ts";
    const { activeEditor } = await import(module);
    const view = activeEditor()!.view;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
  }, TEXT);
  await expect(content).toContainText("lombok.copyableAnnotations");
  return editor;
}

/** Moves the caret to the end of `text` in line `line` (1-based). */
async function caretAfter(page: Page, line: number, text: string) {
  await page.evaluate(
    async ({ line, text }) => {
      const module = "/src/editor/api.ts";
      const { activeEditor } = await import(module);
      const view = activeEditor()!.view;
      const l = view.state.doc.line(line);
      view.dispatch({ selection: { anchor: l.from + l.text.indexOf(text) + text.length } });
      view.focus();
    },
    { line, text },
  );
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

test("lombok.config: highlighting, problems, completion, documentation and the key fix", async ({
  workbench: page,
}) => {
  const editor = await openConfig(page);

  // Highlighted: the comment, keys and values are tokens of their own.
  const line = (n: number) => editor.locator(".cm-line").nth(n - 1);
  await expect(line(1).locator("span")).toHaveText(["# Lombok settings of acme-api"]);
  await expect(line(2).locator("span")).toHaveText(["config.stopBubbling", "=", "true"]);
  const color = (n: number, i: number) =>
    line(n)
      .locator("span")
      .nth(i)
      .evaluate((e) => getComputedStyle(e).color);
  expect(await color(2, 0)).not.toBe(await color(2, 2));
  expect(await color(1, 0)).not.toBe(await color(2, 0));

  // The lombok.config problems inspection: an unknown key and a value the key does not take.
  await expect(editor.locator(".cm-lintRange-error")).toHaveText(["lombok.acessors.fluent", "yes"]);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/lombok-config-light.png`, animations: "disabled" });

  // ⌥↵ on the misspelt key: the key it most likely means.
  await caretAfter(page, 6, "lombok.ace");
  await page.keyboard.press("Alt+Enter");
  const fix = page.getByText("Change to 'lombok.accessors.fluent'");
  await expect(fix).toBeVisible();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/lombok-config-fix-light.png`, animations: "disabled" });
  await fix.click();
  await expect(line(6)).toHaveText("lombok.accessors.fluent = true");
  await expect(editor.locator(".cm-lintRange-error")).toHaveText(["yes"]);

  // Completion: keys with their type, then the values of a boolean key.
  await caretAfter(page, 8, "clear lombok.log.fieldName");
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await page.keyboard.type("lombok.getter.noIs");
  const list = page.locator(".cm-tooltip-autocomplete");
  await expect(list).toContainText("lombok.getter.noIsPrefix");
  await expect(list).toContainText("boolean");
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/lombok-config-completion-light.png`, animations: "disabled" });
  await page.keyboard.press("Enter");
  await expect(line(9)).toHaveText("lombok.getter.noIsPrefix = ");
  await page.keyboard.type("t");
  await expect(list).toContainText("true");
  await page.keyboard.press("Enter");
  await expect(line(9)).toHaveText("lombok.getter.noIsPrefix = true");

  // Quick Documentation of a key on hover.
  await line(4).getByText("lombok.toString.callSuper").hover();
  const doc = page.locator(".cm-tooltip").filter({ hasText: "superclass implementation" });
  await expect(doc).toBeVisible();
  await expect(doc).toContainText("CALL");
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/lombok-config-doc-light.png`, animations: "disabled" });

  if (SHOTS) {
    await page.mouse.move(0, 0);
    await setTheme(page, "Islands Dark");
    await caretAfter(page, 7, "lombok.getter.noIsPrefix = y");
    await page.screenshot({ path: `${SHOTS}/lombok-config-dark.png`, animations: "disabled" });
    await line(3).getByText("lombok.accessors.chain").hover();
    await expect(page.locator(".cm-tooltip").filter({ hasText: "instead of 'void'" })).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/lombok-config-doc-dark.png`, animations: "disabled" });
  }
});
