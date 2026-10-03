import type { Registry } from 'prom-client';
import { Counter } from 'prom-client';
import type { Config } from './config.js';
import { sslOptions, type DB } from './db/database.js';
import { BackgroundTasks } from './lib/background.js';
import { EmailOutboxWorker } from './modules/email/outbox.js';
import { LogEmailProvider, MemoryEmailProvider, type EmailProvider } from './modules/email/provider.js';
import { ResendEmailProvider } from './modules/email/resend.js';
import { PostgresBus, type Bus } from './modules/realtime/bus.js';
import { RealtimeGateway, type GatewayOptions } from './modules/realtime/gateway.js';
import { Presence, type PresenceOptions } from './modules/realtime/presence.js';

type Log = {
  info: (o: object, m: string) => void;
  warn: (o: object, m: string) => void;
  error: (o: object, m: string) => void;
  debug: (o: object, m: string) => void;
};

/**
 * Long-lived services owned by one API process: email outbox, realtime bus,
 * presence and the WebSocket gateway. Created with the app; started and
 * stopped explicitly so the server controls ordering on boot and shutdown.
 */
export interface Runtime {
  email: EmailProvider;
  outbox: EmailOutboxWorker;
  background: BackgroundTasks;
  bus: Bus;
  presence: Presence;
  gateway: RealtimeGateway;
  start(opts?: { workers?: boolean }): Promise<void>;
  /** Stop accepting realtime work and close sockets gracefully (deploy / scale-in). */
  drain(): Promise<void>;
  stop(): Promise<void>;
}

export interface RuntimeOverrides {
  email?: EmailProvider;
  bus?: Bus;
  gateway?: Partial<GatewayOptions>;
  presence?: Partial<PresenceOptions>;
}

export function createEmailProvider(config: Config, log: Log): EmailProvider {
  switch (config.email.provider) {
    case 'resend':
      return new ResendEmailProvider({ apiKey: config.email.resendApiKey!, baseUrl: config.email.resendApiBase });
    case 'memory':
      return new MemoryEmailProvider();
    case 'log':
      return new LogEmailProvider((o, m) => log.info(o, m));
  }
}

export function createRuntime(deps: { config: Config; db: DB; log: Log; registry: Registry; overrides?: RuntimeOverrides }): Runtime {
  const { config, db, log, registry, overrides = {} } = deps;
  const email = overrides.email ?? createEmailProvider(config, log);

  const emailResults = new Counter({
    name: 'chatme_email_outbox_results_total',
    help: 'Email delivery attempts by outcome and template',
    labelNames: ['status', 'template'] as const,
    registers: [registry],
  });
  const outbox = new EmailOutboxWorker(
    db,
    email,
    log,
    { from: config.email.from, replyTo: config.email.replyTo },
    { onResult: (status, template) => emailResults.inc({ status, template }) },
  );
  const background = new BackgroundTasks((err, label) => log.error({ err, task: label }, 'background task failed'));

  const bus =
    overrides.bus ??
    new PostgresBus(db, {
      url: config.realtimeDatabaseUrl,
      ssl: sslOptions(config.databaseSsl, config.databaseCaCert),
      log,
    });
  const presence = new Presence(db, bus, log, { instanceId: config.instanceId, region: config.region, ...overrides.presence });
  const gateway = new RealtimeGateway(db, bus, presence, log, { instanceId: config.instanceId, region: config.region, ...overrides.gateway }, registry);

  let started = false;
  let workersStarted = false;
  return {
    email,
    outbox,
    background,
    bus,
    presence,
    gateway,
    async start(opts = {}) {
      if (started) return;
      started = true;
      // The bus reconnects on its own; the API serves HTTP even while it is down.
      await bus.start();
      await presence.start();
      gateway.start();
      if (opts.workers ?? config.workersEnabled) {
        outbox.start();
        workersStarted = true;
      }
    },
    async drain() {
      await gateway.drain();
    },
    async stop() {
      gateway.stop();
      if (workersStarted) await outbox.stop();
      await background.idle();
      if (started) await presence.stop().catch((err) => log.warn({ err }, 'presence stop failed'));
      await bus.stop();
      started = false;
    },
  };
}
