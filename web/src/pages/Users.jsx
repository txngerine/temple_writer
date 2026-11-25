import { useState } from 'react';
import { Status, useLoad } from '../App.jsx';
import { api } from '../api/client.js';

// A temple admin can hand out these; the platform super admin is made from the server, never here.
const ROLES = ['admin', 'supervisor', 'operator', 'ml'];
const BLANK = { email: '', name: '', password: '', role: 'supervisor' };

export default function Users({ user: me }) {
  const { data, error, loading, reload } = useLoad(() => api('/users'), []);
  const [form, setForm] = useState(null);
  const [actionError, setActionError] = useState(null);

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
      await api('/users', { method: 'POST', body: form });
      setForm(null);
    });
  };

  function resetPassword(u) {
    const password = window.prompt(`New password for ${u.email} (at least 8 characters):`);
    if (password) run(() => api(`/users/${u.id}`, { method: 'PATCH', body: { password } }));
  }

  return (
    <>
      <header className="page-head">
        <h1>Users</h1>
        <button className="primary" onClick={() => setForm(form ? null : { ...BLANK })}>{form ? 'Cancel' : 'Add user'}</button>
      </header>
      {actionError && <div className="notice error">{actionError}</div>}
      {form && (
        <form className="card form-row" onSubmit={add}>
          <label>Email<input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} required /></label>
          <label>Name<input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
          <label>Password<input type="password" minLength={8} value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} required /></label>
          <label>Role
            <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
              {ROLES.map((r) => <option key={r}>{r}</option>)}
            </select>
          </label>
          <button className="primary">Create</button>
        </form>
      )}
      <Status loading={loading} error={error}>
        <section className="card">
          <table>
            <thead><tr><th>Email</th><th>Name</th><th>Role</th><th>Active</th><th></th></tr></thead>
            <tbody>
              {(data?.users || []).map((u) => {
                const self = u.id === me.id;
                return (
                  <tr key={u.id} className={u.active ? '' : 'voided'}>
                    <td>{u.email}{self && <span className="muted"> (you)</span>}</td>
                    <td>{u.name || '—'}</td>
                    <td>
                      <select value={u.role} disabled={self} onChange={(e) => run(() => api(`/users/${u.id}`, { method: 'PATCH', body: { role: e.target.value } }))}>
                        {ROLES.map((r) => <option key={r}>{r}</option>)}
                      </select>
                    </td>
                    <td>
                      <input type="checkbox" checked={u.active} disabled={self}
                        onChange={(e) => run(() => api(`/users/${u.id}`, { method: 'PATCH', body: { active: e.target.checked } }))} />
                    </td>
                    <td className="num"><button className="small" onClick={() => resetPassword(u)}>Reset password</button></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
      </Status>
    </>
  );
}
