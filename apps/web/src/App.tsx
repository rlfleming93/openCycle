import { useEffect } from 'react';
import { BrowserRouter, NavLink, Navigate, Route, Routes, useLocation } from 'react-router-dom';

import { connectWs } from './lib/ws.js';
import DevicesPage from './pages/DevicesPage.js';
import { HistoryPage } from './pages/HistoryPage.js';
import ProfilesPage from './pages/ProfilesPage.js';
import { RideDetailPage } from './pages/RideDetailPage.js';
import RidePage from './pages/RidePage.js';
import SessionBuilderPage from './pages/SessionBuilderPage.js';
import TrainingPage from './pages/TrainingPage.js';
import VoyagePage from './pages/VoyagePage.js';
import { useAppStore, type AppState } from './store.js';

const WS_DOT_CLASS: Record<AppState['wsStatus'], string> = {
  open: 'bg-on',
  connecting: 'bg-over animate-pulse',
  closed: 'bg-danger',
};

const NAV_LINKS: { to: string; label: string; end?: boolean }[] = [
  { to: '/', label: 'Ride', end: true },
  { to: '/session/new', label: 'Session' },
  { to: '/voyage', label: 'Voyage' },
  { to: '/profiles', label: 'Profiles' },
  { to: '/devices', label: 'Devices' },
  { to: '/history', label: 'History' },
  { to: '/training', label: 'Training' },
];

function NavBar() {
  const wsStatus = useAppStore((s) => s.wsStatus);
  const session = useAppStore((s) => s.session);
  const location = useLocation();

  // Full-screen dashboard while a session runs on '/'.
  if (location.pathname === '/' && session !== null) return null;

  const linkClass = ({ isActive }: { isActive: boolean }): string =>
    `font-display text-lg uppercase tracking-[0.06em] transition-colors ${
      isActive ? 'text-on' : 'text-dim hover:text-ink'
    }`;

  return (
    <header className="border-b border-line bg-deep">
      <nav className="mx-auto flex h-16 max-w-7xl flex-wrap items-center gap-x-7 gap-y-1 px-6">
        <span className="font-display text-2xl font-bold uppercase tracking-[0.06em] text-ink">openCycle</span>
        {NAV_LINKS.map((link) => (
          <NavLink key={link.to} to={link.to} end={link.end} className={linkClass}>
            {link.label}
          </NavLink>
        ))}
        <span className="ml-auto flex items-center gap-2" title={`WS ${wsStatus}`}>
          <span aria-hidden="true" className={`h-3 w-3 rounded-full ${WS_DOT_CLASS[wsStatus]}`} />
          <span className="font-display text-sm uppercase tracking-[0.06em] text-dim">{wsStatus}</span>
        </span>
      </nav>
    </header>
  );
}

function HomeRoute() {
  const session = useAppStore((s) => s.session);
  const wsStatus = useAppStore((s) => s.wsStatus);
  const hydrated = useAppStore((s) => s.hydrated);

  if (session !== null) return <RidePage />;

  // No session AND (socket down OR the initial sessionState frame has not
  // arrived yet): hold the dashboard's place instead of bouncing to
  // /session/new — the session may still be running server-side and the
  // server always sends a sessionState frame (null included) on connect.
  if (wsStatus !== 'open' || !hydrated) {
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-void">
        <div className="flex flex-col items-center gap-5 text-ink">
          <div className="h-12 w-12 animate-spin rounded-full border-4 border-line border-t-on" />
          <p className="font-display text-3xl font-semibold uppercase tracking-[0.06em]">Reconnecting…</p>
          <p className="text-xl text-dim">Your session stays on screen once the server is back.</p>
        </div>
      </div>
    );
  }

  // Socket open and the server confirms no session: the builder is the home.
  return <Navigate to="/session/new" replace />;
}

export default function App() {
  useEffect(() => {
    connectWs();
  }, []);

  return (
    <BrowserRouter>
      <div className="flex h-full flex-col bg-void text-ink">
        <NavBar />
        <main className="min-h-0 flex-1">
          <Routes>
            <Route path="/" element={<HomeRoute />} />
            <Route path="/session/new" element={<SessionBuilderPage />} />
            <Route path="/voyage" element={<VoyagePage />} />
            <Route path="/profiles" element={<ProfilesPage />} />
            <Route path="/devices" element={<DevicesPage />} />
            <Route path="/history" element={<HistoryPage />} />
            <Route path="/history/:rideId" element={<RideDetailPage />} />
            <Route path="/training" element={<TrainingPage />} />
          </Routes>
        </main>
      </div>
    </BrowserRouter>
  );
}
