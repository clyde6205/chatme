import type { Me } from '@chatme/contracts';
import { useEffect } from 'preact/hooks';
import { ErrorBoundary, LocationProvider, Router, lazy, useLocation } from 'preact-iso';
import { Layout } from './components/Layout';
import { api, ApiError } from './lib/api';
import { useApp } from './state';

// Every screen is its own chunk; only the one being opened is downloaded.
const Auth = lazy(() => import('./screens/Auth'));
const Home = lazy(() => import('./screens/Home'));
const Profile = lazy(() => import('./screens/Profile'));
const Settings = lazy(() => import('./screens/Settings'));
const Devices = lazy(() => import('./screens/Devices'));
const Recovery = lazy(() => import('./screens/Recovery'));

/** Signed-out only: signed-in users are sent home. */
const PUBLIC = new Set(['/signin', '/join']);
/** Reachable either way: email links open here whether or not this browser is signed in. */
const OPEN = new Set(['/forgot-password', '/reset-password', '/verify-email']);

/** Live updates from other devices. Loaded after first render, never on the critical path. */
function useRealtime() {
  const { me, setMe } = useApp();
  const { route } = useLocation();
  const userId = me?.id;
  useEffect(() => {
    if (!userId) return;
    let stopped = false;
    let stop: (() => void) | undefined;
    const refresh = () =>
      api<Me>('/v1/me')
        .then(setMe)
        .catch(() => {});
    const timer = setTimeout(() => {
      void import('./lib/realtime').then(({ RealtimeClient }) => {
        if (stopped) return;
        const client = new RealtimeClient(userId, {
          onEvent: (type) => {
            if (type === 'me.updated' || type === 'email.verified') void refresh();
          },
          onResync: () => void refresh(),
          onSessionEnded: () => {
            setMe(null);
            route('/signin', true);
          },
        });
        client.start();
        stop = () => client.stop();
      });
    }, 1500);
    return () => {
      stopped = true;
      clearTimeout(timer);
      stop?.();
    };
  }, [userId]);
}

function Guard() {
  const { me, setMe } = useApp();
  const { path, route } = useLocation();
  useRealtime();

  // Render immediately from the cached identity, then revalidate in the background.
  useEffect(() => {
    if (!me) return;
    api<Me>('/v1/me')
      .then(setMe)
      .catch((err) => {
        if (err instanceof ApiError && err.code === 'unauthenticated') setMe(null);
        // Network/server errors: keep the cached identity so the app stays usable offline.
      });
  }, []);

  useEffect(() => {
    if (OPEN.has(path)) return;
    if (!me && !PUBLIC.has(path)) route('/signin', true);
    else if (me && PUBLIC.has(path)) route('/', true);
  }, [me, path]);

  return (
    <Router>
      <Auth path="/signin" mode="signin" />
      <Auth path="/join" mode="join" />
      <Home path="/" />
      <Profile path="/profile" />
      <Settings path="/settings" />
      <Devices path="/devices" />
      <Recovery path="/forgot-password" mode="forgot" />
      <Recovery path="/reset-password" mode="reset" />
      <Recovery path="/verify-email" mode="verify" />
      <Home default />
    </Router>
  );
}

export function App() {
  return (
    <LocationProvider>
      <ErrorBoundary>
        <Layout>
          <Guard />
        </Layout>
      </ErrorBoundary>
    </LocationProvider>
  );
}
