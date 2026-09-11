// Sales Managers — property ↔ app-SalesManager linkage, grouped by micro-market.
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
// Layout: micro-market → the manager(s) who own that micro-market → ONE LINE per
// property with the sales-manager dropdown right there in the row. No expanding.
// The roster of assignable people is fetched ONCE (/api/sales-managers/assignable);
// the at-a-glance current owner is the CRM's own `sales_manager` text, and a save
// writes straight to Core and then shows what Core accepted.
import { useEffect, useMemo, useState } from 'react';
import { loadAssignableSalesManagers, setPropertySalesManager } from '../api.js';
import { toast } from '../lib/toast.js';

const DEAD = new Set(['Sold', 'Archived']);
const NO_MM = '— No micro-market set —';

export default function SalesManagersView({ seed }) {
  const properties = seed.properties || [];
  const users = seed.users || [];

  const [q, setQ] = useState('');
  const [city, setCity] = useState('all');
  const [status, setStatus] = useState('live');     // live | all
  const [assignable, setAssignable] = useState([]);
  const [loadErr, setLoadErr] = useState('');
  const [rowState, setRowState] = useState({});     // home_id → { saving, savedTo, err }
  const [sel, setSel] = useState({});               // home_id → explicitly chosen sales_manager_id
  const [collapsed, setCollapsed] = useState(() => new Set());

  // one request for the whole grid
  useEffect(() => {
    let alive = true;
    loadAssignableSalesManagers()
      .then((d) => { if (alive) setAssignable(d.assignable || []); })
      .catch((e) => { if (alive) setLoadErr(String(e?.message || e).slice(0, 160)); });
    return () => { alive = false; };
  }, []);

  const cities = useMemo(
    () => [...new Set(properties.map((p) => p.city_name).filter(Boolean))].sort(),
    [properties],
  );

  // micro-market → the people who manage it (TL/Admin carrying that micro_market)
  const mmManagers = useMemo(() => {
    const m = {};
    users.forEach((u) => {
      (u.micro_markets || []).forEach((mm) => {
        if (!mm) return;
        (m[mm] || (m[mm] = [])).push(u);
      });
    });
    return m;
  }, [users]);

  // name → assignable entry, so the dropdown can preselect from the CRM's text
  const byName = useMemo(() => {
    const m = {};
    assignable.forEach((a) => { m[(a.name || '').trim().toLowerCase()] = a; });
    return m;
  }, [assignable]);

  const groups = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const keep = properties
      .filter((p) => String(p.home_id || '').trim())          // addressable in Core
      .filter((p) => (status === 'all' ? true : !DEAD.has(p.listing_status)))
      .filter((p) => (city === 'all' ? true : p.city_name === city))
      .filter((p) => {
        if (!needle) return true;
        return [p.property_name, p.society_name, p.sales_manager, p.home_id, p.micro_market]
          .filter(Boolean).some((s) => String(s).toLowerCase().includes(needle));
      });
    const g = {};
    keep.forEach((p) => {
      const mm = (p.micro_market || '').trim() || NO_MM;
      (g[mm] || (g[mm] = [])).push(p);
    });
    return Object.entries(g)
      .map(([mm, list]) => ({
        mm,
        managers: mmManagers[mm] || [],
        list: list.sort((a, b) => (a.society_name || '').localeCompare(b.society_name || '')
          || (a.property_name || '').localeCompare(b.property_name || '')),
      }))
      .sort((a, b) => (a.mm === NO_MM ? 1 : b.mm === NO_MM ? -1 : a.mm.localeCompare(b.mm)));
  }, [properties, q, city, status, mmManagers]);

  const total = groups.reduce((n, g) => n + g.list.length, 0);

  const toggleGroup = (mm) => setCollapsed((p) => {
    const n = new Set(p); if (n.has(mm)) n.delete(mm); else n.add(mm); return n;
  });

  async function save(p, raw) {
    const id = String(p.home_id);
    const smId = raw === '__none__' ? null : Number(raw);
    setRowState((s) => ({ ...s, [id]: { saving: true } }));
    try {
      const res = await setPropertySalesManager(id, smId);
      const nm = res?.sales_manager?.name || (smId === null ? 'Nobody' : '');
      setRowState((s) => ({ ...s, [id]: { saving: false, savedTo: nm || '—' } }));
      toast(smId === null ? 'Unassigned in the app' : `Assigned to ${nm || 'the selected person'}`, 'good');
    } catch (e) {
      const msg = String(e?.message || e).slice(0, 160);
      setRowState((s) => ({ ...s, [id]: { saving: false, err: msg } }));
      toast(msg, 'bad');
    }
  }

  return (
    <div className="rx-fade">
      <div className="sm-note-banner" style={{
        border: '1px solid var(--line)', borderLeft: '3px solid var(--warn,#D97706)',
        borderRadius: 8, padding: '8px 11px', fontSize: 12.5, marginBottom: 10,
      }}>
        <b>This changes the sales manager in the OpenHouse APP.</b> It does not change CRM
        visibility — that follows the CRM's own property assignment, which is separate.
      </div>

      <div className="neg-filters" style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search unit, society, micro-market, manager…"
               style={{ flex: '1 1 260px', minWidth: 200, padding: '6px 9px', border: '1px solid var(--line)', borderRadius: 7, fontSize: 13 }} />
        <select className="sm-select" value={city} onChange={(e) => setCity(e.target.value)}>
          <option value="all">All cities</option>
          {cities.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <select className="sm-select" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="live">Live stock</option>
          <option value="all">Include Sold / Archived</option>
        </select>
        <span style={{ color: 'var(--mut)', fontSize: 12.5 }}>
          <b>{total}</b> propert{total === 1 ? 'y' : 'ies'} · {groups.length} micro-market{groups.length === 1 ? '' : 's'}
        </span>
      </div>

      {loadErr ? (
        <div className="empty"><div className="emoji">⚠️</div><div className="t">Couldn’t load the manager list</div><div className="s">{loadErr}</div></div>
      ) : total === 0 ? (
        <div className="empty"><div className="emoji">🧑‍💼</div><div className="t">No properties match these filters</div></div>
      ) : groups.map((g) => (
        <div key={g.mm} style={{ marginBottom: 14 }}>
          <div onClick={() => toggleGroup(g.mm)}
               style={{ display: 'flex', alignItems: 'baseline', gap: 10, cursor: 'pointer',
                        padding: '6px 2px', borderBottom: '1px solid var(--line)' }}>
            <span style={{ fontSize: 11, color: 'var(--mut)' }}>{collapsed.has(g.mm) ? '▸' : '▾'}</span>
            <b style={{ fontSize: 13.5 }}>{g.mm}</b>
            <span style={{ fontSize: 12, color: 'var(--mut)' }}>
              {g.managers.length
                ? <>managed by <b>{g.managers.map((u) => u.name).join(', ')}</b></>
                : <i>no micro-market manager assigned</i>}
            </span>
            <span style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--mut)' }}>{g.list.length}</span>
          </div>

          {!collapsed.has(g.mm) && (
            <div className="tbl-wrap">
              <table className="t sm-table">
                <thead>
                  <tr>
                    <th>Society / Unit</th><th>City</th><th>Status</th>
                    <th>CRM property manager</th><th>App sales manager</th>
                  </tr>
                </thead>
                <tbody>
                  {g.list.map((p) => {
                    const id = String(p.home_id);
                    const st = rowState[id] || {};
                    const cur = byName[(p.sales_manager || '').trim().toLowerCase()];
                    return (
                      <tr key={id}>
                        <td><b>{p.society_name || '—'}</b>
                          <div style={{ fontSize: 10.5, color: 'var(--mut)', marginTop: 1 }}>{p.property_name || ''}</div>
                        </td>
                        <td><span className="city-pill">{p.city_name || ''}</span></td>
                        <td><span style={{ fontSize: 11.5, color: DEAD.has(p.listing_status) ? 'var(--mut)' : undefined }}>{p.listing_status || '—'}</span></td>
                        <td style={{ fontSize: 12 }}>{p.sales_manager || <span className="muted">—</span>}</td>
                        <td style={{ whiteSpace: 'nowrap' }}>
                          <select className="sm-select" disabled={st.saving || !assignable.length}
                                  value={sel[id] ?? (cur ? String(cur.sales_manager_id) : '')}
                                  onChange={(e) => {
                                    const val = e.target.value;
                                    setSel((m) => ({ ...m, [id]: val }));
                                    if (val !== '') save(p, val);
                                  }}>
                            <option value="">{assignable.length ? '— not mapped —' : 'loading…'}</option>
                            <option value="__none__">Unassign (nobody)</option>
                            {assignable.map((a) => (
                              <option key={a.slug} value={a.sales_manager_id}>{a.name} · {a.team}</option>
                            ))}
                          </select>
                          {st.saving ? <span className="sm-note" style={{ marginLeft: 6 }}>Saving…</span> : null}
                          {st.savedTo ? <span className="sm-note" style={{ marginLeft: 6, color: 'var(--good,#16A34A)' }}>✓ {st.savedTo}</span> : null}
                          {st.err ? <span className="sm-note" style={{ marginLeft: 6, color: 'var(--bad)' }}>{st.err}</span> : null}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
