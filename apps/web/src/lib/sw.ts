/** Register the service worker after the app is interactive so it never competes with first render. */
export function registerServiceWorker() {
  if (!('serviceWorker' in navigator) || import.meta.env.DEV) return;
  const go = () => void import('virtual:pwa-register').then(({ registerSW }) => registerSW({ immediate: true }));
  if (document.readyState === 'complete') setTimeout(go, 0);
  else addEventListener('load', go, { once: true });
}
