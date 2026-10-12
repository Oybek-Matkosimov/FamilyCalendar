import { test, expect } from '@playwright/test';

// Whether the browser itself calls the app installable is checked against the production build in
// scripts/prod-smoke.ts (the development server compiles the manifest on demand, which is too slow to test reliably).
test.describe('installable app', () => {
  test("the page links the manifest and icons and carries the app's name", async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('link[rel="manifest"]')).toHaveAttribute('href', /manifest/);
    await expect(page.locator('link[rel="apple-touch-icon"]')).toHaveCount(1);
    await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute('content', '#2450d8');
    await expect(page).toHaveTitle("Oybek's Calendar");
    await expect(page.getByText('Oybek’s Calendar').first()).toBeVisible();
  });

  test('opening the app offline shows a friendly page, not a browser error', async ({ page, context }) => {
    await page.goto('/');
    await page.evaluate(async () => { await navigator.serviceWorker.ready; });
    await page.reload(); // let the worker take control of the page
    await context.setOffline(true);
    await page.goto('/create').catch(() => undefined);
    await expect(page.getByRole('heading', { name: "You're offline" })).toBeVisible();
    await context.setOffline(false);
  });
});
