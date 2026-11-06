import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";

const SHOTS = process.env.LUMA_SHOTS;

// The bundled headless shell is not always installed: the system Chrome renders the same.
if (process.env.LUMA_E2E_CHROME) test.use({ channel: "chrome" });
test.setTimeout(90_000);

/**
 * The Elasticsearch cluster of `elasticBrowser.fixture.tsx`, plus the requests the tree,
 * cluster overview and New Index dialog send beyond Discover's (`_cat/nodes`, `PUT /index`).
 */
async function fakeCluster(page: Page) {
  await page.evaluate(async () => {
    const fixturePath = "/e2e/elasticBrowser.fixture.tsx";
    const bindingsPath = "/src/bindings.ts";
    const storePath = "/src/features/database/store.ts";
    const contributionsPath = "/src/workbench/contributions.ts";
    const { installFakeElastic } = await import(fixturePath);
    const { commands } = await import(bindingsPath);
    const { DB_TOOL_WINDOW } = await import(storePath);
    const { toolWindowService } = await import(contributionsPath);
    const state = await installFakeElastic();
    const c = commands as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
    const base = c.esRequest!;
    const json = (status: number, body: unknown) => ({
      status: "ok",
      data: { status, elapsedMs: 4.6, contentType: "application/json", body: JSON.stringify(body), truncated: false },
    });
    c.esRequest = async (req, id, method, path, body) => {
      const p = String(path);
      if (p.startsWith("/_cat/nodes")) {
        state.log.push(`${String(method)} ${p}`);
        return json(200, [
          {
            name: "es-node-1",
            "node.role": "cdfhilmrstw",
            master: "*",
            "heap.percent": "41",
            "ram.percent": "78",
            cpu: "6",
            "disk.used_percent": "63.2",
            version: "8.19.10",
            ip: "172.18.0.2",
          },
        ]);
      }
      if (String(method) === "PUT" && /^\/[^/_][^/]*$/.test(p)) {
        state.log.push(`PUT ${p}`);
        return json(200, { acknowledged: true, shards_acknowledged: true, index: p.slice(1) });
      }
      return base(req, id, method, path, body);
    };
    (window as unknown as { __es: typeof state }).__es = state;
    toolWindowService().show(DB_TOOL_WINDOW, true);
  });
}

const requests = (page: Page) => page.evaluate(() => (window as unknown as { __es: { log: string[] } }).__es.log);

test("the Elasticsearch tree: indices, data streams, aliases, fields and the cluster", async ({ workbench: page }) => {
  await fakeCluster(page);
  const tree = page.getByRole("tree", { name: "Data sources" });
  await tree.getByRole("treeitem", { name: /luma-es/ }).click();
  await page.keyboard.press("ArrowRight");
  const logs = tree.getByRole("treeitem", { name: /logs-app-2026\.11\.05/ }).first();
  await expect(logs).toBeVisible();
  // System indices stay out unless asked for.
  await expect(tree.getByRole("treeitem", { name: /\.kibana/ })).toHaveCount(0);
  await expect(tree.getByRole("treeitem", { name: /orders/ })).toBeVisible();
  await logs.click();
  await page.keyboard.press("ArrowRight");
  await expect(tree.getByRole("treeitem", { name: /^message/ }).first()).toBeVisible();
  if (SHOTS)
    await page
      .locator('section[data-toolwindow="database"]')
      .screenshot({ path: `${SHOTS}/es-tree.png`, animations: "disabled" });

  await page.evaluate(async () => {
    const storePath = "/src/features/database/elastic/store.ts";
    const { openCluster } = await import(storePath);
    openCluster("logs");
  });
  await expect(page.getByRole("region", { name: "Nodes" })).toContainText("es-node-1");
  await expect(page.getByRole("region", { name: "Indices" })).toContainText("orders");
  expect((await requests(page)).some((r) => r.startsWith("GET /_cat/nodes?format=json"))).toBe(true);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/es-cluster.png`, animations: "disabled" });
});

test("New Index: the name checked as Elasticsearch does, then created", async ({ workbench: page }) => {
  await fakeCluster(page);
  await page.evaluate(async () => {
    const storePath = "/src/features/database/elastic/store.ts";
    const { openEsDialog } = await import(storePath);
    openEsDialog({ kind: "createIndex", id: "logs" });
  });
  const dialog = page.getByRole("dialog");
  const name = dialog.getByLabel("Name:");
  await name.fill("Orders");
  await expect(dialog).toContainText(/lower case/);
  await expect(dialog.getByRole("button", { name: "Create" })).toBeDisabled();
  await name.fill("orders-2026.11");
  await expect(dialog.getByRole("button", { name: "Create" })).toBeEnabled();
  if (SHOTS) await dialog.screenshot({ path: `${SHOTS}/es-new-index.png`, animations: "disabled" });
  await dialog.getByRole("button", { name: "Create" }).click();
  await expect(dialog).toHaveCount(0);
  expect(await requests(page)).toContain("PUT /orders-2026.11");
});

test("the Elasticsearch console: highlighting, run per request, hits and errors", async ({ workbench: page }) => {
  await fakeCluster(page);
  await page.evaluate(async () => {
    const fixturePath = "/e2e/elasticConsole.fixture.tsx";
    const { mountEsConsole } = await import(fixturePath);
    await mountEsConsole(
      [
        "# Errors of the last day",
        "GET /logs-*/_search",
        "{",
        '  "size": 20,',
        '  "query": { "match": { "message": "timeout" } },',
        '  "sort": [{ "@timestamp": "desc" }]',
        "}",
        "",
        "GET /_unknown_endpoint",
        "",
      ].join("\n"),
    );
  });
  const host = page.locator("[data-es-console]");
  await expect(host.getByRole("button", { name: "Data source" })).toContainText("luma-es");
  // The gutter is aria-hidden (CodeMirror's): ⌘↵ is the keyboard way.
  const runs = host.locator(".cm-luma-es-run");
  await expect(runs).toHaveCount(2);
  await runs.first().click();
  const results = page.getByRole("grid", { name: "Hits" });
  await expect(results.getByRole("row").nth(1)).toBeVisible();
  await expect(page.getByText(/hits$/).first()).toBeVisible();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/es-console.png`, animations: "disabled" });

  await page.getByRole("radio", { name: "JSON" }).click();
  await expect(page.getByRole("tree", { name: "Response" })).toBeVisible();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/es-console-json.png`, animations: "disabled" });

  await runs.nth(1).click();
  await expect(host.locator(".cm-luma-es-run-bad")).toHaveCount(1);
  await expect(page.getByText("400", { exact: true }).first()).toBeVisible();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/es-console-error.png`, animations: "disabled" });

  // Completion: endpoints after the method.
  await host.locator(".cm-content").click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type("GET /_ca");
  await page.keyboard.press("Control+Space");
  await expect(page.locator(".cm-tooltip-autocomplete")).toContainText("_cat");
  if (SHOTS) await host.screenshot({ path: `${SHOTS}/es-console-completion.png`, animations: "disabled" });
});

test("the Elasticsearch data source dialog: authentication modes, no database", async ({ workbench: page }) => {
  await page.evaluate(async () => {
    const storePath = "/src/features/database/store.ts";
    const contributionsPath = "/src/workbench/contributions.ts";
    const { openSourceDialog, useDatabase, DB_TOOL_WINDOW } = await import(storePath);
    const { toolWindowService } = await import(contributionsPath);
    useDatabase.setState({ loaded: true, sources: [] });
    toolWindowService().show(DB_TOOL_WINDOW, true);
    openSourceDialog(null, { driver: "elasticsearch", port: 9200, ssl: "prefer" });
  });
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByLabel("Port:")).toHaveValue("9200");
  await expect(dialog.getByLabel("Database:")).toHaveCount(0);
  await expect(dialog.getByLabel("User:")).toBeVisible();
  if (SHOTS) await dialog.screenshot({ path: `${SHOTS}/es-source.png`, animations: "disabled" });
  await dialog.getByRole("button", { name: "Authentication" }).click();
  await page.getByRole("option", { name: "API Key" }).click();
  await expect(dialog.getByLabel("User:")).toHaveCount(0);
  await expect(dialog.getByLabel("API key:")).toBeVisible();
  await dialog.getByRole("tab", { name: "Options" }).click();
  await expect(dialog.getByText("Show hidden and system indices")).toBeVisible();
});
