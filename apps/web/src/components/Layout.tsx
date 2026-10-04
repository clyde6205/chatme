import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { useLocation } from 'preact-iso';
import { useOnline } from '../lib/network';
import { useApp } from '../state';

export function Layout(props: { children: ComponentChildren }) {
  const { t, me } = useApp();
  const { path } = useLocation();
  const online = useOnline();
  const [showBackOnline, setShowBackOnline] = useState(false);
  const wasOffline = useRef(!online);

  useEffect(() => {
    if (!online) wasOffline.current = true;
    else if (wasOffline.current) {
      wasOffline.current = false;
      setShowBackOnline(true);
      const id = setTimeout(() => setShowBackOnline(false), 3000);
      return () => clearTimeout(id);
    }
  }, [online]);

  const nav = [
    { href: '/', label: t.t('nav.home') },
    { href: '/profile', label: t.t('nav.profile') },
    { href: '/settings', label: t.t('nav.settings') },
    { href: '/devices', label: t.t('nav.devices') },
  ];

  return (
    <div class="layout">
      <a class="skip" href="#main">{t.t('app.skipToContent')}</a>
      <header class="topbar">
        <a href="/" class="brand" aria-label={t.t('app.name')}>
          <b>CHAT</b>me
        </a>
        {me && (
          <nav aria-label={t.t('nav.home')}>
            {nav.map((n) => (
              <a key={n.href} href={n.href} aria-current={path === n.href ? 'page' : undefined}>
                {n.label}
              </a>
            ))}
          </nav>
        )}
      </header>
      {!online && <div class="banner banner--offline" role="status">{t.t('network.offline')}</div>}
      {online && showBackOnline && <div class="banner banner--online" role="status">{t.t('network.online')}</div>}
      <main id="main" tabIndex={-1}>
        {props.children}
      </main>
    </div>
  );
}
