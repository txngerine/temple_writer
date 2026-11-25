import { useState } from 'react';
import { Status, useLoad } from '../App.jsx';
import { api, rupees } from '../api/client.js';
import OfferingsImport from './OfferingsImport.jsx';

const BLANK = { labelMal: '', labelEng: '', price: '', priceIsFixed: true, quickPick: false, sortOrder: 100 };

export default function Offerings({ user }) {
  const canEdit = ['admin', 'supervisor'].includes(user.role);
  const { data, error, loading, reload } = useLoad(() => api('/offerings'), []);
  const [draft, setDraft] = useState({});      // id -> price being typed
  const [actionError, setActionError] = useState(null);
  const [adding, setAdding] = useState(null);
  const [importing, setImporting] = useState(false);
  const [imported, setImported] = useState(null);

  async function patch(o, body) {
    setActionError(null);
    try {
      await api(`/offerings/${o.id}`, { method: 'PATCH', body });
      setDraft((d) => ({ ...d, [o.id]: undefined }));
      reload();
    } catch (e) {
      setActionError(`${o.labelEng}: ${e.message}`);
    }
  }

  async function add(e) {
    e.preventDefault();
    setActionError(null);
    try {
      await api('/offerings', { method: 'POST', body: { ...adding, price: adding.priceIsFixed ? adding.price : null } });
      setAdding(null);
      reload();
    } catch (err) {
      setActionError(err.message);
    }
  }

  const unpriced = (data?.offerings || []).filter((o) => o.priceIsFixed && o.price == null).length;
  return (
    <>
      <header className="page-head">
        <h1>Offerings &amp; prices</h1>
        {canEdit && (
          <div className="filters">
            <button onClick={() => { setImporting(!importing); setAdding(null); setImported(null); }}>Import from Excel</button>
            <button className="primary" onClick={() => { setAdding(adding ? null : { ...BLANK }); setImporting(false); }}>{adding ? 'Cancel' : 'Add offering'}</button>
          </div>
        )}
      </header>
      {imported && (
        <div className="notice success">
          Imported: {imported.created} added, {imported.updated} updated
          {imported.errors > 0 ? `, ${imported.errors} skipped` : ''}.
        </div>
      )}
      {importing && (
        <OfferingsImport
          onCancel={() => setImporting(false)}
          onDone={(result) => { setImporting(false); setImported(result); reload(); }}
        />
      )}
      {unpriced > 0 && (
        <div className="notice">
          {unpriced} offering{unpriced > 1 ? 's have' : ' has'} no price yet. An offering reaches the counters only once it is priced and switched on.
        </div>
      )}
      {actionError && <div className="notice error">{actionError}</div>}

      {adding && (
        <form className="card form-row" onSubmit={add}>
          <label>Malayalam<input value={adding.labelMal} onChange={(e) => setAdding({ ...adding, labelMal: e.target.value })} required /></label>
          <label>English<input value={adding.labelEng} onChange={(e) => setAdding({ ...adding, labelEng: e.target.value })} required /></label>
          <label className="check"><input type="checkbox" checked={!adding.priceIsFixed} onChange={(e) => setAdding({ ...adding, priceIsFixed: !e.target.checked })} />Devotee chooses the amount</label>
          {adding.priceIsFixed && (
            <label>Price (₹)<input className="narrow" type="number" min="0" step="any" value={adding.price} onChange={(e) => setAdding({ ...adding, price: e.target.value })} /></label>
          )}
          <button className="primary">Save</button>
        </form>
      )}

      <Status loading={loading} error={error}>
        <section className="card">
          <table>
            <thead>
              <tr><th>Offering</th><th>English</th><th>Price</th><th>Quick pick</th><th>At the counters</th></tr>
            </thead>
            <tbody>
              {(data?.offerings || []).map((o) => {
                const typed = draft[o.id];
                const dirty = typed !== undefined && typed !== String(o.price ?? '');
                return (
                  <tr key={o.id}>
                    <td>{o.labelMal}</td>
                    <td>{o.labelEng}</td>
                    <td>
                      {!o.priceIsFixed ? <span className="muted">Devotee chooses</span> : canEdit ? (
                        <form className="inline" onSubmit={(e) => { e.preventDefault(); if (dirty) patch(o, { price: typed }); }}>
                          <span>₹</span>
                          <input className="narrow" type="number" min="0" step="any" placeholder="not set"
                            value={typed ?? (o.price ?? '')} onChange={(e) => setDraft({ ...draft, [o.id]: e.target.value })} />
                          {dirty && <button className="small primary">Save</button>}
                        </form>
                      ) : (o.price == null ? <span className="muted">Not set</span> : rupees(o.price))}
                    </td>
                    <td>
                      <input type="checkbox" checked={o.quickPick} disabled={!canEdit} onChange={(e) => patch(o, { quickPick: e.target.checked })} />
                    </td>
                    <td>
                      <label className="check">
                        <input type="checkbox" checked={o.active} disabled={!canEdit} onChange={(e) => patch(o, { active: e.target.checked })} />
                        {o.active ? 'On' : 'Off'}
                      </label>
                    </td>
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
