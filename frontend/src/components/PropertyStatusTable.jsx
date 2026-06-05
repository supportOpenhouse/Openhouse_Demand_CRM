import { useMemo, useState } from 'react';
import { buildKhMap, buildPropertyStatusRows, PS_COLUMNS, sortRows, psToCsv } from '../lib/propertyStatus.js';

const INVENTORY_SHEET_URL = 'https://docs.google.com/spreadsheets/d/1-kxlCnXUv7absl4rpWeMoYIxSAHpWykyjpd9v_5df-o/edit';
const int = (n) => (n || 0).toLocaleString('en-IN');

function downloadCsv(rows) {
  const blob = new Blob([psToCsv(rows)], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'oh-property-status.csv';
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(a.href);
}

export default function PropertyStatusTable({ seed, filters = {}, khItems = [], khSource = 'unset' }) {
  const [sortKey, setSortKey] = useState('total');
  const [sortDir, setSortDir] = useState('desc');

  const khMap = useMemo(() => buildKhMap(khItems), [khItems]);
  const allRows = useMemo(
    () => buildPropertyStatusRows(seed.properties || [], seed.visits || [], khMap),
    [seed, khMap],
  );

  // respect the page's City / Society filters (the buyer-name box is visit-only —
  // property rows have no buyer field, so applying it would wrongly empty the table).
  const filtered = useMemo(() => {
    const cities = filters.cities || [];
    const socs = filters.societies || [];
    return allRows.filter((r) => {
      if (cities.length && !cities.includes(r.city)) return false;
      if (socs.length && !socs.includes(r.society)) return false;
      return true;
    });
  }, [allRows, filters]);

  const rows = useMemo(() => sortRows(filtered, sortKey, sortDir), [filtered, sortKey, sortDir]);

  const onSort = (k) => {
    if (sortKey === k) { setSortDir((d) => (d === 'asc' ? 'desc' : 'asc')); return; }
    setSortKey(k);
    setSortDir(['region', 'society', 'unit', 'config', 'responsible'].includes(k) ? 'asc' : 'desc');
  };

  const matched = useMemo(() => allRows.filter((r) => r.kh_date).length, [allRows]);

  return (
    <div className="an-card an-card-wide">
      <div className="an-card-h">
        <div>
          <div className="an-card-t">Property Status <span className="an-card-s">({int(rows.length)} properties)</span></div>
          <div className="an-card-s" style={{ marginTop: 3 }}>
            Unit-level ageing &amp; visit-bucket report. Respects City / Society filters.
            {khSource === 'connected' && ` · ${int(matched)} matched a key-handover date.`}
            {khSource === 'unset' && ' · KH date: set PROPERTIES_DATABASE_URL to enable.'}
            {khSource === 'error' && ' · KH source unreachable.'}
          </div>
        </div>
        <div className="an-table-actions">
          <button type="button" className="an-btn" onClick={() => downloadCsv(rows)}>⬇ CSV</button>
          <button type="button" className="an-btn ghost" onClick={() => window.open(INVENTORY_SHEET_URL, '_blank', 'noopener')}>↗ Open in Sheets</button>
        </div>
      </div>
      <div className="ps-wrap">
        <table className="ps-table">
          <thead>
            <tr>
              {PS_COLUMNS.map((c) => (
                <th key={c.k} className={(c.type !== 'text' ? 'num ' : '') + (sortKey === c.k ? 'sorted' : '')} onClick={() => onSort(c.k)}>
                  {c.label}<span className="ps-sort">{sortKey === c.k ? (sortDir === 'asc' ? '▲' : '▼') : '↕'}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={`${r.society}|${r.unit}|${i}`}>
                <td>{r.region || '—'}</td>
                <td className="ps-strong">{r.society || '—'}</td>
                <td>{r.unit || '—'}</td>
                <td>{r.config || '—'}</td>
                <td>{r.flat_status || '—'}</td>
                <td>{r.ask_price || '—'}</td>
                <td>{r.responsible || '—'}</td>
                <td className="ps-kh">{r.kh_date || '—'}</td>
                <td className="num ps-kh">{r.days_since_kh == null ? '—' : r.days_since_kh}</td>
                <td className="num">{r.total}</td>
                <td className="num">{r.lastWeek}</td>
                <td className="num">{r.prevWeek}</td>
                <td className="num">{r.hot}</td>
                <td className="num">{r.warm}</td>
                <td className="num">{r.cold}</td>
                <td className="num">{r.revisit}</td>
                <td className="num">{r.negotiation}</td>
                <td className="num">{r.booking}</td>
                <td className="num">{r.not_interested}</td>
                <td className="num">{r.need_more}</td>
                <td className="num">{r.future_prospect}</td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr><td colSpan={PS_COLUMNS.length}><div className="an-empty">No properties match the current filters.</div></td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
