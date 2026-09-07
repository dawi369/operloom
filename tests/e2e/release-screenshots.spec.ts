import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

import { expect, test, type Page } from "@playwright/test";

const releaseMode = process.env.E2E_RELEASE_MODE;
const outputDirectory = resolve(process.cwd(), "docs/assets/release");

const assertSafeSyntheticPage = async (page: Page) => {
  const text = await page.locator("body").innerText();
  expect(text).not.toMatch(/(?:sk|pk)_(?:live|test)_[A-Za-z0-9_-]{12,}/);
  expect(text).not.toContain("Bearer ");
  expect(text).not.toContain("/Users/");
  expect(text).not.toMatch(
    /Unhandled Runtime Error|Internal Server Error|Application error|execution failed/i,
  );
  for (const email of text.match(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g) ?? []) {
    expect(email.endsWith("@example.test"), email).toBe(true);
  }
};

const capture = async (page: Page, name: string) => {
  await assertSafeSyntheticPage(page);
  await page.screenshot({ path: resolve(outputDirectory, name), fullPage: true });
};

test("captures deterministic public release product evidence", async ({ page }) => {
  test.skip(releaseMode !== "local-session");
  test.setTimeout(90_000);
  mkdirSync(outputDirectory, { recursive: true });

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "What are we working on?" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Message input" })).toBeEditable();
  await expect(
    page.getByText(/Live (?:updates are connected|session updates connected)/),
  ).toBeVisible({ timeout: 15_000 });
  const composer = page.getByRole("textbox", { name: "Message input" });
  await composer.fill("/admin");
  await composer.press("Enter");
  await expect(page.getByRole("dialog", { name: "Admin" })).toBeVisible();
  await page.getByRole("tab", { name: "Agents" }).click();
  await expect(page.getByText("Swordfish Runtime", { exact: true })).toBeVisible();
  await capture(page, "agent-packs.png");
  await page
    .locator("article")
    .filter({ hasText: "Repository Analyst" })
    .getByRole("button", { name: "Use agent" })
    .click();
  await expect(page.getByRole("heading", { name: "Repository Analyst" })).toBeVisible();
  await expect(page.getByRole("dialog", { name: "Admin" })).toBeHidden();
  await expect(page.getByRole("button", { name: /Assess release readiness/i })).toBeVisible();
  await composer.click();
  await expect(
    page.getByText(/Live (?:updates are connected|session updates connected)/),
  ).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("Loading chats...", { exact: true })).toBeHidden();
  await capture(page, "workbench.png");

  await page.getByRole("button", { name: /Assess release readiness/i }).click();
  await expect(page.getByRole("dialog", { name: "Readiness report" })).toBeVisible();
  await page.getByRole("button", { name: "Run dry-run" }).click();
  await expect(page.getByRole("dialog", { name: "Workbench History" })).toBeVisible();
  await expect(page.getByText("Repository snapshot report", { exact: true })).toBeVisible({
    timeout: 30_000,
  });
  await page.locator("summary").filter({ hasText: /^Result$/ }).click();
  await page.locator("summary").filter({ hasText: /^View result$/ }).click();
  await capture(page, "history-and-action-ledger.png");
  await page.getByRole("button", { name: "Close" }).click();

  const instantiated = await page.request.post(
    "/api/workbench/agent-packs/complex-operator/instantiate",
  );
  expect(instantiated.ok(), await instantiated.text()).toBe(true);
  const instantiatedBody = (await instantiated.json()) as { agent?: { id?: string } };
  expect(instantiatedBody.agent?.id).toBeTruthy();
  const activated = await page.request.post(
    `/api/workbench/agents/${encodeURIComponent(instantiatedBody.agent!.id!)}/activate`,
  );
  expect(activated.ok(), await activated.text()).toBe(true);
  const switched = await page.request.post("/api/workbench/chat-session/agent-switch", {
    data: { agentId: instantiatedBody.agent!.id!, target: "new_thread" },
  });
  expect(switched.ok(), await switched.text()).toBe(true);
  await page.reload();
  await expect(page.getByRole("heading", { name: "Complex Operator" })).toBeVisible();

  await page.getByRole("button", { name: "Tools", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Connections" })).toBeVisible();
  await capture(page, "tools-and-connections.png");
  await page.getByRole("button", { name: "Close" }).click();

  await page.getByRole("button", { name: "Workspace access" }).click();
  await expect(page.getByRole("dialog", { name: "Workspace" })).toBeVisible();
  await page.getByRole("button", { name: "Manage workspace" }).click();
  await page.getByRole("tab", { name: "Data & privacy" }).click();
  await expect(page.getByRole("heading", { name: "Data lifecycle" })).toBeVisible();
  await capture(page, "workspace-retention-and-export.png");
});
