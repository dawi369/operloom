import { expect, test, type ConsoleMessage } from "./fixtures";

const releaseMode = process.env.E2E_RELEASE_MODE;
const hydrationErrors: string[] = [];

const captureHydrationErrors = (message: ConsoleMessage) => {
  if (message.type() === "error" && message.text().includes("Hydration failed")) {
    hydrationErrors.push(message.text());
  }
};

test.beforeEach(async ({ page }) => {
  hydrationErrors.length = 0;
  page.on("console", captureHydrationErrors);
});

test("signed-out refresh stays on the deliberate access screen", async ({ page, context }) => {
  test.skip(releaseMode !== "signed-out");

  await page.goto("/");
  await expect(page).toHaveTitle("Operloom");
  await expect(page.getByRole("heading", { name: "Resume your workspace" })).toBeVisible();
  await expect(page.getByText("Pick up your chats, agents, and history.")).toBeVisible();
  await expect(page.getByText("agent workbench", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign in" })).toHaveCount(1);
  await expect(page.getByText("Recent chats", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Workspace access" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: /deletion recovery/i })).toHaveCount(0);

  await expect
    .poll(async () => {
      const cookies = await context.cookies();
      return cookies.find((cookie) => cookie.name === "assistant-mk1-auth-presentation")?.value;
    })
    .toBe("signed-out");

  const response = await page.reload();
  expect(response).not.toBeNull();
  const firstFrameHtml = await response!.text();
  expect(firstFrameHtml).toContain("Resume your workspace");
  expect(firstFrameHtml).not.toContain("Bring a question, a problem, or a workflow.");
  await expect(page.getByRole("heading", { name: "Resume your workspace" })).toBeVisible();
  expect(hydrationErrors).toEqual([]);
});

test("chat deletion uses an accessible in-app confirmation", async ({ page }) => {
  test.skip(releaseMode !== "local-session");

  await page.goto("/");
  const created = await page.request.post("/api/workbench/chat-session/threads", {
    data: { title: "Delete confirmation fixture" },
  });
  expect(created.ok(), await created.text()).toBe(true);
  const createdBody = (await created.json()) as { activeThread?: { threadId?: string } };
  const threadId = createdBody.activeThread?.threadId;
  expect(threadId).toBeTruthy();

  await page.reload();
  const threadItem = page.getByTestId(`thread-history-item-${threadId}`);
  const deleteChatButton = threadItem.getByRole("button", { name: "Delete chat" });
  await deleteChatButton.click();
  const deleteDialog = page.getByRole("dialog", { name: "Delete this chat?" });
  await expect(deleteDialog).toBeVisible();
  await expect(deleteDialog).not.toContainText("Delete confirmation fixture");
  await expect(deleteDialog).toContainText(
    "This permanently removes the chat and stops any active response.",
  );
  await expect(deleteDialog.getByRole("button", { name: "Cancel" })).toBeFocused();

  await page.keyboard.press("Escape");
  await expect(deleteDialog).toHaveCount(0);
  await expect(deleteChatButton).toBeFocused();

  await page.route(`**/api/workbench/chat-session/threads/${threadId}`, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    await route.continue();
  });
  await deleteChatButton.click();
  await deleteDialog.getByRole("button", { name: "Delete chat" }).click();
  await expect(deleteDialog).toHaveCount(0, { timeout: 300 });
  await expect(threadItem).toHaveCount(0);
});

test("archived chats are prefetched and remain visible while revalidating", async ({ page }) => {
  test.skip(releaseMode !== "local-session");

  const created = await page.request.post("/api/workbench/chat-session/threads", {
    data: { title: "Archived cache fixture" },
  });
  expect(created.ok(), await created.text()).toBe(true);
  const createdBody = (await created.json()) as { activeThread?: { threadId?: string } };
  const threadId = createdBody.activeThread?.threadId;
  expect(threadId).toBeTruthy();
  const archived = await page.request.patch(
    `/api/workbench/chat-session/threads/${encodeURIComponent(threadId!)}`,
    { data: { status: "archived" } },
  );
  expect(archived.ok(), await archived.text()).toBe(true);

  let archivedRequests = 0;
  await page.route("**/api/workbench/chat-session/threads?status=archived", async (route) => {
    archivedRequests += 1;
    await route.continue();
  });
  await page.goto("/");
  await expect.poll(() => archivedRequests).toBeGreaterThan(0);
  const requestsAfterPrefetch = archivedRequests;

  await page.getByRole("button", { name: "Archived" }).click();
  await expect(page.getByText("Archived cache fixture", { exact: true })).toBeVisible();
  await expect(page.getByText("Loading archived chats...", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Recent" }).click();
  await page.getByRole("button", { name: "Archived" }).click();
  await expect(page.getByText("Archived cache fixture", { exact: true })).toBeVisible();
  expect(archivedRequests).toBe(requestsAfterPrefetch);
});

test("trusted local session is immediately usable and exposes release controls", async ({
  page,
}) => {
  test.skip(releaseMode !== "local-session");

  test.setTimeout(120_000);
  let adminSummaryRequests = 0;
  page.on("request", (request) => {
    if (request.url().includes("/api/workbench/admin-summary")) adminSummaryRequests += 1;
  });

  await page.goto("/");
  await expect(page).toHaveTitle("Operloom");
  await expect(page.getByText("agent workbench", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "What are we working on?" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Message input" })).toBeEditable();
  await expect.poll(() => adminSummaryRequests).toBeGreaterThan(0);
  await expect
    .poll(async () => {
      const response = await page.request.get("/api/workbench/admin-access");
      return response.ok() && ((await response.json()) as { isAdmin?: boolean }).isAdmin;
    })
    .toBe(true);

  await page.route("**/api/workbench/chat-session/stage-thread**", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    await route.continue();
  });
  const stageResponsePromise = page.waitForResponse(
    (response) =>
      response.url().includes("/api/workbench/chat-session/stage-thread") && response.ok(),
  );
  const newChatStartedAt = Date.now();
  await page.getByRole("button", { name: "New chat" }).click();
  const composer = page.getByRole("textbox", { name: "Message input" });
  await expect(composer).toBeEditable();
  expect(Date.now() - newChatStartedAt).toBeLessThan(1_200);
  const composerShell = page.locator('[data-slot="aui_composer-shell"]');
  await composer.focus();
  const optimisticComposerStyle = await composerShell.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      backgroundColor: style.backgroundColor,
      borderColor: style.borderColor,
      borderRadius: style.borderRadius,
      boxShadow: style.boxShadow,
      padding: style.padding,
    };
  });
  const welcome = page.locator(".aui-thread-welcome-root");
  await expect(welcome).toHaveClass(/workbench-enter/);
  await expect(page.getByRole("button", { name: /Explore what’s possible/i })).toBeVisible();
  await expect(page.getByRole("button", { name: /Plan a project handoff/i })).toBeVisible();
  await expect(page.getByRole("button", { name: /Review a decision/i })).toBeVisible();
  await expect(page.getByRole("button", { name: /Explain a failure/i })).toBeVisible();
  const materializeResponsePromise = page.waitForResponse(
    (response) =>
      response.url().includes("/api/workbench/chat-session/materialize-turn") && response.ok(),
  );
  const firstMessage = "Queue this while the Agent connects.";
  await composer.fill(firstMessage);
  await composer.press("Enter");
  await expect(page.getByRole("status")).toContainText("Sending…");
  await expect(composer).toBeDisabled();

  const [stageResponse, materializeResponse] = await Promise.all([
    stageResponsePromise,
    materializeResponsePromise,
  ]);
  const staged = (await stageResponse.json()) as { stagedThread?: { threadId?: string } };
  const materialized = (await materializeResponse.json()) as {
    materializedTurn?: { threadId?: string };
  };
  expect(materialized.materializedTurn?.threadId).toBe(staged.stagedThread?.threadId);
  await expect(
    page.locator('[data-slot="aui_message-group"]').getByText(firstMessage, { exact: true }),
  ).toBeVisible();
  await expect(composer).toBeEditable();
  await expect(composer).toHaveValue("");
  await expect(page.getByRole("status")).toHaveCount(0);
  await expect
    .poll(() =>
      composerShell.evaluate((element) => {
        const style = getComputedStyle(element);
        return {
          backgroundColor: style.backgroundColor,
          borderColor: style.borderColor,
          borderRadius: style.borderRadius,
          boxShadow: style.boxShadow,
          padding: style.padding,
        };
      }),
    )
    .toEqual(optimisticComposerStyle);

  await composer.fill("/history");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Workbench History" })).toBeVisible();
  await page
    .getByRole("dialog", { name: "Workbench History" })
    .getByRole("button", { name: "Close" })
    .click();

  await page.getByRole("button", { name: "Workspace access" }).click();
  await expect(page.getByRole("dialog", { name: "Workspace" })).toBeVisible();
  await expect(
    page.getByRole("dialog", { name: "Workspace" }).getByText("Default Workspace", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Manage workspace" }).click();
  await page.getByRole("tab", { name: "Members" }).click();
  await expect(page.getByRole("combobox", { name: "Role for e2e-owner" })).toHaveValue("owner");
  await page.getByRole("button", { name: "Close" }).click();

  await composer.fill("/admin");
  await page.getByText("Open workspace, agent, and runtime controls.", { exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Admin" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Overview" })).toHaveCount(0);
  await expect(page.getByRole("tab", { name: "Agents" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Controls" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "System" })).toBeVisible();

  await page.getByRole("tab", { name: "Controls" }).click();
  await expect(page.getByRole("heading", { name: "Approvals" })).toBeVisible();
  await expect(page.getByText("Tool permissions", { exact: true })).toBeVisible();

  await page.getByRole("tab", { name: "System" }).click();
  await expect(page.getByRole("heading", { name: "Recent runtime" })).toBeVisible();
  await expect(page.getByText("Run system checks", { exact: true })).toBeVisible();

  await page.getByRole("tab", { name: "Agents" }).click();
  const repositoryPack = page.locator("article").filter({ hasText: "Repository Analyst" });
  await expect(repositoryPack).toContainText("v1.2.1");
  await expect(page.getByText("Polymancer Research", { exact: true })).toBeVisible();
  await expect(page.getByText("Swordfish Runtime", { exact: true })).toBeVisible();
  const agentSwitchResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === "/api/workbench/chat-session/agent-switch",
  );
  await repositoryPack.getByRole("button", { name: "Use agent" }).click();
  const agentSwitch = await agentSwitchResponse;
  expect(agentSwitch.ok(), await agentSwitch.text()).toBe(true);

  await expect(page.getByRole("dialog", { name: "Admin" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Repository Analyst" })).toBeVisible();
  await expect(page.getByRole("button", { name: /Assess release readiness/i })).toBeVisible();
  await expect(page.getByRole("button", { name: /Map the architecture/i })).toBeVisible();
  await expect(page.getByRole("button", { name: /Find the next slice/i })).toBeVisible();
  await expect(page.getByRole("button", { name: /Review release risk/i })).toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("button", { name: /Assess release readiness/i })).toBeVisible();
  await expect(page.getByRole("button", { name: /Map the architecture/i })).toBeVisible();
  await expect(page.getByRole("button", { name: /Find the next slice/i })).toBeHidden();
  await expect(page.getByRole("button", { name: /Review release risk/i })).toBeHidden();
  await page.setViewportSize({ width: 1440, height: 900 });

  await page.getByRole("button", { name: "Tools", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Repository Analyst tools" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Available to you" })).toBeVisible();
  await expect(page.getByText("Readiness report", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Agent only" })).toBeVisible();
  await expect(page.getByText("No conversational agent-only tools are enabled.")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Inside workflows" })).toBeVisible();
  await expect(page.getByText("repo.snapshot", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Close" }).click();

  await page.getByRole("button", { name: /Assess release readiness/i }).click();
  await expect(page.getByRole("dialog", { name: "Readiness report" })).toBeVisible();
  await expect(page.getByText("Documentation", { exact: true })).toBeVisible();
  const workflowResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname.startsWith("/api/workbench/workflows/"),
  );
  await page.getByRole("button", { name: "Run dry-run" }).click();
  const workflow = await workflowResponse;
  expect(workflow.ok(), await workflow.text()).toBe(true);
  await expect(page.getByRole("dialog", { name: "Workbench History" })).toBeVisible();
  await expect(page.getByText("Repository snapshot report", { exact: true })).toBeVisible({
    timeout: 30_000,
  });
  await expect(
    page.getByRole("listitem").filter({ hasText: "Release recovery fixture" }),
  ).toBeVisible();
  await page
    .getByRole("listitem")
    .filter({ hasText: "Release recovery fixture" })
    .getByRole("button", { name: /Open Release recovery fixture/ })
    .click();
  await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();

  await page
    .getByRole("dialog", { name: "Workbench History" })
    .getByRole("button", {
      name: "Close",
    })
    .click();
  const requestsBeforeBurst = adminSummaryRequests;
  const minimumGeneratedAt = new Date(Date.now() + 60_000).toISOString();
  let convergenceRequests = 0;
  await page.route("**/api/workbench/admin-summary**", async (route) => {
    convergenceRequests += 1;
    const response = await route.fetch();
    const body = (await response.json()) as {
      summary?: { generatedAt?: string };
    };
    if (body.summary) {
      body.summary.generatedAt =
        convergenceRequests < 3
          ? new Date(Date.parse(minimumGeneratedAt) - 1_000).toISOString()
          : minimumGeneratedAt;
    }
    await route.fulfill({ response, json: body });
  });
  await page.evaluate((requiredGeneratedAt) => {
    for (const source of ["event", "fallback-poll"]) {
      window.dispatchEvent(
        new CustomEvent("operloom:workbench-summary-refresh", {
          detail: { source, minimumGeneratedAt: requiredGeneratedAt },
        }),
      );
    }
  }, minimumGeneratedAt);
  await expect.poll(() => convergenceRequests, { timeout: 6_000 }).toBeGreaterThanOrEqual(3);
  expect(adminSummaryRequests).toBeGreaterThanOrEqual(requestsBeforeBurst + 3);
  await expect(page.getByText("Loading", { exact: true })).toHaveCount(0);
  await expect(page.locator("[data-summary-sync-status]")).toHaveAttribute(
    "data-summary-sync-status",
    "idle",
  );
  await page.unroute("**/api/workbench/admin-summary**");

  const recoveredComposer = page.getByRole("textbox", { name: "Message input" });
  await expect(recoveredComposer).toBeEditable();
  await recoveredComposer.fill("/admin");
  await page.getByText("Open workspace, agent, and runtime controls.", { exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Admin" })).toBeVisible();

  expect(hydrationErrors).toEqual([]);
});

test("chat renaming stays in the app and persists after refresh", async ({ page }) => {
  test.skip(releaseMode !== "local-session");
  await page.goto("/");
  const created = await page.request.post("/api/workbench/chat-session/threads", {
    data: { title: "Rename fixture" },
  });
  expect(created.ok()).toBe(true);
  const body = await created.json();
  await page.reload();
  const item = page.getByTestId(`thread-history-item-${body.activeThread.threadId}`);
  await item.getByRole("button", { name: "Rename chat" }).click();
  const dialog = page.getByRole("dialog", { name: "Rename chat", exact: true });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Chat name").fill("  ");
  await expect(dialog.getByRole("button", { name: "Save name" })).toBeDisabled();
  await dialog.getByLabel("Chat name").fill("Release planning");
  await dialog.getByLabel("Chat name").press("Enter");
  await expect(dialog).not.toBeVisible();
  await expect(item).toContainText("Release planning");
  await page.reload();
  await expect(item).toContainText("Release planning");
});
