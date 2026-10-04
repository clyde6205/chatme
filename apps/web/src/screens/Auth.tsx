import type { Me } from '@chatme/contracts';
import { useState } from 'preact/hooks';
import { useLocation } from 'preact-iso';
import { Button, ErrorNote, Field, invalidFields, type RouteProps } from '../components/ui';
import { api } from '../lib/api';
import { deviceLabel } from '../lib/device';
import { useApp } from '../state';

export default function Auth(props: RouteProps & { mode: 'signin' | 'join' }) {
  const { t, setMe } = useApp();
  const { route } = useLocation();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const join = props.mode === 'join';
  const bad = invalidFields(error);

  async function submit(e: Event) {
    e.preventDefault();
    if (busy) return;
    const form = new FormData(e.currentTarget as HTMLFormElement);
    const device = { platform: 'web' as const, name: deviceLabel(), appVersion: '0.1.0' };
    setBusy(true);
    setError(null);
    try {
      const body = join
        ? {
            email: form.get('email'),
            password: form.get('password'),
            username: form.get('username'),
            displayName: form.get('displayName'),
            locale: t.locale,
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            device,
          }
        : { email: form.get('email'), password: form.get('password'), device };
      const res = await api<{ user: Me }>(join ? '/v1/auth/register' : '/v1/auth/login', { method: 'POST', body });
      setMe(res.user);
      route('/', true);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section class="card auth">
      <h1>{join ? t.t('auth.joinTitle') : t.t('auth.welcomeBack')}</h1>
      <p class="muted">{t.t('app.tagline')}</p>
      <form onSubmit={submit} noValidate={false}>
        <Field id="email" label={t.t('auth.email')} error={bad.has('email')}>
          {(id) => <input id={id} name="email" type="email" autoComplete="email" inputMode="email" required maxLength={254} aria-invalid={bad.has('email')} />}
        </Field>
        {join && (
          <>
            <Field id="displayName" label={t.t('auth.displayName')} error={bad.has('displayName')}>
              {(id) => <input id={id} name="displayName" autoComplete="name" required maxLength={64} aria-invalid={bad.has('displayName')} />}
            </Field>
            <Field id="username" label={t.t('auth.username')} hint={t.t('auth.usernameHint')} error={bad.has('username')}>
              {(id, hint) => (
                <input id={id} name="username" autoComplete="username" required minLength={3} maxLength={30} pattern="[A-Za-z][A-Za-z0-9_]*"
                  autoCapitalize="none" spellcheck={false} dir="ltr" aria-describedby={hint} aria-invalid={bad.has('username')} />
              )}
            </Field>
          </>
        )}
        <Field id="password" label={t.t('auth.password')} hint={join ? t.t('auth.passwordHint', { min: 10 }) : undefined} error={bad.has('password')}>
          {(id, hint) => (
            <input id={id} name="password" type="password" autoComplete={join ? 'new-password' : 'current-password'} required
              minLength={join ? 10 : 1} maxLength={128} aria-describedby={hint} aria-invalid={bad.has('password')} />
          )}
        </Field>
        {!join && <p class="small"><a href="/forgot-password">{t.t('auth.forgotPassword')}</a></p>}
        <ErrorNote error={error} />
        <Button type="submit" busy={busy}>
          {busy ? t.t('auth.working') : join ? t.t('auth.createAccount') : t.t('auth.signIn')}
        </Button>
      </form>
      <p class="switch">
        {join ? t.t('auth.haveAccount') : t.t('auth.noAccount')}{' '}
        <a href={join ? '/signin' : '/join'}>{join ? t.t('auth.signIn') : t.t('auth.createAccount')}</a>
      </p>
    </section>
  );
}
