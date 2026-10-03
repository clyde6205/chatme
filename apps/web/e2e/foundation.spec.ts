import { expect, test, type Page } from '@playwright/test';
import { linkFromOutbox } from './mail';

const unique = () => `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;

async function register(page: Page, opts: { name?: string } = {}) {
  const id = unique();
  const user = { email: `e2e_${id}@example.com`, username: `e2e_${id}`, password: 'a long enough passphrase', name: opts.name ?? `Tester ${id}` };
  await page.goto('/join');
  await page.getByLabel('Email').fill(user.email);
  await page.getByLabel('Display name').fill(user.name);
  await page.getByLabel('Username').fill(user.username);
  await page.getByLabel('Password').fill(user.password);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByRole('heading', { name: `Hi, ${user.name}` })).toBeVisible();
  return user;
}

test('static shell paints before JavaScript and without any API call', async ({ page }) => {
  const apiCalls: string[] = [];
  page.on('request', (r) => r.url().includes('/api/') && apiCalls.push(r.url()));
  await page.route('**/*.js', (route) => route.abort()); // simulate JS not yet loaded
  await page.goto('/signin');
  await expect(page.locator('.shell .brand')).toHaveText('CHATme');
  expect(apiCalls).toEqual([]);
});

test('new user registers, edits profile, and stays signed in across reloads', async ({ page }) => {
  const user = await register(page);
  await page.getByRole('link', { name: 'Edit profile' }).click();
  await page.getByLabel('About you').fill('Building CHATme');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('status')).toHaveText('Saved');
  await page.reload();
  await expect(page.getByLabel('About you')).toHaveValue('Building CHATme');
  await page.goto('/');
  await expect(page.getByText(`@${user.username}`)).toBeVisible();
});

test('duplicate username shows a translated error, not a crash', async ({ page, browser }) => {
  const user = await register(page);
  const other = await browser.newPage();
  await other.goto('/join');
  await other.getByLabel('Email').fill(`dup_${unique()}@example.com`);
  await other.getByLabel('Display name').fill('Dup');
  await other.getByLabel('Username').fill(user.username.toUpperCase());
  await other.getByLabel('Password').fill('a long enough passphrase');
  await other.getByRole('button', { name: 'Create account' }).click();
  await expect(other.getByRole('alert')).toHaveText('That username is taken.');
  await other.close();
});

test('switching to Arabic flips the whole UI to RTL and persists', async ({ page }) => {
  await register(page);
  await page.goto('/settings');
  await page.getByLabel('Language').selectOption('ar');
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(page.locator('html')).toHaveAttribute('lang', 'ar');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('الإعدادات');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(page.getByRole('link', { name: 'الرئيسية' })).toBeVisible();
});

test('opens offline from cache with the signed-in shell and offline banner', async ({ page, context }) => {
  const user = await register(page);
  // Wait for the service worker to take control so the shell is precached.
  await page.waitForFunction(async () => (await navigator.serviceWorker?.ready) !== undefined && !!navigator.serviceWorker.controller, null, { timeout: 15_000 }).catch(async () => {
    await page.reload();
    await page.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 15_000 });
  });
  await context.setOffline(true);
  await page.reload();
  await expect(page.getByRole('heading', { name: `Hi, ${user.name}` })).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: "You're offline" })).toBeVisible();
  await context.setOffline(false);
  await expect(page.getByRole('status').filter({ hasText: 'Back online' })).toBeVisible();
});

test('signing out other devices revokes them', async ({ page, browser }) => {
  const user = await register(page);
  const phone = await browser.newContext();
  const p2 = await phone.newPage();
  await p2.goto('/signin');
  await p2.getByLabel('Email').fill(user.email);
  await p2.getByLabel('Password').fill(user.password);
  await p2.getByRole('button', { name: 'Sign in' }).click();
  await expect(p2.getByRole('heading', { name: `Hi, ${user.name}` })).toBeVisible();

  await page.goto('/devices');
  await expect(page.getByText('2 active devices')).toBeVisible();
  await page.getByRole('button', { name: 'Sign out all other devices' }).click();
  await expect(page.getByText('Signed out 1 device.')).toBeVisible();

  await p2.reload(); // revalidation discovers the revoked session
  await expect(p2).toHaveURL(/\/signin$/);
  await phone.close();
});

test('low-memory device gets light mode automatically', async ({ browser }) => {
  const ctx = await browser.newContext();
  await ctx.addInitScript(() => Object.defineProperty(Navigator.prototype, 'deviceMemory', { get: () => 1 }));
  const page = await ctx.newPage();
  await page.goto('/signin');
  await expect(page.locator('html')).toHaveAttribute('data-perf', 'low');
  await expect(page.locator('html')).toHaveAttribute('data-motion', 'reduce');
  await ctx.close();
});

test('first usable sign-in screen under slow 3G and 4x CPU throttling', async ({ page }) => {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Network.enable');
  // Chrome DevTools "Slow 3G" profile.
  await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 400, downloadThroughput: (400 * 1024) / 8, uploadThroughput: (400 * 1024) / 8 });
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  const started = Date.now();
  await page.goto('/signin', { waitUntil: 'commit' });
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible({ timeout: 15_000 });
  const ms = Date.now() - started;
  console.log(`cold load to interactive sign-in form (slow 3G, 4x CPU): ${ms} ms`);
  expect(ms).toBeLessThan(6_000);
});

test('verification link from the email confirms the address and clears the banner', async ({ page }) => {
  const user = await register(page);
  await expect(page.getByText(`We sent a link to ${user.email}`, { exact: false })).toBeVisible();
  const link = await linkFromOutbox(user.email, '/verify-email');
  await page.goto(link);
  await expect(page.getByText('Your email is confirmed.')).toBeVisible();
  // The token is removed from the address bar once read.
  expect(new URL(page.url()).hash).toBe('');
  await page.getByRole('button', { name: 'Home' }).click();
  await expect(page.getByRole('heading', { name: `Hi, ${user.name}` })).toBeVisible();
  await expect(page.getByText(`We sent a link to ${user.email}`, { exact: false })).toHaveCount(0);
});

test('forgotten password: request link, set a new one, sign in with it', async ({ page }) => {
  const user = await register(page);
  await page.getByRole('button', { name: 'Sign out' }).click();
  await page.getByRole('link', { name: 'Forgot password?' }).click();
  await page.getByLabel('Email').fill(user.email);
  await page.getByRole('button', { name: 'Send link' }).click();
  await expect(page.getByRole('status')).toContainText('If an account exists');
  await page.goto(await linkFromOutbox(user.email, '/reset-password'));
  await page.getByLabel('New password').fill('an even longer new passphrase');
  await page.getByRole('button', { name: 'Set new password' }).click();
  await expect(page.getByRole('status')).toContainText('Your password was changed');
  await page.goto('/signin');
  await page.getByLabel('Email').fill(user.email);
  await page.getByLabel('Password').fill('an even longer new passphrase');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: `Hi, ${user.name}` })).toBeVisible();
});

test('a profile change on one device appears live on another, and signing a device out ends it', async ({ page, browser }) => {
  const user = await register(page);
  const other = await browser.newContext({ viewport: { width: 360, height: 640 } });
  const second = await other.newPage();
  await second.goto('/signin');
  await second.getByLabel('Email').fill(user.email);
  await second.getByLabel('Password').fill(user.password);
  await second.getByRole('button', { name: 'Sign in' }).click();
  await expect(second.getByRole('heading', { name: `Hi, ${user.name}` })).toBeVisible();
  // Let the realtime client (loaded after first render) connect.
  await second.waitForTimeout(2500);

  await page.goto('/profile');
  await page.getByLabel('Display name').fill('Renamed Live');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(second.getByRole('heading', { name: 'Hi, Renamed Live' })).toBeVisible({ timeout: 10_000 });

  await page.goto('/devices');
  await page.getByRole('button', { name: 'Sign out all other devices' }).click();
  await expect(second).toHaveURL(/\/signin$/, { timeout: 10_000 });
  await other.close();
});
