import { useMemo, useState } from 'react';
import { Status, useLoad } from '../App.jsx';
import { api, templeTime, templeToday } from '../api/client.js';

const hourOf = (iso) =>
  new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', hour: 'numeric', hour12: true }).format(new Date(iso));

export default function DailyLog() {
  const [day, setDay] = useState(templeToday());
  const [type, setType] = useState('');
  const [deviceId, setDeviceId] = useState('');
  const [actorType, setActorType] = useState('');

  const { data, error, loading, reload } = useLoad(
    () => Promise.all([
      api('/logs', { query: { day, type, deviceId, actorType } }),
      api('/logs/summary', { query: { day } }),
      api('/devices'),
    ]),
    [day, type, deviceId, actorType],
  );
  const [logs, summary, devices] = data || [];

  // Grouped by hour so a shift reads as a shift.
  const groups = useMemo(() => {
    const out = [];
    for (const log of logs?.logs || []) {
      const hour = hourOf(log.at);
      if (out.at(-1)?.hour !== hour) out.push({ hour, rows: [] });
      out.at(-1).rows.push(log);
    }
    return out;
  }, [logs]);

  return (
    <>
      <header className="page-head">
        <h1>Daily log</h1>
        <div className="filters">
          <input type="date" value={day} max={templeToday()} onChange={(e) => setDay(e.target.value || templeToday())} />
          <select value={deviceId} onChange={(e) => setDeviceId(e.target.value)}>
            <option value="">All counters</option>
            {(devices?.devices || []).map((d) => <option key={d.deviceId} value={d.deviceId}>{d.counterName}</option>)}
          </select>
          <select value={actorType} onChange={(e) => setActorType(e.target.value)}>
            <option value="">Everyone</option>
            <option value="device">Counters</option>
            <option value="user">Office</option>
            <option value="system">System</option>
          </select>
          <select value={type} onChange={(e) => setType(e.target.value)}>
            <option value="">All events</option>
            {Object.keys(summary?.byType || {}).sort().map((t) => <option key={t}>{t}</option>)}
          </select>
          <button onClick={reload}>Refresh</button>
        </div>
      </header>

      <div className="tiles">
        <Tile label="Logins" value={summary?.logins} />
        <Tile label="Syncs" value={summary?.syncs} />
        <Tile label="Receipts" value={summary?.receipts} />
        <Tile label="Errors" value={summary?.errors} bad={summary?.errors > 0} />
      </div>

      <Status loading={loading} error={error} empty={!groups.length && 'Nothing was logged on this day.'}>
        {groups.map((g) => (
          <section key={g.hour + g.rows[0]._id} className="card log-group">
            <h2>{g.hour}</h2>
            {g.rows.map((log) => (
              <div key={log._id} className={`log-row ${log.severity}`}>
                <time>{templeTime(log.at)}</time>
                <span className="tag">{log.type}</span>
                <span className="msg">{log.message}</span>
                <span className="muted">{log.counterName || (log.actorType === 'user' ? 'Office' : '')}</span>
              </div>
            ))}
          </section>
        ))}
        {logs && logs.total > logs.logs.length && (
          <div className="muted pad">Showing the latest {logs.logs.length} of {logs.total} events. Narrow the filters to see the rest.</div>
        )}
      </Status>
    </>
  );
}

function Tile({ label, value, bad }) {
  return (
    <div className={`tile ${bad ? 'bad' : ''}`}>
      <div className="tile-value">{value ?? '—'}</div>
      <div className="tile-label">{label}</div>
    </div>
  );
}
