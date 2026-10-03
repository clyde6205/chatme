import type { Session } from '@chatme/contracts';
import { useEffect, useState } from 'preact/hooks';
import { useLocation } from 'preact-iso';
import { Button, ErrorNote } from '../components/ui';
import type { RouteProps } from '../components/ui';
import { api } from '../lib/api';
import { useApp } from '../state';

export default function Devices(_props: RouteProps) {
  const { t, setMe } = useApp();
  const { route } = useLocation();
  const [sessions, setSessions] = useState<Session[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = () =>
    api<{ sessions: Session[] }>('/v1/sessions')
      .then((r) => setSessions(r.sessions))
      .catch(setError);
  useEffect(() => void load(), []);

  async function revoke(s: Session) {
    setBusy(s.id);
    setError(null);
    try {
      if (s.current) {
        await api('/v1/auth/logout', { method: 'POST' });
        setMe(null);
        route('/signin', true);
        return;
      }
      await api(`/v1/sessions/${s.id}`, { method: 'DELETE' });
      setSessions((list) => list?.filter((x) => x.id !== s.id) ?? null);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(null);
    }
  }

  async function revokeOthers() {
    setBusy('others');
    setError(null);
    try {
      const { revoked } = await api<{ revoked: number }>('/v1/sessions/revoke-others', { method: 'POST' });
      setNotice(t.t('devices.signedOutOthers', { count: revoked }));
      await load();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(null);
    }
  }

  return (
    <section class="card">
      <h1>{t.t('devices.title')}</h1>
      <ErrorNote error={error} />
      {notice && <p class="note note--ok" role="status">{notice}</p>}
      {sessions === null && !error && <p class="muted" aria-busy="true">{t.t('app.loading')}</p>}
      {sessions && (
        <>
          <p class="muted">{t.t('devices.count', { count: sessions.length })}</p>
          <ul class="list">
            {sessions.map((s) => (
              <li key={s.id} class="list-item">
                <div>
                  <strong>{s.device.name ?? t.t('devices.unknownDevice')}</strong>
                  {s.current && <span class="pill">{t.t('devices.thisDevice')}</span>}
                  <div class="muted small">
                    {t.t('devices.lastActive', { time: t.formatRelative(s.lastSeenAt) })} · {t.t('devices.signedIn', { date: t.formatDate(s.createdAt, { dateStyle: 'medium' }) })}
                  </div>
                </div>
                <Button variant="ghost" busy={busy === s.id} onClick={() => void revoke(s)}>{t.t('devices.signOutDevice')}</Button>
              </li>
            ))}
          </ul>
          {sessions.length > 1 && (
            <Button variant="danger" busy={busy === 'others'} onClick={() => void revokeOthers()}>{t.t('devices.signOutOthers')}</Button>
          )}
        </>
      )}
    </section>
  );
}
