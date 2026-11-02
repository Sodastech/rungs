import { expect, test } from "@playwright/test";
import { signInAs, someAddress, submitExpense, switchTo } from "./helpers";

test.use({ extraHTTPHeaders: { "x-real-ip": someAddress() } });

test("an expense goes from Alice through Marco and finance to approved", async ({ page }) => {
  const title = `Conference ticket ${Date.now()}`;
  await signInAs(page, "Alice Moreau");
  const path = await submitExpense(page, title, "1890");
  await expect(page.getByRole("heading", { name: title })).toBeVisible();

  await switchTo(page, "Marco Rossi");
  await page.getByRole("link", { name: /Inbox/ }).click();
  await page.getByRole("link", { name: new RegExp(title) }).click();
  await page.getByRole("button", { name: "Approve", exact: true }).click();
  await expect(page.getByText("Marco Rossi approved").first()).toBeVisible();

  await switchTo(page, "Fatima Khan");
  await page.getByRole("link", { name: /Inbox/ }).click();
  await page.getByRole("link", { name: new RegExp(title) }).click();
  await page.getByRole("button", { name: "Approve", exact: true }).click();
  await expect(page.getByText("Fatima Khan approved").first()).toBeVisible();

  await switchTo(page, "Alice Moreau");
  await page.goto(path);
  await expect(page.locator("main").getByText("Approved", { exact: true }).first()).toBeVisible();
  await page.getByRole("link", { name: "Notifications" }).click();
  await expect(page.getByText(`"${title}" was approved.`)).toBeVisible();
});

test("the demo clock moves forward", async ({ page }) => {
  await signInAs(page, "Marco Rossi");
  await page.getByRole("button", { name: "+1 day" }).click();
  await expect(page.getByText(/^\+1 day\./)).toBeVisible();
});
