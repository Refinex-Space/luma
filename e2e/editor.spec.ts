import { expect, openFromTree, test } from "./fixtures";

test("opens a file from the project tree and types into it", async ({ workbench: page }) => {
  const editor = await openFromTree(page, "build.gradle.kts");
  await editor.locator(".cm-content").click();
  await page.keyboard.press("Meta+ArrowDown");
  await page.keyboard.press("Enter");
  await page.keyboard.type("// typed by e2e");
  await expect(editor.locator(".cm-content")).toContainText("// typed by e2e");
  // Undo removes the typing again.
  await page.keyboard.press("Meta+z");
  await expect(editor.locator(".cm-content")).not.toContainText("// typed by e2e");
});

test("⌘F opens the find bar and highlights matches; Escape returns to the editor", async ({ workbench: page }) => {
  const editor = await openFromTree(page, "build.gradle.kts");
  await editor.locator(".cm-content").click();
  await page.keyboard.press("Meta+f");
  const find = page.getByRole("textbox", { name: "Find" });
  await expect(find).toBeFocused();
  await find.fill("Order");
  await expect(editor.locator(".cm-luma-findMatch").first()).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(find).toBeHidden();
  await expect(editor.locator(".cm-content")).toBeFocused();
});

test("opening several files creates tabs and ⌘W closes the active one", async ({ workbench: page }) => {
  await openFromTree(page, "build.gradle.kts");
  await openFromTree(page, "settings.gradle.kts");
  const tabs = page.getByRole("tablist", { name: "Editor tabs" }).getByRole("tab");
  await expect(tabs).toHaveCount(2);
  await page.locator(".cm-editor .cm-content").first().click();
  await page.keyboard.press("Meta+w");
  await expect(tabs).toHaveCount(1);
  await expect(tabs.first()).toHaveText(/build\.gradle\.kts/);
});

test("breadcrumbs follow the caret into the symbol under it", async ({ workbench: page }) => {
  const editor = await openFromTree(page, "build.gradle.kts");
  const status = page.getByRole("navigation", { name: "Breadcrumbs", exact: true });
  // The status bar's navigation bar carries them; the editor's own are off by default.
  await expect(page.getByRole("navigation", { name: "Code breadcrumbs" })).toHaveCount(0);
  await editor.locator(".cm-line", { hasText: "service.find(status" }).click();
  await expect(status).toContainText("OrderController");
  await expect(status).toContainText("list()");
  // Typing inside the method keeps its crumb.
  await page.keyboard.press("Home");
  await page.keyboard.type("checked ");
  await expect(status).toContainText("list()");
  await editor.locator(".cm-line", { hasText: "return order.toDto()" }).click();
  await expect(status).toContainText("create()");
  await expect(status).not.toContainText("list()");
  // ⌘↑ opens the navigation bar at the caret's symbol.
  await page.keyboard.press("Meta+ArrowUp");
  const bar = page.getByRole("toolbar", { name: "Navigation bar" });
  await expect(bar).toContainText("create()");
  await page.keyboard.press("Escape");
  await expect(bar).toBeHidden();
});
