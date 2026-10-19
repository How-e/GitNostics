import { expect, test, type Page } from '@playwright/test';

async function blockExternalRequests(page: Page) {
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (['127.0.0.1', 'localhost'].includes(url.hostname)) await route.continue();
    else await route.abort('blockedbyclient');
  });
}

async function enterDemo(page: Page) {
  await blockExternalRequests(page);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: /Good diagnostics start/ })).toBeVisible();
  await page.getByRole('button', { name: 'Explore demo', exact: true }).click();
  await expect(page.getByText('Demo workspace.', { exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'northstar/api', exact: true })).toBeVisible();
}

test('onboards with isolated demo data, navigates evidence, acknowledges a finding, and preserves live isolation', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await enterDemo(page);
  await page.screenshot({ path: '.local/qa-desktop-dark.png', fullPage: true });
  await page.getByRole('link', { name: 'Repositories', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Repositories', exact: true })).toBeVisible();
  await page.getByRole('link', { name: /northstar \/ api/ }).click();
  await expect(page.getByRole('heading', { name: 'api', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Configuration evidence' })).toBeVisible();
  await page.getByRole('link', { name: 'Pull requests', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Pull request diagnostics', exact: true }),
  ).toBeVisible();
  await expect(page.getByText('Upgrade application dependencies', { exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Actions', exact: true }).click();
  await expect(page.getByRole('heading', { name: /Workflow|Actions/ }).first()).toBeVisible();
  await expect(page.getByText('Continuous integration', { exact: true }).first()).toBeVisible();
  await page.getByRole('link', { name: /^Findings/ }).click();
  await expect(page.getByRole('heading', { name: 'Diagnostic findings' })).toBeVisible();
  await page.locator('.finding-row').first().click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: 'Supporting evidence' })).toBeVisible();
  await dialog.getByRole('combobox', { name: 'Finding status' }).selectOption('acknowledged');
  await expect(page.getByRole('status')).toContainText('Finding status updated');
  await dialog.getByRole('button', { name: 'Close dialog' }).click();
  await page.getByRole('combobox', { name: 'Finding status' }).selectOption('acknowledged');
  await expect(page.locator('.finding-row')).toHaveCount(1);
  await page.reload();
  await expect(page.locator('.finding-row')).toHaveCount(1);
  await page.getByRole('button', { name: 'Return to live' }).click();
  await page.getByRole('link', { name: 'Overview', exact: true }).click();
  await expect(page.getByRole('heading', { name: /Good diagnostics start/ })).toBeVisible();
  expect(errors).toEqual([]);
});

test('requires exact demo confirmation and records only simulated operations', async ({ page }) => {
  await enterDemo(page);
  await page.getByRole('link', { name: 'Safe action center', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Safe action center', exact: true }),
  ).toBeVisible();
  await page.getByRole('combobox', { name: 'Workflow run' }).selectOption('1000');
  await page
    .getByRole('button', { name: /Preview/ })
    .first()
    .click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('SIMULATION ONLY', { exact: true })).toBeVisible();
  const execute = dialog.getByRole('button', { name: 'Simulate action' });
  await expect(execute).toBeDisabled();
  await dialog.getByRole('textbox', { name: 'Action confirmation' }).fill('simulate');
  await expect(execute).toBeDisabled();
  await dialog.getByRole('textbox', { name: 'Action confirmation' }).fill('SIMULATE');
  await page.screenshot({ path: '.local/qa-action-confirmation.png', fullPage: true });
  await expect(execute).toBeEnabled();
  await execute.click();
  await expect(dialog).not.toBeVisible();
  await expect(page.getByRole('status')).toContainText('Demo operation simulated');
  await page.getByRole('link', { name: 'Activity', exact: true }).click();
  await expect(page.getByText(/Simulated:/).first()).toBeVisible();
  await page.getByRole('link', { name: 'Storage', exact: true }).click();
  await page
    .getByRole('checkbox', { name: 'Select playwright-traces in northstar/api', exact: true })
    .check();
  await page.getByRole('button', { name: 'Review cleanup (1)', exact: true }).click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Preview deletion', exact: true })
    .click();
  await expect(dialog.getByText('Destructive operation', { exact: true })).toBeVisible();
  await expect(dialog.getByText(/playwright-traces.*842000000 bytes.*501/)).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Simulate action' })).toBeDisabled();
  await dialog.getByRole('textbox', { name: 'Action confirmation' }).fill('SIMULATE');
  await page.screenshot({ path: '.local/qa-cleanup-confirmation.png', fullPage: true });
  await dialog.getByRole('button', { name: 'Simulate action' }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.getByText('playwright-traces', { exact: true })).toBeVisible();
});

test('persists light theme and settings and exposes artifact storage', async ({ page }) => {
  await enterDemo(page);
  await page.getByRole('button', { name: 'Use light theme' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.getByRole('link', { name: 'Settings', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Workspace settings', exact: true }),
  ).toBeVisible();
  await page.getByRole('spinbutton', { name: 'Local history retention', exact: true }).fill('45');
  await page.getByRole('button', { name: 'Save preferences', exact: true }).first().click();
  await expect(page.getByRole('status')).toContainText('Workspace preferences saved');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await expect(
    page.getByRole('spinbutton', { name: 'Local history retention', exact: true }),
  ).toHaveValue('45');
  await page.getByRole('link', { name: 'Storage', exact: true }).click();
  await expect(page.getByText('playwright-traces', { exact: true })).toBeVisible();
  await expect(page.getByText('build-output', { exact: true })).toBeVisible();
  await page.screenshot({ path: '.local/qa-storage-light.png', fullPage: true });
});

test('keeps navigation and content usable on a narrow mobile viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await enterDemo(page);
  await page.getByRole('button', { name: 'Open navigation' }).click();
  await page.getByRole('link', { name: 'Storage', exact: true }).click();
  await expect(page.getByRole('heading', { name: /storage/i }).first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Close navigation' })).not.toBeVisible();
  const horizontalOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth + 1,
  );
  expect(horizontalOverflow).toBe(false);
  await page.screenshot({ path: '.local/qa-mobile-storage.png', fullPage: true });
});
