# Performance

## Startup architecture

1. `index.html` contains inline critical CSS and a static branded shell, so first paint needs no JavaScript and no API call (verified by e2e test with JS blocked).
2. The entry script reads capabilities and the identity snapshot synchronously, loads one locale chunk, and renders. No network request precedes the first render.
3. Service worker registration and web-vitals load at idle time.
4. Each screen and each locale is a separate lazy chunk, precached by the service worker for offline use.

## Budgets (enforced in CI by `apps/web/scripts/check-budget.mjs`)

| Budget | Limit | Current (2026-10-03) |
|---|---|---|
| Critical path: HTML + entry JS + entry CSS, gzip | 20 KB | 15.0 KB |
| Largest lazy chunk, gzip | 15 KB | 2.5 KB |

## Measured

| Scenario | Result | How |
|---|---|---|
| Cold load to interactive sign-in form, Chrome "Slow 3G" (400 ms RTT, 400 kbit/s) + 4× CPU throttle, 360×640 viewport | ~2.4 s (budget 6 s) | Playwright + CDP throttling, e2e test, emulated in the cloud CI machine |

This is an emulation on a server CPU. It is **not** a substitute for physical low-end Android measurements (§42), which have not been done yet.

## Device capability modes

`apps/web/src/lib/capabilities.ts` classifies `low` / `normal` / `high` from `deviceMemory`, `hardwareConcurrency`, Network Information (`effectiveType`, `saveData`) and `prefers-reduced-motion`. Missing signals default to `normal` (we only downgrade on evidence). Users can override in Settings. The mode is applied as `data-perf` / `data-motion` on `<html>`; light mode removes shadows, transitions and sticky positioning.

## Telemetry

The web client reports LCP, FCP, INP, CLS, TTFB and app shell render time to `/v1/telemetry/perf`, aggregated into the `chatme_client_perf_ms` Prometheus histogram by platform, device class and connection. API latency is `chatme_http_request_duration_seconds` by route pattern.
