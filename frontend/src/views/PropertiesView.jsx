import { useEffect, useMemo, useRef, useState } from 'react';
import { propertiesForUser } from '../lib/properties.js';
import { visitStatus, visitStage } from '../lib/visits.js';
import { parsePrice } from '../lib/legacy.js';
import { indexVisitsByProperty, visitsForProperty, buildKhMap, lookupKh, unitNoOf } from '../lib/propertyStatus.js';
import { loadKeyHandovers } from '../api.js';
import useIsMobile from '../lib/useIsMobile.js';
import PropertyModal from '../components/PropertyModal.jsx';

const CITIES = ['Gurgaon', 'Noida', 'Ghaziabad'];

// reusable multi-select dropdown — same pattern/classes (an-ms) as Analytics & Snapshot
function MultiSelect({ label, options, value = [], onChange }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return;
    const h = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [open]);
  const opts = options.map((x) => (typeof x === 'string' ? { value: x, label: x } : x));
  const shown = q ? opts.filter((o) => o.label.toLowerCase().includes(q.toLowerCase())) : opts;
  const toggle = (val) => onChange(value.includes(val) ? value.filter((x) => x !== val) : [...value, val]);
  return (
    <div className="an-ms" ref={ref}>
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

// commission normalization — verbatim from legacy renderPropertiesView
function fmtCommission(c) {
  return (c || '')
    .replace('Commission Payable on', '—')
    .replace('Commission payable on', '—')
    .replace('Registry', 'Reg.');
}

// per-UNIT derived visit counts — matched via the propertyStatus index (home_id
// exact, society+unit fallback). Counting by society_name was the bug: every unit
// of a society showed identical totals.
function propCounts(p, idx) {
  const propVisits = visitsForProperty(p, idx);
  return {
    propVisits,
    total: propVisits.length,
    hot: propVisits.filter((v) => visitStatus(v) === 'hot').length,
    warm: propVisits.filter((v) => visitStatus(v) === 'warm').length,
    upcoming: propVisits.filter((v) => visitStage(v) === 'upcoming').length,
    booking: propVisits.filter((v) => visitStage(v) === 'booking').length,
  };
}

// sortable columns — text | price | num (matches VisitsView's onSort pattern)
const PROP_COLS = [
  { k: 'property_name', label: 'Property · Unit', type: 'text' },
  { k: 'society_name', label: 'Society / MM', type: 'text' },
  { k: 'city_name', label: 'City', type: 'text' },
  { k: 'config', label: 'Config · Area', type: 'text' },
  { k: 'listing_status', label: 'Status', type: 'text' },
  { k: 'listing_price', label: 'Price', type: 'price' },
  { k: 'kh_date', label: 'KH Date', type: 'text' },
  { k: 'total', label: 'Visits', type: 'num', center: true },
  { k: 'hot', label: 'Hot', type: 'num', center: true },
  { k: 'warm', label: 'Warm', type: 'num', center: true },
  { k: 'upcoming', label: 'Upcoming', type: 'num', center: true },
  { k: 'booking', label: 'Booking', type: 'num', center: true },
  { k: 'sales_manager', label: 'PM', type: 'text' },
];

export default function PropertiesView({ seed, onOpenBroker, search = '' }) {
  const me = seed.current_user || {};
  const visits = seed.visits || [];
  const isMobile = useIsMobile();

  const all = useMemo(() => propertiesForUser(seed.properties || [], me, seed.pm_by_property || {}), [seed]); // eslint-disable-line

  // build the per-unit visit index once; reused by every row
  const idx = useMemo(() => indexVisitsByProperty(visits), [visits]);

  // Key-handover dates — same source/mapping as Property Performance. Loaded once;
  // resolved per unit (home_id override wins, else society+unit digit match).
  const [kh, setKh] = useState({ items: [], overrides: {}, source: 'unset' });
  useEffect(() => {
    let alive = true;
    loadKeyHandovers().then((d) => alive && setKh(d)).catch(() => alive && setKh({ items: [], overrides: {}, source: 'error' }));
    return () => { alive = false; };
  }, []);
  const khMap = useMemo(() => buildKhMap(kh.items), [kh.items]);

  const [city, setCity] = useState('all');         // state.cityFilter
  const [open, setOpen] = useState(null);          // state.openProperty (the property obj)
  const [sortField, setSortField] = useState('total'); // default sort by Visits desc
  const [sortDir, setSortDir] = useState('desc');

  // ----- advanced filters (the new Filters panel) -----
  const [showFilters, setShowFilters] = useState(false);
  const [fStatus, setFStatus] = useState([]);      // listing_status multi (Ready / Coming Soon)
  const [fConfigs, setFConfigs] = useState([]);    // configuration multi (BHK)
  const [fRegions, setFRegions] = useState([]);    // micro_market multi
  const [fSocieties, setFSocieties] = useState([]); // society_name multi
  const [fPMs, setFPMs] = useState([]);            // sales_manager multi
  const [priceMin, setPriceMin] = useState('');    // ₹ Cr text
  const [priceMax, setPriceMax] = useState('');    // ₹ Cr text

  // price bounds: inputs are in CRORES → ₹ (e.g. "1.5" → 15,000,000)
  const minRs = useMemo(() => { const n = parseFloat(priceMin); return Number.isFinite(n) && n > 0 ? n * 1e7 : null; }, [priceMin]);
  const maxRs = useMemo(() => { const n = parseFloat(priceMax); return Number.isFinite(n) && n > 0 ? n * 1e7 : null; }, [priceMax]);

  // distinct option lists, derived from the user-scoped property set (alpha sorted)
  const distinct = (getv) => [...new Set(all.map((p) => (getv(p) || '').toString().trim()).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
  const statusOpts = useMemo(() => distinct((p) => p.listing_status), [all]);   // eslint-disable-line
  const configOpts = useMemo(() => distinct((p) => p.configuration), [all]);    // eslint-disable-line
  const regionOpts = useMemo(() => distinct((p) => p.micro_market), [all]);     // eslint-disable-line
  const societyOpts = useMemo(() => distinct((p) => p.society_name), [all]);    // eslint-disable-line
  const pmOpts = useMemo(() => distinct((p) => p.sales_manager), [all]);        // eslint-disable-line

  const activeCount = fStatus.length + fConfigs.length + fRegions.length + fSocieties.length + fPMs.length
    + (minRs != null ? 1 : 0) + (maxRs != null ? 1 : 0);
  const clearFilters = () => { setFStatus([]); setFConfigs([]); setFRegions([]); setFSocieties([]); setFPMs([]); setPriceMin(''); setPriceMax(''); };

  function onSort(k) {
    if (sortField === k) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else { setSortField(k); setSortDir('desc'); }
  }

  // filter pipeline — city + search (legacy) then the advanced filters, then attach
  // per-unit counts so the table, cards and sort all read the same numbers.
  const filtered = useMemo(() => {
    let list = all;
    if (city !== 'all') list = list.filter((p) => p.city_name === city);
    const s = (search || '').trim().toLowerCase();
    if (s) {
      list = list.filter((p) =>
        (p.property_name || '').toLowerCase().includes(s) ||
        (p.society_name || '').toLowerCase().includes(s) ||
        (p.micro_market || '').toLowerCase().includes(s) ||
        (p.sales_manager || '').toLowerCase().includes(s));
    }
    if (fStatus.length) list = list.filter((p) => fStatus.includes((p.listing_status || '').trim()));
    if (fConfigs.length) list = list.filter((p) => fConfigs.includes((p.configuration || '').trim()));
    if (fRegions.length) list = list.filter((p) => fRegions.includes((p.micro_market || '').trim()));
    if (fSocieties.length) list = list.filter((p) => fSocieties.includes((p.society_name || '').trim()));
    if (fPMs.length) list = list.filter((p) => fPMs.includes((p.sales_manager || '').trim()));
    if (minRs != null || maxRs != null) {
      list = list.filter((p) => {
        const v = parsePrice(p.listing_price);
        if (minRs != null && v < minRs) return false;
        if (maxRs != null && v > maxRs) return false;
        return true;
      });
    }
    return list.map((p) => ({
      p,
      ...propCounts(p, idx),
      kh_date: (kh.overrides && kh.overrides[String(p.home_id || '').trim()]) || lookupKh(khMap, p.society_name, unitNoOf(p)) || '',
    }));
  }, [all, city, search, fStatus, fConfigs, fRegions, fSocieties, fPMs, minRs, maxRs, idx, khMap, kh.overrides]);

  const rows = useMemo(() => {
    const col = PROP_COLS.find((c) => c.k === sortField);
    if (!col) return filtered;
    const sgn = sortDir === 'asc' ? 1 : -1;
    const val = (r) => {
      if (col.type === 'num') return r[sortField] || 0;
      if (col.type === 'price') return parsePrice(r.p.listing_price);
      if (sortField === 'config') return (r.p.configuration || '').toLowerCase();
      if (sortField === 'kh_date') return (r.kh_date || '');
      return (r.p[sortField] || '').toString().toLowerCase();
    };
    return filtered.slice().sort((a, b) => {
      const x = val(a); const y = val(b);
      return (x > y ? 1 : x < y ? -1 : 0) * sgn;
    });
  }, [filtered, sortField, sortDir]);

  return (
    <div className="view rx-fade" id="view-properties">
      {/* City tabs (global control that filters this view) */}
      <div className="city-tabs" id="cityTabs">
        <button className={city === 'all' ? 'on' : ''} onClick={() => setCity('all')}>All</button>
        {CITIES.map((c) => (
          <button key={c} className={city === c ? 'on' : ''} data-city={c} onClick={() => setCity(c)}>{c}</button>
        ))}
      </div>

      {/* list-head: count label (left) + Filters toggle (right) */}
      <div className="list-head">
        <span id="propCountLabel">{rows.length} properties{activeCount ? ` · ${activeCount} filter${activeCount > 1 ? 's' : ''}` : ''}</span>
        <div className="pager">
          <button
            type="button"
            className={'an-ms-btn' + (activeCount ? ' has' : '')}
            onClick={() => setShowFilters((o) => !o)}
            title="Filter properties by status, config, region, society, PM, price"
          >
            ⚙ Filters{activeCount ? <span className="an-ms-count">{activeCount}</span> : null}<span className="an-ms-caret">{showFilters ? '▴' : '▾'}</span>
          </button>
        </div>
      </div>

      {showFilters && (
        <div className="snap-filters">
          <div className="snap-filters-row">
            <span className="snap-filters-lbl">Filter properties</span>
            <MultiSelect label="Status" options={statusOpts} value={fStatus} onChange={setFStatus} />
            <MultiSelect label="Config / BHK" options={configOpts} value={fConfigs} onChange={setFConfigs} />
            <MultiSelect label="Region / MM" options={regionOpts} value={fRegions} onChange={setFRegions} />
            <MultiSelect label="Society" options={societyOpts} value={fSocieties} onChange={setFSocieties} />
            <MultiSelect label="PM" options={pmOpts} value={fPMs} onChange={setFPMs} />
            <div className="snap-price">
              <span className="snap-price-lbl">Price (₹ Cr)</span>
              <input type="number" inputMode="decimal" min="0" step="0.25" placeholder="1.5"
                     className="snap-price-in" value={priceMin} onChange={(e) => setPriceMin(e.target.value)} />
              <span className="snap-price-dash">–</span>
              <input type="number" inputMode="decimal" min="0" step="0.25" placeholder="2"
                     className="snap-price-in" value={priceMax} onChange={(e) => setPriceMax(e.target.value)} />
            </div>
            {activeCount ? (
              <button type="button" className="an-chip clear" onClick={clearFilters}>Clear filters ✕</button>
            ) : null}
          </div>
          <div className="snap-filters-row">
            <span className={'snap-match' + (rows.length ? '' : ' zero')}>
              <strong>{rows.length}</strong> {rows.length === 1 ? 'property' : 'properties'} match
            </span>
          </div>
        </div>
      )}

      <div className="prop-tbl-wrap">
        {isMobile ? (
          <PropertiesMobile rows={rows} onOpen={setOpen} />
        ) : (
          <table className="prop-t">
            <thead>
              <tr>
                <th></th>
                {PROP_COLS.map((c) => {
                  const isSorted = sortField === c.k;
                  const arrow = isSorted ? (sortDir === 'asc' ? '↑' : '↓') : '';
                  return (
                    <th
                      key={c.k}
                      className="sort"
                      style={{ cursor: 'pointer', userSelect: 'none', ...(c.center ? { textAlign: 'center' } : null) }}
                      onClick={() => onSort(c.k)}
                    >
                      {c.label}
                      {arrow ? <span className="sI" style={{ color: 'var(--mut2)', marginLeft: 2, fontSize: 9 }}> {arrow}</span> : null}
                    </th>
                  );
                })}
                <th>Commission</th>
              </tr>
            </thead>
            <tbody>
              {rows.length ? rows.map(({ p, total, hot, warm, upcoming, booking, kh_date }, i) => {
                const isReady = p.listing_status === 'Ready';
                return (
                  <tr
                    key={p.property_name || i}
                    data-prop={p.property_name}
                    style={{ cursor: 'pointer' }}
                    onClick={() => setOpen(p)}
                  >
                    <td>
                      <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: isReady ? 'var(--good)' : 'var(--warn)' }} />
                    </td>
                    <td><b>{p.property_name}</b></td>
                    <td>
                      {p.society_name || '—'}
                      <div style={{ fontSize: '10.5px', color: 'var(--mut)', marginTop: 1 }}>{p.micro_market || ''}</div>
                    </td>
                    <td><span className="city-pill">{p.city_name || ''}</span></td>
                    <td>
                      {p.configuration || '—'}
                      <div style={{ fontSize: '10.5px', color: 'var(--mut)', marginTop: 1 }}>{p.super_sqft || ''} / {p.carpet_sqft || ''} sqft</div>
                    </td>
                    <td>
                      <span
                        className={isReady ? 'stpill warm' : 'stpill cold'}
                        style={{ background: isReady ? 'var(--goodBg)' : 'var(--warnBg)', color: isReady ? 'var(--goodDk)' : 'var(--warnDk)' }}
                      >
                        {p.listing_status}
                      </span>
                    </td>
                    <td style={{ fontWeight: 700, color: 'var(--accDark)' }}>{p.listing_price || '—'}</td>
                    <td style={{ fontSize: 12, color: kh_date ? 'var(--txt)' : 'var(--mut)' }}>{kh_date || '—'}</td>
                    <td style={{ textAlign: 'center', fontWeight: 700 }}>{total}</td>
                    <td style={{ textAlign: 'center', fontWeight: hot ? 700 : 500, color: hot ? 'var(--bad)' : 'var(--mut2)' }}>{hot}</td>
                    <td style={{ textAlign: 'center', fontWeight: warm ? 700 : 500, color: warm ? 'var(--warn)' : 'var(--mut2)' }}>{warm}</td>
                    <td style={{ textAlign: 'center', fontWeight: upcoming ? 700 : 500, color: upcoming ? 'var(--blue)' : 'var(--mut2)' }}>{upcoming}</td>
                    <td style={{ textAlign: 'center', fontWeight: booking ? 700 : 500, color: booking ? 'var(--good)' : 'var(--mut2)' }}>{booking}</td>
                    <td style={{ fontSize: 12 }}>{p.sales_manager || '—'}</td>
                    <td style={{ fontSize: 11, color: 'var(--mut)' }}>{fmtCommission(p.commission)}</td>
                  </tr>
                );
              }) : (
                <tr>
                  <td colSpan={15}>
                    <div className="empty"><div className="emoji">🏠</div><div className="t">No properties</div></div>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}
      </div>

      {open && <PropertyModal property={open} seed={seed} onClose={() => setOpen(null)} onOpenBroker={onOpenBroker} />}
    </div>
  );
}

function PropertiesMobile({ rows, onOpen }) {
  if (!rows.length) {
    return <div className="empty"><div className="emoji">🏠</div><div className="t">No properties</div></div>;
  }
  return (
    <div className="m-card-list">
      {rows.map(({ p, total, hot, warm, upcoming, booking, kh_date }, i) => {
        const isReady = p.listing_status === 'Ready';
        return (
          <div key={p.property_name || i} className="m-card" data-prop={p.property_name} onClick={() => onOpen(p)}>
            <div className="mc-top">
              <div className="mc-title">
                {p.property_name}
                <span className="sub">{p.society_name || ''} · {p.micro_market || ''}</span>
              </div>
              <div className="mc-right">
                <span className="stpill" style={{ background: isReady ? 'var(--goodBg)' : 'var(--warnBg)', color: isReady ? 'var(--goodDk)' : 'var(--warnDk)', fontSize: '9.5px' }}>{p.listing_status}</span>
                <span style={{ fontSize: 15, fontWeight: 700, color: 'var(--accDark)', marginTop: 3 }}>{p.listing_price || ''}</span>
              </div>
            </div>
            <div className="mc-meta">
              <span className="bhk-pill">{p.configuration || ''}</span>
              <span className="bhk-pill">{p.super_sqft || ''} sqft</span>
              {p.exit_facing ? <span className="bhk-pill">{p.exit_facing}</span> : null}
              <span className="city-pill">{p.city_name || ''}</span>
            </div>
            <div className="mc-foot">
              <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', fontSize: '11.5px' }}>
                <span><b>{total}</b> <span style={{ color: 'var(--mut)', fontSize: '10.5px' }}>Visits</span></span>
                <span><b style={{ color: hot ? 'var(--bad)' : 'var(--mut2)' }}>{hot}</b> <span style={{ color: 'var(--mut)', fontSize: '10.5px' }}>Hot</span></span>
                <span><b style={{ color: warm ? 'var(--warn)' : 'var(--mut2)' }}>{warm}</b> <span style={{ color: 'var(--mut)', fontSize: '10.5px' }}>Warm</span></span>
                <span><b style={{ color: upcoming ? 'var(--blue)' : 'var(--mut2)' }}>{upcoming}</b> <span style={{ color: 'var(--mut)', fontSize: '10.5px' }}>Upc</span></span>
                <span><b style={{ color: booking ? 'var(--good)' : 'var(--mut2)' }}>{booking}</b> <span style={{ color: 'var(--mut)', fontSize: '10.5px' }}>Book</span></span>
              </div>
            </div>
            <div style={{ marginTop: 6, fontSize: 11, color: 'var(--mut)' }}>PM: <b style={{ color: 'var(--txt)' }}>{p.sales_manager || '—'}</b>{kh_date ? <> · KH: <b style={{ color: 'var(--txt)' }}>{kh_date}</b></> : null}</div>
          </div>
        );
      })}
    </div>
  );
}
