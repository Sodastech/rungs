import { randomInt } from "node:crypto";
import { expect, type Page } from "@playwright/test";

export const isPublic = process.env.DEMO_PUBLIC === "1";

/** Each test acts as its own address, so tests do not share the limits on new sandboxes. */
export const someAddress = () => `198.51.${randomInt(0, 255)}.${randomInt(1, 255)}`;

export async function signInAs(page: Page, name: string): Promise<void> {
  await page.goto("/login");
  await page.getByRole("button", { name: new RegExp(name) }).click();
  await expect(page.getByRole("button", { name: "Switch person" })).toBeVisible();
}

export async function switchTo(page: Page, name: string): Promise<void> {
  await page.getByRole("button", { name: "Switch person" }).click();
  await expect(page).toHaveURL(/\/login/);
  await page.getByRole("button", { name: new RegExp(name) }).click();
  await expect(page.getByRole("button", { name: "Switch person" })).toBeVisible();
}

/** Fills in the form, checks the preview, submits, and returns the request's path. */
export async function submitExpense(page: Page, title: string, amount: string): Promise<string> {
  await page
    .getByRole("navigation", { name: "Main" })
    .getByRole("link", { name: "New expense" })
    .click();
  await page.getByLabel("What did you pay for?").fill(title);
  await page.getByLabel("Amount (USD)").fill(amount);
  await page.getByRole("button", { name: "Preview approvers" }).click();
  await page.getByRole("button", { name: "Submit expense" }).click();
  await expect(page).toHaveURL(/\/requests\/r_/);
  return new URL(page.url()).pathname;
}
