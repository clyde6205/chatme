# Deploying the web app to Vercel

Project settings:

- Root directory: `apps/web` (Vercel detects the pnpm workspace and installs from the root lockfile).
- Build command, output and headers come from `apps/web/vercel.json`.
- Environment variable (Production and Preview): `VITE_API_URL=https://api.chatme.pro`.
- Domains: `chatme.pro` (primary) and `www.chatme.pro` (redirect). The API must list both in `WEB_ORIGINS`.

What `vercel.json` does:

- SPA routing: every path except `/assets/*` and `/icons/*` falls back to `index.html` (existing files are served first).
- `index.html`, `/`, `sw.js` and the manifest are `no-cache`, so a deploy reaches users on their next visit and the service worker updates; hashed `assets/*` are immutable for a year.
- Security headers: CSP (`script-src 'self'`; styles allow the inline critical CSS of the pre-JavaScript shell; `connect-src` is limited to `self` and `api.chatme.pro`), HSTS with preload, `nosniff`, strict referrer, a restrictive Permissions-Policy, COOP.

If the API domain changes, update `VITE_API_URL` and the `connect-src` entry together. `e2e/csp.spec.ts` serves the production build with these headers and fails if the policy blocks the app.

Preview deployments on `*.vercel.app` are a different site from the API, so the session cookie is not sent there: previews show the signed-out screens only unless a preview API with matching origins is configured.

Nothing about the app depends on Vercel: `dist/` is static and runs on any CDN with the same headers.
