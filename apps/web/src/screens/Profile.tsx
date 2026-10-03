import type { Me } from '@chatme/contracts';
import { useState } from 'preact/hooks';
import { Button, ErrorNote, Field, invalidFields } from '../components/ui';
import type { RouteProps } from '../components/ui';
import { api } from '../lib/api';
import { useApp } from '../state';

export default function Profile(_props: RouteProps) {
  const { t, me, setMe } = useApp();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [saved, setSaved] = useState(false);
  if (!me) return null;
  const bad = invalidFields(error);

  async function submit(e: Event) {
    e.preventDefault();
    const form = new FormData(e.currentTarget as HTMLFormElement);
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const next = await api<Me>('/v1/me/profile', {
        method: 'PATCH',
        body: { displayName: form.get('displayName'), username: form.get('username'), bio: String(form.get('bio') ?? '') || null },
      });
      setMe(next);
      setSaved(true);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section class="card">
      <h1>{t.t('profile.title')}</h1>
      <p class="muted">{t.t('profile.memberSince', { date: t.formatDate(me.createdAt, { dateStyle: 'long' }) })}</p>
      <form onSubmit={submit}>
        <Field id="displayName" label={t.t('auth.displayName')} error={bad.has('displayName')}>
          {(id) => <input id={id} name="displayName" defaultValue={me.displayName} required maxLength={64} aria-invalid={bad.has('displayName')} />}
        </Field>
        <Field id="username" label={t.t('auth.username')} hint={t.t('auth.usernameHint')} error={bad.has('username')}>
          {(id, hint) => (
            <input id={id} name="username" defaultValue={me.username} required minLength={3} maxLength={30} pattern="[A-Za-z][A-Za-z0-9_]*"
              autoCapitalize="none" spellcheck={false} dir="ltr" aria-describedby={hint} aria-invalid={bad.has('username')} />
          )}
        </Field>
        <Field id="bio" label={t.t('profile.bio')} hint={t.t('profile.bioHint', { max: 280 })} error={bad.has('bio')}>
          {(id, hint) => <textarea id={id} name="bio" defaultValue={me.bio ?? ''} maxLength={280} rows={3} aria-describedby={hint} />}
        </Field>
        <ErrorNote error={error} />
        {saved && <p class="note note--ok" role="status">{t.t('profile.saved')}</p>}
        <Button type="submit" busy={busy}>{t.t('profile.save')}</Button>
      </form>
    </section>
  );
}
