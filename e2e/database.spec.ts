import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";

const SHOTS = process.env.LUMA_SHOTS;

// The bundled headless shell is not always installed: the system Chrome renders the same.
if (process.env.LUMA_E2E_CHROME) test.use({ channel: "chrome" });

/** A console result as the backend returns it, shown in the Database Console window. */
async function showResult(page: Page) {
  await page.evaluate(async () => {
    const storePath = "/src/features/database/store.ts";
    const contributionsPath = "/src/workbench/contributions.ts";
    const { useDatabase, RESULTS_WINDOW } = await import(storePath);
    const { toolWindowService } = await import(contributionsPath);
    const statement = { from: 0, to: 22, text: "select * from orders;" };
    const statuses = ["PAID", "SHIPPED", "NEW", "CANCELLED"];
    const rows = Array.from({ length: 40 }, (_, i) => [
      String(i + 1),
      String((i % 3) + 1),
      statuses[i % 4],
      (((i * 937) % 2500) + 99.5).toFixed(2),
      i % 5 === 0 ? null : `2026-11-05 20:${String(10 + (i % 50)).padStart(2, "0")}:20`,
    ]);
    useDatabase.setState({
      sources: [{ id: "my", name: "luma-mysql", driver: "mysql", host: "127.0.0.1" }],
      loaded: true,
      output: [{ id: 1, time: Date.now(), kind: "statement", text: statement.text, prompt: "luma>" }],
      results: [
        {
          id: 1,
          title: "Result 1",
          path: "/console.sql",
          sourceId: "my:luma",
          outcome: {
            statement,
            error: null,
            result: {
              statement: statement.text,
              columns: [
                { name: "id", typeName: "BIGINT" },
                { name: "customer_id", typeName: "BIGINT" },
                { name: "status", typeName: "VARCHAR" },
                { name: "total", typeName: "DECIMAL" },
                { name: "created_at", typeName: "DATETIME" },
              ],
              rows,
              affected: null,
              hasMore: true,
              elapsedMs: 3,
              executionMs: 2,
            },
          },
          shape: { sort: [], offset: 0, pageSize: 40, total: null, fixed: false },
        },
      ],
      activeResult: 1,
    });
    toolWindowService().show(RESULTS_WINDOW, true);
  });
  const grid = page.getByRole("grid", { name: "Result 1" });
  await expect(grid).toBeVisible();
  return grid;
}

test("query results live in their own Database Console window", async ({ workbench: page }) => {
  const grid = await showResult(page);
  const window = page.locator('section[data-toolwindow="dbConsole"]');
  await expect(window.getByRole("tab", { name: /Result 1/ })).toBeVisible();
  await expect(window.getByRole("tab", { name: "Services" })).toHaveCount(0);
  // IDEA's pagination and extractor in the result toolbar.
  await expect(window.getByRole("button", { name: "First Page" })).toBeDisabled();
  await expect(window.getByRole("button", { name: "Next Page" })).toBeEnabled();
  await expect(window.getByRole("button", { name: "Data extractor" })).toBeVisible();
  if (SHOTS) await window.screenshot({ path: `${SHOTS}/db-console.png`, animations: "disabled" });

  // A multi-row selection copies through the chosen extractor.
  await window.getByRole("button", { name: "Data extractor" }).click();
  await page.getByRole("option", { name: "SQL Inserts" }).click();
  const rowHeaders = grid.locator('[role="row"] > div:first-child');
  await rowHeaders.nth(2).click();
  await rowHeaders.nth(3).click({ modifiers: ["Shift"] });
  await grid.click({ button: "right", position: { x: 200, y: 60 } });
  const menu = page.getByRole("menu");
  await expect(menu.getByRole("menuitem", { name: /Copy \(SQL Inserts\)/ })).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: /Data Extractor: SQL Inserts/ })).toBeVisible();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/db-cell-menu.png`, animations: "disabled" });
  await page.keyboard.press("Escape");

  // The column header menu.
  await grid.getByRole("columnheader", { name: /status/ }).click({ button: "right" });
  await expect(page.getByRole("menuitem", { name: "Hide Column" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Clear Sorting" })).toBeVisible();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/db-header-menu.png`, animations: "disabled" });
  await page.getByRole("menuitem", { name: "Hide Column" }).click();
  await expect(grid.getByRole("columnheader", { name: /status/ })).toHaveCount(0);

  // Find on the current page.
  await grid.getByRole("gridcell").first().click();
  await page.keyboard.press("Meta+F");
  await page.getByRole("textbox", { name: "Find on current page" }).fill("20:1");
  await expect(window.getByText(/^1\/\d+$/)).toBeVisible();
  if (SHOTS) await window.screenshot({ path: `${SHOTS}/db-find.png`, animations: "disabled" });
});

test("edits a single-table result, pins columns, colours numbers and aggregates", async ({ workbench: page }) => {
  const grid = await showResult(page);
  // As resolved for `orders` (its primary key in the result).
  await page.evaluate(async () => {
    const storePath = "/src/features/database/store.ts";
    const { useDatabase } = await import(storePath);
    useDatabase.setState((s: { results: Array<Record<string, unknown>> }) => ({
      results: s.results.map((r) => ({
        ...r,
        edit: {
          schema: "luma",
          table: "orders",
          primaryKey: ["id"],
          columns: ["id", "customer_id", "status", "total", "created_at"],
        },
      })),
    }));
  });
  const window = page.locator('section[data-toolwindow="dbConsole"]');
  await expect(window.getByRole("button", { name: "Submit" })).toBeDisabled();

  // Edit a cell: pending (coloured) until Submit.
  await grid.getByRole("gridcell", { name: "SHIPPED" }).first().dblclick();
  const editor = grid.getByRole("textbox", { name: "Edit status" });
  await editor.fill("DELIVERED");
  await editor.press("Enter");
  await expect(grid.getByRole("gridcell", { name: "DELIVERED" })).toBeVisible();
  await expect(window.getByRole("button", { name: "Submit" })).toBeEnabled();

  // Pin `total`; colour numbers; aggregate a block of totals.
  await grid.getByRole("columnheader", { name: /total/ }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Pin Column" }).click();
  await expect(grid.getByRole("columnheader").nth(0)).toContainText("total");
  await window.getByRole("button", { name: "View Options" }).click();
  await page.getByRole("menuitem", { name: "Coloring" }).hover();
  await page.getByRole("menuitemcheckbox", { name: "Sequential" }).click();
  const totals = grid.locator('[role="row"] > [role="gridcell"]:nth-child(2)');
  await totals.nth(0).click();
  await totals.nth(5).click({ modifiers: ["Shift"] });
  await expect(window.getByRole("button", { name: /^Sum: / })).toBeVisible();
  if (SHOTS) await window.screenshot({ path: `${SHOTS}/db-edit-pin-heat.png`, animations: "disabled" });
});

test("Code Style › SQL: three choices over a live preview", async ({ workbench: page }) => {
  await page.evaluate(async () => {
    const contributions = "/src/workbench/contributions.ts";
    const section = "/src/features/database/SqlStyleSettings.tsx";
    const actions = "/src/platform/actions.ts";
    const { registerSettingsPage } = await import(contributions);
    const { SqlStyleSettings } = await import(section);
    const { executeAction } = await import(actions);
    // Language pages need the desktop backend; the section is the same on its own page.
    registerSettingsPage({
      id: "editor.codeStyle.sqlPreview",
      title: "SQL",
      group: "Editor",
      component: SqlStyleSettings,
    });
    void executeAction("file.settings", "editor.codeStyle.sqlPreview");
  });
  const dialog = page.getByRole("dialog");
  const preview = dialog.getByLabel("SQL formatting preview");
  await expect(preview).toContainText("SELECT o.id,");
  await expect(preview).toContainText("COUNT(i.id)          AS items,");
  await expect(preview).toContainText("    id         BIGINT");
  if (SHOTS) await dialog.screenshot({ path: `${SHOTS}/sql-style.png`, animations: "disabled" });

  await dialog.getByRole("button", { name: "Clause layout" }).click();
  await page.getByRole("option", { name: "Indented under the keyword" }).click();
  await dialog.getByRole("button", { name: "Keyword case" }).click();
  await page.getByRole("option", { name: "lower" }).click();
  await expect(preview).toContainText("select\n    o.id,");
  if (SHOTS) await dialog.screenshot({ path: `${SHOTS}/sql-style-indented.png`, animations: "disabled" });
});

test("New ▸ Data Source: the submenu stays while the pointer heads for it diagonally", async ({ workbench: page }) => {
  await page.evaluate(async () => {
    const storePath = "/src/features/database/store.ts";
    const contributionsPath = "/src/workbench/contributions.ts";
    const { useDatabase, DB_TOOL_WINDOW } = await import(storePath);
    const { toolWindowService } = await import(contributionsPath);
    useDatabase.setState({ loaded: true, sources: [] });
    toolWindowService().show(DB_TOOL_WINDOW, true);
  });
  await page.locator('section[data-toolwindow="database"]').getByRole("button", { name: /^New/ }).first().click();
  const parent = page.getByRole("menuitem", { name: "Data Source", exact: true });
  const pb = (await parent.boundingBox())!;
  await page.mouse.move(pb.x + pb.width / 2, pb.y + pb.height / 2);
  const redis = page.getByRole("menuitem", { name: "Redis", exact: true });
  await expect(redis).toBeVisible();
  // Down and right, across “From File…”, to an entry far down the submenu.
  const rb = (await redis.boundingBox())!;
  await page.mouse.move(rb.x + 20, rb.y + rb.height / 2, { steps: 12 });
  await expect(redis).toBeVisible();
  await expect(parent).toHaveAttribute("aria-expanded", "true");
});
