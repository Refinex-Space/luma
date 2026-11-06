import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";

const SHOTS = process.env.LUMA_SHOTS;

// The bundled headless shell is not always installed: the system Chrome renders the same.
if (process.env.LUMA_E2E_CHROME) test.use({ channel: "chrome" });

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

/** Turns the plugin on (browser mode has no backend: the settings change in place). */
async function enablePlugin(page: Page) {
  await page.evaluate(async () => {
    const projectPath = "/src/platform/project.ts";
    const storePath = "/src/features/hot-reload/store.ts";
    const { useProject } = await import(projectPath);
    const { useHotReload, refreshStatus } = await import(storePath);
    await refreshStatus();
    const status = useHotReload.getState().status;
    useHotReload.setState({
      status: {
        ...status,
        agent: {
          version: "2.0.4-SNAPSHOT",
          path: "/tools/hotswap-agent/hotswap-agent-2.0.4-SNAPSHOT.jar",
          custom: false,
        },
        runtimes: status.runtimes.map((r: { major: number }) =>
          r.major === 21 ? { ...r, home: "/tools/jdks/jbr-21.0.11/Contents/Home" } : r,
        ),
      },
    });
    const s = useProject.getState().settings ?? {};
    useProject.setState({ settings: { ...s, hotReload: { ...s.hotReload, enabled: true } } });
  });
}

const CODE = `package com.acme.orders

import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.RestController

@RestController
class OrderController(private val orders: OrderService) {

    @GetMapping("/orders")
    fun list(): List<OrderDto> = orders.findAll().map(OrderDto::from)

    @GetMapping("/orders/count")
    fun count(): Int = orders.findAll().size
}
`;

const BANNER = [
  "\x1b[2m2026-11-05T17:08:58.214+08:00\x1b[0;39m \x1b[32m INFO\x1b[0;39m \x1b[35m48211\x1b[0;39m \x1b[2m---\x1b[0;39m \x1b[36mc.a.orders.OrderApplication\x1b[0;39m \x1b[2m:\x1b[0;39m Starting OrderApplication using Java 21.0.11",
  "\x1b[2m2026-11-05T17:08:59.940+08:00\x1b[0;39m \x1b[32m INFO\x1b[0;39m \x1b[35m48211\x1b[0;39m \x1b[2m---\x1b[0;39m \x1b[36mo.s.b.w.embedded.tomcat.TomcatWebServer\x1b[0;39m \x1b[2m:\x1b[0;39m Tomcat started on port 8080 (http) with context path '/'",
  "\x1b[2m2026-11-05T17:09:00.012+08:00\x1b[0;39m \x1b[32m INFO\x1b[0;39m \x1b[35m48211\x1b[0;39m \x1b[2m---\x1b[0;39m \x1b[36mc.a.orders.OrderApplication\x1b[0;39m \x1b[2m:\x1b[0;39m Started OrderApplication in 1.874 seconds (process running for 2.31)",
];
const STARTUP = [
  "HOTSWAP AGENT: 17:08:56.824 INFO (org.hotswap.agent.HotswapAgent) - Loading Hotswap agent 2.0.4-SNAPSHOT - unlimited runtime class redefinition.",
  "HOTSWAP AGENT: 17:08:57.123 INFO (org.hotswap.agent.plugin.spring.boot.SpringBootPlugin) - Spring Boot plugin initialized - Spring Boot core version '3.5.16'",
  "HOTSWAP AGENT: 17:08:57.501 INFO (org.hotswap.agent.plugin.spring.SpringPlugin) - Spring plugin initialized - Spring core version '6.2.19'",
];

/** A Spring Boot run with hot reload whose console prints the agent's lines (as SPEC.md lists them). */
async function startRun(page: Page) {
  await page.evaluate(
    async ({ banner, startup }) => {
      const storePath = "/src/features/run/store.ts";
      const sessionsPath = "/src/features/hot-reload/sessions.ts";
      const { startRun, runtime, useRun } = await import(storePath);
      const { attachSession } = await import(sessionsPath);
      const config = {
        id: "orders",
        name: "OrderApplication",
        kind: "spring-boot",
        command: "java",
        args: ["-cp", "${classpath}", "com.acme.orders.OrderApplicationKt"],
        cwd: null,
        env: {},
        detected: true,
        isTest: false,
        debugAdapter: "java-debug",
        params: { hotReload: "true" },
      };
      useRun.setState({ configs: [config], selectedId: "orders" });
      const session = await startRun(config);
      const rt = runtime(session.id);
      rt.console.clear();
      const key = `run:${session.id}`;
      const started = useRun.getState().sessions.find((s: { id: string }) => s.id === session.id).startedAt;
      useRun.setState((s: { sessions: Array<{ id: string }> }) => ({
        sessions: s.sessions.map((x) =>
          x.id === session.id ? { ...x, status: "running", endedAt: null, runId: 1 } : x,
        ),
      }));
      rt.lineListeners.push(
        attachSession(key, {
          name: config.name,
          configId: config.id,
          mode: "run",
          engine: "hotswapAgent",
          runtime: "JetBrains Runtime 21.0.11",
          module: "",
          startedAt: started,
        }),
      );
      const w = window as unknown as { __hot: (lines: string[], kind?: string) => void };
      w.__hot = (lines, kind = "stdout") => {
        rt.console.append({ kind, text: lines.map((l) => `${l}\n`).join("") });
        useRun.setState((s: { versions: Record<string, number> }) => ({
          versions: { ...s.versions, [session.id]: (s.versions[session.id] ?? 0) + 1 },
        }));
      };
      w.__hot(["Hot reload: JetBrains Runtime 21.0.11 with HotswapAgent"], "system");
      w.__hot([startup[0], startup[1], startup[2], ...banner]);
    },
    { banner: BANNER, startup: STARTUP },
  );
}

async function emit(page: Page, lines: string[]) {
  await page.evaluate((lines) => (window as unknown as { __hot: (l: string[]) => void }).__hot(lines), lines);
}

/** An agent line stamped now (the timeline groups by the agent's clock). */
async function nowLine(page: Page, level: string, logger: string, message: string, offsetMs = 0) {
  return page.evaluate(
    ({ level, logger, message, offsetMs }) => {
      const d = new Date(Date.now() + offsetMs);
      const p = (n: number, w = 2) => String(n).padStart(w, "0");
      return `HOTSWAP AGENT: ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)} ${level} (${logger}) - ${message}`;
    },
    { level, logger, message, offsetMs },
  );
}

async function openController(page: Page) {
  await page.evaluate(async (code) => {
    const contributionsPath = "/src/workbench/contributions.ts";
    const editorPath = "/src/editor/api.ts";
    const { maybeEditorService } = await import(contributionsPath);
    const { useEditorRegistry } = await import(editorPath);
    await maybeEditorService().openFile("/dev/acme-api/src/main/kotlin/com/acme/orders/OrderController.kt");
    for (let i = 0; i < 50 && !useEditorRegistry.getState().active; i++) await new Promise((r) => setTimeout(r, 50));
    const view = useEditorRegistry.getState().active.view;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: code } });
  }, CODE);
  await expect(page.locator(".cm-content")).toContainText("class OrderController");
}

async function reloadOnce(page: Page) {
  const lines = [
    await nowLine(
      page,
      "RELOAD",
      "org.hotswap.agent.config.PluginManager",
      "Reloading classes [com.acme.orders.OrderController, com.acme.orders.OrderDto, com.acme.orders.service.OrderService] (autoHotswap)",
      -180,
    ),
    await nowLine(
      page,
      "INFO",
      "org.hotswap.agent.plugin.spring.reload.SpringBeanReload",
      "add new spring bean 'orderMetrics' into org.springframework.beans.factory.support.DefaultListableBeanFactory@7aead3af",
    ),
  ];
  await emit(page, lines);
}

test("Hot Reload: plugin card, HotSwap settings, run timeline, editor chip and status bar", async ({
  workbench: page,
}) => {
  for (const theme of ["light", "dark"] as const) {
    if (theme === "dark") {
      await page.reload();
      await expect(page.getByRole("tree", { name: "Project" })).toBeVisible();
      await setTheme(page, "Islands Dark");
    }

    // Plugin card: off by default, its download as progress.
    await page.keyboard.press("Meta+,");
    const dialog = page.getByRole("dialog", { name: "Settings", exact: true });
    await dialog.getByRole("textbox", { name: "Search settings" }).fill("Plugins");
    await dialog.getByRole("treeitem", { name: "Plugins", exact: true }).click();
    await dialog.getByRole("textbox", { name: "Filter plugins" }).fill("Hot Reload");
    const row = dialog.getByRole("list", { name: "Installed plugins" }).getByText("Hot Reload", { exact: true });
    await row.click();
    const details = dialog.getByLabel("Hot Reload details");
    await expect(details).toContainText("HotswapAgent (about 2 MB)");
    await page.evaluate(async () => {
      const storePath = "/src/features/hot-reload/store.ts";
      const { useHotReload } = await import(storePath);
      useHotReload.setState({
        job: { request: 1, phase: "runtime", major: 21, fraction: 0.42, detail: "96.6 / 230.0 MB" },
      });
    });
    await expect(details.getByRole("progressbar", { name: "Downloading JetBrains Runtime 21" })).toBeVisible();
    await shot(page, `plugin-card-${theme}`);
    await page.evaluate(async () => {
      const storePath = "/src/features/hot-reload/store.ts";
      const { useHotReload } = await import(storePath);
      useHotReload.setState({ job: null });
    });
    await enablePlugin(page);

    // Settings › Debugger › HotSwap.
    await dialog.getByRole("textbox", { name: "Search settings" }).fill("HotSwap");
    await dialog.getByRole("treeitem", { name: "HotSwap", exact: true }).click();
    await expect(dialog.getByRole("radiogroup", { name: "Reload classes after compilation" })).toBeVisible();
    await expect(dialog.getByRole("listitem", { name: "JetBrains Runtime 21" })).toContainText("Installed");
    await dialog.getByRole("textbox", { name: "Search settings" }).fill("");
    await expect(dialog.getByRole("checkbox", { name: "MyBatis-Plus" })).toBeVisible();
    await shot(page, `hotswap-settings-${theme}`);
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);

    // A Spring Boot run with hot reload: ⚡ on its tab, the agent's lines folded and dimmed.
    await startRun(page);
    const runTabs = page.getByRole("tablist", { name: "Run sessions" });
    await expect(runTabs.getByRole("img", { name: "Hot Reload" })).toBeVisible();
    await expect(page.locator("[data-run-chooser]").getByRole("img", { name: "Hot Reload" })).toBeVisible();
    const views = page.getByRole("tablist", { name: "Session views" });
    await expect(views.getByRole("tab", { name: "Hot Reload" })).toBeVisible();
    await expect(page.getByRole("button", { name: /internal lines?>/ }).first()).toBeVisible();
    const status = page.locator("[data-hot-reload-status]");
    await expect(status).toHaveText("Hot Reload");

    // Save → reload: the chip in the changed file's editor, the status bar, the timeline.
    await openController(page);
    await reloadOnce(page);
    const chip = page.locator("[data-hot-reload-chip]");
    await expect(chip).toContainText("3 classes reloaded · 1 bean ·");
    await expect(status).toContainText("Reloaded");
    await shot(page, `editor-chip-${theme}`);

    await emit(page, [
      await nowLine(
        page,
        "INFO",
        "org.hotswap.agent.plugin.spring.reload.SpringBeanReload",
        "try to add changed property 'file:/dev/acme-api/build/resources/main/application.yml'",
        2500,
      ),
      await nowLine(
        page,
        "RELOAD",
        "org.hotswap.agent.plugin.spring.reload.SpringBeanReload",
        "the properties of 'DefaultListableBeanFactory@7aead3af' is changed",
        2900,
      ),
      await nowLine(
        page,
        "WARNING",
        "org.hotswap.agent.plugin.spring.reload.SpringBeanReload",
        "Cannot refresh bean 'orderCache': constructor arguments changed; restart to apply",
        3100,
      ),
    ]);
    await expect(chip).toContainText("Properties reloaded");
    await expect(chip.getByRole("button", { name: "Restart" })).toBeVisible();
    await shot(page, `editor-chip-warning-${theme}`);

    await status.click();
    const timeline = page.getByRole("list", { name: "Reloads" });
    await expect(timeline).toBeVisible();
    await expect(timeline).toContainText("3 classes reloaded");
    await expect(timeline).toContainText("Started");
    await timeline.getByRole("button", { name: /3 classes reloaded/ }).click();
    await expect(timeline).toContainText("com.acme.orders.OrderDto");
    await shot(page, `timeline-${theme}`);

    // Console: agent lines dimmed and expandable.
    await views.getByRole("tab", { name: "Console" }).click();
    await page
      .getByRole("button", { name: /internal lines?>/ })
      .first()
      .click();
    await expect(page.locator('[role="log"]').getByText("Loading Hotswap agent", { exact: false })).toBeVisible();
    await expect(page.locator('[role="log"] [class*="quiet"]')).toHaveCount(3);
    await expect(page.locator('[role="log"] [class*="quiet"]').first()).toHaveCSS("opacity", "0.8");
    await shot(page, `console-${theme}`);
  }
});

test("Hot Reload: a debug session gets the Hot Reload view and dimmed agent lines", async ({ workbench: page }) => {
  await enablePlugin(page);
  await page.evaluate(async (startup) => {
    const statePath = "/src/features/debugger/state.ts";
    const sessionsPath = "/src/features/hot-reload/sessions.ts";
    const contributionsPath = "/src/workbench/contributions.ts";
    const { adoptSession, appendConsole } = await import(statePath);
    const { expectDebugSession, recordHotSwap } = await import(sessionsPath);
    const { toolWindowService } = await import(contributionsPath);
    const runConfig = {
      id: "orders",
      name: "OrderApplication",
      kind: "spring-boot",
      command: "java",
      args: [],
      cwd: null,
      env: {},
      detected: true,
      isTest: false,
      debugAdapter: "java-debug",
      params: { hotReload: "true" },
    };
    expectDebugSession("orders", {
      name: "OrderApplication",
      configId: "orders",
      mode: "debug",
      engine: "hotswapAgent",
      runtime: "JetBrains Runtime 21.0.11",
      module: "",
      startedAt: Date.now(),
    });
    adoptSession(7, { name: "OrderApplication", runConfig, adapter: "java-debug" });
    appendConsole(
      7,
      "stdout",
      startup.map((l: string) => `${l}\n`).join("") + "Started OrderApplication in 1.874 seconds\n",
    );
    recordHotSwap("debug:7", ["com.acme.orders.OrderController"], [], 64);
    toolWindowService().show("debug", true);
  }, STARTUP);
  const tabs = page.getByRole("tablist", { name: "Debug sessions" });
  await expect(tabs.getByRole("img", { name: "Hot Reload" })).toBeVisible();
  await page.getByRole("tablist", { name: "Debug views" }).getByRole("tab", { name: "Console" }).click();
  await expect(page.getByRole("log", { name: "Debug console" }).locator('[class*="quiet"]')).toHaveCount(3);
  await page.getByRole("tablist", { name: "Debug views" }).getByRole("tab", { name: "Hot Reload" }).click();
  const timeline = page.getByRole("list", { name: "Reloads" });
  await expect(timeline).toContainText("1 class reloaded");
  await expect(timeline).toContainText("HotSwap");
  await shot(page, "debug-timeline-light");
});
