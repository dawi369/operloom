import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page, type TestInfo } from "@playwright/test";

const releaseMode = process.env.E2E_RELEASE_MODE;
const reportDirectory = resolve(process.cwd(), "output/playwright/accessibility");

const safeReportName = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

const auditPage = async (page: Page, testInfo: TestInfo, surface: string) => {
  // Radix dialogs and shared controls animate opacity for 200 ms. Audit the
  // settled surface so Axe does not evaluate transient blended colors.
  await page.waitForTimeout(250);
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  const reportPath = resolve(
    reportDirectory,
    `${releaseMode}-${safeReportName(testInfo.title)}-${safeReportName(surface)}.json`,
  );
  mkdirSync(reportDirectory, { recursive: true });
  writeFileSync(reportPath, `${JSON.stringify(results, null, 2)}\n`);
  await testInfo.attach(`axe-${surface}`, {
    path: reportPath,
    contentType: "application/json",
  });

  expect(
    results.violations.filter(
      (violation) => violation.impact === "serious" || violation.impact === "critical",
    ),
    `Serious or critical accessibility violations on ${surface}; full report: ${reportPath}`,
  ).toEqual([]);
};

const expectNoHorizontalOverflow = async (page: Page) => {
  const overflow = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    document: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
  }));
  expect(overflow.document, JSON.stringify(overflow)).toBeLessThanOrEqual(overflow.viewport + 1);
  expect(overflow.body, JSON.stringify(overflow)).toBeLessThanOrEqual(overflow.viewport + 1);
};

const expectDialogFocusTrap = async (page: Page, name: string) => {
  const dialog = page.getByRole("dialog", { name });
  await expect(dialog).toBeVisible();
  for (let index = 0; index < 12; index += 1) {
    await page.keyboard.press("Tab");
    await expect
      .poll(() => dialog.evaluate((element) => element.contains(document.activeElement)))
      .toBe(true);
  }
};

test("signed-out access is accessible and responsive", async ({ page }, testInfo) => {
  test.skip(releaseMode !== "signed-out");

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Resume your workspace" })).toBeVisible();
  await auditPage(page, testInfo, "signed-out");
  await expectNoHorizontalOverflow(page);

  await page.setViewportSize({ width: 375, height: 812 });
  await expect(page.getByRole("heading", { name: "Resume your workspace" })).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await auditPage(page, testInfo, "signed-out-mobile");
});

test("keyboard, focus, responsive, and accessibility contracts cover workbench surfaces", async ({
  page,
}, testInfo) => {
  test.skip(releaseMode !== "local-session");
  test.setTimeout(90_000);

  await page.goto("/");
  const composer = page.getByRole("textbox", { name: "Message input" });
  await expect(composer).toBeEditable();
  await auditPage(page, testInfo, "chat");

  await page.getByRole("button", { name: "New chat" }).press("Enter");
  await expect(page.getByRole("textbox", { name: "Message input" })).toBeEditable();
  await expect(page.locator("[data-summary-sync-status]")).toHaveAttribute(
    "data-summary-sync-status",
    "idle",
  );
  const commandComposer = page.getByRole("textbox", { name: "Message input" });
  await commandComposer.fill("/history");
  await commandComposer.press("Enter");
  await expectDialogFocusTrap(page, "Workbench History");
  await expect(
    page.getByRole("dialog", { name: "Workbench History" }).getByRole("button", {
      name: "Refresh",
    }),
  ).toBeEnabled();
  await page.waitForTimeout(350);
  await auditPage(page, testInfo, "history");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Workbench History" })).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "Message input" })).toBeFocused();

  await page.getByRole("button", { name: "Workspace access" }).press("Enter");
  await expectDialogFocusTrap(page, "Workspace");
  await page.getByRole("button", { name: "Manage workspace" }).press("Enter");
  await page.getByRole("tab", { name: "Data & privacy" }).press("Enter");
  await expect(page.getByRole("heading", { name: "Data lifecycle" })).toBeVisible();
  await auditPage(page, testInfo, "workspace-lifecycle");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("textbox", { name: "Message input" })).toBeFocused();

  const adminComposer = page.getByRole("textbox", { name: "Message input" });
  await adminComposer.fill("/admin");
  await expect(
    page.getByText("Open workspace, agent, and runtime controls.", { exact: true }),
  ).toBeVisible();
  await adminComposer.press("Enter");
  await expect(page.getByRole("dialog", { name: "Admin" })).toBeFocused();
  await expectDialogFocusTrap(page, "Admin");
  await auditPage(page, testInfo, "admin");
  await page.getByRole("tab", { name: "Agents" }).press("Enter");
  const repositoryPack = page.locator("article").filter({ hasText: "Repository Analyst" });
  await expect(repositoryPack).toBeVisible();
  const useRepositoryPack = repositoryPack.getByRole("button", { name: "Use agent" });
  if (await useRepositoryPack.count()) {
    await useRepositoryPack.press("Enter");
  } else {
    await expect(repositoryPack.getByRole("button", { name: "Current" })).toBeDisabled();
    await page.keyboard.press("Escape");
  }
  await expect(page.getByRole("dialog", { name: "Admin" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Repository Analyst" })).toBeVisible();

  await expect(page.locator("[data-summary-sync-status]")).toHaveAttribute(
    "data-summary-sync-status",
    "idle",
  );
  const toolsButton = page.getByRole("button", { name: "Tools", exact: true });
  await toolsButton.press("Enter");
  await expectDialogFocusTrap(page, "Repository Analyst tools");
  await auditPage(page, testInfo, "agent-tools");
  await page.keyboard.press("Escape");

  await page.getByRole("button", { name: /Assess release readiness/i }).press("Enter");
  await expectDialogFocusTrap(page, "Readiness report");
  await page.getByRole("button", { name: "Run dry-run" }).press("Enter");
  await expect(page.getByRole("dialog", { name: "Workbench History" })).toBeVisible();
  await expect(page.getByText("Repository snapshot report", { exact: true }).first()).toBeVisible({
    timeout: 30_000,
  });
  await page.keyboard.press("Escape");

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
  const credential = page.getByLabel("operator.external-account credential");
  await credential.focus();
  await credential.fill("synthetic-access-key");
  await expect(page.getByRole("button", { name: "Connect" })).toBeEnabled();
  await auditPage(page, testInfo, "connections");

  await page.setViewportSize({ width: 375, height: 812 });
  await expectNoHorizontalOverflow(page);
  await auditPage(page, testInfo, "connections-mobile");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("textbox", { name: "Message input" })).toBeFocused();

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole("button", { name: "History" }).click();
  await expect(page.getByRole("dialog", { name: "Workbench History" })).toBeVisible();
  const approvalRun = page.getByRole("listitem").filter({ hasText: "Approval recovery fixture" });
  await approvalRun.getByRole("button", { name: /Open Approval recovery fixture/ }).click();
  await expect(page.getByRole("button", { name: "Approve" })).toBeVisible();
  await page.getByRole("button", { name: "Approve" }).focus();
  await page.keyboard.press("Shift+Tab");
  await expect(page.getByRole("button", { name: "Deny" })).toBeFocused();
  await auditPage(page, testInfo, "approval-recovery");
});
