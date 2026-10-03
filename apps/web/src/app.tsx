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

const PUBLIC = new Set(['/signin', '/join']);

function Guard() {
  const { me, setMe } = useApp();
  const { path, route } = useLocation();

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
