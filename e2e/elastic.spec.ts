import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";

const SHOTS = process.env.LUMA_SHOTS;

// The bundled headless shell is not always installed: the system Chrome renders the same.
if (process.env.LUMA_E2E_CHROME) test.use({ channel: "chrome" });
test.setTimeout(90_000);

/** An Elasticsearch data source answered in the page (`elasticBrowser.fixture.tsx`), its Discover tab open on `logs-*`. */
async function openDiscover(page: Page, opts: { readOnly?: boolean } = {}) {
  await page.evaluate(async (o) => {
    const fixturePath = "/e2e/elasticBrowser.fixture.tsx";
    const modelPath = "/src/features/database/elastic/model.ts";
    const contributionsPath = "/src/workbench/contributions.ts";
    const { installFakeElastic } = await import(fixturePath);
    const { esDiscoverInput } = await import(modelPath);
    const { editorService } = await import(contributionsPath);
    (window as unknown as { __es: unknown }).__es = await installFakeElastic(o);
    await editorService().openInput(esDiscoverInput("logs", "logs-*"), { focus: true });
  }, opts);
  const bar = page.getByRole("toolbar", { name: "Discover" });
  await expect(bar).toBeVisible();
  const root = bar.locator("..");
  await expect(root.getByRole("grid", { name: "Documents" }).getByRole("row").nth(1)).toBeVisible();
  return root;
}

/** A field's row in the field list. */
function fieldRow(root: ReturnType<Page["locator"]>, name: string) {
  return root
    .getByRole("region", { name: "Fields" })
    .getByRole("listitem")
    .filter({ has: root.page().locator(`[title="${name}"]`) });
}

const requests = (page: Page) => page.evaluate(() => [...(window as unknown as { __es: { log: string[] } }).__es.log]);
const openPits = (page: Page) =>
  page.evaluate(() => (window as unknown as { __es: { pits: Map<string, unknown> } }).__es.pits.size);

async function shot(page: Page, name: string) {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png`, animations: "disabled" });
}

async function hitCount(root: ReturnType<Page["locator"]>): Promise<number> {
  const text =
    (await root
      .getByRole("status")
      .filter({ hasText: /hits?$/ })
      .first()
      .textContent()) ?? "";
  return Number(text.replace(/[^\d]/g, ""));
}

async function setTheme(page: Page, label: string) {
  await page.keyboard.press("Meta+,");
  const dialog = page.getByRole("dialog", { name: "Settings", exact: true });
  await expect(dialog).toBeVisible();
  await dialog
    .locator('[role="treeitem"][aria-level="2"]')
    .filter({ hasText: /^Appearance$/ })
    .click();
  await page.getByRole("button", { name: "Theme", exact: true }).click();
  await page.getByRole("option", { name: label, exact: true }).click();
  await dialog.getByRole("button", { name: "Apply", exact: true }).click();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
}

test("Discover: hits over time, the query bar, fields, columns, sorting and paging", async ({ workbench: page }) => {
  const root = await openDiscover(page);
  const grid = root.getByRole("grid", { name: "Documents" });
  const query = root.getByRole("textbox", { name: "Query" });

  // Time-based: the histogram and the time picker; newest first, as a summary of each document.
  await expect(root.getByRole("img", { name: /Hits over time/ })).toBeVisible();
  await expect(root.getByRole("button", { name: "Time range" })).toContainText("Last 24 hours");
  const total = await hitCount(root);
  expect(total).toBeGreaterThan(150);
  expect(total).toBeLessThan(300);
  await expect(grid.getByRole("columnheader", { name: /@timestamp/ })).toHaveAttribute("aria-sort", "descending");
  await expect(grid.getByRole("row").nth(1)).toContainText("level");
  await page.mouse.move(700, 160);
  await shot(page, "es-discover");

  // KQL: completion of fields, then of values; ↵ runs.
  await query.click();
  await page.keyboard.type("lev");
  const suggestions = page.getByRole("listbox", { name: "Suggestions" });
  await expect(suggestions.getByRole("option", { name: /level/ })).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(query).toHaveValue("level ");
  await expect(suggestions.getByRole("option", { name: /^:\s?equals/ })).toBeVisible();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(query).toHaveValue("level: ");
  await expect(suggestions.getByRole("option", { name: "error" })).toBeVisible();
  await shot(page, "es-discover-complete");
  await page.keyboard.type("err");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(query).toHaveValue('level: "error" ');
  await page.keyboard.press("Enter");
  await expect.poll(() => hitCount(root)).toBeLessThan(total / 3);
  const errors = await hitCount(root);
  expect(errors).toBeGreaterThan(5);

  // A field's top values; + filters for one.
  await fieldRow(root, "service").click();
  const top = page.getByRole("dialog", { name: "Top values of service" });
  await expect(top.getByText("%").first()).toBeVisible();
  await shot(page, "es-discover-top-values");
  await top.getByRole("button", { name: "Filter for Value" }).first().click();
  await expect(query).toHaveValue(/^level: "error" and service:"[a-z]+"$/);
  await expect.poll(() => hitCount(root)).toBeLessThan(errors);

  // Columns from the field list; a column sorts from its header.
  await query.fill("");
  await query.press("Enter");
  await expect.poll(() => hitCount(root)).toBe(total);
  for (const name of ["level", "service", "http.status", "message"]) {
    const row = fieldRow(root, name);
    await row.hover();
    await row.getByRole("button", { name: "Add Column" }).click();
  }
  await expect(grid.getByRole("columnheader", { name: "http.status" })).toBeVisible();
  await grid.getByRole("columnheader", { name: "http.status" }).click();
  await expect(grid.getByRole("columnheader", { name: "http.status" })).toHaveAttribute("aria-sort", "ascending");
  await expect(grid.getByRole("row").nth(1).getByRole("gridcell").nth(4)).toHaveText("200");
  await grid.getByRole("columnheader", { name: "http.status" }).click();
  await expect(grid.getByRole("row").nth(1).getByRole("gridcell").nth(4)).toHaveText(/^50\d$/);
  await shot(page, "es-discover-columns");

  // All time: 300 hits, paged by 100.
  await root.getByRole("button", { name: "Time range" }).click();
  await expect(page.getByRole("dialog", { name: "Time range" })).toBeVisible();
  await shot(page, "es-discover-time");
  await page.getByRole("option", { name: /All time/ }).click();
  await expect.poll(() => hitCount(root)).toBe(300);
  await expect(root.getByText("100 of 300")).toBeVisible();
  await root.getByRole("button", { name: "Load More" }).click();
  await expect(root.getByText("200 of 300")).toBeVisible();
  // Pages come from the search's point in time: documents deleted meanwhile still page in.
  await page.evaluate(() => (window as unknown as { __es: { docs: unknown[] } }).__es.docs.splice(0, 40));
  await root.getByRole("button", { name: "Load More" }).click();
  await expect(root.getByText("300 documents")).toBeVisible();
  const log = await requests(page);
  expect(log.filter((r) => r.startsWith("POST /logs-*/_pit")).length).toBeGreaterThan(0);
  expect(log.filter((r) => r === "POST /_search").length).toBeGreaterThanOrEqual(3);
  // Done: the point in time is closed.
  await expect.poll(() => openPits(page)).toBe(0);

  // Dragging across the histogram zooms in.
  const plot = root.getByRole("img", { name: /Hits over time/ });
  const box = (await plot.boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.7, box.y + 50);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.85, box.y + 50, { steps: 6 });
  await shot(page, "es-discover-brush");
  await page.mouse.up();
  await expect(root.getByRole("button", { name: "Time range" })).toContainText("→");
  await expect.poll(() => hitCount(root)).toBeLessThan(300);
});

test("Discover: highlighted matches, invalid KQL, Lucene", async ({ workbench: page }) => {
  const root = await openDiscover(page);
  const query = root.getByRole("textbox", { name: "Query" });
  await query.fill("timeout or declined");
  await query.press("Enter");
  await expect(root.locator("mark").first()).toBeVisible();
  await page.mouse.move(700, 160);
  await shot(page, "es-discover-highlight");

  // A query cut short is one being typed: unmarked until run or left; running it says why.
  await query.fill("level:(error or ");
  await expect(query).not.toHaveAttribute("aria-invalid", "true");
  await query.press("Enter");
  const alert = root.getByRole("alert");
  await expect(alert).toContainText("Invalid query");
  await query.blur();
  await expect(query).toHaveAttribute("aria-invalid", "true");
  await shot(page, "es-discover-invalid");

  // Lucene goes to query_string.
  await root.getByRole("button", { name: "Query language" }).click();
  await expect(root.getByRole("button", { name: "Query language" })).toHaveText("Lucene");
  await query.fill("level:warn AND service:auth*");
  await query.press("Enter");
  await expect(root.getByRole("alert")).toHaveCount(0);
  await expect(root.getByRole("grid", { name: "Documents" }).getByRole("row").nth(1)).toContainText("auth");

  // Lucene completes too: `field:` then its values, keywords after a term.
  await query.fill("");
  await page.keyboard.type("serv");
  const suggestions = page.getByRole("listbox", { name: "Suggestions" });
  await expect(suggestions.getByRole("option", { name: /service/ })).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(query).toHaveValue("service:");
  await expect(suggestions.getByRole("option", { name: "checkout" })).toBeVisible();
  await suggestions.getByRole("option", { name: "checkout" }).click();
  await expect(query).toHaveValue('service:"checkout" ');
  await expect(suggestions.getByRole("option", { name: "AND" })).toBeVisible();
  await shot(page, "es-discover-lucene-complete");
  await query.press("Escape");
  await query.press("Enter");
  await expect.poll(() => hitCount(root)).toBeGreaterThan(0);
  await expect(root.getByRole("grid", { name: "Documents" }).getByRole("row").nth(1)).toContainText("checkout");
});

test("Discover: the document flyout — table, JSON, stepping, edit and delete", async ({ workbench: page }) => {
  const root = await openDiscover(page);
  const grid = root.getByRole("grid", { name: "Documents" });
  const total = await hitCount(root);
  await grid.getByRole("row").nth(1).dblclick();
  const doc = root.getByRole("region", { name: "Document", exact: true });
  await expect(doc.getByRole("table", { name: "Fields" })).toContainText("user.name");
  await expect(doc).toContainText("1 / ");
  await page.mouse.move(400, 500);
  await shot(page, "es-discover-document");
  await doc.getByRole("button", { name: "Next Document" }).click();
  await expect(doc).toContainText("2 / ");
  await doc.getByRole("tab", { name: "JSON" }).click();
  const json = doc.getByRole("tree", { name: "Document JSON" });
  await expect(json).toContainText('"_source"');
  await expect(json).toContainText('"http"');
  await shot(page, "es-discover-json");

  // Edit: invalid JSON can't be saved; a valid edit shows in the table.
  await doc.getByRole("button", { name: "Edit Document" }).click();
  const source = doc.getByRole("textbox", { name: /Source of/ });
  await source.fill("{ nope");
  await expect(doc.getByRole("button", { name: "Save" })).toBeDisabled();
  await source.fill(
    JSON.stringify(
      { "@timestamp": new Date().toISOString(), level: "info", message: "edited by luma", service: "auth" },
      null,
      2,
    ),
  );
  await shot(page, "es-discover-edit");
  await doc.getByRole("button", { name: "Save" }).click();
  await expect(doc.getByRole("tree", { name: "Document JSON" })).toContainText("edited by luma");
  await expect(grid).toContainText("edited by luma");

  // Delete asks first.
  await doc.getByRole("button", { name: "Delete Document" }).click();
  const confirm = page.getByRole("dialog", { name: "Delete Document" });
  await expect(confirm).toBeVisible();
  await confirm.getByRole("button", { name: "Delete" }).click();
  await expect(grid).not.toContainText("edited by luma");
  await expect.poll(() => hitCount(root)).toBe(total - 1);
  // The total and the histogram are counted again (the hits loaded stay).
  await expect
    .poll(async () => {
      const log = await requests(page);
      const del = log.map((r) => r.startsWith("DELETE /")).lastIndexOf(true);
      return log.slice(del + 1).some((r) => r.startsWith("POST /logs-*/_search"));
    })
    .toBe(true);

  // Dark.
  await setTheme(page, "Islands Dark");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await doc.getByRole("tab", { name: "Table" }).click();
  await page.mouse.move(400, 500);
  await shot(page, "es-discover-document-dark");
});

test("Discover: dark theme, read-only sources and the index picker", async ({ workbench: page }) => {
  await setTheme(page, "Islands Dark");
  const root = await openDiscover(page, { readOnly: true });
  await page.mouse.move(700, 160);
  await shot(page, "es-discover-dark");
  await fieldRow(root, "level").click();
  await expect(page.getByRole("dialog", { name: "Top values of level" }).getByText("%").first()).toBeVisible();
  await shot(page, "es-discover-top-values-dark");
  await page.keyboard.press("Escape");

  await root.getByRole("grid", { name: "Documents" }).getByRole("row").nth(2).dblclick();
  const doc = root.getByRole("region", { name: "Document", exact: true });
  await expect(doc.getByRole("button", { name: "Copy JSON" })).toBeVisible();
  await expect(doc.getByRole("button", { name: "Edit Document" })).toHaveCount(0);
  await expect(doc.getByRole("button", { name: "Delete Document" })).toHaveCount(0);
  await doc.getByRole("tab", { name: "JSON" }).click();
  await page.mouse.move(400, 500);
  await shot(page, "es-discover-json-dark");
  await doc.getByRole("button", { name: "Close", exact: true }).click();

  // The index picker: indices, aliases, data streams; hidden ones only once typed; any pattern.
  await root.getByRole("button", { name: "Index pattern" }).click();
  const picker = page.getByRole("listbox", { name: "Indices" });
  await expect(picker.getByRole("option", { name: /^logs\b/ }).first()).toBeVisible();
  await expect(picker.getByRole("option", { name: /kibana/ })).toHaveCount(0);
  await shot(page, "es-discover-index-picker-dark");
  await page.keyboard.type(".kib");
  await expect(picker.getByRole("option", { name: /kibana/ })).toBeVisible();
  await page.keyboard.press("Control+a");
  await page.keyboard.type("logs-app-*");
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("toolbar", { name: "Discover" }).getByRole("button", { name: "Index pattern" }),
  ).toContainText("logs-app-*");
});

test("Discover: Load More reopens an expired point in time", async ({ workbench: page }) => {
  const root = await openDiscover(page);
  await root.getByRole("button", { name: "Time range" }).click();
  await page.getByRole("option", { name: /All time/ }).click();
  await expect(root.getByText("100 of 300")).toBeVisible();
  expect(await openPits(page)).toBe(1);
  // Idle past its keep-alive: Elasticsearch forgets it.
  await page.evaluate(() => (window as unknown as { __es: { pits: Map<string, unknown> } }).__es.pits.clear());
  await root.getByRole("button", { name: "Load More" }).click();
  await expect(root.getByText("200 of 300")).toBeVisible();
  expect(await openPits(page)).toBe(1);
  // A new search closes the old one.
  await root.getByRole("button", { name: "Refresh" }).click();
  await expect(root.getByText("100 of 300")).toBeVisible();
  await expect.poll(() => openPits(page)).toBe(1);
});
