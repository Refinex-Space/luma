import { expect, PROJECT, test } from "./fixtures";

test("renders title bar, area tabs, launcher, tool window and status bar", async ({ workbench: page }) => {
  const title = page.locator("header").first();
  await expect(title.getByRole("button", { name: PROJECT })).toBeVisible();
  await expect(title.getByRole("button", { name: "Search Everywhere" })).toBeVisible();
  await expect(title.getByRole("button", { name: "Find in Files" })).toBeVisible();
  await expect(title.getByRole("button", { name: "Agents", exact: true })).toBeVisible();

  const left = page.getByRole("tablist", { name: "Left Top" });
  for (const name of ["Project", "Commit"]) {
    await expect(left.getByRole("tab", { name, exact: true })).toBeVisible();
  }
  const launcher = page.getByRole("toolbar", { name: "Bottom tool windows" });
  for (const name of ["Git", "Terminal", "Problems"]) {
    await expect(launcher.getByRole("button", { name, exact: true })).toBeVisible();
  }

  await expect(page.getByRole("region", { name: "Project" })).toBeVisible();
  const status = page.getByRole("contentinfo", { name: "Status bar" });
  await expect(status).toBeVisible();
  // Empty editor area shows the IDEA-style hints.
  await expect(page.getByText("Search Everywhere", { exact: true }).last()).toBeVisible();
});

test("the launcher switches the bottom area; a second click or the title bar toggle closes it", async ({
  workbench: page,
}) => {
  const launcher = page.getByRole("toolbar", { name: "Bottom tool windows" });
  const problems = page.getByRole("region", { name: "Problems" });
  const terminal = page.getByRole("region", { name: "Terminal" });
  const problemsButton = launcher.getByRole("button", { name: "Problems", exact: true });
  await expect(problems).toBeHidden();
  await problemsButton.click();
  await expect(problems).toBeVisible();
  await expect(problemsButton).toHaveAttribute("aria-pressed", "true");
  // The area shows the window alone: its siblings stay in the launcher, not as tabs.
  const strip = page.getByRole("tablist", { name: "Bottom Left" }).filter({ visible: true });
  await expect(strip.getByRole("tab", { name: "Terminal" })).toHaveCount(0);
  await launcher.getByRole("button", { name: "Terminal", exact: true }).click();
  await expect(terminal).toBeVisible();
  await expect(problems).toBeHidden();
  await launcher.getByRole("button", { name: "Terminal", exact: true }).click();
  await expect(terminal).toBeHidden();
  await problemsButton.click();
  await expect(problems).toBeVisible();
  await page
    .locator("header")
    .first()
    .getByRole("button", { name: /^Bottom Panel/ })
    .click();
  await expect(problems).toBeHidden();
  await expect(problemsButton).toHaveAttribute("aria-pressed", "false");
});
