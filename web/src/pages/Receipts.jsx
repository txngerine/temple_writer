import { useState } from 'react';
import { Status, useLoad } from '../App.jsx';
import { api, rupees, templeTime, templeToday } from '../api/client.js';

export default function Receipts({ user }) {
  const [day, setDay] = useState(templeToday());
  const [q, setQ] = useState('');
  const [search, setSearch] = useState('');
  const [voided, setVoided] = useState('');
  const [page, setPage] = useState(1);
  const [actionError, setActionError] = useState(null);
  const canVoid = ['admin', 'supervisor'].includes(user.role);

  const { data, error, loading, reload } = useLoad(
    () => api('/receipts', { query: { day, q: search, voided, page } }),
    [day, search, voided, page],
  );

  async function voidReceipt(r) {
    const reason = window.prompt(`Void ${rupees(r.amount)} ${r.offering} for ${r.name}?\n\nThis cannot be undone. Enter the reason:`);
    if (!reason || !reason.trim()) return;
    setActionError(null);
    try {
      await api(`/receipts/${r.id}/void`, { method: 'POST', body: { reason } });
      reload();
    } catch (e) {
      setActionError(e.message);
    }
  }

  const pages = data ? Math.max(1, Math.ceil(data.total / data.limit)) : 1;
  return (
    <>
      <header className="page-head">
        <h1>Receipts</h1>
        <form className="filters" onSubmit={(e) => { e.preventDefault(); setPage(1); setSearch(q); }}>
          <input type="date" value={day} max={templeToday()} onChange={(e) => { setDay(e.target.value); setPage(1); }} />
          <select value={voided} onChange={(e) => { setVoided(e.target.value); setPage(1); }}>
            <option value="">All receipts</option>
            <option value="false">Not voided</option>
            <option value="true">Voided only</option>
          </select>
          <input placeholder="Devotee name or receipt id" value={q} onChange={(e) => setQ(e.target.value)} />
          <button>Search</button>
        </form>
      </header>
      {!day && <div className="muted pad">Showing every day. Pick a date to narrow it.</div>}
      {actionError && <div className="notice error">{actionError}</div>}
      <Status loading={loading} error={error} empty={data?.receipts.length === 0 && 'No receipts match.'}>
        {data && (
          <section className="card">
            <table>
              <thead>
                <tr><th>Time</th><th>Devotee</th><th>Nakshatram</th><th>Offering</th><th className="num">Amount</th><th>Counter</th><th></th></tr>
              </thead>
              <tbody>
                {data.receipts.map((r) => (
                  <tr key={r.id} className={r.voided ? 'voided' : ''}>
                    <td>{templeTime(r.occurredAt, !day)}</td>
                    <td>{r.name}</td>
                    <td>{r.nakshatram}</td>
                    <td>{r.offering}</td>
                    <td className="num">{rupees(r.amount)}</td>
                    <td>{r.counterName}</td>
                    <td className="num">
                      {r.voided
                        ? <span className="tag warn" title={r.voidReason}>Voided: {r.voidReason}</span>
                        : canVoid && <button className="danger small" onClick={() => voidReceipt(r)}>Void</button>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="pager">
              <span className="muted">{data.total} receipts</span>
              <button disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</button>
              <span>Page {page} of {pages}</span>
              <button disabled={page >= pages} onClick={() => setPage(page + 1)}>Next</button>
            </div>
          </section>
        )}
      </Status>
    </>
  );
}
