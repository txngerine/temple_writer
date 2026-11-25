const BASE = import.meta.env.VITE_API_URL || 'http://localhost:4000';
const TOKEN_KEY = 'temple-admin-token';

export const getToken = () => localStorage.getItem(TOKEN_KEY);
export const setToken = (t) => (t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY));

// The temple a super admin has stepped into. Temple staff never set this: the
// server puts them in their own temple whatever the header says.
const TEMPLE_KEY = 'temple-admin-temple';
export const getTempleId = () => localStorage.getItem(TEMPLE_KEY);
export const setTempleId = (id) => (id ? localStorage.setItem(TEMPLE_KEY, id) : localStorage.removeItem(TEMPLE_KEY));

let zone = 'Asia/Kolkata';
export const setTempleZone = (tz) => { zone = tz || 'Asia/Kolkata'; };
export const templeZone = () => zone;

let onUnauthorized = () => {};
export const setUnauthorizedHandler = (fn) => { onUnauthorized = fn; };

/** Calls the admin API; throws an Error carrying the server's message. */
export async function api(path, { method = 'GET', body, query } = {}) {
  const qs = query
    ? '?' + new URLSearchParams(Object.entries(query).filter(([, v]) => v !== '' && v != null)).toString()
    : '';
  let res;
  try {
    res = await fetch(`${BASE}/admin${path}${qs}`, {
      method,
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(getToken() ? { Authorization: `Bearer ${getToken()}` } : {}),
        ...(getTempleId() ? { 'X-Temple-Id': getTempleId() } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new Error(`Cannot reach the server at ${BASE}`);
  }
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== '/auth/login') {
    setToken(null);
    onUnauthorized();
  }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

/** Today's date in the temple's timezone, as YYYY-MM-DD. */
export const templeToday = () =>
  new Intl.DateTimeFormat('en-CA', { timeZone: zone }).format(new Date());

export const rupees = (n) =>
  new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 }).format(n ?? 0);

export const templeTime = (iso, withDate = false) =>
  iso
    ? new Intl.DateTimeFormat('en-IN', {
        timeZone: zone, hour: '2-digit', minute: '2-digit', hour12: true,
        ...(withDate ? { day: '2-digit', month: 'short', year: 'numeric' } : {}),
      }).format(new Date(iso))
    : '—';
