import { test, expect, type Page } from '@playwright/test';

const accounts = {
  propertyManager: 'pm@pacificridge.ca',
  bookkeeper: 'books@pacificridge.ca',
  broker: 'broker@pacificridge.ca',
} as const;

const password = 'Password123!';

async function signIn(page: Page, email: string) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: /Welcome,/ })).toBeVisible();
}

test.describe('English demo walkthrough smoke test', () => {
  test('bookkeeper can navigate accounting and audit workflows', async ({ page }) => {
    await signIn(page, accounts.bookkeeper);

    await page.getByRole('link', { name: /Bills \/ OCR/ }).click();
    await expect(page.getByRole('heading', { name: 'Bills / OCR' })).toBeVisible();
    await expect(page.getByRole('columnheader', { name: 'Vendor' })).toBeVisible();

    await page.getByRole('link', { name: /Financial Sentinel/ }).click();
    await expect(page.getByRole('heading', { name: 'Financial Sentinel' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Process e-Transfer' })).toBeVisible();

    await page.getByRole('link', { name: /Reconciliation/ }).click();
    await expect(page.getByRole('heading', { name: 'Reconciliation' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Run reconciliation' })).toBeVisible();

    await page.getByRole('link', { name: /Audit Trail/ }).click();
    await expect(page.getByRole('heading', { name: 'Audit Trail' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Verify chain' })).toBeVisible();
  });

  test('property manager can navigate leasing operations workflows', async ({ page }) => {
    await signIn(page, accounts.propertyManager);

    await page.getByRole('link', { name: /Leads/ }).click();
    await expect(page.getByRole('heading', { name: 'Leads / Prospecting' })).toBeVisible();

    await page.getByRole('link', { name: /Conversations/ }).click();
    await expect(page.getByRole('heading', { name: 'Conversations', exact: true })).toBeVisible();

    await page.getByRole('link', { name: /Showings/ }).click();
    await expect(page.getByRole('heading', { name: 'Showings & Calendar' })).toBeVisible();

    await page.getByRole('link', { name: /AI Photos/ }).click();
    await expect(page.getByRole('heading', { name: 'AI Photo Gallery' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Upload' })).toBeVisible();
  });

  test('broker can generate compliance views', async ({ page }) => {
    await signIn(page, accounts.broker);

    await page.getByRole('link', { name: /Leases \/ RTA/ }).click();
    await expect(page.getByRole('heading', { name: 'Leases / RTA-BC' })).toBeVisible();
    await expect(page.getByText('non-binding drafts')).toBeVisible();

    await page.getByRole('link', { name: /Audit Trail/ }).click();
    await expect(page.getByRole('heading', { name: 'Audit Trail' })).toBeVisible();
    await page.getByRole('button', { name: 'Verify chain' }).click();
    await expect(page.getByText(/Chain intact:/)).toBeVisible();
  });
});
