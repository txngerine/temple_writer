import { useCallback, useEffect, useState } from 'react';
import { NavLink, Navigate, Route, Routes } from 'react-router-dom';
import { api, getTempleId, getToken, setTempleId, setTempleZone, setToken, setUnauthorizedHandler } from './api/client.js';
import DailyLog from './pages/DailyLog.jsx';
import Devices from './pages/Devices.jsx';
import Login from './pages/Login.jsx';
import Offerings from './pages/Offerings.jsx';
import Receipts from './pages/Receipts.jsx';
import Reports from './pages/Reports.jsx';
import Temples from './pages/Temples.jsx';
import Users from './pages/Users.jsx';

const ICONS = {
  log: <path d="M4 5h16M4 12h16M4 19h10" />,
  report: <path d="M5 20V10M12 20V4M19 20v-7" />,
  receipt: <path d="M6 3h12v18l-3-2-3 2-3-2-3 2V3zM9 8h6M9 12h6" />,
  offering: <path d="M12 3c2 3 5 4 5 8a5 5 0 0 1-10 0c0-4 3-5 5-8zM8 21h8" />,
  counter: <path d="M4 7h16v10H4zM8 21h8M12 17v4" />,
  temples: <path d="M3 21h18M5 21V10l7-6 7 6v11M9 21v-6h6v6" />,
  users: <path d="M16 20v-1a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v1M9.5 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM21 20v-1a4 4 0 0 0-3-3.9M16 4.2a3.5 3.5 0 0 1 0 6.6" />,
};

// Super admin only: managing the temples themselves.
const PLATFORM_NAV = [{ to: '/temples', label: 'Temples', icon: 'temples' }];

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
  // The temple whose data the pages show: a temple user's own, or the one a
  // super admin has opened.
  const [temple, setTemple] = useState(null);
  const [loading, setLoading] = useState(Boolean(getToken()));
  const [offline, setOffline] = useState(0);

  const isSuper = user?.role === 'superadmin';

  const enter = useCallback((u, t) => {
    setUser(u);
    setTemple(t);
    setTempleZone(t?.timezone);
  }, []);

  const openTemple = useCallback((t) => {
    setTempleId(t?.id);
    setTemple(t);
    setTempleZone(t?.timezone);
  }, []);

  const signOut = useCallback(() => {
    setToken(null);
    setTempleId(null);
    setUser(null);
    setTemple(null);
  }, []);

  useEffect(() => {
    setUnauthorizedHandler(() => { setUser(null); setTemple(null); });
    if (!getToken()) return;
    (async () => {
      try {
        const me = await api('/auth/me');
        let t = me.temple;
        if (me.user.role === 'superadmin') {
          // Pick up where they left off, if that temple still exists.
          const saved = getTempleId();
          t = saved ? (await api('/temples')).temples.find((x) => x.id === saved) ?? null : null;
          if (!t) setTempleId(null);
        }
        enter(me.user, t);
      } catch { /* not signed in */ } finally {
        setLoading(false);
      }
    })();
  }, [enter]);

  // How many counters are down, for the badge beside "Counters". Re-read every
  // 30 s so it is current on whatever page the office is looking at.
  useEffect(() => {
    if (!user || !temple) { setOffline(0); return undefined; }
    const check = () => api('/devices')
      .then((d) => setOffline(d.devices.filter((x) => x.status === 'enrolled' && !x.online).length))
      .catch(() => {});
    check();
    const t = setInterval(check, 30000);
    return () => clearInterval(t);
  }, [user, temple]);

  if (loading) return <div className="center muted">Loading…</div>;
  if (!user) return <Login onSignedIn={enter} />;

  // Inside a temple a super admin has the same powers as that temple's admin.
  const actor = isSuper ? { ...user, role: 'admin' } : user;
  const templeNav = temple ? NAV.filter((n) => !n.roles || n.roles.includes(actor.role)) : [];
  const nav = [...(isSuper ? PLATFORM_NAV : []), ...templeNav];
  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">🛕</span>
          <div>
            <strong>Temple Counter</strong>
            <small>{isSuper ? 'Super admin' : temple?.name || 'Office admin'}</small>
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
        {isSuper && temple && (
          <div className="notice success">
            Working in <strong>{temple.name}</strong>.{' '}
            <button className="link" onClick={() => openTemple(null)}>Leave temple</button>
          </div>
        )}
        {/* Keyed by temple so switching temples never shows the last one's data. */}
        <Routes key={temple?.id ?? 'none'}>
          {isSuper && <Route path="/temples" element={<Temples currentId={temple?.id} onOpen={(t) => openTemple(t)} />} />}
          {temple && <Route path="/" element={<DailyLog />} />}
          {temple && <Route path="/reports" element={<Reports />} />}
          {temple && <Route path="/receipts" element={<Receipts user={actor} />} />}
          {temple && <Route path="/offerings" element={<Offerings user={actor} />} />}
          {temple && <Route path="/devices" element={<Devices user={actor} />} />}
          {temple && actor.role === 'admin' && <Route path="/users" element={<Users user={actor} />} />}
          <Route path="*" element={<Navigate to={isSuper && !temple ? '/temples' : '/'} replace />} />
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
