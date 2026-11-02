import { expect, test } from "@playwright/test";
import { isPublic, signInAs, someAddress, submitExpense } from "./helpers";

test.skip(!isPublic, "only the online demo has sandboxes");
test.use({ extraHTTPHeaders: { "x-real-ip": someAddress() } });

const SANDBOX = "demo_sandbox";

test("a first visit creates nothing, and shows the banner", async ({ page, context }) => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/login/);
  await expect(page.getByText("Public demo with sample data.")).toBeVisible();
  expect((await context.cookies()).map((c) => c.name)).not.toContain(SANDBOX);
});

test("the sandbox cookie cannot be read from scripts", async ({ page, context }) => {
  await signInAs(page, "Alice Moreau");
  const cookie = (await context.cookies()).find((c) => c.name === SANDBOX);
  expect(cookie?.httpOnly).toBe(true);
  expect(cookie?.sameSite).toBe("Lax");
  expect(await page.evaluate(() => document.cookie)).not.toContain(SANDBOX);
});

test("visitors see only their own data, and only their own clock moves", async ({ browser }) => {
  const newVisitor = () => browser.newContext({ extraHTTPHeaders: { "x-real-ip": someAddress() } });
  const a = await (await newVisitor()).newPage();
  const b = await (await newVisitor()).newPage();
  const title = `Only for A ${Date.now()}`;

  await signInAs(a, "Alice Moreau");
  const path = await submitExpense(a, title, "40");
  await signInAs(b, "Alice Moreau");

  await b
    .getByRole("navigation", { name: "Main" })
    .getByRole("link", { name: "My expenses" })
    .click();
  await expect(b.getByRole("heading", { name: "My expenses" })).toBeVisible();
  await expect(b.getByText(title)).toHaveCount(0);
  await b.goto(path);
  await expect(b.getByText(title)).toHaveCount(0);

  const demoTime = (page: typeof a) =>
    page
      .locator(".clockbar time")
      .getAttribute("datetime")
      .then((at) => Date.parse(at as string));
  const before = await demoTime(b);
  await a.getByRole("button", { name: "+3 days" }).click();
  await expect(a.getByText(/^\+3 days\./)).toBeVisible();
  expect(await demoTime(a)).toBeGreaterThan(Date.now() + 2.9 * 86_400_000);
  await b.reload();
  expect(Math.abs((await demoTime(b)) - before)).toBeLessThan(60_000);
});

test("a sandbox that is gone sends the visitor back to start again", async ({ page, context }) => {
  await signInAs(page, "Alice Moreau");
  await context.addCookies([
    { name: SANDBOX, value: "0".repeat(32), domain: "localhost", path: "/" },
  ]);
  await page.goto("/expenses");
  await expect(page).toHaveURL(/\/login/);
  await signInAs(page, "Alice Moreau");
  await expect(page.locator(".clockbar")).toBeVisible();
});

test("a nonsense sandbox cookie does no harm", async ({ page, context }) => {
  await signInAs(page, "Alice Moreau");
  await context.addCookies([
    { name: SANDBOX, value: "x%22%3B%20DROP%20SCHEMA", domain: "localhost", path: "/" },
  ]);
  await page.goto("/expenses");
  await expect(page).toHaveURL(/\/login/);
});

test("pages send the security headers, and scripts run under the policy", async ({ page }) => {
  const violations: string[] = [];
  page.on("console", (message) => {
    if (message.text().includes("Content Security Policy")) violations.push(message.text());
  });
  const response = await page.goto("/login");
  const headers = response?.headers() ?? {};
  expect(headers["content-security-policy"]).toMatch(/script-src 'self' 'nonce-[^']+'/);
  expect(headers["content-security-policy"]).toContain("frame-ancestors 'none'");
  expect(headers["x-content-type-options"]).toBe("nosniff");
  expect(headers["x-frame-options"]).toBe("DENY");
  expect(headers["x-powered-by"]).toBeUndefined();

  await signInAs(page, "Alice Moreau");
  // Client-side navigation only works if the page's scripts were allowed to run.
  await page
    .getByRole("navigation", { name: "Main" })
    .getByRole("link", { name: "New expense" })
    .click();
  await expect(page.getByRole("heading", { name: "New expense" })).toBeVisible();
  expect(violations).toEqual([]);
});

test("the cleanup route needs the secret", async ({ request }) => {
  expect((await request.get("/api/cleanup")).status()).toBe(404);
  const wrong = { Authorization: "Bearer wrong" };
  expect((await request.get("/api/cleanup", { headers: wrong })).status()).toBe(404);
  const right = { Authorization: `Bearer ${process.env.CRON_SECRET}` };
  const response = await request.get("/api/cleanup", { headers: right });
  expect(response.status()).toBe(200);
  expect(await response.json()).toEqual({ deleted: expect.any(Number) });
});

test("an unknown page and a bad request show no internals", async ({ page }) => {
  const response = await page.goto("/requests/%00nonsense");
  const body = await page.content();
  expect(response?.status()).toBeLessThan(500);
  expect(body).not.toMatch(/node_modules|at async|stack|postgres/i);
});
