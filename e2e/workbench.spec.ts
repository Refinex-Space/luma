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

test("the launcher opens a bottom window; the title bar toggle closes the area", async ({ workbench: page }) => {
  const launcher = page.getByRole("toolbar", { name: "Bottom tool windows" });
  const problems = page.getByRole("region", { name: "Problems" });
  await expect(problems).toBeHidden();
  await launcher.getByRole("button", { name: "Problems", exact: true }).click();
  await expect(problems).toBeVisible();
  // The area's own tabs take over while it is open.
  await expect(page.getByRole("tablist", { name: "Bottom Left" }).getByRole("tab", { name: "Problems" })).toBeVisible();
  await expect(launcher).toHaveAttribute("data-hidden", "");
  await page
    .locator("header")
    .first()
    .getByRole("button", { name: /^Bottom Panel/ })
    .click();
  await expect(problems).toBeHidden();
  await expect(launcher).not.toHaveAttribute("data-hidden");
});
