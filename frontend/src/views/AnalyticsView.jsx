import { useMemo, useState, useRef, useEffect } from 'react';
import * as A from '../lib/analytics.js';
import useIsMobile from '../lib/useIsMobile.js';

const int = (n) => (n || 0).toLocaleString('en-IN');
const dec = (n) => (n || 0).toFixed(1);
// source-of-truth visit sheet (analytics is built off the visits data)
const VISITS_SHEET_URL = 'https://docs.google.com/spreadsheets/d/17eEX021t97pGnJasMJ6v7ERE0jezKEC0S8teKepJRWQ/edit';
const asOpts = (arr) => arr.map((x) => (typeof x === 'string' ? { value: x, label: x } : x));

// ---- reusable multi-select dropdown (dependency-free) ----------------------
function MultiSelect({ label, options, value = [], onChange, width }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return;
    const h = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [open]);
  const opts = asOpts(options);
  const shown = q ? opts.filter((o) => o.label.toLowerCase().includes(q.toLowerCase())) : opts;
  const toggle = (val) => onChange(value.includes(val) ? value.filter((x) => x !== val) : [...value, val]);
  return (
    <div className="an-ms" ref={ref} style={width ? { width } : undefined}>
      <button type="button" className={'an-ms-btn' + (value.length ? ' has' : '')} onClick={() => setOpen((o) => !o)}>
        {label}{value.length ? <span className="an-ms-count">{value.length}</span> : null}<span className="an-ms-caret">▾</span>
      </button>
      {open && (
        <div className="an-ms-pop">
          <input className="an-ms-search" autoFocus placeholder={`Search ${label.toLowerCase()}…`} value={q} onChange={(e) => setQ(e.target.value)} />
          <div className="an-ms-actions">
            <button type="button" onClick={() => onChange(shown.map((o) => o.value))}>All</button>
            <button type="button" onClick={() => onChange([])}>Clear</button>
            <span className="an-ms-n">{value.length} selected</span>
          </div>
          <div className="an-ms-list">
            {shown.slice(0, 400).map((o) => (
              <label key={o.value} className="an-ms-opt">
                <input type="checkbox" checked={value.includes(o.value)} onChange={() => toggle(o.value)} />
                <span>{o.label}</span>
              </label>
            ))}
            {shown.length > 400 && <div className="an-ms-more">+{shown.length - 400} more — refine search</div>}
            {shown.length === 0 && <div className="an-ms-more">No matches</div>}
          </div>
        </div>
      )}
    </div>
  );
}

// ---- horizontal bar list chart (clickable) ---------------------------------
function BarList({ title, hint, rows, metrics, labelOf, onPick, picked }) {
  const max = Math.max(1, ...rows.map((r) => r.primary || 0));
  return (
    <div className="an-card">
      <div className="an-card-h">
        <div className="an-card-t">{title}</div>
        {hint && <div className="an-card-s">{hint}</div>}
      </div>
      <div className="an-bars">
        {rows.length === 0 && <div className="an-empty">No data for the current filters.</div>}
        {rows.map((r) => {
          const lbl = labelOf ? labelOf(r) : r.key;
          const on = picked === r.key;
          return (
            <div key={r.key} className={'an-bar-row' + (on ? ' on' : '')} onClick={() => onPick && onPick(r.key)} title={lbl}>
              <div className="an-bar-lbl">{lbl}</div>
              <div className="an-bar-track"><div className="an-bar-fill" style={{ width: `${(r.primary / max) * 100}%` }} /></div>
              <div className="an-bar-metrics">
                {metrics.map((m) => <span key={m.key} className="an-metric" title={m.label}>{m.fmt ? m.fmt(r[m.key]) : int(r[m.key])}</span>)}
              </div>
            </div>
          );
        })}
      </div>
      <div className="an-bar-legend">{metrics.map((m) => <span key={m.key}>{m.label}</span>)}</div>
    </div>
  );
}

// ---- day-wise line chart (SVG) ---------------------------------------------
function LineChart({ title, points, onPick, pickedDay }) {
  const W = 760, H = 220, P = 28;
  const [hover, setHover] = useState(null);   // hovered point index
  const max = Math.max(1, ...points.map((p) => p.n));
  const n = points.length;
  const x = (i) => P + (n <= 1 ? 0 : (i * (W - 2 * P)) / (n - 1));
  const y = (val) => H - P - (val / max) * (H - 2 * P);
  const path = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.n).toFixed(1)}`).join(' ');
  const ticks = points.filter((_, i) => i % Math.ceil(n / 8 || 1) === 0);
  const hp = hover != null && points[hover] ? points[hover] : null;
  return (
    <div className="an-card an-card-wide">
      <div className="an-card-h"><div className="an-card-t">{title}</div><div className="an-card-s">{int(points.reduce((a, b) => a + b.n, 0))} visits over {n} days</div></div>
      <svg className="an-line" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid meet" onMouseLeave={() => setHover(null)}>
        <line x1={P} y1={H - P} x2={W - P} y2={H - P} className="an-axis" />
        <path d={path} className="an-line-path" fill="none" />
        {hp && (() => {
          const cx = x(hover), cy = y(hp.n);
          const bw = 104, bh = 36;
          const bx = Math.min(Math.max(cx - bw / 2, 2), W - bw - 2);
          const by = Math.max(cy - bh - 12, 2);
          return (
            <g pointerEvents="none">
              <line x1={cx} y1={P - 4} x2={cx} y2={H - P} className="an-line-guide" />
              <rect x={bx} y={by} width={bw} height={bh} rx={6} className="an-tip-box" />
              <text x={bx + bw / 2} y={by + 15} className="an-tip-n">{hp.n} visit{hp.n === 1 ? '' : 's'}</text>
              <text x={bx + bw / 2} y={by + 28} className="an-tip-d">{hp.day}</text>
            </g>
          );
        })()}
        {points.map((p, i) => (
          <g key={p.day}>
            {/* generous invisible hit target for hover/click */}
            <circle cx={x(i)} cy={y(p.n)} r={11} fill="transparent" style={{ cursor: 'pointer' }}
              onMouseEnter={() => setHover(i)} onClick={() => onPick && onPick(p.day)} />
            <circle cx={x(i)} cy={y(p.n)} r={pickedDay === p.day || hover === i ? 4.5 : 2.5}
              className={'an-dot' + (pickedDay === p.day ? ' on' : '')} pointerEvents="none" />
          </g>
        ))}
        {ticks.map((p, i) => <text key={i} x={x(points.indexOf(p))} y={H - 8} className="an-xtick">{p.day.slice(5)}</text>)}
      </svg>
    </div>
  );
}

function Kpi({ label, value }) {
  return <div className="an-kpi"><div className="an-kpi-v">{value}</div><div className="an-kpi-l">{label}</div></div>;
}

// ---- main view -------------------------------------------------------------
export default function AnalyticsView({ seed }) {
  const visits = seed.visits || [];
  const isMobile = useIsMobile();
  const [f, setF] = useState({
    statuses: ['completed'], leadStatuses: [], sources: [], cities: [], societies: [],
    apartments: [], salesManagers: [], brokers: [], listingStatuses: [], buyerQuery: '', dateFrom: '', dateTo: '',
  });
  const [cross, setCross] = useState({});
  const set = (k, v) => setF((s) => ({ ...s, [k]: v }));
  const opts = useMemo(() => A.optionLists(visits), [visits]);

  const rows = useMemo(() => A.applyFilters(visits, f, cross), [visits, f, cross]);
  const k = useMemo(() => A.kpis(rows), [rows]);
  const cMonth = useMemo(() => A.chartMonth(rows), [rows]);
  const cApt = useMemo(() => A.chartApartment(rows, 100), [rows]);
  const cDay = useMemo(() => A.chartDay(rows), [rows]);
  const cBroker = useMemo(() => A.chartBroker(rows), [rows]);
  const cSM = useMemo(() => A.chartSM(rows), [rows]);
  const cAdded = useMemo(() => A.chartAddedBy(rows), [rows]);
  const cCity = useMemo(() => A.chartCity(rows), [rows]);
  const cSource = useMemo(() => A.chartSource(rows), [rows]);

  const pick = (dim, val) => setCross((c) => ({ ...c, [dim]: c[dim] === val ? undefined : val }));
  const crossChips = Object.entries(cross).filter(([, v]) => v);
  const resetAll = () => { setF((s) => ({ ...Object.fromEntries(Object.keys(s).map((kk) => [kk, Array.isArray(s[kk]) ? [] : ''])), statuses: ['completed'] })); setCross({}); };

  const TABLE_CAP = 200;
  const tableRows = rows.slice(0, TABLE_CAP);

  return (
    <div className="an-wrap">
      {/* ---- filter bar ---- */}
      <div className="an-filters">
        <div className="an-date">
          <label>From<input type="date" value={f.dateFrom} onChange={(e) => set('dateFrom', e.target.value)} /></label>
          <label>To<input type="date" value={f.dateTo} onChange={(e) => set('dateTo', e.target.value)} /></label>
        </div>
        <MultiSelect label="Status" options={A.STATUS_OPTS.map((s) => ({ value: s, label: A.STATUS_LABEL[s] }))} value={f.statuses} onChange={(v) => set('statuses', v)} />
        <MultiSelect label="City" options={opts.cities} value={f.cities} onChange={(v) => set('cities', v)} />
        <MultiSelect label="Society" options={opts.societies} value={f.societies} onChange={(v) => set('societies', v)} />
        <MultiSelect label="Apartment" options={opts.apartments} value={f.apartments} onChange={(v) => set('apartments', v)} />
        <MultiSelect label="Sales Manager" options={opts.salesManagers} value={f.salesManagers} onChange={(v) => set('salesManagers', v)} />
        <MultiSelect label="Broker / Company" options={opts.brokers} value={f.brokers} onChange={(v) => set('brokers', v)} />
        <MultiSelect label="Lead Status" options={A.LEAD_STATUS_OPTS.map((s) => ({ value: s, label: A.LEAD_STATUS_LABEL[s] }))} value={f.leadStatuses} onChange={(v) => set('leadStatuses', v)} />
        <MultiSelect label="Source" options={['Direct', 'CP', 'Other']} value={f.sources} onChange={(v) => set('sources', v)} />
        <MultiSelect label="Listing Status" options={opts.listingStatuses} value={f.listingStatuses} onChange={(v) => set('listingStatuses', v)} />
        <input className="an-buyer" placeholder="Buyer name / contact…" value={f.buyerQuery} onChange={(e) => set('buyerQuery', e.target.value)} />
        <button type="button" className="an-reset" onClick={resetAll}>Reset</button>
      </div>

      {/* ---- cross-filter chips ---- */}
      {crossChips.length > 0 && (
        <div className="an-cross">
          <span className="an-cross-lbl">Drill-down:</span>
          {crossChips.map(([dim, val]) => (
            <button key={dim} className="an-chip" onClick={() => pick(dim, val)}>{dim}: {String(val)} ✕</button>
          ))}
          <button className="an-chip clear" onClick={() => setCross({})}>Clear all</button>
        </div>
      )}

      {/* ---- KPI strip ---- */}
      <div className="an-kpis">
        <Kpi label="Visits (filtered)" value={int(k.visits)} />
        <Kpi label="Unique buyers" value={int(k.buyers)} />
        <Kpi label="Unique CPs" value={int(k.cps)} />
        <Kpi label="Properties" value={int(k.properties)} />
        <Kpi label="Apartments" value={int(k.apartments)} />
        <Kpi label="Visits / property" value={dec(k.perProperty)} />
      </div>

      {/* ---- charts grid ---- */}
      <div className="an-grid">
        <BarList title="1 · By Month" hint="visits · buyers · per-property" rows={cMonth} picked={cross.month} onPick={(v) => pick('month', v)}
          metrics={[{ key: 'visits', label: 'Visits' }, { key: 'buyers', label: 'Unique buyers' }, { key: 'perProp', label: 'Visits/property', fmt: dec }]} />

        <BarList title="2 · By Apartment" hint="top 100 · visits · unique CPs" rows={cApt} picked={cross.apartment} onPick={(v) => pick('apartment', v)}
          metrics={[{ key: 'visits', label: 'Visits' }, { key: 'cps', label: 'Unique CPs' }]} />

        <LineChart title="3 · Day-wise visits" points={cDay} pickedDay={cross.day} onPick={(d) => pick('day', d)} />

        <BarList title="4 · By Broker" hint="top 20 · visits · unique properties" rows={cBroker} labelOf={(r) => r.label} picked={cross.broker} onPick={(v) => pick('broker', v)}
          metrics={[{ key: 'visits', label: 'Visits' }, { key: 'props', label: 'Unique properties' }]} />

        <BarList title="5 · By Sales Manager" hint="visits · unique apartments" rows={cSM} picked={cross.salesManager} onPick={(v) => pick('salesManager', v)}
          metrics={[{ key: 'visits', label: 'Visits' }, { key: 'apts', label: 'Unique apartments' }]} />

        <BarList title="6 · Visit added by" hint="broker vs sales manager · visits" rows={cAdded} picked={cross.addedBy} onPick={(v) => pick('addedBy', v)}
          metrics={[{ key: 'visits', label: 'Visits' }]} />

        <BarList title="7 · By City" hint="visits · apts · /prop · buyers · buyers/prop" rows={cCity} picked={cross.city} onPick={(v) => pick('city', v)}
          metrics={[{ key: 'visits', label: 'Visits' }, { key: 'apts', label: 'Apartments' }, { key: 'perProp', label: 'Visits/prop', fmt: dec }, { key: 'buyers', label: 'Buyers' }, { key: 'buyersPerProp', label: 'Buyers/prop', fmt: dec }]} />

        <BarList title="8 · By Source" hint="Direct vs CP · visits · per-property" rows={cSource} picked={cross.source} onPick={(v) => pick('source', v)}
          metrics={[{ key: 'visits', label: 'Visits' }, { key: 'perProp', label: 'Visits/property', fmt: dec }]} />
      </div>

      {/* ---- chart 9: raw data ---- */}
      <div className="an-card an-card-wide">
        <div className="an-card-h">
          <div className="an-card-t">9 · Raw visit data <span className="an-card-s">({int(rows.length)} rows after filters)</span></div>
          <div className="an-table-actions">
            <button type="button" className="an-btn" onClick={() => A.downloadCsv(rows)}>⬇ Download CSV</button>
            <button type="button" className="an-btn ghost" onClick={() => window.open(VISITS_SHEET_URL, '_blank', 'noopener')}>↗ View in Google Sheets</button>
          </div>
        </div>
        <div className="an-table-wrap">
          {isMobile ? (
          <table className="an-table">
            <thead><tr><th>Date</th><th>Apartment</th><th>Status</th><th>Buyer</th></tr></thead>
            <tbody>
              {tableRows.map((v) => (
                <tr key={v.id}>
                  <td>{v.selected_date || v.visit_date || ''}</td>
                  <td className="an-td-apt">{A.apartmentOf(v)}</td>
                  <td>{A.STATUS_LABEL[(v.status || '').toLowerCase()] || v.status}</td>
                  <td>{v.buyer_name}</td>
                </tr>
              ))}
            </tbody>
          </table>
          ) : (
          <table className="an-table">
            <thead><tr>
              <th>Date</th><th>City</th><th>Apartment</th><th>Status</th><th>Lead</th><th>Source</th><th>Sales Mgr</th><th>Broker</th><th>CP</th><th>Buyer</th><th>Contact</th>
            </tr></thead>
            <tbody>
              {tableRows.map((v) => (
                <tr key={v.id}>
                  <td>{v.selected_date || v.visit_date || ''}</td><td>{v.city}</td><td className="an-td-apt">{A.apartmentOf(v)}</td>
                  <td>{A.STATUS_LABEL[(v.status || '').toLowerCase()] || v.status}</td>
                  <td>{A.LEAD_STATUS_LABEL[(v.lead_status || '').toLowerCase()] || v.lead_status}</td>
                  <td>{A.sourceLabel(v)}</td><td>{v.sales_manager}</td><td>{v.broker_name}</td><td>{v.cp_code}</td>
                  <td>{v.buyer_name}</td><td>{v.buyer_contact}</td>
                </tr>
              ))}
            </tbody>
          </table>
          )}
          {rows.length > TABLE_CAP && <div className="an-table-more">Showing first {TABLE_CAP} of {int(rows.length)} — download CSV for all.</div>}
        </div>
      </div>
    </div>
  );
}
