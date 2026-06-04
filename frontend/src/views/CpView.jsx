import { useEffect, useMemo, useState, useDeferredValue } from 'react';
import { fmtDate, fmtDay } from '../lib/format.js';
import { usersBySlug, ownedCpCodes, buildCpIndex, TIERS, TIER_META, sortInTier } from '../lib/brokers.js';
import { LAST_FU_PRESETS, matchLastFuFilter } from '../lib/visits.js';
import { TEAM_PILL, lastFollowupTakenForCp, buildFuByVisit, isCpNudged, isCpTlAsk } from '../lib/legacy.js';
import ChipBar from '../components/ChipBar.jsx';
import useIsMobile from '../lib/useIsMobile.js';

const CITIES = ['Gurgaon', 'Noida', 'Ghaziabad'];
const PAGE = 100;   // render in pages so a 2,000+ row tier doesn't lock up the browser

// Short tier descriptions used in the mobile layout (legacy renderCpViewMobile, 2583-2588).
const TIER_DESC_MOBILE = {
  T1: 'KAM-owned · top performers',
  T2: 'KAM-owned · promotable',
  T3: 'Ground-owned · active',
  T4: 'Ground-owned · inactive',
};

const PRIORITY_OPTS = [
  { k: 'all', label: 'All', cls: '' },
  { k: 'nudged', label: '🔔 Has nudge', cls: 'pr-nudged' },
  { k: 'tl_ask', label: '📌 On TL daily list', cls: 'pr-tl' },
];

// D30 bold color rule (spec #9.7 / mobile #12.4).
const d30Color = (n) => (n >= 3 ? 'var(--good)' : n > 0 ? 'var(--warn)' : 'var(--mut2)');

export default function CpView({ seed, onOpenBroker, search = '' }) {
  const isMobile = useIsMobile();
  const me = seed.current_user || {};
  const cpOwner = seed.cp_owner || {};
  const properties = seed.properties || [];
  const visits = seed.visits || [];
  const brokers = seed.brokers || [];
  const nudgesByVisit = seed.nudges_by_visit || {};
  const teamTasks = seed.team_tasks || {};

  const ubs = useMemo(() => usersBySlug(seed), [seed]);
  const cpIndex = useMemo(() => buildCpIndex(visits, ubs), [visits, ubs]); // one pass — fixes #1
  const mineSet = useMemo(() => ownedCpCodes(brokers, me, cpOwner, properties, visits), [seed]); // eslint-disable-line
  const ownerOptions = useMemo(() => (seed.users || []).slice().sort((a, b) => (a.name || '').localeCompare(b.name || '')), [seed]);

  // Per-CP visit list — used for last-FU + nudge derivation (one map, O(1) per CP).
  const visitsByCp = useMemo(() => {
    const m = {};
    for (const v of visits) {
      if (!v.cp_code) continue;
      (m[v.cp_code] = m[v.cp_code] || []).push(v);
    }
    return m;
  }, [visits]);

  // Same universe/scope as the prior file: my CPs + every T3/T4 (visible to all).
  const universe = useMemo(() => brokers
    .filter((b) => mineSet.has(b.cp_code) || b.tier === 'T3' || b.tier === 'T4')
    .map((b) => ({ ...b, _mine: mineSet.has(b.cp_code) })), [brokers, mineSet]);

  const [tier, setTier] = useState('T1');
  const [city, setCity] = useState('all');
  const [owner, setOwner] = useState('all');   // all | __none__ | slug
  const [unit, setUnit] = useState('');         // #4 typeable unit number
  const [sort, setSort] = useState('rank');
  const [lastFu, setLastFu] = useState('all');     // chip-bar 1
  const [priority, setPriority] = useState('all'); // chip-bar 2
  const [page, setPage] = useState(1);
  const dq = useDeferredValue(search);              // global topbar search, debounced

  // overlay seed.followups into per-CP last-FU (matches legacy store.followupLog).
  const fuByVisit = useMemo(() => buildFuByVisit(seed.followups || []), [seed]);
  // Per-CP last-FU date (matchLastFuFilter input). Memoized over the whole universe.
  const lfForCp = useMemo(() => {
    const m = {};
    universe.forEach((b) => { m[b.cp_code] = lastFollowupTakenForCp(b.cp_code, visitsByCp[b.cp_code] || [], fuByVisit); });
    return m;
  }, [universe, visitsByCp, fuByVisit]);
  const nudgedForCp = useMemo(() => {
    const m = {};
    universe.forEach((b) => { m[b.cp_code] = isCpNudged(b.cp_code, visitsByCp[b.cp_code] || [], nudgesByVisit); });
    return m;
  }, [universe, visitsByCp, nudgesByVisit]);
  const tlAskForCp = useMemo(() => {
    const m = {};
    universe.forEach((b) => { m[b.cp_code] = isCpTlAsk(b.cp_code, teamTasks); });
    return m;
  }, [universe, teamTasks]);

  // City-scoped base list — drives the chip counts (independent, do not cascade — spec #5/#6).
  const baseCity = useMemo(() => universe.filter((b) => city === 'all' || b.city === city), [universe, city]);

  const lastFuCounts = useMemo(() => {
    const c = {};
    LAST_FU_PRESETS.forEach((p) => { c[p.k] = baseCity.filter((b) => matchLastFuFilter(lfForCp[b.cp_code], p.k)).length; });
    return c;
  }, [baseCity, lfForCp]);
  const priorityCounts = useMemo(() => ({
    all: baseCity.length,
    nudged: baseCity.filter((b) => nudgedForCp[b.cp_code]).length,
    tl_ask: baseCity.filter((b) => tlAskForCp[b.cp_code]).length,
  }), [baseCity, nudgedForCp, tlAskForCp]);

  // Filter pipeline (spec #4): city → search(name/cp/company/phone) → lastFu → priority,
  // plus the kept owner + unit filters from the prior file.
  const filteredAll = useMemo(() => universe.filter((b) => {
    if (city !== 'all' && b.city !== city) return false;
    if (owner !== 'all') { const o = cpOwner[b.cp_code]; if (owner === '__none__' ? !!o : o !== owner) return false; }
    if (unit.trim()) { const u = cpIndex[b.cp_code]?.units || []; if (!u.some((x) => x.includes(unit.trim().toLowerCase()))) return false; }
    if (dq.trim()) {
      const s = dq.trim().toLowerCase();
      if (!((b.name || '').toLowerCase().includes(s) || (b.cp_code || '').toLowerCase().includes(s)
        || (b.company_name || '').toLowerCase().includes(s) || (b.phone_number || '').includes(s))) return false;
    }
    if (lastFu !== 'all' && !matchLastFuFilter(lfForCp[b.cp_code], lastFu)) return false;
    if (priority === 'nudged' && !nudgedForCp[b.cp_code]) return false;
    if (priority === 'tl_ask' && !tlAskForCp[b.cp_code]) return false;
    return true;
  }), [universe, city, owner, unit, dq, lastFu, priority, cpIndex, cpOwner, lfForCp, nudgedForCp, tlAskForCp]);

  const groups = useMemo(() => {
    const g = { T1: [], T2: [], T3: [], T4: [] };
    filteredAll.forEach((b) => { (g[b.tier || 'T4'] = g[b.tier || 'T4'] || []).push(b); });
    return g;
  }, [filteredAll]);

  const activeTier = (groups[tier] && groups[tier].length) ? tier : (TIERS.find((t) => groups[t]?.length) || 'T1');
  const hideOwner = activeTier === 'T3' || activeTier === 'T4';   // #5: CP Owner hidden for T3/T4
  const sorted = useMemo(() => {
    const list = groups[activeTier] || [];
    if (sort === 'recent') return list.slice().sort((a, b) => ((cpIndex[b.cp_code]?.lastVisit) || '').localeCompare((cpIndex[a.cp_code]?.lastVisit) || ''));
    if (sort === 'onboard') return list.slice().sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
    return sortInTier(list, sort);
  }, [groups, activeTier, sort, cpIndex]);
  const SORT_LABEL = { rank: 'Rank (tier)', recent: 'Most recent visit', d30: 'D30 visits', all_time: 'All-time visits', onboard: 'Recently onboarded' };

  // pagination — only render PAGE rows at a time
  const totalPages = Math.max(1, Math.ceil(sorted.length / PAGE));
  const pg = Math.min(page, totalPages);
  const pageRows = useMemo(() => sorted.slice((pg - 1) * PAGE, pg * PAGE), [sorted, pg]);
  useEffect(() => { setPage(1); }, [activeTier, city, owner, unit, dq, sort, lastFu, priority]);

  // ---- desktop row ----
  const renderRow = (b) => {
    const ownerU = ubs[cpOwner[b.cp_code]];
    const e = cpIndex[b.cp_code] || {};
    const lf = lfForCp[b.cp_code];
    const nud = nudgedForCp[b.cp_code];
    const tl = tlAskForCp[b.cp_code];
    const d30 = b.d30_visits || 0;
    const d60 = b.d60_visits || 0;
    const d90 = b.d90_visits || 0;
    const mm = (b.micro_markets || '').split(',').slice(0, 2).join(',');
    return (
      <tr key={b.cp_code} data-cp={b.cp_code} style={{ cursor: 'pointer' }} onClick={() => onOpenBroker(b.cp_code)}>
        <td>{b.tier_rank ? '#' + b.tier_rank : '—'}</td>
        <td>
          <b>{b.name}</b>
          <div style={{ fontSize: '10.5px', color: 'var(--mut)', marginTop: 1 }}>{(b.company_name || '')} · {b.phone_number}</div>
        </td>
        <td>
          <span className="city-pill">{b.city || ''}</span>
          <div style={{ fontSize: '10.5px', color: 'var(--mut)', marginTop: 1, whiteSpace: 'normal' }}>{mm}</div>
        </td>
        <td><span className="id-pill">{b.cp_code}</span></td>
        <td><span style={{ fontSize: '10.5px', color: 'var(--mut)', background: 'var(--panel2)', padding: '2px 7px', borderRadius: 4 }}>{b.activity_category || '—'}</span></td>
        <td style={{ textAlign: 'center', fontWeight: d30 > 0 ? 700 : 500, color: d30Color(d30) }}>{d30}</td>
        <td style={{ textAlign: 'center', fontWeight: d60 > 0 ? 600 : 500, color: d60 >= 3 ? 'var(--txt)' : 'var(--mut2)' }}>{d60}</td>
        <td style={{ textAlign: 'center', fontWeight: d90 > 0 ? 600 : 500, color: d90 >= 3 ? 'var(--txt)' : 'var(--mut2)' }}>{d90}</td>
        <td style={{ textAlign: 'center', fontWeight: 600 }}>{b.all_time_visits || 0}</td>
        <td style={{ fontSize: '11.5px' }}>{b.added_by || '—'}</td>
        {!hideOwner && (
          <td>{ownerU
            ? <><div style={{ fontSize: '11.5px', fontWeight: 600 }}>{ownerU.name}</div><span className={'role-pill ' + (TEAM_PILL[ownerU.team] || '')}>{ownerU.team}</span></>
            : <span className="muted">—</span>}</td>
        )}
        <td style={{ fontSize: '11.5px' }}>{e.lastVisit ? fmtDay(e.lastVisit) : '—'}</td>
        <td className={'last-fu-cell ' + (lf ? '' : 'none')}>
          {lf ? <><div className="lf-date">{fmtDate(lf)}</div><div className="lf-ago">{fmtDay(lf)}</div></> : 'Not taken'}
        </td>
        <td>
          {nud && <span className="prio-tag nudge" title="Has active nudge">🔔</span>}
          {tl && <>{nud ? ' ' : ''}<span className="prio-tag tl" title="On TL daily call list">📌</span></>}
        </td>
      </tr>
    );
  };

  // ---- mobile card ----
  const renderCard = (b) => {
    const ownerU = ubs[cpOwner[b.cp_code]];
    const e = cpIndex[b.cp_code] || {};
    const lf = lfForCp[b.cp_code];
    const nud = nudgedForCp[b.cp_code];
    const tl = tlAskForCp[b.cp_code];
    const d30 = b.d30_visits || 0;
    const mm = (b.micro_markets || '').split(',').slice(0, 2).map((s) => s.trim()).filter(Boolean).join(' · ');
    return (
      <div key={b.cp_code} className="m-card" onClick={() => onOpenBroker(b.cp_code)}>
        <div className="mc-top">
          <div className="mc-title">
            {b.tier_rank ? <span style={{ fontSize: '11px', color: 'var(--mut)', fontWeight: 600 }}>#{b.tier_rank}</span> : null}{b.tier_rank ? ' ' : ''}{b.name}
            <span className="sub">{(b.company_name || '')} · {b.phone_number}</span>
          </div>
          <div className="mc-right">
            <span className={'tier-badge ' + (b.tier || 'T4')}>{b.tier || 'T4'}</span>
            <span style={{ fontSize: '10px', color: 'var(--mut)', marginTop: 3 }}>{b.activity_category || ''}</span>
          </div>
        </div>
        <div className="mc-meta">
          <span className="city-pill">{b.city || ''}</span>
          <span style={{ fontSize: '11px' }}>{mm}</span>
        </div>
        <div className="mc-foot" style={{ borderTop: '1px solid var(--line)', paddingTop: 8 }}>
          <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
            <span><b style={{ color: d30Color(d30) }}>{d30}</b> <span style={{ color: 'var(--mut)', fontSize: '10.5px' }}>D30</span></span>
            <span><b>{b.d90_visits || 0}</b> <span style={{ color: 'var(--mut)', fontSize: '10.5px' }}>D90</span></span>
            <span><b>{b.all_time_visits || 0}</b> <span style={{ color: 'var(--mut)', fontSize: '10.5px' }}>All</span></span>
            {e.lastVisit && <span style={{ color: 'var(--mut)', fontSize: '10.5px' }}>Last: {fmtDay(e.lastVisit)}</span>}
          </div>
          <div className="quick-actions">
            {b.phone_number && <a className="qa call" href={`tel:${b.phone_number}`} onClick={(ev) => ev.stopPropagation()} title="Call">📞</a>}
            {b.phone_number && <button type="button" className="qa wa" onClick={(ev) => ev.stopPropagation()} title="WhatsApp (draft picker)">💬</button>}
          </div>
        </div>
        {ownerU && (
          <div style={{ marginTop: 6, fontSize: '11px', color: 'var(--mut)', display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            Owner: <b style={{ color: 'var(--txt)' }}>{ownerU.name}</b> <span className={'role-pill ' + (TEAM_PILL[ownerU.team] || '')}>{ownerU.team}</span>
            {lf ? <span>· Last FU: <b style={{ color: 'var(--txt)' }}>{fmtDay(lf)}</b></span> : <span>· <b style={{ color: 'var(--bad)' }}>Not taken</b></span>}
            {nud && <span className="prio-tag nudge">🔔 Nudge</span>}
            {tl && <span className="prio-tag tl">📌 TL</span>}
          </div>
        )}
      </div>
    );
  };

  const tierTabs = (
    <div className="tier-tabs">
      {TIERS.map((t) => (
        <button key={t} type="button" className={t.toLowerCase() + (activeTier === t ? ' on' : '')} onClick={() => setTier(t)}>
          {isMobile
            ? TIER_META[t].label.replace('Tier ', 'T')
            : <span className={'tier-badge ' + t} style={{ background: 'transparent', color: 'inherit', padding: 0 }}>{TIER_META[t].label}</span>}
          <span className="ct">{(groups[t] || []).length}</span>
        </button>
      ))}
    </div>
  );

  return (
    <div className="rx-fade">
      <ChipBar label="Last followup taken with this CP"
               options={LAST_FU_PRESETS} showDots={false}
               counts={lastFuCounts} value={lastFu} onChange={setLastFu} />
      <ChipBar label="Priority · TL ask & nudges"
               options={PRIORITY_OPTS}
               counts={priorityCounts} value={priority} onChange={setPriority} />

      <div className="rx-filters" style={{ marginTop: 4 }}>
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
          <option value="rank">Sort: Rank (tier)</option>
          <option value="recent">Sort: Most recent visit</option>
          <option value="d30">Sort: D30 visits</option>
          <option value="all_time">Sort: All-time visits</option>
          <option value="onboard">Sort: Recently onboarded</option>
        </select>
        <input className="rx-inp" style={{ width: 132 }} placeholder="Unit no. — 203" value={unit} onChange={(e) => setUnit(e.target.value)} />
      </div>

      <div className="list-head" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', color: 'var(--mut)', fontSize: 12, margin: '6px 2px 10px' }}>
        <span>{filteredAll.length} CPs</span>
        <span>Sort within tier · {SORT_LABEL[sort] || 'Rank (tier)'}</span>
      </div>

      {tierTabs}
      <div style={{ fontSize: isMobile ? '11px' : '11.5px', color: 'var(--mut)', marginBottom: isMobile ? 8 : 10, padding: '0 4px', fontStyle: 'italic' }}>
        {isMobile ? TIER_DESC_MOBILE[activeTier] : TIER_META[activeTier].desc}
      </div>

      {isMobile ? (
        <div className="m-card-list">
          {pageRows.length ? pageRows.map(renderCard) : (
            <div className="empty"><div className="emoji">👥</div><div className="t">No CPs in this tier</div></div>
          )}
        </div>
      ) : (
        <div className="cp-tbl-wrap" style={{ borderRadius: 10 }}>
          <table className="t" style={{ minWidth: hideOwner ? 1300 : 1420 }}>
            <thead><tr>
              <th>Rank</th><th>Channel Partner</th><th>City · MM</th><th>CP Code</th><th>Activity</th>
              <th style={{ textAlign: 'center' }}>D30</th><th style={{ textAlign: 'center' }}>D60</th>
              <th style={{ textAlign: 'center' }}>D90</th><th style={{ textAlign: 'center' }}>All time</th>
              <th>Onboarded by</th>{!hideOwner && <th>CP Owner</th>}<th>Last visit</th><th>Last FU taken</th><th>⚑</th>
            </tr></thead>
            <tbody>
              {pageRows.length ? pageRows.map(renderRow) : (
                <tr><td colSpan={hideOwner ? 13 : 14}><div className="empty"><div className="emoji">👥</div><div className="t">No CPs in this tier for your scope</div></div></td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {totalPages > 1 && (
        <div className="rx-pager">
          <button className="btn xs" type="button" disabled={pg <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>← Prev</button>
          <span className="muted" style={{ fontSize: 12 }}>Page {pg} / {totalPages} · {sorted.length} CPs</span>
          <button className="btn xs" type="button" disabled={pg >= totalPages} onClick={() => setPage((p) => Math.min(totalPages, p + 1))}>Next →</button>
        </div>
      )}
    </div>
  );
}
