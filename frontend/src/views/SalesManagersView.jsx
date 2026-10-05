// Sales Managers — property ↔ app-SalesManager linkage, grouped by micro-market.
//
// The OpenHouse app holds ONE sales manager per home (Core `homes.sales_manager`).
// This tab is the place to see and change that mapping in bulk, rather than hunting
// unit by unit through the property modal.
//
// ONE sales manager per property: the app's. The CRM mirrors it (inventory
// export + 15-min sheet sync, matching the person by PHONE, then name), and a change
// made here is mirrored into the CRM immediately by the backend, so the app, the CRM
// column and CRM visibility all agree at once.
//
// Layout: micro-market → the manager(s) who own that micro-market → ONE LINE per
// property with the sales-manager dropdown right there in the row. No expanding.
// The roster of assignable people is fetched ONCE (/api/sales-managers/assignable).
// The dropdown shows the APP's current sales manager: the unit's app phone
// (sales_manager_contact, exported from Core) matched to a roster phone — the same
// rule the sync uses — then the name. If the app holds someone the CRM can't match,
// it says so instead of pretending the unit is unmapped.
import { Fragment, useEffect, useMemo, useState } from 'react';
import { loadAssignableSalesManagers, setPropertySalesManager } from '../api.js';
import { toast } from '../lib/toast.js';
import SmPicker, { smLabel } from '../components/SmPicker.jsx';

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
  const [crmNow, setCrmNow] = useState({});         // home_id → CRM text after a save (server mirror)
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

  // Who the APP says owns a unit, resolved to a roster entry exactly as the sync does:
  // phone first (the app SM's mobile is exported as sales_manager_contact), then name.
  const last10 = (v) => { const d = String(v || '').replace(/\D/g, ''); return d.length >= 10 ? d.slice(-10) : ''; };
  const byName = useMemo(() => {
    const m = {};
    assignable.forEach((a) => { m[(a.name || '').trim().toLowerCase()] = a; });
    return m;
  }, [assignable]);
  const byPhone = useMemo(() => {
    const m = {};
    assignable.forEach((a) => { const k = last10(a.phone); if (k) m[k] = a; });
    return m;
  }, [assignable]);  // eslint-disable-line react-hooks/exhaustive-deps
  const appOwner = (p) => byPhone[last10(p.sales_manager_contact)]
    || byName[(p.sales_manager || '').trim().toLowerCase()] || null;

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

  // All the wrong assignments that prompted this were CROSS-CITY namesake picks (a Noida unit
  // given to the Gurgaon "Ankit Kumar"). The picker already shows name · city · phone and
  // lists the unit's city first; this asks before a cross-city save goes to the app.
  function pickFor(p, pick, shown) {
    const id = String(p.home_id);
    if (pick === '__none__') {
      setSel((m) => ({ ...m, [id]: '__none__' }));
      save(p, '__none__', shown);
      return;
    }
    if (String(pick.sales_manager_id) === String(shown)) return;     // no change
    const unitCity = p.city_name || '';
    const cities = pick.cities || [];
    // no city on their CRM profile = can't tell, so ask as well
    if (unitCity && !cities.includes(unitCity)
        && !window.confirm(`${p.property_name} is a ${unitCity} unit, but this person `
          + `${cities.length ? `is based in ${cities.join('/')}` : 'has no city on their CRM profile'}:\n\n`
          + `${smLabel(pick)}\n\nAssign anyway?`)) return;
    setSel((m) => ({ ...m, [id]: String(pick.sales_manager_id) }));
    save(p, String(pick.sales_manager_id), shown);
  }

  // prev = what the row showed before this attempt, i.e. the last value the app accepted
  async function save(p, raw, prev) {
    const id = String(p.home_id);
    const smId = raw === '__none__' ? null : Number(raw);
    setRowState((s) => ({ ...s, [id]: { saving: true } }));
    try {
      const res = await setPropertySalesManager(id, smId);
      const nm = res?.sales_manager?.name || (smId === null ? 'Nobody' : '');
      // the backend mirrored this into the CRM in the same request — show the CRM's
      // new value now rather than after the next sync
      if (res?.crm_mirror?.properties_updated) setCrmNow((m) => ({ ...m, [id]: res.crm_mirror.crm_name || '' }));
      setRowState((s) => ({ ...s, [id]: { saving: false, savedTo: nm || '—' } }));
      toast(smId === null ? 'Unassigned in the app' : `Assigned to ${nm || 'the selected person'}`, 'good');
    } catch (e) {
      const msg = String(e?.message || e).slice(0, 160);
      setRowState((s) => ({ ...s, [id]: { saving: false, err: msg } }));
      setSel((m) => ({ ...m, [id]: prev }));   // the app refused it: show what it still holds
      toast(msg, 'bad');
    }
  }

  return (
    <div className="rx-fade">
      <div className="sm-note-banner" style={{
        border: '1px solid var(--line)', borderLeft: '3px solid var(--warn,#D97706)',
        borderRadius: 8, padding: '8px 11px', fontSize: 12.5, marginBottom: 10,
      }}>
        <b>One sales manager per property — the OpenHouse app's.</b> Changing it here updates
        the app and the CRM together, straight away. Changes made directly in the app reach the
        CRM automatically, usually within the hour. Someone shown as "not linked in CRM" needs their phone
        on their CRM profile to match the app.
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
              <col style={{ width: '20%' }} />
              <col style={{ width: '21%' }} />
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
                    const cur = appOwner(p);
                    // the app has a sales manager the CRM cannot match to a person
                    // only once the roster has loaded — while loading, nobody is "unlinked"
                    const appOnly = assignable.length > 0 && !cur
                      && String(p.sales_manager || '').trim() && last10(p.sales_manager_contact);
                    const shown = sel[id] ?? (cur ? String(cur.sales_manager_id) : appOnly ? '__app__' : '');
                    const crmText = crmNow[id] ?? p.sales_manager;
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
                        <td style={{ fontSize: 12, ...clip }} title={crmText || ''}>
                          {crmText || <span className="muted">—</span>}
                        </td>
                        <td style={{ overflow: 'hidden' }}>
                          <SmPicker options={assignable} unitCity={p.city_name || ''}
                                    loading={!assignable.length} disabled={!!st.saving}
                                    value={shown} appOnlyLabel={appOnly ? p.sales_manager : ''}
                                    onPick={(pick) => pickFor(p, pick, shown)} />
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
