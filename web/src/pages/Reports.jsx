import { useState } from 'react';
import { Status, useLoad } from '../App.jsx';
import { api, rupees, templeToday } from '../api/client.js';

export default function Reports({ user }) {
  const [day, setDay] = useState(templeToday());
  const { data, error, loading } = useLoad(() => api('/reports/daily', { query: { day } }), [day]);

  return (
    <>
      <header className="page-head">
        <h1>Daily report</h1>
        <div className="filters">
          <input type="date" value={day} max={templeToday()} onChange={(e) => setDay(e.target.value || templeToday())} />
        </div>
      </header>
      <Status loading={loading} error={error}>
        {data && (
          <>
            <div className="tiles">
              <div className="tile"><div className="tile-value">{rupees(data.total.amount)}</div><div className="tile-label">Collected</div></div>
              <div className="tile"><div className="tile-value">{data.total.count}</div><div className="tile-label">Receipts</div></div>
              <div className={`tile ${data.voided.count ? 'warn' : ''}`}>
                <div className="tile-value">{data.voided.count}</div>
                <div className="tile-label">Voided ({rupees(data.voided.amount)}, not counted)</div>
              </div>
            </div>
            <div className="two-col">
              <Breakdown title="By offering" rows={data.byOffering.map((r) => [r.offering, r.count, r.amount])} first="Offering" />
              <Breakdown title="By counter" rows={data.byCounter.map((r) => [r.counterName || r.deviceId, r.count, r.amount])} first="Counter" />
            </div>
            <Reconciliation day={day} canClose={user?.role === 'admin' || user?.role === 'supervisor'} />
          </>
        )}
      </Status>
    </>
  );
}

export function Reconciliation({ day, canClose }) {
  const { data, error, loading, reload } = useLoad(() => api('/reports/reconciliation', { query: { day } }), [day]);
  return (
    <section className="card">
      <h2>Cash reconciliation</h2>
      <p className="muted pad">Expected cash is the day's cash receipts per counter. Enter what was counted in the till.</p>
      <Status loading={loading} error={error} empty={data?.counters.length === 0 && 'No counters had activity on this day.'}>
        {data && (
          <table>
            <thead><tr><th>Counter</th><th className="num">Cash expected</th><th className="num">UPI / card</th><th>Sync</th><th>Counted</th><th>Status</th></tr></thead>
            <tbody>
              {data.counters.map((c) => <CloseRow key={c.deviceId} c={c} day={day} canClose={canClose} onSaved={reload} />)}
            </tbody>
          </table>
        )}
      </Status>
    </section>
  );
}

function CloseRow({ c, day, canClose, onSaved }) {
  const [counted, setCounted] = useState(c.close ? String(c.close.declaredCash) : '');
  const [note, setNote] = useState(c.close?.note || '');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true); setErr('');
    try {
      await api(`/reports/close?day=${day}`, { method: 'POST', body: { deviceId: c.deviceId, declaredCash: counted, note } });
      onSaved();
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  const v = c.close?.variance;
  return (
    <tr>
      <td>{c.counterName}</td>
      <td className="num">{rupees(c.cash)}</td>
      <td className="num">{rupees(c.upi + c.card)}</td>
      <td>{c.pendingCount > 0 ? `${c.pendingCount} unsynced${c.online ? '' : ' (offline)'}` : 'Synced'}</td>
      <td>
        {canClose ? (
          <>
            <input type="number" min="0" step="0.01" value={counted} placeholder="Counted ₹" onChange={(e) => setCounted(e.target.value)} />
            <input value={note} placeholder="Note (required if mismatch)" onChange={(e) => setNote(e.target.value)} />
            <button className="small" disabled={busy || counted === ''} onClick={save}>{c.close ? 'Re-close' : 'Close'}</button>
            {err && <div className="notice error">{err}</div>}
          </>
        ) : (c.close ? rupees(c.close.declaredCash) : '—')}
      </td>
      <td>
        {!c.close ? 'Open' : c.close.stale ? 'Receipts changed since close'
          : v === 0 ? 'Matched' : `${v > 0 ? 'Over' : 'Short'} ${rupees(Math.abs(v))}`}
      </td>
    </tr>
  );
}

function Breakdown({ title, rows, first }) {
  return (
    <section className="card">
      <h2>{title}</h2>
      {rows.length === 0 ? <div className="muted pad">No receipts on this day.</div> : (
        <table>
          <thead><tr><th>{first}</th><th className="num">Receipts</th><th className="num">Amount</th></tr></thead>
          <tbody>
            {rows.map(([name, count, amount]) => (
              <tr key={name}><td>{name}</td><td className="num">{count}</td><td className="num">{rupees(amount)}</td></tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
