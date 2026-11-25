import { useEffect, useState } from 'react';
import { Status, useLoad } from '../App.jsx';
import { api, templeTime } from '../api/client.js';

export default function Devices({ user }) {
  const isAdmin = user.role === 'admin';
  const { data, error, loading, reload } = useLoad(() => api('/devices'), []);
  const [counterName, setCounterName] = useState('');
  const [issued, setIssued] = useState(null);
  const [actionError, setActionError] = useState(null);

  // A counter's status is only useful while it is current: re-read it every
  // 15 s so an offline counter shows up without anyone pressing refresh.
  useEffect(() => {
    const t = setInterval(reload, 15000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const live = (data?.devices || []).filter((d) => d.status === 'enrolled');
  const offline = live.filter((d) => !d.online);

  async function add(e) {
    e.preventDefault();
    setActionError(null);
    try {
      const res = await api('/devices', { method: 'POST', body: { counterName } });
      setIssued({ name: res.device.counterName, code: res.enrollCode });
      setCounterName('');
      reload();
    } catch (err) {
      setActionError(err.message);
    }
  }

  async function revoke(d) {
    const reason = window.prompt(`Revoke ${d.counterName}? It will stop syncing at once and cannot be restored; a replacement needs a new code.\n\nReason:`);
    if (reason === null) return;
    setActionError(null);
    try {
      await api(`/devices/${d.id}/revoke`, { method: 'POST', body: { reason } });
      reload();
    } catch (err) {
      setActionError(err.message);
    }
  }

  return (
    <>
      <header className="page-head">
        <h1>Counters</h1>
        {isAdmin && (
          <form className="filters" onSubmit={add}>
            <input placeholder="Counter name, e.g. Counter 2" value={counterName} onChange={(e) => setCounterName(e.target.value)} required />
            <button className="primary">Register counter</button>
          </form>
        )}
      </header>
      {issued && (
        <div className="notice success">
          Enrolment code for <strong>{issued.name}</strong>: <code className="code">{issued.code}</code>
          <div>Enter it on that counter. It is shown only this once, and stops working once the counter has connected.</div>
        </div>
      )}
      {actionError && <div className="notice error">{actionError}</div>}
      {live.length > 0 && (
        offline.length > 0
          ? <div className="notice error"><strong>{offline.length} of {live.length} counters offline:</strong> {offline.map((d) => d.counterName).join(', ')}</div>
          : <div className="notice success">All {live.length} counter{live.length === 1 ? ' is' : 's are'} online.</div>
      )}
      <Status loading={loading && !data} error={error} empty={data?.devices.length === 0 && 'No counters registered yet.'}>
        <section className="card">
          <table>
            <thead>
              <tr><th>Counter</th><th>Status</th><th>Last seen</th><th className="num">Waiting to sync</th><th>App</th><th>Model</th><th></th></tr>
            </thead>
            <tbody>
              {(data?.devices || []).map((d) => (
                <tr key={d.id} className={d.status === 'revoked' ? 'voided' : ''}>
                  <td>{d.counterName}</td>
                  <td>
                    {d.status === 'enrolled'
                      ? <span className={`tag ${d.online ? 'ok' : 'warn'}`}>{d.online ? '● Online' : '○ Offline'}</span>
                      : <span className={`tag ${d.status === 'revoked' ? 'bad' : 'warn'}`}>{d.status}</span>}
                  </td>
                  <td>{templeTime(d.lastSeenAt, true)}</td>
                  <td className="num">{d.pendingCount ?? 0}</td>
                  <td>{d.appVersion || '—'}{d.platform ? ` (${d.platform})` : ''}</td>
                  <td>{d.modelVersion || '—'}</td>
                  <td className="num">{isAdmin && d.status !== 'revoked' && <button className="danger small" onClick={() => revoke(d)}>Revoke</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      </Status>
    </>
  );
}
