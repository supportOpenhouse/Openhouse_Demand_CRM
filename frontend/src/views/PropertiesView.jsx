import { useMemo, useState } from 'react';
import { propertiesForUser } from '../lib/properties.js';
import PropertyModal from '../components/PropertyModal.jsx';

const CITIES = ['Gurgaon', 'Noida', 'Ghaziabad'];

export default function PropertiesView({ seed, onOpenBroker }) {
  const me = seed.current_user || {};
  const all = useMemo(() => propertiesForUser(seed.properties || [], me), [seed]); // eslint-disable-line
  const visits = seed.visits || [];

  const [city, setCity] = useState('all');
  const [status, setStatus] = useState('all');
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(null);

  const visitCountBySoc = useMemo(() => {
    const m = {}; visits.forEach((v) => { if (v.society_name) m[v.society_name] = (m[v.society_name] || 0) + 1; });
    return m;
  }, [visits]);

  const statuses = useMemo(() => [...new Set(all.map((p) => p.listing_status).filter(Boolean))].sort(), [all]);

  const rows = useMemo(() => all.filter((p) => {
    if (city !== 'all' && p.city_name !== city) return false;
    if (status !== 'all' && p.listing_status !== status) return false;
    if (q.trim()) {
      const s = q.trim().toLowerCase();
      if (!((p.property_name || '').toLowerCase().includes(s) || (p.society_name || '').toLowerCase().includes(s)
        || (p.micro_market || '').toLowerCase().includes(s) || (p.sales_manager || '').toLowerCase().includes(s))) return false;
    }
    return true;
  }), [all, city, status, q]);

  return (
    <div className="rx-fade">
      <div className="rx-filters">
        <select className="rx-sel" value={city} onChange={(e) => setCity(e.target.value)}>
          <option value="all">All cities</option>{CITIES.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <select className="rx-sel" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="all">All statuses</option>{statuses.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <input className="rx-inp" style={{ flex: 1, minWidth: 200 }} placeholder="Search property / society / RM…" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <div className="muted" style={{ fontSize: 12, margin: '6px 2px 10px' }}>{rows.length} propert{rows.length === 1 ? 'y' : 'ies'} · click a row for visits + top brokers</div>

      <div className="tbl-wrap">
        <table className="t" style={{ minWidth: 1100 }}>
          <thead><tr><th>Property</th><th>Society · MM</th><th>City</th><th>Config</th><th>Status</th><th>Price</th><th>RM</th><th style={{ textAlign: 'center' }}>Visits</th></tr></thead>
          <tbody>
            {rows.length ? rows.map((p, i) => (
              <tr key={p.property_name || i} style={{ cursor: 'pointer' }} onClick={() => setOpen(p)}>
                <td style={{ whiteSpace: 'normal', maxWidth: 240 }}><b>{p.property_name}</b></td>
                <td style={{ whiteSpace: 'normal', maxWidth: 200 }}>{p.society_name || '—'}<div className="rx-sub">{p.micro_market || ''}</div></td>
                <td><span className="city-pill">{p.city_name || ''}</span></td>
                <td>{p.configuration || '—'}<div className="rx-sub">{[p.super_sqft, p.carpet_sqft].filter(Boolean).join(' / ')} sqft</div></td>
                <td><span className="rx-pill" style={{ background: 'var(--panel2)', color: 'var(--txt)' }}>{p.listing_status || '—'}</span></td>
                <td style={{ fontWeight: 700, color: 'var(--accDark,var(--acc))' }}>{p.listing_price || '—'}</td>
                <td>{p.sales_manager || '—'}</td>
                <td style={{ textAlign: 'center', fontWeight: 700 }}>{visitCountBySoc[p.society_name] || 0}</td>
              </tr>
            )) : <tr><td colSpan={8}><div className="empty"><div className="emoji">🏠</div><div className="t">No properties match</div></div></td></tr>}
          </tbody>
        </table>
      </div>

      {open && <PropertyModal property={open} seed={seed} onClose={() => setOpen(null)} onOpenBroker={onOpenBroker} />}
    </div>
  );
}
