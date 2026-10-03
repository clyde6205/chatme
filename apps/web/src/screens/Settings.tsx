import type { Me, NotificationSettings, PrivacySettings } from '@chatme/contracts';
import { LOCALE_MANIFEST, SUPPORTED_LOCALES, type Locale } from '@chatme/i18n';
import { useMemo, useState } from 'preact/hooks';
import { useLocation } from 'preact-iso';
import { Button, ErrorNote, Field, Toggle } from '../components/ui';
import type { RouteProps } from '../components/ui';
import { api } from '../lib/api';
import type { PerformanceMode } from '../lib/capabilities';
import { useApp } from '../state';

type PrefPatch = Partial<{
  locale: Locale;
  timezone: string;
  performanceMode: PerformanceMode;
  privacy: Partial<PrivacySettings>;
  notifications: Partial<NotificationSettings>;
}>;

const LEVELS = ['everyone', 'contacts', 'nobody'] as const;
const LEVEL_KEY = { everyone: 'settings.levelEveryone', contacts: 'settings.levelContacts', nobody: 'settings.levelNobody' } as const;
const PERF_KEY = { auto: 'settings.performanceAuto', low: 'settings.performanceLow', normal: 'settings.performanceNormal', high: 'settings.performanceHigh' } as const;

export default function Settings(_props: RouteProps) {
  const { t, me, setMe, caps, changeLocale, changePerfPreference, perfPreference } = useApp();
  const [error, setError] = useState<unknown>(null);
  const timezones = useMemo(() => {
    try {
      return Intl.supportedValuesOf('timeZone');
    } catch {
      return me ? [me.timezone] : ['UTC'];
    }
  }, []);
  if (!me) return null;

  /** Optimistic: show the change immediately, roll back if the server rejects it. */
  async function save(patch: PrefPatch, optimistic: Me) {
    const previous = me!;
    setError(null);
    setMe(optimistic);
    try {
      setMe(await api<Me>('/v1/me/preferences', { method: 'PATCH', body: patch }));
    } catch (err) {
      setMe(previous);
      setError(err);
    }
  }

  const setPrivacy = <K extends keyof PrivacySettings>(k: K, v: PrivacySettings[K]) =>
    save({ privacy: { [k]: v } }, { ...me, privacy: { ...me.privacy, [k]: v } });
  const setNotif = <K extends keyof NotificationSettings>(k: K, v: NotificationSettings[K]) =>
    save({ notifications: { [k]: v } }, { ...me, notifications: { ...me.notifications, [k]: v } });

  return (
    <div class="stack">
      <ErrorNote error={error} />
      <section class="card">
        <h1>{t.t('settings.title')}</h1>
        <Field id="locale" label={t.t('settings.language')} hint={t.t('settings.languageHint')}>
          {(id, hint) => (
            <select id={id} aria-describedby={hint} value={me.locale}
              onChange={(e) => {
                const locale = (e.currentTarget as HTMLSelectElement).value as Locale;
                void changeLocale(locale);
                void save({ locale }, { ...me, locale });
              }}>
              {SUPPORTED_LOCALES.map((l) => (
                <option key={l} value={l} lang={l}>
                  {LOCALE_MANIFEST[l].nativeName}{LOCALE_MANIFEST[l].status === 'draft' ? ` (${t.t('settings.draftLabel')})` : ''}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field id="timezone" label={t.t('settings.timezone')}>
          {(id) => (
            <select id={id} value={me.timezone} dir="ltr"
              onChange={(e) => { const timezone = (e.currentTarget as HTMLSelectElement).value; void save({ timezone }, { ...me, timezone }); }}>
              {timezones.map((z) => <option key={z} value={z}>{z}</option>)}
            </select>
          )}
        </Field>
      </section>

      <section class="card">
        <h2>{t.t('settings.performance')}</h2>
        <p class="muted">{t.t('settings.performanceHint')}</p>
        <div class="segmented" role="radiogroup" aria-label={t.t('settings.performance')}>
          {(['auto', 'low', 'normal', 'high'] as const).map((p) => (
            <label key={p}>
              <input type="radio" name="perf" value={p} checked={perfPreference === p}
                onChange={() => { changePerfPreference(p); void save({ performanceMode: p }, { ...me, performanceMode: p }); }} />
              <span>{t.t(PERF_KEY[p])}</span>
            </label>
          ))}
        </div>
        <p class="muted">{t.t('settings.detected', { mode: t.t(PERF_KEY[caps.deviceClass]) })}</p>
      </section>

      <section class="card">
        <h2>{t.t('settings.privacy')}</h2>
        {(['profileVisibility', 'whoCanMessage', 'whoCanAddToGroups'] as const).map((k) => (
          <Field key={k} id={k} label={t.t(`settings.${k}`)}>
            {(id) => (
              <select id={id} value={me.privacy[k]} onChange={(e) => void setPrivacy(k, (e.currentTarget as HTMLSelectElement).value as (typeof LEVELS)[number])}>
                {LEVELS.map((l) => <option key={l} value={l}>{t.t(LEVEL_KEY[l])}</option>)}
              </select>
            )}
          </Field>
        ))}
        {(['showPresence', 'sendReadReceipts', 'discoverable'] as const).map((k) => (
          <Toggle key={k} id={k} label={t.t(`settings.${k}`)} checked={me.privacy[k]} onChange={(v) => void setPrivacy(k, v)} />
        ))}
      </section>

      <section class="card">
        <h2>{t.t('settings.notifications')}</h2>
        {([
          ['messages', 'notifyMessages'], ['mentions', 'notifyMentions'], ['calls', 'notifyCalls'],
          ['groupActivity', 'notifyGroupActivity'], ['communityActivity', 'notifyCommunityActivity'],
        ] as const).map(([k, label]) => (
          <Toggle key={k} id={`n-${k}`} label={t.t(`settings.${label}`)} checked={me.notifications[k]} onChange={(v) => void setNotif(k, v)} />
        ))}
        <Toggle id="quiet" label={t.t('settings.quietHours')} checked={me.notifications.quietHours.enabled}
          onChange={(enabled) => void setNotif('quietHours', { ...me.notifications.quietHours, enabled })} />
        {me.notifications.quietHours.enabled && (
          <div class="row">
            {(['start', 'end'] as const).map((k) => (
              <Field key={k} id={`quiet-${k}`} label={t.t(k === 'start' ? 'settings.quietFrom' : 'settings.quietTo')}>
                {(id) => (
                  <input id={id} type="time" value={me.notifications.quietHours[k]} required
                    onChange={(e) => {
                      const v = (e.currentTarget as HTMLInputElement).value;
                      if (/^\d\d:\d\d$/.test(v)) void setNotif('quietHours', { ...me.notifications.quietHours, [k]: v });
                    }} />
                )}
              </Field>
            ))}
          </div>
        )}
      </section>

      <DeleteAccount />
    </div>
  );
}

function DeleteAccount() {
  const { t, setMe } = useApp();
  const { route } = useLocation();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function submit(e: Event) {
    e.preventDefault();
    const password = String(new FormData(e.currentTarget as HTMLFormElement).get('password') ?? '');
    setBusy(true);
    setError(null);
    try {
      await api('/v1/me/delete', { method: 'POST', body: { password } });
      setMe(null);
      route('/join', true);
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  return (
    <section class="card card--danger">
      <h2>{t.t('settings.deleteAccount')}</h2>
      <p>{t.t('settings.deleteWarning')}</p>
      <form onSubmit={submit}>
        <Field id="delete-password" label={t.t('settings.confirmPassword')}>
          {(id) => <input id={id} name="password" type="password" autoComplete="current-password" required maxLength={128} />}
        </Field>
        <ErrorNote error={error} />
        <Button type="submit" variant="danger" busy={busy}>{t.t('settings.deleteConfirm')}</Button>
      </form>
    </section>
  );
}
