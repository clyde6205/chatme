import { sql } from 'kysely';
import type { PresenceState } from '@chatme/contracts/realtime';
import type { DB } from '../../db/database.js';
import type { Bus } from './bus.js';

/**
 * Presence across instances.
 *
 * Each instance owns rows in realtime_presence for users connected to it and
 * keeps its realtime_instances heartbeat fresh. A user is online when any of
 * their rows belongs to a live instance. When an instance dies without
 * cleaning up, its heartbeat goes stale; the survivors' sweeper deletes it and
 * announces users who are now offline. Offline announcements wait a short
 * grace period so a reconnect after a network blip does not flap.
 */
export interface PresenceOptions {
  instanceId: string;
  region: string;
  heartbeatMs?: number;
  /** An instance whose heartbeat is older than this is considered dead. */
  staleMs?: number;
  graceMs?: number;
}

type Log = { info: (o: object, m: string) => void; warn: (o: object, m: string) => void };

export class Presence {
  private readonly local = new Map<string, number>();
  private readonly pendingOffline = new Map<string, NodeJS.Timeout>();
  private heartbeatTimer: NodeJS.Timeout | undefined;
  private sweepTimer: NodeJS.Timeout | undefined;
  private readonly o: Required<PresenceOptions>;
  private started = false;

  constructor(
    private readonly db: DB,
    private readonly bus: Bus,
    private readonly log: Log,
    opts: PresenceOptions,
  ) {
    this.o = { heartbeatMs: 15_000, staleMs: 45_000, graceMs: 10_000, ...opts };
  }

  get localUsers() {
    return this.local.size;
  }

  async start() {
    // A restarted machine reuses its id: discard whatever the previous process left behind.
    await this.db.deleteFrom('realtime_instances').where('id', '=', this.o.instanceId).execute();
    await this.db.insertInto('realtime_instances').values({ id: this.o.instanceId, region: this.o.region }).execute();
    this.started = true;
    this.heartbeatTimer = setInterval(() => void this.heartbeat(), this.o.heartbeatMs);
    this.heartbeatTimer.unref();
    // Jitter so instances do not all sweep at once.
    this.sweepTimer = setInterval(() => void this.sweep().catch((err) => this.log.warn({ err }, 'presence sweep failed')), this.o.staleMs + Math.floor(Math.random() * 5_000));
    this.sweepTimer.unref();
  }

  private async heartbeat() {
    try {
      const res = await this.db
        .updateTable('realtime_instances')
        .set({ heartbeat_at: new Date() })
        .where('id', '=', this.o.instanceId)
        .executeTakeFirst();
      if (Number(res.numUpdatedRows) === 0) {
        // Another instance swept us (we were partitioned from the database for too long).
        // Re-register and re-assert every local user so presence converges again.
        await this.db.insertInto('realtime_instances').values({ id: this.o.instanceId, region: this.o.region }).onConflict((oc) => oc.doNothing()).execute();
        for (const [userId, n] of this.local) await this.writeRow(userId, n);
        this.log.warn({ instanceId: this.o.instanceId }, 'presence instance re-registered after being swept');
      }
    } catch (err) {
      this.log.warn({ err }, 'presence heartbeat failed');
    }
  }

  private liveCutoff() {
    return new Date(Date.now() - this.o.staleMs);
  }

  private async writeRow(userId: string, connections: number) {
    await this.db
      .insertInto('realtime_presence')
      .values({ instance_id: this.o.instanceId, user_id: userId, connections })
      .onConflict((oc) => oc.columns(['instance_id', 'user_id']).doUpdateSet({ connections }))
      .execute();
  }

  /** Connections the user holds across all live instances. */
  async connectionCount(userId: string): Promise<number> {
    const row = await this.db
      .selectFrom('realtime_presence as p')
      .innerJoin('realtime_instances as i', 'i.id', 'p.instance_id')
      .select(sql<string>`coalesce(sum(p.connections), 0)`.as('n'))
      .where('p.user_id', '=', userId)
      .where('i.heartbeat_at', '>', this.liveCutoff())
      .executeTakeFirstOrThrow();
    return Number(row.n);
  }

  private async isOnlineElsewhere(userId: string): Promise<boolean> {
    const row = await this.db
      .selectFrom('realtime_presence as p')
      .innerJoin('realtime_instances as i', 'i.id', 'p.instance_id')
      .select('p.user_id')
      .where('p.user_id', '=', userId)
      .where('p.instance_id', '!=', this.o.instanceId)
      .where('i.heartbeat_at', '>', this.liveCutoff())
      .limit(1)
      .executeTakeFirst();
    return row !== undefined;
  }

  private readonly chains = new Map<string, Promise<void>>();

  /** Run presence changes for one user strictly in order; a socket can close while its open is still being recorded. */
  private serial(userId: string, fn: () => Promise<void>): Promise<void> {
    const prev = this.chains.get(userId) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(fn);
    const tracked = next.finally(() => {
      if (this.chains.get(userId) === tracked) this.chains.delete(userId);
    });
    this.chains.set(userId, tracked);
    return next;
  }

  connect(userId: string): Promise<void> {
    return this.serial(userId, () => this.doConnect(userId));
  }

  disconnect(userId: string): Promise<void> {
    return this.serial(userId, () => this.doDisconnect(userId));
  }

  private async doConnect(userId: string): Promise<void> {
    const n = (this.local.get(userId) ?? 0) + 1;
    this.local.set(userId, n);
    const pending = this.pendingOffline.get(userId);
    if (pending) {
      // Reconnected within the grace period: watchers never saw them leave.
      clearTimeout(pending);
      this.pendingOffline.delete(userId);
      await this.writeRow(userId, n);
      return;
    }
    if (n > 1) {
      await this.writeRow(userId, n);
      return;
    }
    const elsewhere = await this.isOnlineElsewhere(userId);
    await this.writeRow(userId, n);
    if (elsewhere) return;
    // Disconnected from some instance within the grace period: that instance has not
    // announced offline yet and will see this connection when its timer fires, so
    // watchers never saw the user leave. Covers reconnects that land on a different machine.
    const row = await this.db.selectFrom('users').select('last_seen_at').where('id', '=', userId).executeTakeFirst();
    if (row?.last_seen_at && Date.now() - new Date(row.last_seen_at).getTime() < this.o.graceMs) return;
    await this.announce(userId, true, null);
  }

  private async doDisconnect(userId: string): Promise<void> {
    const n = (this.local.get(userId) ?? 1) - 1;
    if (n > 0) {
      this.local.set(userId, n);
      await this.writeRow(userId, n);
      return;
    }
    this.local.delete(userId);
    const now = new Date();
    await this.db.deleteFrom('realtime_presence').where('instance_id', '=', this.o.instanceId).where('user_id', '=', userId).execute();
    await this.db.updateTable('users').set({ last_seen_at: now }).where('id', '=', userId).execute();
    const timer = setTimeout(() => {
      this.pendingOffline.delete(userId);
      if (this.local.has(userId)) return;
      void this.isOnlineElsewhere(userId)
        .then((elsewhere) => (elsewhere ? undefined : this.announce(userId, false, now.toISOString())))
        .catch((err) => this.log.warn({ err }, 'presence offline check failed'));
    }, this.o.graceMs);
    timer.unref();
    this.pendingOffline.set(userId, timer);
  }

  /** Announce a change to watchers, unless the user hides their presence. */
  async announce(userId: string, online: boolean, lastSeenAt: string | null, force = false): Promise<void> {
    if (!force && !(await this.visible(userId))) return;
    await this.bus.publish({ k: 'pr', u: userId, on: online, at: lastSeenAt });
  }

  private async visible(userId: string): Promise<boolean> {
    const row = await this.db
      .selectFrom('user_preferences')
      .select(sql<boolean>`coalesce((privacy->>'showPresence')::boolean, true)`.as('show'))
      .where('user_id', '=', userId)
      .executeTakeFirst();
    return row?.show ?? false;
  }

  /** Current presence for up to PRESENCE_SUB_MAX users, honouring each user's showPresence setting. */
  async status(userIds: string[]): Promise<PresenceState[]> {
    if (!userIds.length) return [];
    const rows = await this.db
      .selectFrom('users as u')
      .innerJoin('user_preferences as p', 'p.user_id', 'u.id')
      .select([
        'u.id',
        'u.last_seen_at',
        sql<boolean>`coalesce((p.privacy->>'showPresence')::boolean, true)`.as('show'),
        sql<boolean>`exists (
          select 1 from realtime_presence rp join realtime_instances ri on ri.id = rp.instance_id
          where rp.user_id = u.id and ri.heartbeat_at > ${this.liveCutoff()}
        )`.as('online'),
      ])
      .where('u.id', 'in', userIds)
      .execute();
    const byId = new Map(rows.map((r) => [r.id, r]));
    // Unknown and hidden users look the same: offline, never seen. Do not reveal which ids exist.
    return userIds.map((id) => {
      const r = byId.get(id);
      if (!r || !r.show) return { id, online: false, lastSeenAt: null };
      return { id, online: r.online, lastSeenAt: r.last_seen_at ? new Date(r.last_seen_at).toISOString() : null };
    });
  }

  /** Remove instances that stopped heart-beating and announce users who went offline with them. */
  async sweep(): Promise<number> {
    const cutoff = this.liveCutoff();
    const affected = await this.db.transaction().execute(async (trx) => {
      const dead = await trx
        .selectFrom('realtime_instances')
        .select('id')
        .where('heartbeat_at', '<', cutoff)
        .where('id', '!=', this.o.instanceId)
        .forUpdate()
        .skipLocked()
        .execute();
      if (!dead.length) return [];
      const ids = dead.map((d) => d.id);
      const users = await trx.selectFrom('realtime_presence').select('user_id').distinct().where('instance_id', 'in', ids).execute();
      await trx.deleteFrom('realtime_instances').where('id', 'in', ids).execute();
      this.log.warn({ instances: ids, users: users.length }, 'swept dead realtime instances');
      return users.map((u) => u.user_id);
    });
    for (const userId of affected) {
      if (this.local.has(userId) || (await this.isOnlineElsewhere(userId))) continue;
      const row = await this.db.selectFrom('users').select('last_seen_at').where('id', '=', userId).executeTakeFirst();
      await this.announce(userId, false, row?.last_seen_at ? new Date(row.last_seen_at).toISOString() : null);
    }
    return affected.length;
  }

  /** Graceful stop: remove this instance and announce users who are not connected anywhere else. */
  async stop(): Promise<void> {
    await Promise.allSettled([...this.chains.values()]);
    clearInterval(this.heartbeatTimer);
    clearInterval(this.sweepTimer);
    for (const t of this.pendingOffline.values()) clearTimeout(t);
    if (!this.started) return;
    this.started = false;
    const users = [...this.local.keys(), ...this.pendingOffline.keys()];
    this.pendingOffline.clear();
    this.local.clear();
    const now = new Date();
    if (users.length) await this.db.updateTable('users').set({ last_seen_at: now }).where('id', 'in', users).execute();
    await this.db.deleteFrom('realtime_instances').where('id', '=', this.o.instanceId).execute();
    for (const userId of users) {
      if (!(await this.isOnlineElsewhere(userId))) await this.announce(userId, false, now.toISOString());
    }
  }
}
