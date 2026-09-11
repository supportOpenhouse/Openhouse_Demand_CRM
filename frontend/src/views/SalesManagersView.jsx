// Sales Managers — property ↔ app-SalesManager linkage (Admin only · beta).
//
// The OpenHouse app holds ONE sales manager per home (Core `homes.sales_manager`).
// This tab is the place to see and change that mapping in bulk, rather than hunting
// unit by unit through the property modal.
//
// IMPORTANT: this reassigns the sales manager in the APP. It does NOT change the
// CRM's own property_assignments, which is what drives CRM scoping/visibility —
// the two are deliberately independent. The banner says so, because "I reassigned
// them but they still can't see it in the CRM" would otherwise be a support call.
//
// Current SM is read per-unit from Core on demand (there is no bulk endpoint), so
// the table shows the CRM's own `sales_manager` text as the at-a-glance column and
// fetches Core's authoritative value when a row is opened.
import { Fragment, useMemo, useState } from 'react';
import { loadPropertySalesManager, setPropertySalesManager } from '../api.js';
import { toast } from '../lib/toast.js';

const DEAD = new Set(['Sold', 'Archived']);

export default function SalesManagersView({ seed }) {
  const properties = seed.properties || [];

  const [q, setQ] = useState('');
  const [city, setCity] = useState('all');
  const [status, setStatus] = useState('live');     // live | all
  const [openId, setOpenId] = useState(null);       // home_id of the expanded row

  // Per-row Core state: { [home_id]: {loading, err, sales_manager, assignable, saving} }
  const [core, setCore] = useState({});

  const cities = useMemo(
    () => Array.from(new Set(properties.map((p) => p.city).filter(Boolean))).sort(),
    [properties],
  );

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return properties
      // Only units with a home_id can be addressed in Core at all.
      .filter((p) => String(p.home_id || '').trim())
      .filter((p) => (status === 'all' ? true : !DEAD.has(p.listing_status)))
      .filter((p) => (city === 'all' ? true : p.city === city))
      .filter((p) => {
        if (!needle) return true;
        return [p.property_name, p.society_name, p.sales_manager, p.home_id, p.micro_market]
          .filter(Boolean).some((s) => String(s).toLowerCase().includes(needle));
      })
      .sort((a, b) => (a.society_name || '').localeCompare(b.society_name || '')
        || (a.property_name || '').localeCompare(b.property_name || ''));
  }, [properties, q, city, status]);

  function patch(homeId, next) {
    setCore((c) => ({ ...c, [homeId]: { ...(c[homeId] || {}), ...next } }));
  }

  async function toggleRow(p) {
    const id = String(p.home_id);
    if (openId === id) { setOpenId(null); return; }
    setOpenId(id);
    if (core[id]?.sales_manager !== undefined || core[id]?.loading) return;   // already have it
    patch(id, { loading: true, err: '' });
    try {
      const d = await loadPropertySalesManager(id);
      patch(id, { loading: false, sales_manager: d.sales_manager || null, assignable: d.assignable || [] });
    } catch (e) {
      patch(id, { loading: false, err: e.message || 'Could not load from the app' });
    }
  }

  async function save(p, value) {
    const id = String(p.home_id);
    patch(id, { saving: true, err: '' });
    try {
      const smId = value === '__none__' ? null : Number(value);
      const res = await setPropertySalesManager(id, smId);
      patch(id, { saving: false, sales_manager: res.sales_manager || null });
      toast(res.sales_manager
        ? `${p.property_name || 'Unit'} → ${res.sales_manager.name}`
        : `${p.property_name || 'Unit'} → unassigned`);
    } catch (e) {
      patch(id, { saving: false, err: e.message || 'Could not update the app' });
    }
  }

  return (
    <div className="sm-view">
      <div className="sm-head">
        <div>
          <h2 className="sm-h2">Sales Managers</h2>
          <div className="sm-sub">
            Who the <b>OpenHouse app</b> shows as the sales manager for each unit.
          </div>
        </div>
      </div>

      <div className="sm-banner">
        Changes here update the <b>app only</b>. CRM visibility and edit rights are driven by the
        CRM’s own property assignments and are <b>not</b> affected.
      </div>

      <div className="sm-filters">
        <input className="sm-search" type="search" value={q} placeholder="Search unit, society, PM, home id…"
               onChange={(e) => setQ(e.target.value)} />
        <select className="sm-select" value={city} onChange={(e) => setCity(e.target.value)}>
          <option value="all">All cities</option>
          {cities.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <select className="sm-select" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="live">Live stock only</option>
          <option value="all">Include Sold / Archived</option>
        </select>
        <span className="sm-count">{rows.length} unit{rows.length === 1 ? '' : 's'}</span>
      </div>

      {rows.length === 0 ? (
        <div className="empty"><div className="emoji">🏢</div><div className="t">No units match</div>
          <div className="s">Only units with an app home id can be mapped.</div></div>
      ) : (
        <div className="sm-table-wrap">
          <table className="sm-table">
            <thead>
              <tr>
                <th style={{ width: 34 }} />
                <th>Unit</th>
                <th>Society</th>
                <th>City</th>
                <th>Status</th>
                <th>CRM PM</th>
                <th style={{ width: 90 }}>Home id</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => {
                const id = String(p.home_id);
                const st = core[id] || {};
                const isOpen = openId === id;
                return (
                  // Fragment carries the key — the two <tr>s are one logical row.
                  <Fragment key={id}>
                    <tr className={'sm-row' + (isOpen ? ' open' : '')} onClick={() => toggleRow(p)}>
                      <td className="sm-caret">{isOpen ? '▾' : '▸'}</td>
                      <td className="sm-unit">{p.property_name || '—'}</td>
                      <td>{p.society_name || '—'}</td>
                      <td>{p.city || '—'}</td>
                      <td><span className={'sm-pill ' + (DEAD.has(p.listing_status) ? 'dead' : 'live')}>{p.listing_status || '—'}</span></td>
                      <td>{p.sales_manager || <span className="muted">—</span>}</td>
                      <td className="sm-home">{id}</td>
                    </tr>
                    {isOpen ? (
                      <tr className="sm-expand">
                        <td colSpan={7}>
                          {st.loading ? <div className="sm-note">Loading from the app…</div> : null}
                          {st.err ? <div className="sm-err">{st.err}</div> : null}
                          {!st.loading && !st.err && st.sales_manager !== undefined ? (
                            <div className="sm-edit">
                              <div className="sm-cur">
                                <span>App sales manager</span>
                                <b>{st.sales_manager
                                  ? `${st.sales_manager.name}${st.sales_manager.mobile ? ` · ${st.sales_manager.mobile}` : ''}`
                                  : 'Nobody'}</b>
                              </div>
                              <div className="sm-assign">
                                <label htmlFor={'sm-' + id}>Reassign to</label>
                                <select id={'sm-' + id} className="sm-select" disabled={st.saving}
                                        value=""
                                        onChange={(e) => { if (e.target.value) save(p, e.target.value); }}>
                                  <option value="">— select a person —</option>
                                  <option value="__none__">Unassign (nobody)</option>
                                  {(st.assignable || []).map((a) => (
                                    <option key={a.slug} value={a.sales_manager_id}>{a.name} · {a.team}</option>
                                  ))}
                                </select>
                                {st.saving ? <span className="sm-note">Saving…</span> : null}
                              </div>
                            </div>
                          ) : null}
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
