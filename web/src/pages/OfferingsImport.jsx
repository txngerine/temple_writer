import { useRef, useState } from 'react';
import { api, rupees } from '../api/client.js';
import { downloadTemplate, readOfferingsFile } from '../offeringsSheet.js';

const LABEL = { create: 'New', update: 'Update', error: 'Problem' };

/**
 * Add or update offerings from an Excel (.xlsx) or CSV sheet.
 * Pick a file -> see what each row would do -> confirm. Nothing is saved until
 * "Import" is pressed; rows with a problem are skipped, the rest go in.
 */
export default function OfferingsImport({ onDone, onCancel }) {
  const fileInput = useRef(null);
  const [fileName, setFileName] = useState('');
  const [rows, setRows] = useState(null);
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function choose(e) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setError(null);
    setPreview(null);
    setRows(null);
    setFileName(file.name);
    setBusy(true);
    try {
      const parsed = await readOfferingsFile(file);
      setRows(parsed);
      setPreview(await api('/offerings/import', { method: 'POST', body: { rows: parsed, dryRun: true } }));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function run() {
    setBusy(true);
    setError(null);
    try {
      const done = await api('/offerings/import', { method: 'POST', body: { rows } });
      onDone(done);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  const ok = preview ? preview.created + preview.updated : 0;
  return (
    <section className="card">
      <h2>Import offerings from a spreadsheet</h2>
      <p className="muted" style={{ marginTop: 0 }}>
        Columns: <strong>Malayalam</strong>, <strong>English</strong>, <strong>Price</strong>,{' '}
        <strong>Devotee chooses</strong> (yes for no fixed price), <strong>Active</strong> (optional).
        A row whose Malayalam name already exists updates that offering; any other row adds a new one.{' '}
        <button type="button" className="link-btn" onClick={downloadTemplate}>Download a template</button>
      </p>
      <div className="form-row">
        <input ref={fileInput} type="file" accept=".xlsx,.csv" onChange={choose} hidden />
        <button type="button" onClick={() => fileInput.current?.click()} disabled={busy}>
          {fileName ? 'Choose another file' : 'Choose Excel file'}
        </button>
        {fileName && <span className="muted">{fileName}</span>}
        <button type="button" onClick={onCancel} disabled={busy}>Cancel</button>
      </div>

      {error && <div className="notice error" style={{ marginTop: 14 }}>{error}</div>}

      {preview && (
        <>
          <div className="notice" style={{ margin: '14px 0' }}>
            <strong>{preview.created}</strong> new · <strong>{preview.updated}</strong> to update
            {preview.errors > 0 && (
              <> · <strong style={{ color: 'var(--bad)' }}>{preview.errors} with a problem (will be skipped)</strong></>
            )}
          </div>
          <table>
            <thead>
              <tr><th>#</th><th>Malayalam</th><th>English</th><th className="num">Price</th><th>Counters</th><th>Result</th></tr>
            </thead>
            <tbody>
              {preview.results.map((r) => (
                <tr key={r.row} className={r.status === 'error' ? 'voided' : ''}>
                  <td>{r.row}</td>
                  <td>{r.labelMal || '—'}</td>
                  <td>{r.labelEng || '—'}</td>
                  <td className="num">
                    {r.status === 'error' ? '' : r.priceIsFixed
                      ? (r.price == null ? '—' : rupees(r.price))
                      : <span className="muted">Devotee chooses</span>}
                  </td>
                  <td>{r.status === 'error' ? '' : r.active ? 'On' : 'Off'}</td>
                  <td>
                    <span className={`tag ${r.status === 'create' ? 'ok' : r.status === 'update' ? '' : 'bad'}`}>{LABEL[r.status]}</span>
                    {r.error && <span className="muted"> {r.error}</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="form-row" style={{ marginTop: 14 }}>
            <button type="button" className="primary" onClick={run} disabled={busy || ok === 0}>
              {busy ? 'Importing…' : `Import ${ok} offering${ok === 1 ? '' : 's'}`}
            </button>
          </div>
        </>
      )}
    </section>
  );
}
