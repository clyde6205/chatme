import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname, join } from 'node:path';
import { expect, test } from '@playwright/test';

/**
 * Serves the production build with the security headers from vercel.json, so a
 * Content-Security-Policy that would break the deployed app fails here first.
 */
const dist = join(import.meta.dirname, '..', 'dist');
const vercel = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'vercel.json'), 'utf8')) as { headers: { source: string; headers: { key: string; value: string }[] }[] };
const global = vercel.headers.find((h) => h.source === '/(.*)')!.headers;
const types: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };

let server: Server;
let origin: string;
test.beforeAll(async () => {
  server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0]!;
    let file = join(dist, path);
    let body: Buffer;
    try {
      body = readFileSync(file);
    } catch {
      file = join(dist, 'index.html'); // SPA rewrite, as vercel.json does
      body = readFileSync(file);
    }
    for (const h of global) res.setHeader(h.key, h.value);
    res.setHeader('content-type', types[extname(file)] ?? 'application/octet-stream');
    res.end(body);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
test.afterAll(() => new Promise<void>((r) => server.close(() => r())));

test('the production CSP allows the app to boot with no violations', async ({ page }) => {
  const violations: string[] = [];
  page.on('console', (m) => /Content Security Policy|Refused to/i.test(m.text()) && violations.push(m.text()));
  await page.goto(`${origin}/signin`);
  await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible();
  await page.goto(`${origin}/forgot-password`);
  await expect(page.getByRole('button', { name: 'Send link' })).toBeVisible();
  expect(violations).toEqual([]);
});
