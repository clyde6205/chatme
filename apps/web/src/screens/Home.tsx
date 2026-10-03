import { useState } from 'preact/hooks';
import { useLocation } from 'preact-iso';
import { Button, ErrorNote } from '../components/ui';
import type { RouteProps } from '../components/ui';
import { api, ApiError } from '../lib/api';
import { useApp } from '../state';

export default function Home(_props: RouteProps) {
  const { t, me, setMe } = useApp();
  const { route } = useLocation();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  if (!me) return null;

  async function signOut() {
    setBusy(true);
    try {
      await api('/v1/auth/logout', { method: 'POST' });
    } catch (err) {
      // An already-invalid session is signed out as far as the user is concerned.
      if (!(err instanceof ApiError && err.code === 'unauthenticated')) {
        setError(err);
        setBusy(false);
        return;
      }
    }
    setMe(null);
    route('/signin', true);
  }

  return (
    <section class="card">
      {!me.emailVerified && <VerifyBanner email={me.email} />}
      <h1>{t.t('home.greeting', { name: me.displayName })}</h1>
      <p class="muted" dir="ltr">@{me.username}</p>
      <p>{t.t('home.intro')}</p>
      <div class="actions">
        <a class="btn btn--primary" href="/profile">{t.t('home.editProfile')}</a>
        <a class="btn btn--ghost" href="/settings">{t.t('home.openSettings')}</a>
        <a class="btn btn--ghost" href="/devices">{t.t('home.manageDevices')}</a>
      </div>
      <ErrorNote error={error} />
      <Button variant="ghost" busy={busy} onClick={() => void signOut()}>{t.t('auth.signOut')}</Button>
    </section>
  );
}

function VerifyBanner(props: { email: string }) {
  const { t } = useApp();
  const [state, setState] = useState<'idle' | 'busy' | 'sent'>('idle');
  const [error, setError] = useState<unknown>(null);

  async function resend() {
    setState('busy');
    setError(null);
    try {
      await api('/v1/auth/verify-email/resend', { method: 'POST' });
      setState('sent');
    } catch (err) {
      setError(err);
      setState('idle');
    }
  }

  return (
    <div class="note note--info" role="status">
      <p>{t.t('home.verifyBanner', { email: props.email })}</p>
      {state === 'sent' ? (
        <p>{t.t('home.resent')}</p>
      ) : (
        <Button variant="ghost" busy={state === 'busy'} onClick={() => void resend()}>{t.t('home.resend')}</Button>
      )}
      <ErrorNote error={error} />
    </div>
  );
}
