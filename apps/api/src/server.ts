import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createDatabase } from './db/database.js';
import { pruneExpiredSessions } from './modules/auth/service.js';
import { pruneVerificationTokens } from './modules/auth/recovery.js';
import { pruneEmailOutbox } from './modules/email/outbox.js';
import { pruneUserEvents } from './modules/realtime/events.js';

const config = loadConfig();
const { db, pool } = createDatabase({
  url: config.databaseUrl,
  poolMax: config.databasePoolMax,
  ssl: config.databaseSsl,
  caCert: config.databaseCaCert,
});
const app = await buildApp({ config, db, pool });

// Housekeeping. Every instance runs it; the deletes are idempotent and cheap.
const housekeeping = async () => {
  const jobs = { sessions: pruneExpiredSessions, tokens: pruneVerificationTokens, outbox: pruneEmailOutbox, events: pruneUserEvents };
  for (const [name, job] of Object.entries(jobs)) {
    try {
      const n = await job(db);
      if (n) app.log.info({ job: name, pruned: n }, 'housekeeping');
    } catch (err) {
      app.log.warn({ err, job: name }, 'housekeeping failed');
    }
  }
};
const housekeepingTimer = setInterval(() => void housekeeping(), 60 * 60_000);
housekeepingTimer.unref();

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal, connections: app.runtime.gateway.size }, 'shutting down');
  clearInterval(housekeepingTimer);
  // Must finish within the platform's kill timeout (fly.toml kill_timeout = 30s).
  const force = setTimeout(() => {
    app.log.error({}, 'shutdown timed out; exiting');
    process.exit(1);
  }, 25_000);
  force.unref();
  try {
    // 1. Readiness flips to 503 and sockets close with 1012, spread out so clients
    //    reconnect to other machines gradually.
    await app.runtime.drain();
    // 2. Stop accepting HTTP and finish in-flight requests.
    await app.close();
    // 3. Stop workers (in-flight emails finish or are retried by another instance), presence, bus.
    await app.runtime.stop();
    await db.destroy();
    app.log.info({}, 'shutdown complete');
  } catch (err) {
    app.log.error({ err }, 'shutdown failed');
  } finally {
    process.exit(0);
  }
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

// The API starts even when the database is down: /health/ready reports it, requests get 503,
// and the realtime bus keeps retrying in the background.
try {
  await app.runtime.start();
} catch (err) {
  app.log.error({ err }, 'runtime start failed; realtime presence unavailable until restart');
}
await app.listen({ host: config.host, port: config.port });
app.log.info({ region: config.region, instance: config.instanceId }, 'listening');
void housekeeping();
