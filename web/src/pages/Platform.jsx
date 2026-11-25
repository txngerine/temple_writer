import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Status, useLoad } from '../App.jsx';
import { api, rupees, templeTime, templeToday } from '../api/client.js';

const sum = (rows, k) => rows.reduce((n, r) => n + (r[k] || 0), 0);

/** Platform super admin's landing page: every temple at a glance. */
export default function Platform({ onOpen }) {
  const navigate = useNavigate();
  const [day, setDay] = useState(templeToday());
  const overview = useLoad(() => api('/temples/overview', { query: { day } }), [day]);
  const summary = useLoad(() => api('/temples/summary'), []);
  const temples = overview.data?.temples || [];
  const s = summary.data;
  const max = Math.max(1, ...(s?.trend || []).map((d) => d.amount));

  return (
    <>
      <header className="page-head">
        <h1>Dashboard</h1>
        <div className="filters">
          <input type="date" value={day} max={templeToday()} onChange={(e) => setDay(e.target.value || templeToday())} />
        </div>
      </header>
      <Status loading={overview.loading} error={overview.error}>
        {overview.data && (
          <div className="tiles">
            <div className="tile"><div className="tile-value">{rupees(overview.data.total.collected)}</div><div className="tile-label">Collected</div></div>
            <div className="tile"><div className="tile-value">{overview.data.total.receipts}</div><div className="tile-label">Receipts</div></div>
            <div className="tile"><div className="tile-value">{temples.filter((t) => t.active).length}</div><div className="tile-label">Active temples</div></div>
            <div className="tile"><div className="tile-value">{sum(temples, 'online')} / {sum(temples, 'counters')}</div><div className="tile-label">Counters online</div></div>
            <div className={`tile ${sum(temples, 'unsynced') ? 'warn' : ''}`}><div className="tile-value">{sum(temples, 'unsynced')}</div><div className="tile-label">Unsynced receipts</div></div>
            <div className={`tile ${sum(temples, 'short') ? 'warn' : ''}`}><div className="tile-value">{sum(temples, 'short')}</div><div className="tile-label">Cash mismatches</div></div>
          </div>
        )}
      </Status>

      <section className="card">
        <h2>Temples</h2>
        {temples.length === 0 ? <div className="muted pad">No temples yet. Add one under Temples.</div> : (
          <table>
            <thead><tr><th>Temple</th><th className="num">Collected</th><th className="num">vs last week</th><th className="num">Receipts</th><th className="num">Cash</th><th className="num">UPI / card</th><th className="num">Voided</th><th>Counters online</th><th className="num">Unsynced</th><th>Cash closed</th><th></th></tr></thead>
            <tbody>
              {temples.map((t) => (
                <tr key={t.id} className={t.active ? '' : 'voided'}>
                  <td><Health h={t.health} /> {t.name}{!t.active && <span className="muted"> (inactive)</span>}</td>
                  <td className="num">{rupees(t.collected)}</td>
                  <td className="num">{t.lastWeekCollected ? `${t.collected >= t.lastWeekCollected ? '▲' : '▼'} ${Math.abs(Math.round(((t.collected - t.lastWeekCollected) / t.lastWeekCollected) * 100))}%` : '—'}</td>
                  <td className="num">{t.receipts}</td>
                  <td className="num">{rupees(t.cash)}</td>
                  <td className="num">{rupees(t.digital)}</td>
                  <td className="num">{t.voided}</td>
                  <td>{t.online} of {t.counters}</td>
                  <td className="num">{t.unsynced}</td>
                  <td>{t.closed} of {t.counters}{t.short ? ` (${t.short} mismatch)` : ''}</td>
                  <td className="num"><button className="small" onClick={() => { onOpen(t); navigate('/'); }}>Open</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <Status loading={summary.loading} error={summary.error}>
        {s && (
          <>
            <div className="two-col">
              <section className="card">
                <h2>Last 7 days</h2>
                <table>
                  <thead><tr><th>Day</th><th></th><th className="num">Receipts</th><th className="num">Amount</th></tr></thead>
                  <tbody>
                    {s.trend.map((d) => (
                      <tr key={d.day}>
                        <td>{d.day}</td>
                        <td style={{ width: '40%' }}><div style={{ height: 10, borderRadius: 5, background: 'currentColor', opacity: 0.55, width: `${(d.amount / max) * 100}%` }} /></td>
                        <td className="num">{d.count}</td>
                        <td className="num">{rupees(d.amount)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </section>
              <section className="card">
                <h2>Top offerings today</h2>
                {s.topOfferings.length === 0 ? <div className="muted pad">No receipts yet today.</div> : (
                  <table>
                    <thead><tr><th>Offering</th><th className="num">Receipts</th><th className="num">Amount</th></tr></thead>
                    <tbody>{s.topOfferings.map((o) => <tr key={o.offering}><td>{o.offering}</td><td className="num">{o.count}</td><td className="num">{rupees(o.amount)}</td></tr>)}</tbody>
                  </table>
                )}
              </section>
            </div>

            <div className="two-col">
              <section className="card">
                <h2>Needs attention</h2>
                {s.offlineCounters.length + s.mismatches.length === 0 ? <div className="muted pad">All counters are online and every closed till matches.</div> : (
                  <table>
                    <thead><tr><th>Temple</th><th>Counter</th><th>Issue</th></tr></thead>
                    <tbody>
                      {s.mismatches.map((m, i) => (
                        <tr key={`m${i}`}><td>{m.temple}</td><td>{m.counterName}</td><td>Cash {m.variance > 0 ? 'over' : 'short'} {rupees(Math.abs(m.variance))}{m.note ? ` — ${m.note}` : ''}</td></tr>
                      ))}
                      {s.offlineCounters.map((c, i) => (
                        <tr key={`o${i}`}><td>{c.temple}</td><td>{c.counterName}</td><td>Offline, last seen {templeTime(c.lastSeenAt, true)}{c.pendingCount ? `, ${c.pendingCount} unsynced` : ''}</td></tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </section>
              <section className="card">
                <h2>Recent warnings</h2>
                {s.warnings.length === 0 ? <div className="muted pad">No warnings.</div> : (
                  <table>
                    <thead><tr><th>When</th><th>Temple</th><th>Event</th></tr></thead>
                    <tbody>{s.warnings.map((w, i) => <tr key={i}><td>{templeTime(w.at, true)}</td><td>{w.temple}</td><td>{w.message}</td></tr>)}</tbody>
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

const HEALTH = {
  green: ['#2e7d32', 'Healthy'], amber: ['#e0a100', 'Worth a look: unsynced receipts, or no sales yet today'],
  red: ['#c62828', 'Offline counter or cash mismatch'], grey: ['#9e9e9e', 'Inactive, or no counters yet'],
};
function Health({ h }) {
  const [color, label] = HEALTH[h] || HEALTH.grey;
  return <span title={label} aria-label={label} style={{ display: 'inline-block', width: 10, height: 10, borderRadius: '50%', background: color, marginRight: 6 }} />;
}
