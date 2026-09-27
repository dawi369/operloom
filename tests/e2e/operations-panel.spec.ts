import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "./fixtures";

const releaseMode = process.env.E2E_RELEASE_MODE;
const defaultAgentId = "agent-workspace:local-api:e2e-owner:default";

test.afterEach(async ({ page }) => {
  if (releaseMode !== "local-session") return;
  const restored = await page.request.post("/api/workbench/chat-session/agent-switch", {
    data: { agentId: defaultAgentId, target: "new_thread" },
  });
  expect(restored.ok(), await restored.text()).toBe(true);
});

const expectAccessible = async (page: Page) => {
  // Radix dialogs animate opacity; audit the settled surface.
  await page.waitForTimeout(250);
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  expect(
    results.violations.filter(
      (violation) => violation.impact === "serious" || violation.impact === "critical",
    ),
  ).toEqual([]);
};

test("operations panel edits settings, runs queries and registers webhooks through /v1", async ({
  page,
}) => {
  test.skip(releaseMode !== "local-session");
  test.setTimeout(120_000);

  const instantiated = await page.request.post(
    "/api/workbench/agent-packs/document-review/instantiate",
  );
  expect(instantiated.ok(), await instantiated.text()).toBe(true);
  const { agent } = (await instantiated.json()) as { agent: { id: string } };
  const switched = await page.request.post("/api/workbench/chat-session/agent-switch", {
    data: { agentId: agent.id, target: "new_thread" },
  });
  expect(switched.ok(), await switched.text()).toBe(true);

  await page.goto("/");
  const composer = page.getByRole("textbox", { name: "Message input" });
  await expect(composer).toBeEditable();
  await composer.fill("/operations");
  await composer.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Operations" });
  await expect(dialog).toBeVisible();

  await expect(dialog.getByRole("button", { name: "simulation", exact: true })).toBeDisabled();
  const strictness = dialog.getByLabel("strictness");
  await expect(strictness).toHaveValue("normal");
  await strictness.selectOption("strict");
  await dialog.getByRole("button", { name: "Save settings" }).click();
  await expect(dialog.getByRole("status")).toHaveText("Settings saved.");
  await expect(dialog.getByText("Version 1")).toBeVisible();
  await expectAccessible(page);

  await dialog.getByRole("tab", { name: "Queries" }).click();
  await dialog.getByRole("button", { name: "document-review.summary" }).click();
  await dialog.getByRole("button", { name: "Run query" }).click();
  await expect(dialog.locator("pre")).toContainText('"strictness": "strict"');

  await dialog.getByRole("tab", { name: "Decisions" }).click();
  await expect(dialog.getByRole("heading", { name: "Entries (simulation)" })).toBeVisible();

  await dialog.getByRole("tab", { name: "Webhooks" }).click();
  await dialog.getByLabel("Webhook URL").fill("https://hooks.example.com/operloom-e2e");
  await dialog.getByLabel("Event types").fill("agent.settings.changed");
  await dialog.getByRole("button", { name: "Add webhook" }).click();
  await expect(dialog.getByRole("status")).toContainText("whsec_");
  await expect(dialog.getByText("https://hooks.example.com/operloom-e2e")).toBeVisible();

  await page.setViewportSize({ width: 375, height: 812 });
  const overflow = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    document: document.documentElement.scrollWidth,
  }));
  expect(overflow.document, JSON.stringify(overflow)).toBeLessThanOrEqual(overflow.viewport + 1);
  await expect(dialog.getByRole("tab", { name: "Webhooks" })).toBeVisible();
  await expectAccessible(page);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
});
