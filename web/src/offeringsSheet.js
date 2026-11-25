import { readSheet } from 'read-excel-file/browser';

// Column headings we recognise, matched ignoring case, spaces and punctuation.
const ALIASES = {
  labelMal: ['malayalam', 'labelmal', 'offering', 'name', 'മലയാളം'],
  labelEng: ['english', 'labeleng'],
  price: ['price', 'amount', 'rate', 'rs', 'inr'],
  devoteeChooses: ['devoteechooses', 'devoteechoosestheamount', 'chooses', 'variable', 'devoteechosen'],
  active: ['active', 'on', 'atthecounters', 'live'],
  quickPick: ['quickpick'],
};
const DEFAULT_ORDER = ['labelMal', 'labelEng', 'price', 'devoteeChooses', 'active'];
const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9ഀ-ൿ]/g, '');

/** "yes"/"y"/"true"/"1"/"x"/"on" -> true, "no"/"n"/"false"/"0"/"off" -> false, blank -> undefined. */
function toBool(v) {
  if (v === true || v === false) return v;
  const s = norm(v);
  if (!s) return undefined;
  if (['yes', 'y', 'true', '1', 'x', 'on'].includes(s)) return true;
  if (['no', 'n', 'false', '0', 'off'].includes(s)) return false;
  return undefined;
}

function toPrice(v) {
  if (v === '' || v == null) return '';
  if (typeof v === 'number') return v;
  const cleaned = String(v).replace(/[^0-9.\-]/g, '');
  return cleaned === '' ? String(v) : Number(cleaned); // a non-number is passed on so the server can reject it
}

/** Minimal CSV reader: quotes, escaped quotes, BOM, and , or ; as the separator. */
function parseCsv(text) {
  const src = text.replace(/^﻿/, '');
  const first = src.split('\n')[0];
  const sep = (first.match(/;/g) || []).length > (first.match(/,/g) || []).length ? ';' : ',';
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') quoted = false; else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === sep) { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(cell); cell = ''; rows.push(row); row = [];
    } else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

/** Reads an .xlsx or .csv file into offering rows ready for POST /offerings/import. */
export async function readOfferingsFile(file) {
  const grid = /\.csv$/i.test(file.name) ? parseCsv(await file.text()) : await readSheet(file);
  const lines = grid.filter((r) => r.some((c) => String(c ?? '').trim() !== ''));
  if (lines.length === 0) throw new Error('The file is empty.');

  // Use the first line as headings if any cell in it is a known heading.
  const heads = lines[0].map(norm);
  const map = {};
  heads.forEach((h, i) => {
    for (const [key, names] of Object.entries(ALIASES)) if (names.includes(h) && !(key in map)) map[key] = i;
  });
  const hasHeader = Object.keys(map).length > 0;
  if (!hasHeader) DEFAULT_ORDER.forEach((k, i) => { map[k] = i; });
  if (!('labelMal' in map)) throw new Error('Could not find a "Malayalam" column in the first row.');

  return (hasHeader ? lines.slice(1) : lines).map((r) => {
    const get = (k) => (k in map ? r[map[k]] : undefined);
    const row = {
      labelMal: String(get('labelMal') ?? '').trim(),
      labelEng: String(get('labelEng') ?? '').trim(),
      price: toPrice(get('price')),
    };
    if (toBool(get('devoteeChooses')) === true) row.priceIsFixed = false;
    const active = toBool(get('active'));
    if (active !== undefined) row.active = active;
    const quick = toBool(get('quickPick'));
    if (quick !== undefined) row.quickPick = quick;
    return row;
  });
}

/** Downloads a starter sheet (CSV, which Excel opens) showing the columns. */
export function downloadTemplate() {
  const csv = '﻿' + [
    'Malayalam,English,Price,Devotee chooses,Active',
    'അർച്ചന,Archana,50,,yes',
    'തുലാഭാരം,Thulabharam,,yes,yes',
    'പുതിയ വഴിപാട്,New offering,120,,',
  ].join('\r\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  a.download = 'offerings-template.csv';
  a.click();
  URL.revokeObjectURL(a.href);
}
