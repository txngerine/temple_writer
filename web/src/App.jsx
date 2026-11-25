import { useCallback, useEffect, useState } from 'react';
import { NavLink, Navigate, Route, Routes } from 'react-router-dom';
import { api, getToken, setToken, setUnauthorizedHandler } from './api/client.js';
import DailyLog from './pages/DailyLog.jsx';
import Devices from './pages/Devices.jsx';
import Login from './pages/Login.jsx';
import Offerings from './pages/Offerings.jsx';
import Receipts from './pages/Receipts.jsx';
import Reports from './pages/Reports.jsx';
import Users from './pages/Users.jsx';

const ICONS = {
  log: <path d="M4 5h16M4 12h16M4 19h10" />,
  report: <path d="M5 20V10M12 20V4M19 20v-7" />,
  receipt: <path d="M6 3h12v18l-3-2-3 2-3-2-3 2V3zM9 8h6M9 12h6" />,
  offering: <path d="M12 3c2 3 5 4 5 8a5 5 0 0 1-10 0c0-4 3-5 5-8zM8 21h8" />,
  counter: <path d="M4 7h16v10H4zM8 21h8M12 17v4" />,
  users: <path d="M16 20v-1a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v1M9.5 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM21 20v-1a4 4 0 0 0-3-3.9M16 4.2a3.5 3.5 0 0 1 0 6.6" />,
};

const NAV = [
  { to: '/', label: 'Daily log', icon: 'log', roles: null },
  { to: '/reports', label: 'Daily report', icon: 'report', roles: null },
  { to: '/receipts', label: 'Receipts', icon: 'receipt', roles: null },
  { to: '/offerings', label: 'Offerings & prices', icon: 'offering', roles: null },
  { to: '/devices', label: 'Counters', icon: 'counter', roles: null },
  { to: '/users', label: 'Users', icon: 'users', roles: ['admin'] },
];

const NavIcon = ({ name }) => <svg viewBox="0 0 24 24" aria-hidden="true">{ICONS[name]}</svg>;

export default function App() {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(Boolean(getToken()));
  const [offline, setOffline] = useState(0);

  const signOut = useCallback(() => {
    setToken(null);
    setUser(null);
  }, []);

  useEffect(() => {
    setUnauthorizedHandler(() => setUser(null));
    if (!getToken()) return;
    api('/auth/me').then((d) => setUser(d.user)).catch(() => {}).finally(() => setLoading(false));
  }, []);

  // How many counters are down, for the badge beside "Counters". Re-read every
  // 30 s so it is current on whatever page the office is looking at.
  useEffect(() => {
    if (!user) return undefined;
    const check = () => api('/devices')
      .then((d) => setOffline(d.devices.filter((x) => x.status === 'enrolled' && !x.online).length))
      .catch(() => {});
    check();
    const t = setInterval(check, 30000);
    return () => clearInterval(t);
  }, [user]);

  if (loading) return <div className="center muted">Loading…</div>;
  if (!user) return <Login onSignedIn={setUser} />;

  const nav = NAV.filter((n) => !n.roles || n.roles.includes(user.role));
  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">🛕</span>
          <div>
            <strong>Temple Counter</strong>
            <small>Office admin</small>
          </div>
        </div>
        <nav>
          {nav.map((n) => (
            <NavLink key={n.to} to={n.to} end={n.to === '/'}>
              <NavIcon name={n.icon} />
              <span>{n.label}</span>
              {n.to === '/devices' && offline > 0 && <span className="nav-badge" title={`${offline} counter(s) offline`}>{offline}</span>}
            </NavLink>
          ))}
        </nav>
        <div className="who">
          <div className="avatar">{(user.name || user.email || '?').trim().charAt(0).toUpperCase()}</div>
          <div className="who-text">
            <div>{user.name || user.email}</div>
            <small>{user.role}</small>
          </div>
          <button className="link" onClick={signOut}>Sign out</button>
        </div>
      </aside>
      <main>
        <Routes>
          <Route path="/" element={<DailyLog />} />
          <Route path="/reports" element={<Reports />} />
          <Route path="/receipts" element={<Receipts user={user} />} />
          <Route path="/offerings" element={<Offerings user={user} />} />
          <Route path="/devices" element={<Devices user={user} />} />
          {user.role === 'admin' && <Route path="/users" element={<Users user={user} />} />}
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  );
}

/** Loads data when `deps` change; returns { data, error, loading, reload }. */
export function useLoad(loader, deps) {
  const [state, setState] = useState({ data: null, error: null, loading: true });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    setState((s) => ({ ...s, loading: true, error: null }));
    loader()
      .then((data) => live && setState({ data, error: null, loading: false }))
      .catch((e) => live && setState({ data: null, error: e.message, loading: false }));
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);
  return { ...state, reload: () => setTick((t) => t + 1) };
}

export function Status({ loading, error, empty, children }) {
  if (error) return <div className="notice error">{error}</div>;
  if (loading) return <div className="muted pad">Loading…</div>;
  if (empty) return <div className="muted pad">{empty}</div>;
  return children;
}
