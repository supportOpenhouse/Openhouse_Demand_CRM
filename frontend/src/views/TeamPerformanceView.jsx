// Team Performance (Admin only) — Ground (grouped by dominant micro-market) and
// KAM (flat) tables. Backend columns are computed from the seed (read-only);
// manual columns are admin-editable and persisted to team_perf_manual. Counts use
// completed visits only and respect the Date + City filters. Self-contained `tp-`
// styles so app.css / theme.css stay untouched.
import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { buildGround, buildKam, GROUND_COLS, KAM_COLS, teamPerfCities, fmtCell } from '../lib/teamPerf.js';
import { loadTeamPerfManual, setTeamPerfManual } from '../api.js';
import { toast } from '../lib/toast.js';

const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
function monthStart() { const d = new Date(); return ymd(new Date(d.getFullYear(), d.getMonth(), 1)); }
function daysAgo(n) { const d = new Date(); d.setDate(d.getDate() - n); return ymd(d); }

function ManualCell({ row, col, onSave }) {
  const [editing, setEditing] = useState(false);
  const val = row[col.k] || '';
  if (editing) {
    return (
      <td className="tp-num tp-man">
        <input autoFocus defaultValue={val} className="tp-inp"
          onBlur={(e) => { setEditing(false); const v = e.target.value.trim(); if (v !== val) onSave(row, col.k, v); }}
          onKeyDown={(e) => { if (e.key === 'Enter') e.target.blur(); else if (e.key === 'Escape') setEditing(false); }} />
      </td>
    );
  }
  return (
    <td className="tp-num tp-man" title="Manual — click to edit" onClick={() => setEditing(true)}>
      {val !== '' ? fmtCell(val, col) : <span className="tp-add">+ set</span>}
    </td>
  );
}

function Row({ row, cols, saveManual, isTotal }) {
  return (
    <tr className={isTotal ? 'tp-total' : ''}>
      <td className="tp-name">{row.name}</td>
      {cols.map((c) => {
        if (c.kind === 'manual' && !isTotal) return <ManualCell key={c.k} row={row} col={c} onSave={saveManual} />;
        return <td key={c.k} className={'tp-num' + (c.kind === 'manual' ? ' tp-man' : '')}>
          {isTotal && c.kind === 'manual' ? '' : fmtCell(row[c.k], c)}</td>;
      })}
    </tr>
  );
}

export default function TeamPerformanceView({ seed }) {
  const [tab, setTab] = useState('ground');
  const [manual, setManual] = useState({});
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [cities, setCities] = useState([]);
  const allCities = useMemo(() => teamPerfCities(seed), [seed]);

  useEffect(() => {
    let alive = true;
    loadTeamPerfManual().then((d) => alive && setManual(d.manual || {})).catch(() => { /* admin-only; ignore */ });
    return () => { alive = false; };
  }, []);

  const saveManual = useCallback(async (row, key, value) => {
    const prev = manual;
    setManual((m) => ({ ...m, [row.slug]: { ...(m[row.slug] || {}), [key]: value } }));
    try {
      await setTeamPerfManual({ person_slug: row.slug, metric_key: key, value });
      toast(value ? 'Saved' : 'Cleared', 'good');
    } catch (e) { setManual(prev); toast('Save failed: ' + e.message, 'bad'); }
  }, [manual]);

  const ground = useMemo(() => buildGround(seed, manual, { from, to, cities }), [seed, manual, from, to, cities]);
  const kam = useMemo(() => buildKam(seed, manual, { from, to, cities }), [seed, manual, from, to, cities]);
  const cols = tab === 'ground' ? GROUND_COLS : KAM_COLS;
  const toggleCity = (c) => setCities((cs) => (cs.includes(c) ? cs.filter((x) => x !== c) : [...cs, c]));

  return (
    <div className="tp-root">
      <style>{TP_CSS}</style>

      <div className="tp-bar">
        <div className="tp-tabs">
          <button type="button" className={'tp-tab' + (tab === 'ground' ? ' on' : '')} onClick={() => setTab('ground')}>Ground Team</button>
          <button type="button" className={'tp-tab' + (tab === 'kam' ? ' on' : '')} onClick={() => setTab('kam')}>KAM</button>
        </div>
        <div className="tp-filters">
          <span className="tp-lbl">Date</span>
          <input type="date" className="tp-date" value={from} onChange={(e) => setFrom(e.target.value)} />
          <span className="tp-dash">→</span>
          <input type="date" className="tp-date" value={to} onChange={(e) => setTo(e.target.value)} />
          <button type="button" className="tp-preset" onClick={() => { setFrom(monthStart()); setTo(ymd(new Date())); }}>This month</button>
          <button type="button" className="tp-preset" onClick={() => { setFrom(daysAgo(30)); setTo(ymd(new Date())); }}>30d</button>
          <button type="button" className="tp-preset" onClick={() => { setFrom(''); setTo(''); }}>All</button>
        </div>
      </div>

      {allCities.length > 0 && (
        <div className="tp-cities">
          <span className="tp-lbl">City</span>
          {allCities.map((c) => (
            <button key={c} type="button" className={'tp-chip' + (cities.includes(c) ? ' on' : '')} onClick={() => toggleCity(c)}>{c}</button>
          ))}
          {cities.length > 0 && <button type="button" className="tp-chip clear" onClick={() => setCities([])}>clear</button>}
        </div>
      )}

      <div className="tp-note">
        Backend columns (plain) are computed live from completed visits — read-only. Tinted columns are admin-entered.
        {from || to ? ` · ${from || '…'} → ${to || '…'}` : ' · all dates'}
      </div>

      <div className="tp-wrap">
        <table className="tp-table">
          <thead>
            <tr>
              <th className="tp-name">{tab === 'ground' ? 'Property Manager' : 'KAM'}</th>
              {cols.map((c) => <th key={c.k} className={'tp-num' + (c.kind === 'manual' ? ' tp-man' : '')}>{c.label}</th>)}
            </tr>
          </thead>
          <tbody>
            {tab === 'ground' ? (
              <>
                {ground.groups.map((g) => (
                  <Fragment key={g.mm}>
                    <tr className="tp-mm"><td colSpan={cols.length + 1}>{g.mm}</td></tr>
                    {g.rows.map((r) => <Row key={r.slug} row={r} cols={cols} saveManual={saveManual} />)}
                    <Row row={{ ...g.subtotal, name: 'Total' }} cols={cols} isTotal />
                  </Fragment>
                ))}
                {ground.groups.length === 0 && <tr><td colSpan={cols.length + 1}><div className="tp-empty">No assigned properties match the filters.</div></td></tr>}
                {ground.groups.length > 0 && <Row row={{ ...ground.grand, name: 'Grand Total' }} cols={cols} isTotal />}
              </>
            ) : (
              <>
                {kam.rows.map((r) => <Row key={r.slug} row={r} cols={cols} saveManual={saveManual} />)}
                {kam.rows.length === 0 && <tr><td colSpan={cols.length + 1}><div className="tp-empty">No KAM data matches the filters.</div></td></tr>}
                {kam.rows.length > 0 && <Row row={{ ...kam.overall, name: 'Overall' }} cols={cols} isTotal />}
              </>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

const TP_CSS = `
.tp-root{font-size:13px;color:var(--ink)}
.tp-bar{display:flex;flex-wrap:wrap;gap:12px;align-items:center;justify-content:space-between;margin-bottom:10px}
.tp-tabs{display:inline-flex;gap:4px;background:var(--panel,#fff);border:1px solid var(--line);border-radius:10px;padding:3px}
.tp-tab{border:none;background:transparent;padding:7px 16px;border-radius:8px;font-size:13px;font-weight:700;color:var(--mut);cursor:pointer}
.tp-tab.on{background:var(--acc,#F4541C);color:#fff}
.tp-filters{display:inline-flex;gap:6px;align-items:center;flex-wrap:wrap}
.tp-lbl{font-size:11px;font-weight:700;color:var(--mut);text-transform:uppercase;letter-spacing:.03em;margin-right:2px}
.tp-date{border:1px solid var(--line);border-radius:8px;padding:5px 8px;font:inherit;font-size:12.5px;background:#fff;color:var(--ink)}
.tp-dash{color:var(--mut)}
.tp-preset{border:1px solid var(--line);background:#fff;border-radius:8px;padding:5px 9px;font-size:12px;font-weight:600;color:var(--ink);cursor:pointer}
.tp-preset:hover{border-color:var(--acc,#F4541C);color:var(--acc,#F4541C)}
.tp-cities{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin-bottom:10px}
.tp-chip{border:1px solid var(--line);background:#fff;border-radius:999px;padding:4px 11px;font-size:12px;font-weight:600;color:#55504a;cursor:pointer}
.tp-chip.on{background:var(--acc,#F4541C);border-color:var(--acc,#F4541C);color:#fff}
.tp-chip.clear{color:var(--mut)}
.tp-note{font-size:11.5px;color:var(--mut);margin-bottom:8px}
.tp-wrap{overflow:auto;border:1px solid var(--line);border-radius:12px;background:var(--panel,#fff)}
.tp-table{border-collapse:separate;border-spacing:0;width:100%;font-size:12.5px}
.tp-table th,.tp-table td{padding:8px 10px;border-bottom:1px solid var(--line);white-space:nowrap;text-align:right}
.tp-table th{position:sticky;top:0;background:var(--bg,#F6F4F0);font-size:11px;font-weight:700;color:#4a4640;z-index:2;vertical-align:bottom}
.tp-name{text-align:left!important;position:sticky;left:0;background:var(--panel,#fff);min-width:180px;font-weight:600;z-index:1}
.tp-table th.tp-name{z-index:3;background:var(--bg,#F6F4F0)}
.tp-num{text-align:right;font-variant-numeric:tabular-nums}
.tp-man{background:var(--tint,#FEEEE7)}
.tp-table th.tp-man{background:#fbe3d8}
.tp-man{cursor:pointer}
.tp-add{color:var(--acc,#F4541C);font-weight:600}
.tp-inp{width:64px;border:1px solid var(--acc,#F4541C);border-radius:6px;padding:2px 5px;font:inherit;font-size:12.5px;text-align:right}
.tp-mm td{background:var(--bg,#F6F4F0);font-weight:800;font-size:11.5px;letter-spacing:.03em;text-transform:uppercase;color:#6b665f;text-align:left!important}
.tp-total td{font-weight:800;background:#faf8f5}
.tp-total .tp-name{background:#faf8f5}
.tp-empty{padding:26px;text-align:center;color:var(--mut)}
`;
