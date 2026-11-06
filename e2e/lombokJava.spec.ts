import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";

const SHOTS = process.env.LUMA_SHOTS;

// The bundled headless shell is not always installed: the system Chrome renders the same.
if (process.env.LUMA_E2E_CHROME) test.use({ channel: "chrome" });

const PATH = "/dev/acme-api/src/main/java/com/acme/orders/Customer.java";

const TEXT = `package com.acme.orders;

import lombok.ToString;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

@ToString
public class Customer {
  private static final Logger LOG = LoggerFactory.getLogger(Customer.class);

  private String name;
  private boolean active;
  private int visits;

  /**
   * The customer's display name.
   *
   * @return the name
   */
  public String getName() {
    return name;
  }

  public boolean isActive() {
    return active;
  }

  public int getVisits() {
    return visits;
  }

  public void setVisits(int visits) {
    this.visits = visits;
  }

  public void visit() {
    visits++;
    LOG.info("{} visited", name);
  }
}
`;

/** Opens a Java source using Lombok (browser memory) in the editor. */
async function openJava(page: Page) {
  await page.evaluate(async (path) => {
    const module = "/src/workbench/contributions.ts";
    const { editorService } = await import(module);
    await editorService().openFile(path, { focus: true });
  }, PATH);
  await expect(page.getByRole("tab", { name: "Customer.java" })).toBeVisible();
  await page.evaluate(async (text) => {
    const module = "/src/editor/api.ts";
    const { activeEditor } = await import(module);
    const view = activeEditor()!.view;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
  }, TEXT);
  const editor = page.locator(".cm-editor").first();
  await expect(editor.locator(".cm-content")).toContainText("public class Customer");
  return editor;
}

async function caretAt(page: Page, text: string, offset = 0) {
  await page.evaluate(
    async ({ text, offset }) => {
      const module = "/src/editor/api.ts";
      const { activeEditor } = await import(module);
      const view = activeEditor()!.view;
      view.dispatch({ selection: { anchor: view.state.doc.toString().indexOf(text) + offset } });
      view.focus();
    },
    { text, offset },
  );
}

const source = (page: Page) =>
  page.evaluate(async () => {
    const module = "/src/editor/api.ts";
    const { activeEditor } = await import(module);
    return activeEditor()!.view.state.doc.toString();
  });

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

test("Lombok inspections: warnings in a Java editor and their ⌥↵ fixes", async ({ workbench: page }) => {
  const editor = await openJava(page);
  // @Slf4j on the logger; @Getter / @Setter on trivial accessors (the methods' names).
  await expect(editor.locator(".cm-lintRange-warning")).toHaveText([
    "Customer",
    "private static final Logger LOG = LoggerFactory.getLogger(Customer.class);",
    "setVisits",
  ]);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/lombok-java-warnings-light.png`, animations: "disabled" });

  // Every field has a getter: the class may use @Getter.
  await caretAt(page, "public class Customer", "public class ".length);
  await page.keyboard.press("Alt+Enter");
  const getter = page.getByText("Use lombok @Getter for 'Customer'");
  await expect(getter).toBeVisible();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/lombok-java-fix-light.png`, animations: "disabled" });
  await getter.click();
  let text = await source(page);
  expect(text).toContain("@Getter\n@ToString\npublic class Customer");
  expect(text).toContain("import lombok.Getter;\nimport lombok.ToString;");
  expect(text).not.toContain("getName()");
  // The getter's doc comment moved to its field.
  expect(text).toContain(
    "  /**\n   * -- GETTER --\n   * The customer's display name.\n   *\n   * @return the name\n   */\n  private String name;",
  );

  // The logger: replaced by @Slf4j, its uses renamed to `log`.
  await caretAt(page, "private static final Logger");
  await page.keyboard.press("Alt+Enter");
  await page.getByText("Replace logger field with @Slf4j annotation").click();
  text = await source(page);
  expect(text).toContain("@Slf4j\n@Getter");
  expect(text).toContain('log.info("{} visited", name);');
  expect(text).not.toContain("import org.slf4j");
  await expect(editor.locator(".cm-lintRange-warning")).toHaveText(["setVisits"]);

  // One undo restores the logger.
  await page.keyboard.press("Meta+z");
  await expect.poll(() => source(page)).toContain("LoggerFactory.getLogger(Customer.class)");

  await setTheme(page, "Islands Dark");
  await caretAt(page, "setVisits");
  await page.keyboard.press("Alt+Enter");
  await expect(page.getByText("Use lombok @Setter for 'visits'")).toBeVisible();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/lombok-java-fix-dark.png`, animations: "disabled" });
});

test("Refactor › Lombok › Default @Data replaces the accessors and toString of the class", async ({
  workbench: page,
}) => {
  await openJava(page);
  await caretAt(page, "private String name");
  await page.evaluate(async () => {
    const module = "/src/platform/actions.ts";
    const { executeAction } = await import(module);
    await executeAction("lombok.addData");
  });
  const text = await source(page);
  expect(text).toContain("@Data\npublic class Customer");
  expect(text).not.toContain("@ToString");
  expect(text).not.toMatch(/public (String|boolean|int|void) (getName|isActive|getVisits|setVisits)\(/);
  expect(text).toContain("import lombok.Data;");
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/lombok-java-data-light.png`, animations: "disabled" });
});
