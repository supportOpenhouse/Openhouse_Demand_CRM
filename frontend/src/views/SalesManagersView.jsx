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
import { Fragment, useEffect, useMemo, useState } from 'react';
import { loadAssignableSalesManagers, setPropertySalesManager } from '../api.js';
import { toast } from '../lib/toast.js';

const DEAD = new Set(['Sold', 'Archived']);
const NO_MM = '— No micro-market set —';

// Sortable columns → the value each one sorts on. Keep in step with the <th>s below.
const SORT_VAL = {
  society: (p) => `${p.society_name || ''} ${p.property_name || ''}`,
  locality: (p) => p.locality_or_sector || '',
  city: (p) => p.city_name || '',
  status: (p) => p.listing_status || '',
  manager: (p) => p.sales_manager || '',
};

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
  const [unmappedOnly, setUnmappedOnly] = useState(false);
  // sort applies WITHIN each micro-market group, so the MM grouping is preserved
  const [sort, setSort] = useState({ key: 'society', dir: 'asc' });
  const toggleSort = (key) => setSort((s) => (
    s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' }
  ));

  // one request for the whole grid
  useEffect(() => {
    let alive = true;
    loadAssignableSalesManagers()
      .then((d) => { if (alive) setAssignable(d.assignable || []); })
      .catch((e) => { if (alive) setLoadErr(String(e?.message || e).slice(0, 160)); });
    return () => { alive = false; };
  }, []);

  // "Not mapped to anyone" = the unit has no sales manager at all (15 live units today).
  // Deliberately based on the property's own value, not on whether that name resolves to a
  // CRM roster member — a unit owned by someone off the roster is assigned, just not mapped.
  const isUnmapped = (p) => !String(p.sales_manager || '').trim();

  const unmappedCount = useMemo(() => properties.filter((p) => (
    String(p.home_id || '').trim() && !DEAD.has(p.listing_status) && isUnmapped(p)
  )).length, [properties]);

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
      .filter((p) => (unmappedOnly ? isUnmapped(p) : true))
      .filter((p) => {
        if (!needle) return true;
        return [p.property_name, p.society_name, p.sales_manager, p.home_id, p.micro_market,
                p.locality_or_sector]
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
        list: list.sort((a, b) => {
          const d = sort.dir === 'asc' ? 1 : -1;
          const va = String(SORT_VAL[sort.key]?.(a) ?? '');
          const vb = String(SORT_VAL[sort.key]?.(b) ?? '');
          // blanks always sort last, whichever direction — an empty cell is never "first"
          if (!va && vb) return 1;
          if (va && !vb) return -1;
          return (va.localeCompare(vb) * d)
            || (a.society_name || '').localeCompare(b.society_name || '')
            || (a.property_name || '').localeCompare(b.property_name || '');
        }),
      }))
      .sort((a, b) => (a.mm === NO_MM ? 1 : b.mm === NO_MM ? -1 : a.mm.localeCompare(b.mm)));
  }, [properties, q, city, status, mmManagers, unmappedOnly, sort]);

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
        <button type="button" className="btn sm" onClick={() => setUnmappedOnly((v) => !v)}
                title="Show only units with no sales manager, so they can be assigned from here"
                style={unmappedOnly
                  ? { borderColor: 'var(--bad)', color: 'var(--bad)', fontWeight: 700 }
                  : undefined}>
          {unmappedOnly ? '✓ ' : ''}Unmapped only{unmappedCount ? ` · ${unmappedCount}` : ''}
        </button>
        <span style={{ color: 'var(--mut)', fontSize: 12.5 }}>
          <b>{total}</b> propert{total === 1 ? 'y' : 'ies'} · {groups.length} micro-market{groups.length === 1 ? '' : 's'}
        </span>
      </div>

      {loadErr ? (
        <div className="empty"><div className="emoji">⚠️</div><div className="t">Couldn’t load the manager list</div><div className="s">{loadErr}</div></div>
      ) : total === 0 ? (
        <div className="empty"><div className="emoji">{unmappedOnly ? '✅' : '🧑‍💼'}</div>
          <div className="t">{unmappedOnly ? 'Every unit here has a sales manager' : 'No properties match these filters'}</div></div>
      ) : (
        // ONE table for every micro-market. Each group used to render its OWN <table>, so
        // each sized its columns independently and the same column landed at a different x
        // in every group. A single table = a single column model = columns line up
        // everywhere. Group headers are full-width rows inside the same tbody.
        <div className="tbl-wrap">
          <table className="t sm-table" style={{ tableLayout: 'fixed', width: '100%', minWidth: 980 }}>
            <colgroup>
              <col style={{ width: '22%' }} />
              <col style={{ width: '17%' }} />
              <col style={{ width: '9%' }} />
              <col style={{ width: '11%' }} />
              <col style={{ width: '19%' }} />
              <col style={{ width: '22%' }} />
            </colgroup>
            <thead>
              <tr>
                {[['society', 'Society / Unit'], ['locality', 'Locality'], ['city', 'City'],
                  ['status', 'Status'], ['manager', 'CRM property manager']].map(([k, label]) => (
                  <th key={k} className="sort" onClick={() => toggleSort(k)}
                      style={{ cursor: 'pointer', whiteSpace: 'nowrap', overflow: 'hidden' }}
                      title={`Sort by ${label.toLowerCase()}`}>
                    <span style={{ display: 'flex', alignItems: 'center', gap: 3, overflow: 'hidden' }}>
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{label}</span>
                      <span className="sI" style={{ flex: 'none', opacity: sort.key === k ? 1 : .25 }}>
                        {sort.key === k ? (sort.dir === 'asc' ? '↑' : '↓') : '↕'}
                      </span>
                    </span>
                  </th>
                ))}
                <th style={{ overflow: 'hidden', textOverflow: 'ellipsis' }} title="App sales manager">App sales manager</th>
              </tr>
            </thead>
            <tbody>
              {groups.map((g) => (
                <Fragment key={g.mm}>
                  <tr className="sm-group" onClick={() => toggleGroup(g.mm)} style={{ cursor: 'pointer' }}>
                    <td colSpan={6} style={{ background: 'var(--bg2,#FAFAFB)', padding: '7px 10px' }}>
                      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
                        <span style={{ fontSize: 11, color: 'var(--mut)' }}>{collapsed.has(g.mm) ? '▸' : '▾'}</span>
                        <b style={{ fontSize: 13 }}>{g.mm}</b>
                        <span style={{ fontSize: 12, color: 'var(--mut)' }}>
                          {g.managers.length
                            ? <>managed by <b>{g.managers.map((u) => u.name).join(', ')}</b></>
                            : <i>no micro-market manager assigned</i>}
                        </span>
                        <span style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--mut)' }}>{g.list.length}</span>
                      </div>
                    </td>
                  </tr>
                  {!collapsed.has(g.mm) && g.list.map((p) => {
                    const id = String(p.home_id);
                    const st = rowState[id] || {};
                    const cur = byName[(p.sales_manager || '').trim().toLowerCase()];
                    const clip = { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' };
                    return (
                      <tr key={id}>
                        <td style={{ overflow: 'hidden' }}>
                          <b style={{ display: 'block', ...clip }} title={p.society_name || ''}>{p.society_name || '—'}</b>
                          <div style={{ fontSize: 10.5, color: 'var(--mut)', marginTop: 1, ...clip }}
                               title={p.property_name || ''}>{p.property_name || ''}</div>
                        </td>
                        <td style={{ fontSize: 12, ...clip }} title={p.locality_or_sector || ''}>
                          {p.locality_or_sector || <span className="muted">—</span>}
                        </td>
                        <td><span className="city-pill">{p.city_name || ''}</span></td>
                        <td><span style={{ fontSize: 11.5, color: DEAD.has(p.listing_status) ? 'var(--mut)' : undefined }}>{p.listing_status || '—'}</span></td>
                        <td style={{ fontSize: 12, ...clip }} title={p.sales_manager || ''}>
                          {p.sales_manager || <span className="muted">—</span>}
                        </td>
                        <td style={{ overflow: 'hidden' }}>
                          <select className="sm-select" disabled={st.saving || !assignable.length}
                                  style={{ width: '100%', maxWidth: '100%' }}
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
                          {st.saving ? <div className="sm-note" style={{ marginTop: 2 }}>Saving…</div> : null}
                          {st.savedTo ? <div className="sm-note" style={{ marginTop: 2, color: 'var(--good,#16A34A)', ...clip }} title={st.savedTo}>✓ {st.savedTo}</div> : null}
                          {st.err ? <div className="sm-note" style={{ marginTop: 2, color: 'var(--bad)' }} title={st.err}>{st.err}</div> : null}
                        </td>
                      </tr>
                    );
                  })}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
