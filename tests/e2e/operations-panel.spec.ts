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

test("history renders a package artifact card inside its bound and falls back beyond it", async ({
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

  const review = async (documentId: string, text: string) => {
    const response = await page.request.post("/api/workbench/workflows/document-review.review", {
      data: { executionMode: "dry_run", input: { documentId, text } },
    });
    expect(response.ok(), await response.text()).toBe(true);
  };
  const stamp = Date.now().toString(36);
  await review(`card-${stamp}`, "A short reviewed document.");
  // The report carries the reviewed text; past the renderer's 4 KiB bound the JSON view stands in.
  await review(`long-${stamp}`, "word ".repeat(1200));

  await page.goto("/");
  await page.getByRole("button", { name: "History", exact: true }).click();
  const history = page.getByRole("dialog", { name: "Workbench History" });
  await expect(history).toBeVisible();

  // The featured artifact's result is open by default; open the summary only when it is not.
  const reveal = async (target: ReturnType<typeof history.locator>) => {
    await expect(target.first()).toBeAttached();
    if (!(await target.first().isVisible()))
      await target.first().locator("xpath=ancestor::details[1]/summary").click();
    await expect(target.first()).toBeVisible();
  };

  await history.getByRole("button", { name: "Open Review document" }).first().click();
  const card = history.locator('[data-slot="pack-artifact-renderer"]');
  const fallback = history.locator("pre").filter({ hasText: `"documentId": "long-${stamp}"` });
  // Runs list newest first: the oversize review opens first and shows no package card.
  await reveal(fallback);
  await expect(history.locator('[data-runtime-renderer="document-review-report"]')).toHaveCount(0);

  await history.getByRole("button", { name: "Open Review document" }).nth(1).click();
  await reveal(card);
  await expect(card).toContainText(`card-${stamp} · reviewed · 4 words`);
  await expect(card).toContainText("A short reviewed document.");
  await expectAccessible(page);
  await page.keyboard.press("Escape");
});
