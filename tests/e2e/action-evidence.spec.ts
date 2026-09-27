import { expect, test } from "./fixtures";

for (const viewport of [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
]) {
  test(`action evidence and projection recovery at ${viewport.width}px`, async ({ page }) => {
    test.skip(process.env.E2E_RELEASE_MODE !== "local-session");
    test.setTimeout(90_000);
    await page.setViewportSize(viewport);
    const timestamp = "2026-09-27T08:00:00.000Z";
    let reconciled = false;
    let failRefresh = false;
    const commands: string[] = [];
    const common = {
      toolId: "capacity.allocate",
      actionType: "allocate",
      version: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
      terminalAt: null,
      externalReference: null,
      ledger: [
        {
          sequence: 1,
          status: "approved",
          summary: "Allocation approved",
          createdAt: timestamp,
          externalReference: null,
        },
      ],
    };
    await page.route("**/api/workbench/actions**", async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      if (request.method() === "POST") {
        commands.push(path);
        expect(path).toBe("/api/workbench/actions/repair/reconcile");
        reconciled = true;
        await route.fulfill({
          json: {
            ok: true,
            result: { proposalId: "repair", status: "reconciled", summary: "Projection repaired" },
          },
        });
        return;
      }
      if (failRefresh) {
        await route.fulfill({
          status: 503,
          json: { ok: false, error: "Action refresh unavailable" },
        });
        return;
      }
      await route.fulfill({
        json: {
          ok: true,
          proposals: [
            {
              ...common,
              id: "repair",
              summary: "Allocate review capacity",
              status: reconciled ? "reconciled" : "executing",
              proposal: { preview: { resource: "review-pool", units: 2 } },
              review: {
                requestHash: "review-hash-bound-to-approved-content",
                expiresAt: "2026-09-27T08:15:00.000Z",
              },
              providerOperation: {
                id: "receipt",
                operationId: "capacity.allocate",
                version: "1",
                status: "succeeded",
                output: { resourceId: "allocation-1", lifecycle: "pending" },
                updatedAt: timestamp,
              },
            },
            {
              ...common,
              id: "closed",
              summary: "Cancelled capacity attempt",
              status: "reconciled",
              terminalAt: timestamp,
              result: { dispatchStatus: "not_dispatched" },
            },
          ],
        },
      });
    });
    await page.goto("/");
    if (viewport.width < 640) {
      const composer = page.getByRole("textbox", { name: "Message input" });
      await composer.fill("/history");
      await composer.press("Enter");
    } else {
      await page.getByRole("button", { name: "History", exact: true }).click();
    }
    const history = page.getByRole("dialog", { name: "Workbench History" });
    const action = history.getByRole("article", { name: "Allocate review capacity" });
    await expect(action).toBeVisible();
    await action.getByText("Action evidence", { exact: true }).click();
    await expect(action.getByText("Resource lifecycle", { exact: true })).toBeVisible();
    await expect(
      action.getByText(
        "The provider accepted the request. The external resource is still pending.",
      ),
    ).toBeVisible();
    await expect(
      action.getByText("review-hash-bound-to-approved-content", { exact: true }),
    ).toBeVisible();
    await expect(
      action.getByText(/repair the action outcome without submitting it again/),
    ).toBeVisible();
    await action.getByRole("button", { name: "Reconcile", exact: true }).click();
    await expect(action.getByRole("button", { name: "Reconcile", exact: true })).toHaveCount(0);
    await expect(action.getByText("reconciled", { exact: true })).toBeVisible();
    await expect(action.locator(".animate-spin")).toHaveCount(0);
    expect(commands).toEqual(["/api/workbench/actions/repair/reconcile"]);
    const closed = history.getByRole("article", { name: "Cancelled capacity attempt" });
    await closed.getByText("Action evidence", { exact: true }).click();
    await expect(
      closed.getByText("No external mutation was dispatched. This attempt is closed."),
    ).toBeVisible();
    await expect(closed.getByRole("button")).toHaveCount(0);
    failRefresh = true;
    await history.getByRole("button", { name: "Refresh history" }).click();
    await expect(history.getByText("Action refresh unavailable", { exact: true })).toBeVisible();
    await expect(action.getByText("reconciled", { exact: true })).toBeVisible();
    await expect(action).toBeVisible();
    const overflow = await history.evaluate(
      (element) => element.scrollWidth > element.clientWidth + 1,
    );
    expect(overflow).toBe(false);
    await page.screenshot({
      path: `output/playwright/action-evidence-${viewport.width}.png`,
      fullPage: true,
    });
  });
}
