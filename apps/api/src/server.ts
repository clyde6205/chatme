import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createDatabase } from './db/database.js';
import { pruneExpiredSessions } from './modules/auth/service.js';

const config = loadConfig();
const { db, pool } = createDatabase({ url: config.databaseUrl, poolMax: config.databasePoolMax });
const app = await buildApp({ config, db, pool });

const prune = () =>
  pruneExpiredSessions(db)
    .then((n) => n && app.log.info({ pruned: n }, 'expired sessions pruned'))
    .catch((err) => app.log.warn({ err }, 'session prune failed'));
const pruneTimer = setInterval(prune, 60 * 60_000);
pruneTimer.unref();

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, 'shutting down');
  clearInterval(pruneTimer);
  const force = setTimeout(() => process.exit(1), 15_000);
  force.unref();
  try {
    await app.close(); // stops accepting, drains in-flight requests
    await db.destroy();
  } finally {
    process.exit(0);
  }
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

// The API starts even when the database is down; /health/ready reports it and requests get 503.
await app.listen({ host: config.host, port: config.port });
void prune();
