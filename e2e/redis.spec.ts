import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";

const SHOTS = process.env.LUMA_SHOTS;

// The bundled headless shell is not always installed: the system Chrome renders the same.
if (process.env.LUMA_E2E_CHROME) test.use({ channel: "chrome" });

/**
 * A Redis data source answered in the page (browser mode has no backend): the
 * `commands` the Redis views call return what a real server would (shapes from
 * `ide_db::redis`, verified against Redis 8 by `crates/ide-db/tests/redis.rs`).
 */
async function fakeRedis(page: Page) {
  await page.evaluate(async () => {
    const bindingsPath = "/src/bindings.ts";
    const storePath = "/src/features/database/store.ts";
    const contributionsPath = "/src/workbench/contributions.ts";
    const { commands } = await import(bindingsPath);
    const { useDatabase, loadSources, DB_TOOL_WINDOW } = await import(storePath);
    const { toolWindowService } = await import(contributionsPath);
    const ok = (data: unknown) => Promise.resolve({ status: "ok", data });
    const t = (text: string) => ({ text, binary: false });
    const keys: Array<[string, string]> = [
      ["user:1001:profile", "hash"],
      ["user:1001:cart", "list"],
      ["user:1002:profile", "hash"],
      ["user:1002:cart", "list"],
      ["session:9f2c1a", "string"],
      ["leaderboard:weekly", "zset"],
      ["tags:popular", "set"],
      ["events:orders", "stream"],
      ["config:feature-flags", "ReJSON-RL"],
      ["counter:visits", "string"],
    ];
    const c = commands as Record<string, unknown>;
    c.dbSources = () =>
      ok([
        { id: "cache", name: "luma-redis", driver: "redis", host: "127.0.0.1", port: 6379, database: "0", options: {} },
      ]);
    c.dbConnected = () => ok([]);
    c.dbConnect = () => ok(null);
    c.redisKeyspace = () =>
      ok({
        version: "8.0.2",
        mode: "standalone",
        databases: Array.from({ length: 16 }, (_, i) => ({
          index: i,
          keys: i === 0 ? keys.length : i === 3 ? 42 : 0,
          expires: i === 0 ? 1 : 0,
        })),
      });
    c.redisScan = () =>
      ok({ cursor: "0", done: true, keys: keys.map(([k, kind]) => ({ key: t(k), kind, ttlMs: -1, memory: 312 })) });
    c.redisKeyInfo = (_: string, key: { text: string }) =>
      ok({
        key,
        kind: keys.find(([k]) => k === key.text)?.[1] ?? "none",
        ttlMs: 3_540_000,
        length: 4,
        memory: 312,
        encoding: "listpack",
      });
    c.redisValue = (_: string, key: { text: string }, kind: string) => {
      if (kind === "hash")
        return ok({
          kind,
          columns: ["field", "value"],
          rows: [
            [t("name"), t("Ada Lovelace")],
            [t("email"), t("ada@example.com")],
            [t("plan"), t("pro")],
            [t("signup"), t("2026-01-04T09:12:44Z")],
          ],
          cursor: null,
          offset: 0,
          total: 4,
          value: null,
          truncated: false,
        });
      return ok({
        kind,
        columns: [],
        rows: [],
        cursor: null,
        offset: 0,
        total: null,
        value: t(`{"key":"${key.text}"}`),
        truncated: false,
      });
    };
    c.redisInfo = () =>
      ok(
        [
          "# Server",
          "redis_version:8.0.2",
          "redis_mode:standalone",
          "uptime_in_seconds:356400",
          "# Clients",
          "connected_clients:12",
          "blocked_clients:0",
          "# Memory",
          "used_memory:25165824",
          "used_memory_peak:31457280",
          "maxmemory:268435456",
          "mem_fragmentation_ratio:1.18",
          "mem_allocator:jemalloc-5.3.0",
          "# Persistence",
          "rdb_last_save_time:1762300000",
          "rdb_changes_since_last_save:37",
          "aof_enabled:1",
          "# Stats",
          "total_commands_processed:1843210",
          "instantaneous_ops_per_sec:1284",
          "keyspace_hits:982211",
          "keyspace_misses:41022",
          "expired_keys:5310",
          "evicted_keys:0",
          "instantaneous_input_kbps:84.21",
          "instantaneous_output_kbps:311.40",
          "# Replication",
          "role:master",
          "connected_slaves:1",
          "used_memory_rss:41943040",
          "used_memory_dataset:18874368",
          "used_memory_dataset_perc:75.00%",
          "used_memory_overhead:6291456",
          "maxmemory_policy:allkeys-lru",
          "total_connections_received:2381",
          "rejected_connections:0",
          "maxclients:10000",
          "total_net_input_bytes:73400320",
          "total_net_output_bytes:419430400",
          "pubsub_channels:3",
          "pubsub_patterns:1",
          "rdb_last_bgsave_status:ok",
          "os:Linux 6.12.76-linuxkit aarch64",
          "arch_bits:64",
          "tcp_port:6379",
          "process_id:1",
          "executable:/data/redis-server",
          "multiplexing_api:epoll",
          "uptime_in_days:4",
          "# Commandstats",
          "cmdstat_get:calls=812044,usec=1624088,usec_per_call=2.00,rejected_calls=0,failed_calls=0",
          "cmdstat_set:calls=302111,usec=906333,usec_per_call=3.00,rejected_calls=0,failed_calls=0",
          "cmdstat_hgetall:calls=120400,usec=722400,usec_per_call=6.00,rejected_calls=0,failed_calls=0",
          "cmdstat_zrange:calls=64020,usec=576180,usec_per_call=9.00,rejected_calls=0,failed_calls=0",
          "cmdstat_client|list:calls=12,usec=360,usec_per_call=30.00,rejected_calls=0,failed_calls=0",
          "# Keyspace",
          "db0:keys=10,expires=1,avg_ttl=3540000",
          "db3:keys=42,expires=0,avg_ttl=0",
        ].join("\r\n"),
      );
    c.redisCommand = () => ok({ kind: "array", items: [] });
    useDatabase.setState({ loaded: false });
    await loadSources();
    toolWindowService().show(DB_TOOL_WINDOW, true);
  });
}

test("browses a Redis server: databases, namespaces, typed keys, a key and the server", async ({ workbench: page }) => {
  await fakeRedis(page);
  const tree = page.getByRole("tree", { name: "Data sources" });
  await tree.getByRole("treeitem", { name: /luma-redis/ }).click();
  await page.keyboard.press("ArrowRight");
  const db0 = tree.getByRole("treeitem", { name: /^db0/ });
  await expect(db0).toBeVisible();
  // Databases with keys (and the configured one); empty ones stay out.
  await expect(tree.getByRole("treeitem", { name: /^db3/ })).toBeVisible();
  await expect(tree.getByRole("treeitem", { name: /^db1\b/ })).toHaveCount(0);
  await db0.click();
  await page.keyboard.press("ArrowRight");
  const user = tree.getByRole("treeitem", { name: /^user/ });
  await expect(user).toContainText("4");
  await user.click();
  await page.keyboard.press("ArrowRight");
  await tree.getByRole("treeitem", { name: /^1001/ }).click();
  await page.keyboard.press("ArrowRight");
  const profile = tree.getByRole("treeitem", { name: /profile/ }).first();
  await expect(profile).toContainText("HASH");
  if (SHOTS)
    await page
      .locator('section[data-toolwindow="database"]')
      .screenshot({ path: `${SHOTS}/redis-tree.png`, animations: "disabled" });

  await profile.dblclick();
  const editor = page.getByRole("grid", { name: /user:1001:profile|profile/ }).first();
  await expect(page.getByText("Ada Lovelace")).toBeVisible();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/redis-key.png`, animations: "disabled" });
  void editor;

  await page.evaluate(async () => {
    const redisStore = "/src/features/database/redis/store.ts";
    const { openServerInfo } = await import(redisStore);
    openServerInfo("cache");
  });
  await expect(page.getByText("Hit rate")).toBeVisible();
  await expect(page.getByText("96.0%")).toBeVisible();
  await expect(page.getByRole("region", { name: "Top Commands" })).toContainText("HGETALL");
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/redis-server.png`, animations: "disabled" });
  await page.getByRole("tab", { name: "All Info" }).click();
  await expect(page.getByRole("region", { name: "Commandstats" })).toBeVisible();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/redis-info.png`, animations: "disabled" });

  await page.evaluate(async () => {
    const redisStore = "/src/features/database/redis/store.ts";
    const { openRedisDialog } = await import(redisStore);
    openRedisDialog({ kind: "newKey", target: "cache:0", prefix: "user:1003:" });
  });
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByLabel("Key:")).toHaveValue("user:1003:");
  await dialog.getByRole("button", { name: "Key type" }).click();
  await page.getByRole("option", { name: "Hash" }).click();
  await expect(dialog.getByLabel("Field:")).toBeVisible();
  if (SHOTS) await dialog.screenshot({ path: `${SHOTS}/redis-new-key.png`, animations: "disabled" });
});

test("the Redis console: highlighting, database picker, completion", async ({ workbench: page }) => {
  await fakeRedis(page);
  await page.evaluate(async () => {
    const fixturePath = "/e2e/redisConsole.fixture.tsx";
    const { mountRedisConsole } = await import(fixturePath);
    await mountRedisConsole(
      'HSET user:1001:profile plan "enterprise"\nZRANGE leaderboard:weekly 0 9 WITHSCORES\n# keys of a namespace\nSCAN 0 MATCH user:* COUNT 100\n',
    );
  });
  const host = page.locator("[data-redis-console]");
  await expect(host.getByRole("button", { name: "Database" })).toContainText("db0");
  await host.locator(".cm-content").click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type("hge");
  await page.keyboard.press("Control+Space");
  await expect(page.locator(".cm-tooltip-autocomplete")).toContainText("HGETALL");
  if (SHOTS) await host.screenshot({ path: `${SHOTS}/redis-console.png`, animations: "disabled" });
});

test("the Redis data source dialog opens, and data source dialogs keep opening after it", async ({
  workbench: page,
}) => {
  const errors: string[] = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await page.evaluate(async () => {
    const storePath = "/src/features/database/store.ts";
    const contributionsPath = "/src/workbench/contributions.ts";
    const { openSourceDialog, useDatabase, DB_TOOL_WINDOW } = await import(storePath);
    const { toolWindowService } = await import(contributionsPath);
    useDatabase.setState({ loaded: true, sources: [] });
    toolWindowService().show(DB_TOOL_WINDOW, true);
    openSourceDialog(null, { driver: "redis", port: 6379, ssl: "disable" });
  });
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("tab", { name: "SSH/SSL" })).toBeVisible();
  // Redis has neither schemas nor driver properties.
  await expect(dialog.getByRole("tab", { name: "Schemas" })).toHaveCount(0);
  await expect(dialog.getByRole("tab", { name: "Advanced" })).toHaveCount(0);
  await dialog.getByRole("tab", { name: "Options" }).click();
  await expect(dialog.getByLabel("Key separator:")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);

  await page.locator('section[data-toolwindow="database"]').getByRole("button", { name: /^New/ }).first().click();
  await page.getByRole("menuitem", { name: "Data Source", exact: true }).hover();
  await page.getByRole("menuitem", { name: "MySQL", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  expect(errors.filter((e) => /crashed|TypeError/.test(e))).toEqual([]);
});

async function fakeServer(page: Page) {
  await page.evaluate(async () => {
    const fixturePath = "/e2e/redisBrowser.fixture.tsx";
    const { installFakeRedis } = await import(fixturePath);
    await installFakeRedis();
  });
}

test("the Redis Browser: keys by folder, values by type, filters, menus and the command line", async ({
  workbench: page,
}) => {
  await fakeServer(page);
  const tree = page.getByRole("tree", { name: "Data sources" });
  await tree.getByRole("treeitem", { name: /luma-redis/ }).click();
  await page.keyboard.press("ArrowRight");
  // Double-clicking a database opens its Browser.
  await tree.getByRole("treeitem", { name: /^db0/ }).dblclick();
  const browser = page.getByRole("toolbar", { name: "Redis Browser" }).locator("..");
  const keys = browser.getByRole("tree", { name: "Keys" });
  await expect(keys.getByRole("treeitem", { name: /^user/ })).toBeVisible();
  await expect(page.getByRole("tab", { name: /luma-redis · db0/ })).toBeVisible();

  // Folders open; a key shows its type, TTL and size, and its value beside.
  await keys.getByRole("treeitem", { name: /^user/ }).click();
  await page.keyboard.press("ArrowRight");
  await keys.getByRole("treeitem", { name: /^1001/ }).click();
  await page.keyboard.press("ArrowRight");
  const profile = keys.getByRole("treeitem", { name: /profile/ }).first();
  await expect(profile).toContainText("HASH");
  await profile.click();
  const value = browser.getByRole("region", { name: "Value" });
  await expect(value.getByText("user:1001:profile")).toBeVisible();
  await expect(value.getByText("Ada Lovelace")).toBeVisible();
  // A JSON field opens the Value panel by itself.
  await expect(value.getByRole("tab", { name: "Value" })).toBeVisible();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/redis-browser-hash.png`, animations: "disabled" });

  // A sorted set, a string as JSON, a stream.
  await keys.getByRole("treeitem", { name: /^leaderboard/ }).click();
  await page.keyboard.press("ArrowRight");
  await keys.getByRole("treeitem", { name: /weekly/ }).click();
  await expect(value.getByText("3820")).toBeVisible();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/redis-browser-zset.png`, animations: "disabled" });

  // The filter scans by pattern (text is a substring), the type picker by type.
  const filter = browser.getByRole("textbox", { name: "Filter keys" });
  await filter.fill("session");
  await expect(keys.getByRole("treeitem")).toHaveCount(3);
  await keys.getByRole("treeitem", { name: /9f2c1a/ }).click();
  await expect(value.getByRole("textbox", { name: /Value of session:9f2c1a/ })).toHaveValue(/"uid": 1001/);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/redis-browser-string.png`, animations: "disabled" });
  await filter.fill("");
  await browser.getByRole("button", { name: "Key type" }).click();
  await page.getByRole("option", { name: "Stream" }).click();
  await expect(keys.getByRole("treeitem", { name: /^events/ })).toBeVisible();
  await expect(keys.getByRole("treeitem", { name: /^user/ })).toHaveCount(0);
  await browser.getByRole("button", { name: "Key type" }).click();
  await page.getByRole("option", { name: "All Types" }).click();
  await expect(keys.getByRole("treeitem", { name: /^user/ })).toBeVisible();

  // The command line: runs on db0, prints like redis-cli; a write refreshes the keys.
  const cli = browser.getByRole("region", { name: "Command Line" });
  const prompt = cli.getByRole("textbox", { name: "Redis command" });
  await prompt.click();
  await page.keyboard.type("HGETALL user:1001:profile");
  await page.keyboard.press("Enter");
  await expect(cli.getByText('2) "Ada Lovelace"')).toBeVisible();
  await page.keyboard.type("SET app:mode maintenance");
  await page.keyboard.press("Enter");
  await expect(cli.getByText("OK", { exact: true })).toBeVisible();
  await expect(keys.getByRole("treeitem", { name: /^app/ })).toContainText("2");
  await page.keyboard.type("NOPE 1");
  await page.keyboard.press("Enter");
  await expect(cli.getByText(/\(error\) ERR unknown command 'NOPE'/)).toBeVisible();
  // Completion lists open above the pane, never clipped by it.
  await page.keyboard.type("zra");
  const list = page.locator(".cm-tooltip-autocomplete");
  await expect(list).toBeVisible();
  await expect(list).toContainText("ZRANGE");
  await expect(cli.locator(".cm-tooltip-autocomplete")).toHaveCount(0);
  // Whole, inside the window (the pane is short: the list overlaps what is around it).
  const box = (await list.boundingBox())!;
  const viewport = page.viewportSize()!;
  expect(box.height).toBeGreaterThan(100);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/redis-browser-complete.png`, animations: "disabled" });
  await page.keyboard.press("Escape");
  await page.keyboard.press("Control+c");
  // ↑ recalls the last command.
  await page.keyboard.press("ArrowUp");
  await expect(prompt).toHaveText("NOPE 1");
  await page.keyboard.press("Control+c");
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/redis-browser-cli.png`, animations: "disabled" });

  // A key's menu; the command line collapses to its header and comes back.
  await keys.getByRole("treeitem", { name: /^user/ }).click();
  await keys.getByRole("treeitem", { name: /cart/ }).first().click({ button: "right" });
  await expect(page.getByRole("menuitem", { name: "Open in New Tab" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Delete Key…" })).toBeVisible();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/redis-browser-menu.png`, animations: "disabled" });
  await page.getByRole("menuitem", { name: "Insert into Command Line" }).click();
  await expect(prompt).toHaveText("user:1001:cart");
  await browser.getByRole("button", { name: "Collapse Command Line" }).click();
  await expect(prompt).toBeHidden();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/redis-browser-collapsed.png`, animations: "disabled" });
  await browser.getByRole("button", { name: "Expand Command Line" }).click();
  await expect(prompt).toBeVisible();
});
