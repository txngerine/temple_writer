import { useState } from 'react';
import { Status, useLoad } from '../App.jsx';
import { api, rupees, templeToday } from '../api/client.js';

export default function Reports() {
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
          </>
        )}
      </Status>
    </>
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
