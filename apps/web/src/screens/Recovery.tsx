import type { Me } from '@chatme/contracts';
import { useEffect, useState } from 'preact/hooks';
import { useLocation } from 'preact-iso';
import { Button, ErrorNote, Field, invalidFields, type RouteProps } from '../components/ui';
import { api, ApiError } from '../lib/api';
import { useApp } from '../state';

/**
 * Reads the one-time token from the URL fragment and removes it from the
 * address bar and history, so it is not left behind in the tab or shared by
 * copying the URL. Fragments are never sent to servers.
 */
function useFragmentToken(): string | null {
  const [token] = useState(() => {
    const m = /(?:^#|&)token=([A-Za-z0-9_-]{43})(?:&|$)/.exec(location.hash);
    return m ? m[1]! : null;
  });
  useEffect(() => {
    if (location.hash) history.replaceState(history.state, '', location.pathname + location.search);
  }, []);
  return token;
}

export default function Recovery(props: RouteProps & { mode: 'forgot' | 'reset' | 'verify' }) {
  if (props.mode === 'forgot') return <Forgot />;
  if (props.mode === 'reset') return <Reset />;
  return <Verify />;
}

function Forgot() {
  const { t } = useApp();
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function submit(e: Event) {
    e.preventDefault();
    const email = String(new FormData(e.currentTarget as HTMLFormElement).get('email') ?? '');
    setBusy(true);
    setError(null);
    try {
      await api('/v1/auth/password/forgot', { method: 'POST', body: { email } });
      setSent(true);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section class="card auth">
      <h1>{t.t('auth.forgotTitle')}</h1>
      {sent ? (
        <p class="note note--ok" role="status">{t.t('auth.linkSent')}</p>
      ) : (
        <form onSubmit={submit}>
          <p class="muted">{t.t('auth.forgotIntro')}</p>
          <Field id="email" label={t.t('auth.email')} error={invalidFields(error).has('email')}>
            {(id) => <input id={id} name="email" type="email" autoComplete="email" inputMode="email" required maxLength={254} />}
          </Field>
          <ErrorNote error={error} />
          <Button type="submit" busy={busy}>{busy ? t.t('auth.working') : t.t('auth.sendLink')}</Button>
        </form>
      )}
      <p class="switch"><a href="/signin">{t.t('auth.signIn')}</a></p>
    </section>
  );
}

function Reset() {
  const { t, setMe } = useApp();
  const token = useFragmentToken();
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<unknown>(token ? null : new ApiError('invalid_token', 400));

  async function submit(e: Event) {
    e.preventDefault();
    if (!token) return;
    const password = String(new FormData(e.currentTarget as HTMLFormElement).get('password') ?? '');
    setBusy(true);
    setError(null);
    try {
      await api('/v1/auth/password/reset', { method: 'POST', body: { token, password } });
      // Every session was revoked server-side, including this browser's.
      setMe(null);
      setDone(true);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section class="card auth">
      <h1>{t.t('auth.forgotTitle')}</h1>
      {done ? (
        <p class="note note--ok" role="status">{t.t('auth.passwordUpdated')}</p>
      ) : token ? (
        <form onSubmit={submit}>
          <Field id="password" label={t.t('auth.newPassword')} hint={t.t('auth.passwordHint', { min: 10 })} error={invalidFields(error).has('password')}>
            {(id, hint) => <input id={id} name="password" type="password" autoComplete="new-password" required minLength={10} maxLength={128} aria-describedby={hint} />}
          </Field>
          <ErrorNote error={error} />
          <Button type="submit" busy={busy}>{busy ? t.t('auth.working') : t.t('auth.setPassword')}</Button>
        </form>
      ) : (
        <ErrorNote error={error} />
      )}
      <p class="switch">
        <a href={done ? '/signin' : '/forgot-password'}>{done ? t.t('auth.signIn') : t.t('auth.sendLink')}</a>
      </p>
    </section>
  );
}

function Verify() {
  const { t, me, setMe } = useApp();
  const { route } = useLocation();
  const token = useFragmentToken();
  const [state, setState] = useState<'working' | 'done' | 'failed'>(token ? 'working' : 'failed');
  const [error, setError] = useState<unknown>(token ? null : new ApiError('invalid_token', 400));

  useEffect(() => {
    if (!token) return;
    api('/v1/auth/verify-email', { method: 'POST', body: { token } })
      .then(async () => {
        setState('done');
        if (me) setMe(await api<Me>('/v1/me').catch(() => ({ ...me, emailVerified: true })));
      })
      .catch((err) => {
        setError(err);
        setState('failed');
      });
  }, []);

  return (
    <section class="card auth">
      <h1>{t.t('auth.verifyTitle')}</h1>
      {state === 'working' && <p class="muted" role="status">{t.t('auth.verifying')}</p>}
      {state === 'done' && <p class="note note--ok" role="status">{t.t('auth.verified')}</p>}
      {state === 'failed' && <ErrorNote error={error} />}
      <div class="actions">
        <Button onClick={() => route(me ? '/' : '/signin', true)}>{me ? t.t('nav.home') : t.t('auth.signIn')}</Button>
      </div>
    </section>
  );
}
