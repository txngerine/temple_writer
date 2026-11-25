import { useState } from 'react';
import { Status, useLoad } from '../App.jsx';
import { api, rupees } from '../api/client.js';

const BLANK = { name: '', code: '', timezone: 'Asia/Kolkata', adminEmail: '', adminName: '', adminPassword: '' };
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);

/** Platform super admin: every temple, and the way into each one. */
export default function Temples({ currentId, onOpen }) {
  const { data, error, loading, reload } = useLoad(() => api('/temples'), []);
  const overview = useLoad(() => api('/temples/overview'), []);
  const [form, setForm] = useState(null);
  const [actionError, setActionError] = useState(null);
  const [created, setCreated] = useState(null);

  async function run(fn) {
    setActionError(null);
    try {
      await fn();
      reload();
    } catch (err) {
      setActionError(err.message);
    }
  }

  const add = (e) => {
    e.preventDefault();
    run(async () => {
      const res = await api('/temples', {
        method: 'POST',
        body: {
          name: form.name, code: form.code, timezone: form.timezone,
          admin: { email: form.adminEmail, name: form.adminName, password: form.adminPassword },
        },
      });
      setCreated(res.temple);
      setForm(null);
    });
  };

  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  return (
    <>
      <header className="page-head">
        <h1>Temples</h1>
        <button className="primary" onClick={() => { setCreated(null); setForm(form ? null : { ...BLANK }); }}>{form ? 'Cancel' : 'Add temple'}</button>
      </header>
      {actionError && <div className="notice error">{actionError}</div>}
      {created && (
        <div className="notice success">
          <strong>{created.name}</strong> is ready with its offering list. Its admin can sign in now and register counters.
        </div>
      )}
      {form && (
        <form className="card form-row" onSubmit={add}>
          <label>Temple name
            <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value, code: form.code === slug(form.name) ? slug(e.target.value) : form.code })} required />
          </label>
          <label>Code
            <input value={form.code} onChange={set('code')} pattern="[a-z0-9][a-z0-9\-]{1,39}" title="2-40 lowercase letters, digits or dashes" required />
          </label>
          <label>Timezone<input value={form.timezone} onChange={set('timezone')} required /></label>
          <label>Admin email<input type="email" value={form.adminEmail} onChange={set('adminEmail')} required /></label>
          <label>Admin name<input value={form.adminName} onChange={set('adminName')} /></label>
          <label>Admin password<input type="password" minLength={8} value={form.adminPassword} onChange={set('adminPassword')} required /></label>
          <button className="primary">Create temple</button>
        </form>
      )}
      {overview.data && (
        <section className="card">
          <h2>Today across all temples — {rupees(overview.data.total.collected)} from {overview.data.total.receipts} receipts</h2>
          <table>
            <thead><tr><th>Temple</th><th className="num">Collected</th><th className="num">Receipts</th><th className="num">Cash</th><th className="num">UPI / card</th><th>Counters online</th><th className="num">Unsynced</th><th>Cash closed</th><th></th></tr></thead>
            <tbody>
              {overview.data.temples.map((t) => (
                <tr key={t.id} className={t.active ? '' : 'voided'}>
                  <td>{t.name}</td>
                  <td className="num">{rupees(t.collected)}</td>
                  <td className="num">{t.receipts}</td>
                  <td className="num">{rupees(t.cash)}</td>
                  <td className="num">{rupees(t.digital)}</td>
                  <td>{t.online} of {t.counters}</td>
                  <td className="num">{t.unsynced}</td>
                  <td>{t.closed} of {t.counters}{t.short ? ` (${t.short} mismatch)` : ''}</td>
                  <td className="num"><button className="small" onClick={() => onOpen(t)}>Open</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
      <Status loading={loading} error={error} empty={data?.temples.length === 0 && 'No temples yet. Add the first one.'}>
        <section className="card">
          <table>
            <thead><tr><th>Temple</th><th>Code</th><th>Timezone</th><th className="num">Counters</th><th className="num">Users</th><th>Active</th><th></th></tr></thead>
            <tbody>
              {(data?.temples || []).map((t) => (
                <tr key={t.id} className={t.active ? '' : 'voided'}>
                  <td>{t.name}{t.id === currentId && <span className="muted"> (open)</span>}</td>
                  <td>{t.code}</td>
                  <td>{t.timezone}</td>
                  <td className="num">{t.counters}</td>
                  <td className="num">{t.users}</td>
                  <td>
                    <input type="checkbox" checked={t.active}
                      onChange={(e) => run(() => api(`/temples/${t.id}`, { method: 'PATCH', body: { active: e.target.checked } }))} />
                  </td>
                  <td className="num"><button className="small" onClick={() => onOpen(t)}>Open</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      </Status>
    </>
  );
}
