// Daily Sales Report (Admin team + area managers; the backend enforces access and
// returns 403 otherwise). One row per PM grouped by area -> city -> total, month-to-date
// up to the picked date (IST). All numbers come from GET /api/dsr — nothing is computed
// here except formatting. The "Targets & team" panel edits the month's area targets and
// the area/PM manager mapping; it degrades gracefully (409) until the settings tables exist.
import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { loadDsr, loadDsrSettings, setDsrTarget, setDsrAreaManager, setDsrPmManager, dsrExportUrl } from '../api.js';
import { toast } from '../lib/toast.js';

const todayIST = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }); // YYYY-MM-DD

// Column layout follows the sample sheet's group headers.
const GROUPS = [
  { label: 'IDENTITY', span: 3 },
  { label: 'TARGETS', span: 2 },
  { label: 'ACTIVITY', span: 3 },
  { label: 'QUALITY', span: 7 },
  { label: 'OUTCOME', span: 2 },
  { label: 'EFFICIENCY', span: 2 },
];
const COLS = [
  { k: 'target', label: 'Target', t: 'n' },
  { k: 'ach_pct', label: 'Ach %', t: 'p' },
  { k: 'cp_meetings', today: 'cp_meetings_today', label: 'CP meetings (today)', t: 'n' },
  { k: 'weekly_visit_avg', label: 'Weekly visit avg', t: 'd' },
  { k: 'visits', today: 'visits_today', label: 'Visits (today)', t: 'n' },
  { k: 'assisted_pct', label: 'Assisted %', t: 'p' },
  { k: 'fu48_pct', label: 'Follow-up 48h %', t: 'p' },
  { k: 'fu_any_pct', label: 'Any follow-up %', t: 'p' },
  { k: 'revisit_sched_pct', label: 'Revisit sched %', t: 'p' },
  { k: 'revisit_done_pct', label: 'Revisit done %', t: 'p' },
  { k: 'neg_sched_pct', label: 'Negotiation sched %', t: 'p' },
  { k: 'neg_held_pct', label: 'Negotiation held %', t: 'p' },
  { k: 'closures', today: 'closures_today', label: 'Closures (today)', t: 'n' },
  { k: 'visit_to_closure_pct', label: 'Visit→Closure %', t: 'p' },
  { k: 'dead_pct', label: 'Visit→Dead %', t: 'p' },
  { k: 'closures_since_aug', label: 'Closures since Aug', t: 'n' },
];
const SOURCE_LABEL = { core: 'Core app (Assisted %)', meetings: 'Meetings DB (CP meetings)', bookings: 'Demand Dashboard (Closures)' };

const DASH = '—';
function fmt(v, t) {
  if (v === null || v === undefined || v === '') return DASH;
  const n = Number(v);
  if (!Number.isFinite(n)) return String(v);
  if (t === 'p') return `${Math.round(n * 100)}%`;
  if (t === 'd') return n.toFixed(1);
  return n.toLocaleString('en-IN');
}

function Cell({ row, col }) {
  const main = fmt(row[col.k], col.t);
  if (!col.today) return <td className="ds-num">{main}</td>;
  const t = row[col.today];
  return (
    <td className="ds-num">
      {main}{main !== DASH && t !== null && t !== undefined && <span className="ds-today"> ({fmt(t, 'n')})</span>}
    </td>
  );
}

function DsrRow({ row }) {
  const sub = row.kind !== 'pm';
  const area = row.kind === 'pm' ? row.area
    : row.kind === 'area' ? `${row.area} total`
    : row.kind === 'city' ? `${row.city} total`
    : 'Grand total';
  return (
    <tr className={'ds-r-' + row.kind}>
      <td className="ds-id ds-area">{area || DASH}</td>
      <td className="ds-id">{row.kind === 'pm' ? (row.pm_name || DASH) : ''}</td>
      <td className="ds-id">{sub && row.kind !== 'area' ? '' : (row.manager_name || DASH)}</td>
      {COLS.map((c) => <Cell key={c.k} row={row} col={c} />)}
    </tr>
  );
}

// Plain-React filterable dropdown (no npm dependency). options: [{id, name, team}]
function SearchSelect({ value, options, onChange, disabled, placeholder = 'Pick a person…' }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const current = options.find((o) => String(o.id) === String(value));
  const list = useMemo(() => {
    const s = q.trim().toLowerCase();
    return (s ? options.filter((o) => (o.name || '').toLowerCase().includes(s)) : options).slice(0, 60);
  }, [q, options]);
  if (disabled) return <span className="ds-ro">{current ? current.name : DASH}</span>;
  return (
    <div className="ds-ss">
      <button type="button" className="ds-ss-btn" onClick={() => { setOpen((o) => !o); setQ(''); }}>
        {current ? current.name : <span className="ds-mut">{placeholder}</span>} <span className="ds-mut">▾</span>
      </button>
      {open && (
        <>
          <div className="ds-ss-back" onClick={() => setOpen(false)} />
          <div className="ds-ss-menu">
            <input autoFocus className="ds-ss-q" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search…" />
            {list.map((o) => (
              <button key={o.id} type="button" className={'ds-ss-item' + (String(o.id) === String(value) ? ' on' : '')}
                onClick={() => { setOpen(false); if (String(o.id) !== String(value)) onChange(o.id); }}>
                {o.name}{o.team ? <span className="ds-mut"> · {o.team}</span> : null}
              </button>
            ))}
            {list.length === 0 && <div className="ds-mut ds-ss-none">No match</div>}
          </div>
        </>
      )}
    </div>
  );
}

function TargetInput({ value, disabled, onSave }) {
  if (disabled) return <span className="ds-ro">{value ?? DASH}</span>;
  return (
    <input type="number" min="0" step="1" className="ds-inp" defaultValue={value ?? ''} key={String(value)}
      onBlur={(e) => {
        const raw = e.target.value.trim();
        if (raw === '' || Number(raw) === Number(value)) return;
        const n = Number(raw);
        if (!Number.isInteger(n) || n < 0) { toast('Target must be a whole number', 'bad'); e.target.value = value ?? ''; return; }
        onSave(n);
      }}
      onKeyDown={(e) => { if (e.key === 'Enter') e.target.blur(); }} />
  );
}

function SettingsPanel({ month, isAdmin, canEditTargets, onChanged }) {
  const [s, setS] = useState(null);
  const [err, setErr] = useState(null);
  const [notReady, setNotReady] = useState(false);

  const load = useCallback(() => {
    setErr(null);
    loadDsrSettings(month).then(setS).catch((e) => setErr(e.status === 403 ? 'You don’t have access to DSR settings.' : e.message));
  }, [month]);
  useEffect(() => { load(); }, [load]);

  const canEditManagers = isAdmin || canEditTargets.length > 0;
  const save = async (fn, body) => {
    try {
      await fn(body);
      toast('Saved', 'good');
      load(); onChanged();
    } catch (e) {
      if (e.status === 409) { setNotReady(true); toast('Settings tables not created yet', 'bad'); }
      else toast((e.status === 403 ? 'Not allowed: ' : 'Save failed: ') + e.message, 'bad');
      load();
    }
  };

  if (err) return <div className="ds-panel"><div className="ds-msg">{err}</div></div>;
  if (!s) return <div className="ds-panel"><div className="ds-mut">Loading settings…</div></div>;
  const users = s.users || [];

  return (
    <div className="ds-panel">
      {notReady && (
        <div className="ds-warn">Settings tables not created yet — the report uses the built-in October defaults. Edits will work once the DSR migration is approved and run.</div>
      )}
      <div className="ds-grid">
        <div>
          <div className="ds-h">Area targets · {s.month}</div>
          <table className="ds-mini">
            <thead><tr><th>City</th><th>Area</th><th className="ds-num">Target</th><th>Area manager</th></tr></thead>
            <tbody>
              {(s.area_targets || []).map((a) => {
                const am = (s.area_managers || []).find((m) => m.area === a.area);
                return (
                  <tr key={a.area}>
                    <td>{a.city}</td>
                    <td>{a.area}</td>
                    <td className="ds-num">
                      <TargetInput value={a.target} disabled={!(isAdmin || canEditTargets.includes(a.area))}
                        onSave={(n) => save(setDsrTarget, { month: s.month, area: a.area, target: n })} />
                    </td>
                    <td>
                      <SearchSelect value={am?.manager_user_id} options={users} disabled={!canEditManagers}
                        onChange={(id) => save(setDsrAreaManager, { area: a.area, manager_user_id: id })} />
                    </td>
                  </tr>
                );
              })}
              <tr className="ds-mini-tot">
                <td colSpan={2}>Total</td>
                <td className="ds-num">{(s.area_targets || []).reduce((t, a) => t + (Number(a.target) || 0), 0)}</td>
                <td />
              </tr>
            </tbody>
          </table>
        </div>
        <div>
          <div className="ds-h">PM → manager</div>
          <table className="ds-mini">
            <thead><tr><th>PM</th><th>Manager</th></tr></thead>
            <tbody>
              {(s.pm_managers || []).map((p) => (
                <tr key={p.pm_user_id}>
                  <td>{p.pm_name}</td>
                  <td>
                    <SearchSelect value={p.manager_user_id} options={users} disabled={!canEditManagers}
                      onChange={(id) => save(setDsrPmManager, { pm_user_id: p.pm_user_id, manager_user_id: id })} />
                  </td>
                </tr>
              ))}
              {(s.pm_managers || []).length === 0 && <tr><td colSpan={2} className="ds-mut">No PMs</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
      <div className="ds-h" style={{ marginTop: 14 }}>Change log</div>
      {(s.log || []).length === 0 ? <div className="ds-mut">No changes yet.</div> : (
        <table className="ds-mini">
          <thead><tr><th>When</th><th>By</th><th>What</th><th>Key</th><th>Old</th><th>New</th></tr></thead>
          <tbody>
            {s.log.map((l, i) => (
              <tr key={i}>
                <td>{l.at ? new Date(l.at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }) : DASH}</td>
                <td>{l.by ?? DASH}</td><td>{l.kind}</td><td>{l.key}</td>
                <td>{l.old ?? DASH}</td><td>{l.new ?? DASH}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

export default function DsrView() {
  const [date, setDate] = useState(todayIST());
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [loading, setLoading] = useState(false);
  const [showSettings, setShowSettings] = useState(false);

  const load = useCallback(() => {
    if (!date) return;
    setLoading(true); setErr(null);
    loadDsr(date)
      .then((d) => setData(d))
      .catch((e) => { setData(null); setErr(e); })
      .finally(() => setLoading(false));
  }, [date]);
  useEffect(() => { load(); }, [load]);

  const missing = data ? Object.entries(data.sources || {}).filter(([, ok]) => !ok).map(([k]) => k) : [];
  const canEditTargets = data?.can_edit_targets || [];
  const canSettings = !!data && (data.is_admin || canEditTargets.length > 0);
  const rows = data?.rows || [];
  const nCols = 3 + COLS.length;

  return (
    <div className="ds-root">
      <style>{DS_CSS}</style>
      <div className="ds-bar">
        <div className="ds-filters">
          <span className="ds-lbl">Report date</span>
          <input type="date" className="ds-date" value={date} max={todayIST()} onChange={(e) => setDate(e.target.value)} />
          <button type="button" className="ds-btn" onClick={() => setDate(todayIST())}>Today</button>
          {loading && <span className="ds-mut">Loading…</span>}
        </div>
        <div className="ds-filters">
          {canSettings && (
            <button type="button" className={'ds-btn' + (showSettings ? ' on' : '')} onClick={() => setShowSettings((v) => !v)}>Targets &amp; team</button>
          )}
          <a className="ds-btn ds-primary" href={dsrExportUrl(date)} download>Download Excel</a>
        </div>
      </div>

      {data && (
        <div className="ds-note">
          Month-to-date {data.month_start} → {data.date} · {data.days_elapsed} day{data.days_elapsed === 1 ? '' : 's'} · completed visits only · (today) = {data.date}
        </div>
      )}
      {missing.length > 0 && (
        <div className="ds-badges">
          {missing.map((k) => <span key={k} className="ds-badge">{SOURCE_LABEL[k] || k}: unavailable</span>)}
        </div>
      )}

      {showSettings && canSettings && (
        <SettingsPanel month={(data?.month_start || date).slice(0, 7)} isAdmin={!!data.is_admin}
          canEditTargets={canEditTargets} onChanged={load} />
      )}

      {err ? (
        <div className="ds-msg">
          {err.status === 403 ? 'The DSR is available to the Admin team and area managers.' : `Couldn’t load the DSR: ${err.message}`}
        </div>
      ) : (
        <div className="ds-wrap">
          <table className="ds-table">
            <thead>
              <tr className="ds-grp">
                {GROUPS.map((g) => <th key={g.label} colSpan={g.span}>{g.label}</th>)}
              </tr>
              <tr className="ds-hdr">
                <th className="ds-id">Area</th><th className="ds-id">PM</th><th className="ds-id">Manager</th>
                {COLS.map((c) => <th key={c.k} className="ds-num">{c.label}</th>)}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <Fragment key={`${r.kind}-${r.city}-${r.area}-${r.pm_id}-${i}`}><DsrRow row={r} /></Fragment>
              ))}
              {data && rows.length === 0 && <tr><td colSpan={nCols}><div className="ds-empty">No data for this date.</div></td></tr>}
              {!data && loading && <tr><td colSpan={nCols}><div className="ds-empty">Loading…</div></td></tr>}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

const DS_CSS = `
.ds-root{font-size:13px;color:var(--ink)}
.ds-bar{display:flex;flex-wrap:wrap;gap:12px;align-items:center;justify-content:space-between;margin-bottom:10px}
.ds-filters{display:inline-flex;gap:6px;align-items:center;flex-wrap:wrap}
.ds-lbl{font-size:11px;font-weight:700;color:var(--mut);text-transform:uppercase;letter-spacing:.03em;margin-right:2px}
.ds-date{border:1px solid var(--line);border-radius:8px;padding:5px 8px;font:inherit;font-size:12.5px;background:#fff;color:var(--ink)}
.ds-btn{border:1px solid var(--line);background:#fff;border-radius:8px;padding:6px 11px;font-size:12px;font-weight:700;color:var(--ink);cursor:pointer;text-decoration:none;display:inline-block}
.ds-btn:hover,.ds-btn.on{border-color:var(--acc,#F4541C);color:var(--acc,#F4541C)}
.ds-btn.ds-primary{background:var(--acc,#F4541C);border-color:var(--acc,#F4541C);color:#fff}
.ds-note{font-size:11.5px;color:var(--mut);margin-bottom:8px}
.ds-badges{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px}
.ds-badge{background:#fff4e5;border:1px solid #f3c98b;color:#8a5a00;border-radius:999px;padding:3px 10px;font-size:11.5px;font-weight:600}
.ds-msg{padding:22px;text-align:center;color:var(--mut);border:1px dashed var(--line);border-radius:12px;background:var(--panel,#fff)}
.ds-warn{background:#fff4e5;border:1px solid #f3c98b;color:#8a5a00;border-radius:8px;padding:8px 10px;margin-bottom:10px;font-size:12px}
.ds-mut{color:var(--mut)}
.ds-wrap{overflow:auto;max-height:calc(100vh - 230px);border:1px solid var(--line);border-radius:12px;background:var(--panel,#fff)}
.ds-table{border-collapse:separate;border-spacing:0;width:100%;font-size:12.5px}
.ds-table th,.ds-table td{padding:7px 9px;border-bottom:1px solid var(--line);white-space:nowrap;text-align:right}
.ds-table thead th{position:sticky;background:var(--bg,#F6F4F0);color:#4a4640;z-index:2}
.ds-grp th{top:0;height:26px;font-size:10.5px;font-weight:800;letter-spacing:.06em;text-align:center!important;border-left:1px solid var(--line)}
.ds-hdr th{top:26px;font-size:11px;font-weight:700;vertical-align:bottom;white-space:normal;min-width:62px}
.ds-id{text-align:left!important}
.ds-area{position:sticky;left:0;background:var(--panel,#fff);z-index:1;min-width:150px}
.ds-table thead th.ds-id:first-child{left:0;z-index:3}
.ds-num{text-align:right;font-variant-numeric:tabular-nums}
.ds-today{color:var(--mut);font-size:11.5px}
tr.ds-r-area td{font-weight:800;background:#faf8f5}
tr.ds-r-city td{font-weight:800;background:#f3efe9}
tr.ds-r-total td{font-weight:900;background:#ece6dd}
tr.ds-r-pm td.ds-area{font-weight:400;color:var(--mut)}
tr.ds-r-pm td:nth-child(2){font-weight:600}
.ds-empty{padding:26px;text-align:center;color:var(--mut)}
.ds-panel{border:1px solid var(--line);border-radius:12px;background:var(--panel,#fff);padding:12px 14px;margin-bottom:12px}
.ds-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:18px}
.ds-h{font-size:11px;font-weight:800;color:#6b665f;text-transform:uppercase;letter-spacing:.04em;margin-bottom:6px}
.ds-mini{border-collapse:collapse;width:100%;font-size:12.5px}
.ds-mini th,.ds-mini td{padding:5px 7px;border-bottom:1px solid var(--line);text-align:left}
.ds-mini th{font-size:11px;color:#4a4640;background:var(--bg,#F6F4F0)}
.ds-mini .ds-num{text-align:right}
.ds-mini-tot td{font-weight:800;background:#faf8f5}
.ds-inp{width:64px;border:1px solid var(--line);border-radius:6px;padding:3px 6px;font:inherit;font-size:12.5px;text-align:right}
.ds-inp:focus{border-color:var(--acc,#F4541C);outline:none}
.ds-ro{color:var(--ink)}
.ds-ss{position:relative;display:inline-block}
.ds-ss-btn{border:1px solid var(--line);background:#fff;border-radius:6px;padding:3px 8px;font:inherit;font-size:12.5px;cursor:pointer;min-width:150px;text-align:left}
.ds-ss-back{position:fixed;inset:0;z-index:20}
.ds-ss-menu{position:absolute;z-index:21;top:100%;left:0;margin-top:2px;background:#fff;border:1px solid var(--line);border-radius:8px;box-shadow:0 6px 20px rgba(0,0,0,.12);width:230px;max-height:260px;overflow:auto;padding:4px}
.ds-ss-q{width:100%;box-sizing:border-box;border:1px solid var(--line);border-radius:6px;padding:4px 7px;font:inherit;font-size:12.5px;margin-bottom:4px}
.ds-ss-item{display:block;width:100%;text-align:left;border:none;background:transparent;padding:5px 7px;border-radius:6px;font:inherit;font-size:12.5px;cursor:pointer}
.ds-ss-item:hover{background:var(--bg,#F6F4F0)}
.ds-ss-item.on{color:var(--acc,#F4541C);font-weight:700}
.ds-ss-none{padding:6px 7px}
`;
