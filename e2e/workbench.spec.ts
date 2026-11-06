import { expect, PROJECT, test } from "./fixtures";

test("renders title bar, tool window bars, tool window and status bar", async ({ workbench: page }) => {
  const title = page.locator("header").first();
  await expect(title.getByRole("button", { name: PROJECT })).toBeVisible();
  await expect(title.getByRole("button", { name: "Search Everywhere" })).toBeVisible();
  await expect(title.getByRole("button", { name: "Find in Files" })).toBeVisible();
  await expect(title.getByRole("button", { name: "Layout" })).toBeVisible();

  // Each bar group opens the area beside it.
  const groups: Array<[string, string, string[]]> = [
    ["Left tool windows", "Left Top", ["Project", "Commit"]],
    ["Left tool windows", "Left Bottom", ["Structure", "Bookmarks"]],
    ["Left tool windows", "Bottom Left", ["Git"]],
    ["Right tool windows", "Right Top", ["Agents"]],
    ["Right tool windows", "Right Bottom", ["Notifications"]],
    ["Right tool windows", "Bottom Right", ["Terminal", "Problems", "TODO"]],
  ];
  for (const [bar, group, names] of groups) {
    const g = page.getByRole("toolbar", { name: bar }).getByRole("group", { name: group });
    for (const name of names) await expect(g.getByRole("button", { name, exact: true })).toBeVisible();
  }

  await expect(page.getByRole("region", { name: "Project" })).toBeVisible();
  const status = page.getByRole("contentinfo", { name: "Status bar" });
  await expect(status).toBeVisible();
  // Empty editor area shows the IDEA-style hints.
  await expect(page.getByText("Search Everywhere", { exact: true }).last()).toBeVisible();
});

test("a bar button toggles its window; windows of the two bottom areas show side by side", async ({
  workbench: page,
}) => {
  const right = page.getByRole("toolbar", { name: "Right tool windows" });
  const left = page.getByRole("toolbar", { name: "Left tool windows" });
  const problems = page.getByRole("region", { name: "Problems" });
  const terminal = page.getByRole("region", { name: "Terminal" });
  const git = page.getByRole("region", { name: "Git" });
  const problemsButton = right.getByRole("button", { name: "Problems", exact: true });
  await expect(problems).toBeHidden();
  await problemsButton.click();
  await expect(problems).toBeVisible();
  await expect(problemsButton).toHaveAttribute("aria-pressed", "true");
  // Same area: Terminal replaces Problems.
  await right.getByRole("button", { name: "Terminal", exact: true }).click();
  await expect(terminal).toBeVisible();
  await expect(problems).toBeHidden();
  // Bottom Left beside it.
  await left.getByRole("button", { name: "Git", exact: true }).click();
  await expect(git).toBeVisible();
  await expect(terminal).toBeVisible();
  const [g, t] = [await git.boundingBox(), await terminal.boundingBox()];
  expect(g!.x).toBeLessThan(t!.x);
  // A second click closes.
  await right.getByRole("button", { name: "Terminal", exact: true }).click();
  await expect(terminal).toBeHidden();
  await expect(right.getByRole("button", { name: "Terminal", exact: true })).toHaveAttribute("aria-pressed", "false");
});
