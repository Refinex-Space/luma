import type { Page } from "@playwright/test";
import { doubleShift, expect, test } from "./fixtures";

const SHOTS = process.env.LUMA_SHOTS;

// The bundled headless shell is not always installed: the system Chrome renders the same.
if (process.env.LUMA_E2E_CHROME) test.use({ channel: "chrome" });

/**
 * A MySQL data source as the `luma` user sees the sample server (`tmp/luma-docker`), and a
 * Redis one, answered in the page (browser mode has no backend). `mysqlCatalog.json` is
 * what `ide_db` returned from that server: schemas, tables, the catalog, Server Objects.
 */
async function fakeServers(page: Page) {
  await page.evaluate(async () => {
    const bindingsPath = "/src/bindings.ts";
    const storePath = "/src/features/database/store.ts";
    const contributionsPath = "/src/workbench/contributions.ts";
    const dataPath = "/e2e/mysqlCatalog.json";
    const { commands } = await import(bindingsPath);
    const { useDatabase, loadSources, DB_TOOL_WINDOW } = await import(storePath);
    const { toolWindowService } = await import(contributionsPath);
    const data = (await import(dataPath)).default;
    const ok = (v: unknown) => Promise.resolve({ status: "ok", data: v });
    const keys: Array<[string, string]> = [
      ["app:name", "string"],
      ["app:version", "string"],
      ["leaderboard", "zset"],
      ["queue:orders", "list"],
      ["session:abc123", "string"],
      ["tags:product:1", "set"],
      ["user:1001", "hash"],
      ["user:1002", "hash"],
    ];
    const c = commands as Record<string, unknown>;
    c.dbSources = () =>
      ok([
        { id: "redis", name: "0@localhost", driver: "redis", host: "127.0.0.1", port: 6379, database: "0" },
        { id: "my", name: "@localhost", driver: "mysql", host: "127.0.0.1", port: 3306, user: "luma" },
      ]);
    c.dbConnected = () => ok([]);
    c.dbConnect = () => ok(null);
    c.dbSchemas = () => ok(data.schemas);
    c.dbTables = (_: string, schema: string) => ok(data.tables[schema] ?? []);
    c.dbSchemaObjects = () => ok({ routines: [], sequences: [] });
    c.dbTableDetails = (_: string, _schema: string, table: string) =>
      ok(data.details[table] ?? { columns: [], indexes: [], foreignKeys: [], triggers: [] });
    c.dbServerObjects = () => ok(data.server);
    // Nothing saved yet: the connected data source is introspected.
    c.dbCatalog = (_: string, refresh: boolean) => ok(refresh ? data.catalog : null);
    c.redisKeyspace = () =>
      ok({ version: "8.10.0", mode: "standalone", databases: [{ index: 0, keys: 8, expires: 0 }] });
    c.redisScan = () =>
      ok({
        cursor: "0",
        done: true,
        keys: keys.map(([k, kind]) => ({ key: { text: k, binary: false }, kind, ttlMs: -1, memory: 64 })),
      });
    await loadSources();
    useDatabase.setState({ treeExpanded: new Set() });
    toolWindowService().show(DB_TOOL_WINDOW, true);
  });
}

/** Double Shift after the typing guard (a Shift right after other keys is typing, not the gesture). */
async function searchEverywhere(page: Page) {
  await page.waitForTimeout(400);
  await doubleShift(page);
  const dialog = page.getByRole("dialog", { name: "Search Everywhere" });
  await expect(dialog).toBeVisible();
  return dialog;
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

const tree = (page: Page) => page.getByRole("tree", { name: "Data sources" });
const row = (page: Page, name: RegExp | string) => tree(page).getByRole("treeitem", { name }).first();

async function expand(page: Page, name: RegExp | string) {
  const item = row(page, name);
  await item.click();
  await page.keyboard.press("ArrowRight");
  await expect(item).toHaveAttribute("aria-expanded", "true");
}

test("the Database tree lists the system schemas and Server Objects", async ({ workbench: page }) => {
  await fakeServers(page);
  await expand(page, /^(Connected )?@localhost/);
  for (const name of [/^information_schema/, /^luma/, /^performance_schema/, /^Server Objects/])
    await expect(row(page, name)).toBeVisible();
  await expand(page, /^information_schema/);
  await expect(row(page, /^views\s*78$/)).toBeVisible();
  await expand(page, /^performance_schema/);
  await expand(page, /^tables\s*8$/);
  await expect(row(page, /^global_status/)).toBeVisible();
  await expand(page, /^Server Objects/);
  await expect(row(page, /^collations\s*286$/)).toBeVisible();
  await expand(page, /^users\s*1$/);
  await expect(row(page, /^luma@%$/)).toBeVisible();
  await row(page, /^luma@%$/).scrollIntoViewIfNeeded();
  // The MySQL internal schemas stay behind "Show internal system schemas".
  await expect(row(page, /^mysql$/)).toHaveCount(0);
  if (SHOTS) {
    const window = page.locator('section[data-toolwindow="database"]');
    await window.screenshot({ path: `${SHOTS}/db-server-objects-light.png`, animations: "disabled" });
    await setTheme(page, "Islands Dark");
    await window.screenshot({ path: `${SHOTS}/db-server-objects-dark.png`, animations: "disabled" });
  }
});

test("Search Everywhere finds tables, columns, keys and Redis keys, and selects them in the tree", async ({
  workbench: page,
}) => {
  await fakeServers(page);
  // Connected data sources are introspected on the first search; Redis keys once the tree loaded them.
  await expand(page, /^(Connected )?@localhost/);
  await expand(page, /^(Connected )?0@localhost/);
  await expand(page, /^db0/);

  const dialog = await searchEverywhere(page);
  await dialog.getByRole("combobox").fill("order");
  const option = (name: RegExp) => dialog.getByRole("option", { name });
  await expect(option(/^orders\s*luma \[@localhost\]/)).toBeVisible();
  await expect(option(/^order_item\s*luma \[@localhost\]/)).toBeVisible();
  await expect(option(/^order_summary\s*luma \[@localhost\]/)).toBeVisible();
  await expect(option(/^order_id\s*luma\.order_item \[@localhost\]/)).toBeVisible();
  if (SHOTS) await dialog.screenshot({ path: `${SHOTS}/se-database-all-light.png`, animations: "disabled" });
  // The All tab shows the best few; the Symbols tab lists every object.
  await dialog.getByRole("tab", { name: "Symbols" }).click();
  await expect(option(/^fk_item_order\s*luma\.order_item/)).toBeVisible();
  await expect(option(/^idx_orders_status\s*luma\.orders/)).toBeVisible();
  await expect(option(/queue:orders\s*0 \[0@localhost\]/)).toBeVisible();
  await expect(option(/^ACTION_ORDER\s*information_schema\.TRIGGERS/)).toBeVisible();
  if (SHOTS) await dialog.screenshot({ path: `${SHOTS}/se-database-symbols-light.png`, animations: "disabled" });

  // ⌥↵: what else the object offers.
  await option(/^orders\s*luma/).hover();
  await dialog.getByRole("combobox").focus();
  for (let i = 0; i < 20 && !(await option(/^orders\s*luma/).getAttribute("aria-selected"))?.includes("true"); i++)
    await page.keyboard.press("ArrowDown");
  await expect(option(/^orders\s*luma/)).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Alt+Enter");
  for (const name of ["Select in Database View", "Edit Data", "Go to DDL", "Copy Qualified Name"])
    await expect(page.getByRole("menuitem", { name })).toBeVisible();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/se-database-intentions-light.png`, animations: "disabled" });
  await page.keyboard.press("Escape");

  // Enter selects it in the Database tool window.
  await page.keyboard.press("Enter");
  await expect(dialog).toBeHidden();
  await expect(row(page, /^orders$/)).toHaveAttribute("aria-selected", "true");

  // A qualified column: its table and columns folder open on the way.
  await (await searchEverywhere(page)).getByRole("combobox").fill("luma.customer.email");
  // The column, then its unique index of the same name.
  await expect(option(/^email\s*luma\.customer/)).toHaveCount(2);
  await expect(option(/^email\s*luma\.customer/).first()).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Enter");
  await expect(row(page, /^email/)).toHaveAttribute("aria-selected", "true");
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/se-database-revealed-light.png`, animations: "disabled" });

  if (SHOTS) {
    await setTheme(page, "Islands Dark");
    await (await searchEverywhere(page)).getByRole("combobox").fill("order");
    await dialog.getByRole("tab", { name: "Symbols" }).click();
    await expect(option(/^ACTION_ORDER/)).toBeVisible();
    await dialog.screenshot({ path: `${SHOTS}/se-database-symbols-dark.png`, animations: "disabled" });
  }
});
