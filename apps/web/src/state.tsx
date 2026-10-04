import type { Me } from '@chatme/contracts';
import type { Locale, Translator } from '@chatme/i18n';
import { createContext, type ComponentChildren } from 'preact';
import { useCallback, useContext, useMemo, useState } from 'preact/hooks';
import { applyMode, resolveMode, type Capabilities, type DeviceClass, type PerformanceMode } from './lib/capabilities';
import { applyDocumentLocale, loadTranslator } from './lib/i18n';
import { KEYS, storage } from './lib/storage';

interface AppState {
  t: Translator;
  me: Me | null;
  caps: Capabilities;
  mode: DeviceClass;
  perfPreference: PerformanceMode;
  setMe: (me: Me | null) => void;
  changeLocale: (locale: Locale) => Promise<void>;
  changePerfPreference: (pref: PerformanceMode) => void;
}

const Ctx = createContext<AppState | null>(null);

export function useApp(): AppState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useApp outside provider');
  return v;
}

export function AppProvider(props: { initial: { t: Translator; me: Me | null; caps: Capabilities }; children: ComponentChildren }) {
  const { caps } = props.initial;
  const [t, setT] = useState(props.initial.t);
  const [me, setMeState] = useState(props.initial.me);
  const [perfPreference, setPerf] = useState<PerformanceMode>(
    () => props.initial.me?.performanceMode ?? storage.get<PerformanceMode>(KEYS.perfMode) ?? 'auto',
  );
  const mode = resolveMode(perfPreference, caps);

  const changeLocale = useCallback(async (locale: Locale) => {
    const next = await loadTranslator(locale, me?.timezone);
    storage.set(KEYS.locale, locale);
    applyDocumentLocale(next);
    setT(next);
  }, [me?.timezone]);

  const changePerfPreference = useCallback((pref: PerformanceMode) => {
    storage.set(KEYS.perfMode, pref);
    setPerf(pref);
    applyMode(resolveMode(pref, caps), caps);
  }, [caps]);

  const setMe = useCallback((next: Me | null) => {
    if (next) {
      storage.set(KEYS.me, next);
      if (next.performanceMode !== perfPreference) changePerfPreference(next.performanceMode);
      if (next.locale !== t.locale || next.timezone !== me?.timezone) {
        void loadTranslator(next.locale, next.timezone).then((tr) => {
          applyDocumentLocale(tr);
          setT(tr);
        });
      }
    } else {
      storage.remove(KEYS.me);
    }
    setMeState(next);
  }, [perfPreference, changePerfPreference, t.locale, me?.timezone]);

  const value = useMemo(
    () => ({ t, me, caps, mode, perfPreference, setMe, changeLocale, changePerfPreference }),
    [t, me, caps, mode, perfPreference, setMe, changeLocale, changePerfPreference],
  );
  return <Ctx.Provider value={value}>{props.children}</Ctx.Provider>;
}
