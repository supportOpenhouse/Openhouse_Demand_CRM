import { useMemo, useState } from 'react';
import { propertiesForUser } from '../lib/properties.js';
import { visitStatus, visitStage } from '../lib/visits.js';
import { parsePrice } from '../lib/legacy.js';
import { indexVisitsByProperty, visitsForProperty } from '../lib/propertyStatus.js';
import useIsMobile from '../lib/useIsMobile.js';
import PropertyModal from '../components/PropertyModal.jsx';

const CITIES = ['Gurgaon', 'Noida', 'Ghaziabad'];

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

  const [city, setCity] = useState('all');         // state.cityFilter
  const [propFilter, setPropFilter] = useState('all'); // state.propFilter
  const [open, setOpen] = useState(null);          // state.openProperty (the property obj)
  const [sortField, setSortField] = useState('total'); // default sort by Visits desc
  const [sortDir, setSortDir] = useState('desc');

  function onSort(k) {
    if (sortField === k) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else { setSortField(k); setSortDir('desc'); }
  }

  // filter pipeline — exact order from legacy renderPropertiesView, then attach
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
    if (propFilter !== 'all') list = list.filter((p) => p.listing_status === propFilter);
    return list.map((p) => ({ p, ...propCounts(p, idx) }));
  }, [all, city, search, propFilter, idx]);

  const rows = useMemo(() => {
    const col = PROP_COLS.find((c) => c.k === sortField);
    if (!col) return filtered;
    const sgn = sortDir === 'asc' ? 1 : -1;
    const val = (r) => {
      if (col.type === 'num') return r[sortField] || 0;
      if (col.type === 'price') return parsePrice(r.p.listing_price);
      if (sortField === 'config') return (r.p.configuration || '').toLowerCase();
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

      {/* list-head: count label (left) + propFilter select (right) */}
      <div className="list-head">
        <span id="propCountLabel">{rows.length} properties</span>
        <div className="pager">
          <span style={{ color: 'var(--mut)' }}>Filter:</span>
          <select
            id="propFilter"
            style={{ padding: '5px 8px', border: '1px solid var(--line)', borderRadius: 6, fontSize: 12, background: 'var(--panel)' }}
            value={propFilter}
            onChange={(e) => setPropFilter(e.target.value)}
          >
            <option value="all">All</option>
            <option value="Ready">Ready</option>
            <option value="Coming Soon">Coming Soon</option>
          </select>
        </div>
      </div>

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
              {rows.length ? rows.map(({ p, total, hot, warm, upcoming, booking }, i) => {
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
                  <td colSpan={14}>
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
      {rows.map(({ p, total, hot, warm, upcoming, booking }, i) => {
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
            <div style={{ marginTop: 6, fontSize: 11, color: 'var(--mut)' }}>PM: <b style={{ color: 'var(--txt)' }}>{p.sales_manager || '—'}</b></div>
          </div>
        );
      })}
    </div>
  );
}
