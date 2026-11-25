import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Status, useLoad } from '../App.jsx';
import { api, rupees, templeToday, templeTime } from '../api/client.js';
import { Reconciliation } from './Reports.jsx';

const hourLabel = (h) => `${h % 12 || 12}${h < 12 ? 'a' : 'p'}`;

function Change({ now, before, label }) {
  if (!before) return <span className="muted">{label}: no sales</span>;
  const pct = Math.round(((now - before) / before) * 100);
  return <span className="muted">{pct >= 0 ? '▲' : '▼'} {Math.abs(pct)}% {label} ({rupees(before)})</span>;
}

/** The temple office's landing page. */
export default function Today({ user }) {
  const [day, setDay] = useState(templeToday());
  const { data, error, loading } = useLoad(() => api('/reports/today', { query: { day } }), [day]);
  const canClose = user?.role === 'admin' || user?.role === 'supervisor';
  const max = Math.max(1, ...(data?.hourly || []).map((h) => h.amount));
  const active = (data?.hourly || []).filter((h) => h.count > 0);
  const from = active.length ? Math.max(0, active[0].hour - 1) : 5;
  const to = active.length ? Math.min(23, active[active.length - 1].hour + 1) : 20;

  return (
    <>
      <header className="page-head">
        <h1>{day === templeToday() ? 'Today' : day}</h1>
        <div className="filters">
          <input type="date" value={day} max={templeToday()} onChange={(e) => setDay(e.target.value || templeToday())} />
        </div>
      </header>
      <Status loading={loading} error={error}>
        {data && (
          <>
            <div className="tiles">
              <div className="tile">
                <div className="tile-value">{rupees(data.total.amount)}</div>
                <div className="tile-label">Collected</div>
                <Change now={data.total.amount} before={data.lastWeek.amount} label="vs last week" />
              </div>
              <div className="tile"><div className="tile-value">{data.total.count}</div><div className="tile-label">Receipts</div></div>
              <div className="tile"><div className="tile-value">{rupees(data.total.cash)}</div><div className="tile-label">Cash</div></div>
              <div className="tile"><div className="tile-value">{rupees(data.total.digital)}</div><div className="tile-label">UPI / card</div></div>
              <div className={`tile ${data.close.mismatched ? 'warn' : ''}`}>
                <div className="tile-value">{data.close.closed} of {data.close.total}</div>
                <div className="tile-label">Tills closed{data.close.mismatched ? `, ${data.close.mismatched} mismatch` : ''}</div>
              </div>
            </div>

            <div className="two-col">
              <section className="card">
                <h2>Collection by hour</h2>
                {data.total.count === 0 ? <div className="muted pad">No receipts yet.</div> : (
                  <table>
                    <thead><tr><th>Hour</th><th></th><th className="num">Receipts</th><th className="num">Amount</th></tr></thead>
                    <tbody>
                      {data.hourly.filter((h) => h.hour >= from && h.hour <= to).map((h) => (
                        <tr key={h.hour}>
                          <td>{hourLabel(h.hour)}</td>
                          <td style={{ width: '40%' }}><div style={{ height: 10, borderRadius: 5, background: 'currentColor', opacity: 0.55, width: `${(h.amount / max) * 100}%` }} /></td>
                          <td className="num">{h.count}</td>
                          <td className="num">{rupees(h.amount)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </section>
              <section className="card">
                <h2>Counters</h2>
                {data.counters.length === 0 ? <div className="muted pad">No counters enrolled. <Link to="/devices">Add one</Link>.</div> : (
                  <table>
                    <thead><tr><th>Counter</th><th>Status</th><th className="num">Receipts</th><th className="num">Unsynced</th></tr></thead>
                    <tbody>
                      {data.counters.map((c) => (
                        <tr key={c.deviceId}>
                          <td>{c.counterName}</td>
                          <td>{c.online ? 'Online' : `Offline, seen ${templeTime(c.lastSeenAt, true)}`}</td>
                          <td className="num">{c.receipts}</td>
                          <td className="num">{c.pendingCount}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </section>
            </div>

            <Reconciliation day={day} canClose={canClose} />

            <div className="two-col">
              <section className="card">
                <h2>Top offerings</h2>
                {data.topOfferings.length === 0 ? <div className="muted pad">No receipts yet.</div> : (
                  <table>
                    <thead><tr><th>Offering</th><th className="num">Receipts</th><th className="num">Amount</th></tr></thead>
                    <tbody>{data.topOfferings.map((o) => <tr key={o.offering}><td>{o.offering}</td><td className="num">{o.count}</td><td className="num">{rupees(o.amount)}</td></tr>)}</tbody>
                  </table>
                )}
              </section>
              <section className="card">
                <h2>Voided receipts</h2>
                {data.voided.length === 0 ? <div className="muted pad">None.</div> : (
                  <table>
                    <thead><tr><th>Receipt</th><th className="num">Amount</th><th>Reason</th></tr></thead>
                    <tbody>{data.voided.map((v) => <tr key={v.id}><td>{v.name} · {v.offering}<div className="muted">{v.counterName}</div></td><td className="num">{rupees(v.amount)}</td><td>{v.reason}</td></tr>)}</tbody>
                  </table>
                )}
              </section>
            </div>
          </>
        )}
      </Status>
    </>
  );
}
