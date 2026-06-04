import { useEffect, useMemo, useState } from 'react';
import { fmtDate, fmtDay } from '../lib/format.js';
import { usersBySlug, ownedCpCodes, buildCpIndex, TIERS, TIER_META, sortInTier } from '../lib/brokers.js';

const CITIES = ['Gurgaon', 'Noida', 'Ghaziabad'];
const PAGE = 100;

export default function CpView({ seed, onOpenBroker }) {
  const me = seed.current_user || {};
  const cpOwner = seed.cp_owner || {};
  const properties = seed.properties || [];
  const visits = seed.visits || [];
  const brokers = seed.brokers || [];

  const ubs = useMemo(() => usersBySlug(seed), [seed]);
  const cpIndex = useMemo(() => buildCpIndex(visits, ubs), [visits, ubs]); // one pass — fixes #1
  const mineSet = useMemo(() => ownedCpCodes(brokers, me, cpOwner, properties, visits), [seed]); // eslint-disable-line
  const mySocs = useMemo(() => new Set(properties.filter((p) => p.sales_manager === me.name).map((p) => p.society_name)), [properties, me]);
  const ownerOptions = useMemo(() => (seed.users || []).slice().sort((a, b) => (a.name || '').localeCompare(b.name || '')), [seed]);

  const universe = useMemo(() => brokers
    .filter((b) => mineSet.has(b.cp_code) || b.tier === 'T3' || b.tier === 'T4')
    .map((b) => ({ ...b, _mine: mineSet.has(b.cp_code) })), [brokers, mineSet]);

  const [tier, setTier] = useState('T1');
  const [city, setCity] = useState('all');
  const [owner, setOwner] = useState('all');   // all | __none__ | slug
  const [unit, setUnit] = useState('');         // #4
  const [q, setQ] = useState('');
  const [sort, setSort] = useState('rank');
  const [page, setPage] = useState(1);

  const filteredAll = useMemo(() => universe.filter((b) => {
    if (city !== 'all' && b.city !== city) return false;
    if (owner !== 'all') { const o = cpOwner[b.cp_code]; if (owner === '__none__' ? !!o : o !== owner) return false; }
    if (unit.trim()) { const u = cpIndex[b.cp_code]?.units || []; if (!u.some((x) => x.includes(unit.trim().toLowerCase()))) return false; }
    if (q.trim()) {
      const s = q.trim().toLowerCase();
      if (!((b.name || '').toLowerCase().includes(s) || (b.cp_code || '').toLowerCase().includes(s)
        || (b.company_name || '').toLowerCase().includes(s) || (b.phone_number || '').includes(s))) return false;
    }
    return true;
  }), [universe, city, owner, unit, q, cpIndex, cpOwner]);

  const groups = useMemo(() => {
    const g = { T1: [], T2: [], T3: [], T4: [] };
    filteredAll.forEach((b) => { (g[b.tier || 'T4'] = g[b.tier || 'T4'] || []).push(b); });
    return g;
  }, [filteredAll]);

  const activeTier = (groups[tier] && groups[tier].length) ? tier : (TIERS.find((t) => groups[t]?.length) || 'T1');
  const hideOwner = activeTier === 'T3' || activeTier === 'T4';   // #5
  const sorted = useMemo(() => sortInTier(groups[activeTier] || [], sort), [groups, activeTier, sort]);
  const totalPages = Math.max(1, Math.ceil(sorted.length / PAGE));
  const pg = Math.min(page, totalPages);
  const rows = sorted.slice((pg - 1) * PAGE, pg * PAGE);

  useEffect(() => { setPage(1); }, [activeTier, city, owner, unit, q, sort]);

  return (
    <div className="rx-fade">
      <div className="tier-tabs">
        {TIERS.map((t) => (
          <button key={t} className={t.toLowerCase() + (activeTier === t ? ' on' : '')} onClick={() => setTier(t)}>
            <span className={'tier-badge ' + t} style={{ background: 'transparent', color: 'inherit', padding: 0 }}>{TIER_META[t].label}</span>
            <span className="ct">{(groups[t] || []).length}</span>
          </button>
        ))}
      </div>
      <div style={{ fontSize: '11.5px', color: 'var(--mut)', margin: '4px 4px 10px', fontStyle: 'italic' }}>{TIER_META[activeTier].desc}</div>

      <div className="rx-filters">
        <select className="rx-sel" value={city} onChange={(e) => setCity(e.target.value)}>
          <option value="all">All cities</option>{CITIES.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        {!hideOwner && (
          <select className="rx-sel" value={owner} onChange={(e) => setOwner(e.target.value)}>
            <option value="all">All owners</option>
            <option value="__none__">Unassigned</option>
            {ownerOptions.map((u) => <option key={u.slug} value={u.slug}>{u.name}</option>)}
          </select>
        )}
        <select className="rx-sel" value={sort} onChange={(e) => setSort(e.target.value)}>
          <option value="rank">Sort: Rank</option>
          <option value="d30">Sort: Visits · 30d</option>
          <option value="all_time">Sort: Visits · all-time</option>
        </select>
        <input className="rx-inp" style={{ width: 132 }} placeholder="Unit no. — 203" value={unit} onChange={(e) => setUnit(e.target.value)} />
        <input className="rx-inp" style={{ flex: 1, minWidth: 200 }} placeholder="Search name / CP code / company / phone…" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>

      <div className="muted" style={{ fontSize: 12, margin: '6px 2px 10px' }}>{sorted.length} CPs in {activeTier} · page {pg}/{totalPages}</div>

      <div className="cp-tbl-wrap" style={{ borderRadius: 10 }}>
        <table className="t" style={{ minWidth: hideOwner ? 1300 : 1420 }}>
          <thead><tr>
            <th>Rank</th><th>Channel Partner</th><th>City · MM</th><th>CP Code</th><th>Activity</th>
            <th style={{ textAlign: 'center' }}>D30</th><th style={{ textAlign: 'center' }}>D60</th>
            <th style={{ textAlign: 'center' }}>D90</th><th style={{ textAlign: 'center' }}>All time</th>
            <th>Onboarded by</th>{!hideOwner && <th>CP Owner</th>}<th>My props visited</th><th>Last visit</th><th>Last FU taken</th>
          </tr></thead>
          <tbody>
            {rows.length ? rows.map((b) => {
              const e = cpIndex[b.cp_code] || {};
              const propsVisited = mySocs.size ? [...(e.socs || [])].filter((s) => mySocs.has(s)) : [];
              const ownerU = ubs[cpOwner[b.cp_code]];
              return (
                <tr key={b.cp_code} style={{ cursor: 'pointer' }} onClick={() => onOpenBroker(b.cp_code)}>
                  <td>{b.tier_rank ? '#' + b.tier_rank : '—'}</td>
                  <td style={{ whiteSpace: 'normal', maxWidth: 190 }}><b>{b.name}</b><div className="rx-sub">{[b.company_name, b.phone_number].filter(Boolean).join(' · ')}</div></td>
                  <td><span className="city-pill">{b.city || ''}</span><div className="rx-sub">{(b.micro_markets || '').split(',').slice(0, 2).join(',')}</div></td>
                  <td><span className="id-pill">{b.cp_code}</span></td>
                  <td className="rx-sub">{b.activity_category || '—'}</td>
                  <td style={{ textAlign: 'center', fontWeight: b.d30_visits > 0 ? 700 : 500 }}>{b.d30_visits || 0}</td>
                  <td style={{ textAlign: 'center' }}>{b.d60_visits || 0}</td>
                  <td style={{ textAlign: 'center' }}>{b.d90_visits || 0}</td>
                  <td style={{ textAlign: 'center', fontWeight: 600 }}>{b.all_time_visits || 0}</td>
                  <td className="rx-sub">{b.added_by || '—'}</td>
                  {!hideOwner && <td>{ownerU ? <><div style={{ fontSize: '11.5px', fontWeight: 600 }}>{ownerU.name}</div><span className="rx-sub">{ownerU.team}</span></> : <span className="muted">—</span>}</td>}
                  <td style={{ whiteSpace: 'normal', maxWidth: 200 }}>{propsVisited.length ? propsVisited.map((s, i) => <span key={i} className="rx-chip">{s}</span>) : <span className="muted">—</span>}</td>
                  <td className="rx-sub">{e.lastVisit ? fmtDay(e.lastVisit) : '—'}</td>
                  <td>{e.fuDate ? <><div style={{ fontSize: '11.5px' }}>{fmtDate(e.fuDate)}</div><div className="rx-sub">{fmtDay(e.fuDate)}{e.fuBy ? ` · by ${e.fuBy}` : ''}</div></> : <span className="muted">Not taken</span>}</td>
                </tr>
              );
            }) : (
              <tr><td colSpan={14}><div className="empty"><div className="emoji">👥</div><div className="t">No CPs match these filters</div></div></td></tr>
            )}
          </tbody>
        </table>
      </div>

      {totalPages > 1 && (
        <div className="rx-pager">
          <button className="btn xs" disabled={pg <= 1} onClick={() => setPage(pg - 1)}>← Prev</button>
          <span className="muted" style={{ fontSize: 12 }}>Page {pg} / {totalPages} · {sorted.length} CPs</span>
          <button className="btn xs" disabled={pg >= totalPages} onClick={() => setPage(pg + 1)}>Next →</button>
        </div>
      )}
    </div>
  );
}
