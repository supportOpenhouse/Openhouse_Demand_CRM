import { useMemo, useState, useEffect, useCallback } from 'react';
import { buildKhMap, buildPropertyStatusRows, PS_COLUMNS, sortRows, psToCsv } from '../lib/propertyStatus.js';
import { setKhOverride } from '../api.js';
import { toast } from '../lib/toast.js';

const INVENTORY_SHEET_URL = 'https://docs.google.com/spreadsheets/d/1-kxlCnXUv7absl4rpWeMoYIxSAHpWykyjpd9v_5df-o/edit';
const int = (n) => (n || 0).toLocaleString('en-IN');

// frozen identity columns (stay visible while scrolling the 18 count columns)
const STICK = { region: { left: 0, w: 116 }, society: { left: 116, w: 188 }, unit: { left: 304, w: 92 } };
// colored bucket cells (zeros are muted)
const BUCKET_COLOR = {
  hot: 'var(--bad)', warm: 'var(--warn)', cold: 'var(--cold,#3B82F6)',
  revisit: 'var(--blue,#3B82F6)', negotiation: 'var(--warn)', booking: 'var(--good)',
  not_interested: 'var(--mut)', need_more: 'var(--mut)', future_prospect: 'var(--purple,#8B5CF6)',
};
const STATUS_CLS = { Ready: 'good', Available: 'good', Booked: 'info', 'Coming Soon': 'warn' };
const khAgeColor = (d) => (d == null ? undefined : d > 150 ? 'var(--bad)' : d > 90 ? 'var(--warn)' : 'var(--mut)');

function Num({ n, color }) {
  if (!n) return <span className="ps-zero">0</span>;
  return <b style={color ? { color } : undefined}>{int(n)}</b>;
}

function downloadCsv(rows) {
  const blob = new Blob([psToCsv(rows)], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'oh-property-status.csv';
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(a.href);
}

// KH date cell. For admins on a unit with a home_id it's click-to-edit (a native date
// picker); the value is persisted to the backend and wins over the matched date. ✎ marks
// a manually-set value. Non-admins (or unmapped units) see a read-only date.
function KhCell({ row, canEdit, onSave }) {
  const [editing, setEditing] = useState(false);
  const editable = canEdit && !!row.home_id;
  if (editing) {
    return (
      <td className="ps-kh">
        <input type="date" defaultValue={row.kh_date || ''} autoFocus
          style={{ font: 'inherit', padding: '1px 3px', border: '1px solid var(--acc)', borderRadius: 4, width: 132 }}
          onBlur={(e) => { setEditing(false); const v = e.target.value || ''; if (v !== (row.kh_date || '')) onSave(row, v); }}
          onKeyDown={(e) => { if (e.key === 'Enter') e.target.blur(); else if (e.key === 'Escape') setEditing(false); }} />
      </td>
    );
  }
  return (
    <td className="ps-kh" style={editable ? { cursor: 'pointer' } : undefined}
        title={editable ? 'Click to set / edit the key-handover date' : undefined}
        onClick={editable ? () => setEditing(true) : undefined}>
      {row.kh_date || (editable ? <span style={{ color: 'var(--acc)' }}>+ set</span> : '—')}
      {row.kh_overridden && <span title="Manually set" style={{ marginLeft: 4, color: 'var(--acc)', fontSize: 10 }}>✎</span>}
    </td>
  );
}

export default function PropertyStatusTable({ seed, filters = {}, khItems = [], khOverrides = {}, khSource = 'unset' }) {
  const me = seed.current_user || {};
  const canEditKh = me.team === 'Admin';   // KH editing is admin-only (the backend enforces it too)
  const [sortKey, setSortKey] = useState('total');
  const [sortDir, setSortDir] = useState('desc');
  // manual KH overrides: server truth synced in; a local edit applies immediately and persists.
  const [overrides, setOverrides] = useState(khOverrides || {});
  useEffect(() => { setOverrides(khOverrides || {}); }, [khOverrides]);
  const saveKh = useCallback(async (row, dateStr) => {
    if (!row.home_id) return;
    const prev = overrides;
    setOverrides((o) => { const n = { ...o }; if (dateStr) n[row.home_id] = dateStr; else delete n[row.home_id]; return n; });
    try {
      await setKhOverride({ home_id: row.home_id, society_name: row.society, unit_no: row.unit, kh_date: dateStr });
      toast(dateStr ? 'Key-handover date saved' : 'Override cleared', 'good');
    } catch (e) { setOverrides(prev); toast('Save failed: ' + e.message, 'bad'); }
  }, [overrides]);

  const khMap = useMemo(() => buildKhMap(khItems), [khItems]);
  const allRows = useMemo(
    () => buildPropertyStatusRows(seed.properties || [], seed.visits || [], khMap, overrides),
    [seed, khMap, overrides],
  );

  // respect the page's City / Society filters (buyer-name box is visit-only)
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
  const matched = useMemo(() => allRows.filter((r) => r.kh_date).length, [allRows]);
  const totals = useMemo(() => {
    const t = { total: 0, lastWeek: 0, prevWeek: 0, week3: 0, week4: 0, lastMonth: 0, hot: 0, warm: 0, cold: 0, revisit: 0, negotiation: 0, booking: 0, not_interested: 0, need_more: 0, future_prospect: 0 };
    rows.forEach((r) => Object.keys(t).forEach((k) => { t[k] += r[k] || 0; }));
    return t;
  }, [rows]);

  const onSort = (k) => {
    if (sortKey === k) { setSortDir((d) => (d === 'asc' ? 'desc' : 'asc')); return; }
    setSortKey(k);
    setSortDir(['region', 'society', 'unit', 'config', 'responsible'].includes(k) ? 'asc' : 'desc');
  };

  const BUCKETS = ['hot', 'warm', 'cold', 'revisit', 'negotiation', 'booking', 'not_interested', 'need_more', 'future_prospect'];

  return (
    <div className="an-card an-card-wide">
      <div className="an-card-h">
        <div>
          <div className="an-card-t">Property Status <span className="an-card-s">({int(rows.length)} properties)</span></div>
          <div className="an-card-s" style={{ marginTop: 3 }}>
            Completed visits only, by scheduled visit date. Respects City / Society filters.
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
              {PS_COLUMNS.map((c, i) => (
                <th key={c.k}
                    className={(c.type !== 'text' ? 'num ' : '') + (STICK[c.k] ? 'ps-f ' : '') + (sortKey === c.k ? 'sorted' : '')}
                    style={STICK[c.k] ? { left: STICK[c.k].left, minWidth: STICK[c.k].w } : undefined}
                    onClick={() => onSort(c.k)}>
                  {c.label}<span className="ps-sort">{sortKey === c.k ? (sortDir === 'asc' ? '▲' : '▼') : '↕'}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={`${r.society}|${r.unit}|${i}`}>
                <td className="ps-f" style={{ left: STICK.region.left, minWidth: STICK.region.w }}>{r.region || '—'}</td>
                <td className="ps-f ps-strong" style={{ left: STICK.society.left, minWidth: STICK.society.w }}>{r.society || '—'}</td>
                <td className="ps-f ps-edge" style={{ left: STICK.unit.left, minWidth: STICK.unit.w }}>{r.unit || '—'}</td>
                <td>{r.config || '—'}</td>
                <td>{r.flat_status ? <span className={'ps-pill ' + (STATUS_CLS[r.flat_status] || '')}>{r.flat_status}</span> : '—'}</td>
                <td className="ps-strong">{r.ask_price || '—'}</td>
                <td>{r.responsible || '—'}</td>
                <KhCell row={r} canEdit={canEditKh} onSave={saveKh} />
                <td className="num ps-kh"><b style={{ color: khAgeColor(r.days_since_kh) }}>{r.days_since_kh == null ? '—' : r.days_since_kh}</b></td>
                <td className="num"><Num n={r.total} color="var(--ink)" /></td>
                <td className="num"><Num n={r.lastWeek} color="var(--acc)" /></td>
                <td className="num"><Num n={r.prevWeek} /></td>
                <td className="num"><Num n={r.week3} /></td>
                <td className="num"><Num n={r.week4} /></td>
                <td className="num"><Num n={r.lastMonth} /></td>
                {BUCKETS.map((b) => <td key={b} className="num"><Num n={r[b]} color={BUCKET_COLOR[b]} /></td>)}
              </tr>
            ))}
            {rows.length === 0 && (
              <tr><td colSpan={PS_COLUMNS.length}><div className="an-empty">No properties match the current filters.</div></td></tr>
            )}
          </tbody>
          {rows.length > 0 && (
            <tfoot>
              <tr className="ps-foot">
                <td className="ps-f" style={{ left: STICK.region.left, minWidth: STICK.region.w }}>Totals</td>
                <td className="ps-f" style={{ left: STICK.society.left, minWidth: STICK.society.w }}>{int(rows.length)} properties</td>
                <td className="ps-f ps-edge" style={{ left: STICK.unit.left, minWidth: STICK.unit.w }} />
                <td /><td /><td /><td /><td className="ps-kh" /><td className="num ps-kh" />
                <td className="num"><b>{int(totals.total)}</b></td>
                <td className="num"><b>{int(totals.lastWeek)}</b></td>
                <td className="num"><b>{int(totals.prevWeek)}</b></td>
                <td className="num"><b>{int(totals.week3)}</b></td>
                <td className="num"><b>{int(totals.week4)}</b></td>
                <td className="num"><b>{int(totals.lastMonth)}</b></td>
                {BUCKETS.map((b) => <td key={b} className="num"><b>{int(totals[b])}</b></td>)}
              </tr>
            </tfoot>
          )}
        </table>
      </div>
    </div>
  );
}
