import { useEffect, useMemo, useState, useDeferredValue } from 'react';
import { fmtDate, fmtDay, daysBetween } from '../lib/format.js';
import {
  STAGES, STAGE_BY_KEY, STATUSES, LAST_FU_PRESETS,
  visitStage, visitStatus, nextFuFor, matchLastFuFilter, scopeVisits, isOldLead, visitUnitText,
} from '../lib/visits.js';
import { usersBySlug } from '../lib/brokers.js';
import {
  TEAM_PILL, fmtPrice, nextFuClass, lastFollowupTakenForVisit, buildFuByVisit,
  isVisitNudged, isVisitTlAsk, priceForVisit,
} from '../lib/legacy.js';
import { flatNo } from '../lib/propertyStatus.js';
import { toast } from '../lib/toast.js';
import useIsMobile from '../lib/useIsMobile.js';
import ChipBar from '../components/ChipBar.jsx';

const CITIES = ['Gurgaon', 'Noida', 'Ghaziabad'];
const PAGE_SIZE = 60;

const STATUS_OPTS = [{ k: 'all', label: 'All', cls: '' }, ...STATUSES];
// "Visit Completed" = every operational stage except Upcoming + Cancelled.
const COMPLETED_EXCLUDE = new Set(['upcoming', 'cancelled']);
const STAGE_OPTS = [
  { k: 'all', label: 'All', cls: '' },
  { k: '__completed', label: 'Visit Completed', cls: 'sg-avfu' },
  ...STAGES,
];
// true if a visit's stage passes the selected stage filter (handles the meta value)
const stagePass = (vstage, sel) => sel === 'all'
  || (sel === '__completed' ? !COMPLETED_EXCLUDE.has(vstage) : vstage === sel);
const PRIORITY_OPTS = [
  { k: 'all', label: 'All', cls: '' },
  { k: 'nudged', label: '🔔 Nudged', cls: 'pr-nudged' },
  { k: 'tl_ask', label: '📌 TL Ask', cls: 'pr-tl' },
];

// VISIT_COLS — verbatim order from legacy crm.html (line 2312)
const VISIT_COLS = [
  { k: 'check' },
  { k: 'star' },
  { k: 'id', label: 'Visit ID', sort: true },
  { k: 'visit_date', label: 'Visit', sort: true },
  { k: 'city', label: 'City', sort: true },
  { k: 'rm', label: 'RM', sort: true },
  { k: 'society_name', label: 'Society / Unit', sort: true },
  { k: 'buyer', label: 'Buyer', sort: true },
  { k: 'cp', label: 'CP · Tier', sort: true },
  { k: 'cp_owner', label: 'CP Owner', sort: true },
  { k: 'source', label: 'Src', sort: true },
  { k: 'status', label: 'Status', sort: false },
  { k: 'stage', label: 'Stage', sort: false },
  { k: 'nextFu', label: 'Next FU', sort: true },
  { k: 'lastFu', label: 'Last FU', sort: true },
  { k: 'priority', label: '⚑', sort: false },
  { k: 'price', label: 'Price', sort: false },
];

export default function VisitsView({ seed, onOpenBroker, search = '', filters = {} }) {
  const isMobile = useIsMobile();
  const me = seed.current_user || {};
  const cpOwner = seed.cp_owner || {};
  const properties = seed.properties || [];
  const nudgesByVisit = seed.nudges_by_visit || {};
  const teamTasks = seed.team_tasks || {};

  const ubs = useMemo(() => usersBySlug(seed), [seed]);
  const brokersByCode = useMemo(() => {
    const m = {};
    (seed.brokers || []).forEach((b) => { m[b.cp_code] = b; });
    return m;
  }, [seed]);

  const scoped = useMemo(
    () => scopeVisits(seed.visits || [], me, cpOwner, properties, seed.pm_by_property || {}),
    [seed], // eslint-disable-line react-hooks/exhaustive-deps
  );
  // overlay seed.followups so 'Last FU' reflects followups even when the visit
  // projection (latest_followup_date) is blank — matches legacy store.followupLog.
  const fuByVisit = useMemo(() => buildFuByVisit(seed.followups || []), [seed]);
  // society -> { micro-markets, BHK configs } for the advanced locality/BHK filters
  const propBySociety = useMemo(() => {
    const m = {};
    properties.forEach((p) => {
      if (!p.society_name) return;
      const e = m[p.society_name] || (m[p.society_name] = { mms: new Set(), bhks: new Set() });
      if (p.micro_market) e.mms.add(p.micro_market);
      const dig = String(p.configuration || '').match(/([1-4])\s*BHK/i);
      if (dig) e.bhks.add(dig[1] + ' BHK');
    });
    return m;
  }, [properties]);

  const isAdminOrTL = me.team === 'Admin' || me.team === 'TL' || me.role === 'admin' || (me.role || '').includes('tl');
  const isAdmin = me.team === 'Admin' || me.role === 'admin';

  // --- filter state (multi-select chip-bars) ---
  const [statuses, setStatuses] = useState([]);
  const [stages, setStages] = useState([]);
  const [lastFus, setLastFus] = useState([]); // default: show all FU states (the "Not taken yet" chip is still there to focus)
  const [priorities, setPriorities] = useState([]);
  const [leadSet, setLeadSet] = useState('active');  // #6 Active | Old Leads | All — default hides old leads
  // city + unit filters now live in the Filters modal (filters.cities / filters.unit)
  const [sortField, setSortField] = useState('visit_date');
  const [sortDir, setSortDir] = useState('desc');  // default visit_date desc
  const [page, setPage] = useState(1);
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState(() => new Set());

  // owner resolver (legacy USERS_BY_ID[store.cpOwner[cp]])
  const ownerFor = (v) => ubs[cpOwner[v.cp_code]] || null;

  // --- per-row helpers reused across counts/sort/render ---
  const tierFor = (v) => (brokersByCode[v.cp_code]?.tier) || 'T4';

  const oldCount = useMemo(() => scoped.filter(isOldLead).length, [scoped]);
  // city + lead-set scoped base — drives status & stage chip counts. Default 'active'
  // hides old leads (pre-1-May, never actioned), which also lightens the working set.
  const cityBase = useMemo(() => scoped.filter((v) => {
    if (filters.cities?.length && !filters.cities.includes(v.city)) return false;
    const old = isOldLead(v);
    if (leadSet === 'active' && old) return false;
    if (leadSet === 'old' && !old) return false;
    return true;
  }), [scoped, filters, leadSet]);

  const statusCounts = useMemo(() => {
    const c = { all: cityBase.length, hot: 0, warm: 0, cold: 0, dead: 0, future_prospect: 0, unc: 0 };
    cityBase.forEach((v) => { const s = visitStatus(v); c[s] = (c[s] || 0) + 1; });
    return c;
  }, [cityBase]);

  const stageCounts = useMemo(() => {
    const c = { all: cityBase.length, __completed: 0 };
    STAGES.forEach((s) => { c[s.k] = 0; });
    cityBase.forEach((v) => {
      const s = visitStage(v);
      c[s] = (c[s] || 0) + 1;
      if (!COMPLETED_EXCLUDE.has(s)) c.__completed += 1;
    });
    return c;
  }, [cityBase]);

  // last-FU base = city base + status + stage (multi-select)
  const lastFuBase = useMemo(() => cityBase.filter((v) => {
    if (statuses.length && !statuses.includes(visitStatus(v))) return false;
    if (stages.length && !stages.some((s) => stagePass(visitStage(v), s))) return false;
    return true;
  }), [cityBase, statuses, stages]);

  const lastFuCounts = useMemo(() => {
    const c = {};
    LAST_FU_PRESETS.forEach((p) => {
      c[p.k] = lastFuBase.filter((v) => matchLastFuFilter(lastFollowupTakenForVisit(v, fuByVisit), p.k, v)).length;
    });
    return c;
  }, [lastFuBase]);

  // priority base = last-FU base + lastFu filter (multi-select; match ANY chosen bucket)
  const priorityBase = useMemo(() => lastFuBase.filter((v) => {
    if (lastFus.length && !lastFus.some((kk) => matchLastFuFilter(lastFollowupTakenForVisit(v, fuByVisit), kk, v))) return false;
    return true;
  }), [lastFuBase, lastFus, fuByVisit]);

  const priorityCounts = useMemo(() => ({
    all: priorityBase.length,
    nudged: priorityBase.filter((v) => isVisitNudged(v, nudgesByVisit)).length,
    tl_ask: priorityBase.filter((v) => isVisitTlAsk(v, teamTasks)).length,
  }), [priorityBase, nudgesByVisit, teamTasks]);

  // --- full filtered set (legacy filterVisits): search + status + stage + lastFu + priority + unit ---
  // deferred search keeps typing responsive on slower machines (non-blocking recompute)
  const dq = useDeferredValue(search);
  const filtered = useMemo(() => cityBase.filter((v) => {
    if (dq.trim()) {
      const s = dq.trim().toLowerCase();
      const hit = (v.id || '').toLowerCase().includes(s)
        || (v.society_name || '').toLowerCase().includes(s)
        || (v.broker_name || '').toLowerCase().includes(s)
        || (v.buyer_name || '').toLowerCase().includes(s)
        || (v.cp_code || '').toLowerCase().includes(s)
        || (v.broker_contact || '').includes(s)
        || (v.buyer_contact || '').includes(s)
        || (v.company_name || '').toLowerCase().includes(s)
        || (v.sales_manager || '').toLowerCase().includes(s);
      if (!hit) return false;
    }
    if (statuses.length && !statuses.includes(visitStatus(v))) return false;
    if (stages.length && !stages.some((s) => stagePass(visitStage(v), s))) return false;
    if (lastFus.length && !lastFus.some((kk) => matchLastFuFilter(lastFollowupTakenForVisit(v, fuByVisit), kk, v))) return false;
    if (priorities.length && !((priorities.includes('nudged') && isVisitNudged(v, nudgesByVisit)) || (priorities.includes('tl_ask') && isVisitTlAsk(v, teamTasks)))) return false;
    // --- advanced filters (topbar Filters modal) ---
    const F = filters || {};
    if (F.unit) {
      // match on flat number only — the dropdown now yields "704" (tower-agnostic), and
      // legacy saved values like "A-704" normalise to the same flat number too.
      const target = flatNo(F.unit);
      const vno = flatNo(v.unit_address_line1) || flatNo([v.unit_address_line1, v.unit_address_line2].filter(Boolean).join(' '));
      if (target && vno !== target) return false;
    }
    if (F.society && v.society_name !== F.society) return false;
    if (F.locality) {
      const mms = propBySociety[v.society_name]?.mms;
      if (!(mms && mms.has(F.locality)) && !(v.society_name || '').toLowerCase().includes(F.locality.toLowerCase())) return false;
    }
    if (F.bhk?.length) {
      const bhks = propBySociety[v.society_name]?.bhks;
      if (!bhks || !F.bhk.some((b) => bhks.has(b))) return false;
    }
    if (F.tier?.length) { const b = brokersByCode[v.cp_code]; if (!b || !F.tier.includes(b.tier)) return false; }
    if (F.cp && v.cp_code !== F.cp) return false;
    if (F.rm && v.sales_manager !== F.rm) return false;
    if (F.source?.length && !F.source.includes(v.source)) return false;
    if (F.visitFrom && !(v.visit_date && v.visit_date >= F.visitFrom)) return false;
    if (F.visitTo && !(v.visit_date && v.visit_date <= F.visitTo)) return false;
    if (F.followupDate?.length) {
      const nf = nextFuFor(v);
      let ok = F.followupDate.includes('none') && !nf;
      if (nf != null) {
        const d = daysBetween(nf);
        if (F.followupDate.includes('overdue') && d > 0) ok = true;
        if (F.followupDate.includes('today') && d === 0) ok = true;
        if (F.followupDate.includes('tomorrow') && d === -1) ok = true;
        if (F.followupDate.includes('week') && d <= 0 && d > -7) ok = true;
      }
      if (!ok) return false;
    }
    return true;
  }), [cityBase, dq, statuses, stages, lastFus, priorities, filters, propBySociety, brokersByCode, nudgesByVisit, teamTasks, fuByVisit]);

  // --- sort (legacy sortVisits) ---
  const sorted = useMemo(() => {
    const dir = sortDir === 'asc' ? 1 : -1;
    const key = (v) => {
      switch (sortField) {
        case 'id': return parseInt(v.id, 10) || 0;
        case 'visit_date': return v.visit_date || '';
        case 'city': return v.city || '';
        case 'rm': return v.sales_manager || '';
        case 'society_name': return v.society_name || '';
        case 'buyer': return v.buyer_name || '';
        case 'cp': return v.broker_name || '';
        case 'cp_owner': { const o = ownerFor(v); return o ? (o.name || '') : ''; }
        case 'source': return v.source || '';
        case 'nextFu': return nextFuFor(v) || '9999-12-31';
        case 'lastFu': return lastFollowupTakenForVisit(v, fuByVisit) || '0000-00-00';
        default: return '';
      }
    };
    return filtered.slice().sort((a, b) => (key(a) > key(b) ? 1 : key(a) < key(b) ? -1 : 0) * dir);
  }, [filtered, sortField, sortDir]); // eslint-disable-line react-hooks/exhaustive-deps

  const total = sorted.length;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const pg = Math.min(page, totalPages);
  const pageVisits = useMemo(() => sorted.slice((pg - 1) * PAGE_SIZE, pg * PAGE_SIZE), [sorted, pg]);
  const start = total === 0 ? 0 : (pg - 1) * PAGE_SIZE + 1;
  const end = Math.min(total, pg * PAGE_SIZE);

  // reset to page 1 when any filter changes
  useEffect(() => { setPage(1); }, [statuses, stages, lastFus, priorities, leadSet, dq, filters, sortField, sortDir]);

  function onSort(k) {
    if (sortField === k) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else { setSortField(k); setSortDir('desc'); }
  }

  function toggleSel(id) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }
  function toggleSelAll() {
    const allOn = pageVisits.length && pageVisits.every((v) => selected.has(v.id));
    setSelected((prev) => {
      const next = new Set(prev);
      if (allOn) pageVisits.forEach((v) => next.delete(v.id));
      else pageVisits.forEach((v) => next.add(v.id));
      return next;
    });
  }
  const pageAllSelected = pageVisits.length > 0 && pageVisits.every((v) => selected.has(v.id));

  function openWa(cp) {
    if (cp) toast('WhatsApp draft picker — ' + cp);
  }

  // #3 — export the CURRENTLY-VISIBLE rows (full filtered + sorted set, not just the page)
  function exportCsv() {
    const esc = (val) => {
      const s = val == null ? '' : String(val);
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const headers = [
      'Visit ID', 'Visit date', 'Selected time', 'City', 'RM', 'Society', 'Unit',
      'Buyer', 'Buyer contact', 'CP name', 'CP code', 'Company', 'Buyer status',
      'Stage', 'Next FU', 'Last FU', 'Price',
    ];
    const rows = sorted.map((v) => {
      const st = visitStatus(v);
      const stLabel = STATUSES.find((s) => s.k === st)?.label || st;
      const sgDef = STAGE_BY_KEY[visitStage(v)];
      const sgLabel = sgDef ? sgDef.label : visitStage(v);
      const price = priceForVisit(v, properties);
      return [
        v.id || '',
        v.visit_date || '',
        v.selected_time || '',
        v.city || '',
        v.sales_manager || '',
        v.society_name || '',
        visitUnitText(v),
        v.buyer_name || '',
        v.buyer_contact || '',
        v.broker_name || '',
        v.cp_code || '',
        v.company_name || '',
        stLabel,
        sgLabel,
        nextFuFor(v) || '',
        lastFollowupTakenForVisit(v, fuByVisit) || '',
        price ? fmtPrice(price) : '',
      ].map(esc).join(',');
    });
    const csv = [headers.map(esc).join(','), ...rows].join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'oh-visits.csv';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  return (
    <div className="rx-fade">
      {/* ===== 4 chip-bars ===== */}
      <ChipBar multi
        label="Buyer status · Hot / Warm / Cold / Dead — set in AVFU"
        options={STATUS_OPTS}
        counts={statusCounts}
        value={statuses}
        onChange={setStatuses}
      />
      <ChipBar multi
        label="Visit stage · operational pipeline"
        options={STAGE_OPTS}
        counts={stageCounts}
        value={stages}
        onChange={setStages}
      />
      <ChipBar multi
        label={'Last followup taken · default "Not taken" focuses on remaining work'}
        options={LAST_FU_PRESETS}
        counts={lastFuCounts}
        value={lastFus}
        onChange={setLastFus}
        showDots={false}
      />
      <ChipBar multi
        label="Priority · TL ask & nudges"
        options={PRIORITY_OPTS}
        counts={priorityCounts}
        value={priorities}
        onChange={setPriorities}
      />

      {/* ===== filter row: leads segment + select (city + unit moved to Filters modal) ===== */}
      <div className="rx-filters" style={{ marginTop: 4 }}>
        <div className="rx-segment" title="Old Leads = visits on units that are no longer live inventory (Sold / Archived / Booked, or no listing). Marked Dead.">
          {[['active', 'Active'], ['old', `Old Leads${oldCount ? ` · ${oldCount}` : ''}`], ['all', 'All']].map(([k, l]) => (
            <button key={k} type="button" className={'rx-seg' + (leadSet === k ? ' on' : '')} onClick={() => setLeadSet(k)}>{l}</button>
          ))}
        </div>
        <button
          className={'btn' + (selectMode ? ' primary' : '')}
          type="button"
          onClick={() => { setSelectMode((s) => !s); if (selectMode) setSelected(new Set()); }}
        >
          Select
        </button>
      </div>

      {/* ===== list head + pager ===== */}
      <div className="list-head">
        <span>{start}–{end} of {total} visits</span>
        <div className="pager">
          {isAdmin && (
            <button className="btn xs" type="button" disabled={!total} onClick={exportCsv} title="Download the currently-visible visits as CSV (admins only)">⬇ CSV</button>
          )}
          <button className="btn xs" type="button" disabled={pg <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>← Prev</button>
          Page
          <input
            type="number"
            min={1}
            value={pg}
            onChange={(e) => {
              const n = parseInt(e.target.value, 10);
              if (!Number.isNaN(n)) setPage(Math.min(totalPages, Math.max(1, n)));
            }}
          />
          / <span>{totalPages}</span>
          <button className="btn xs" type="button" disabled={pg >= totalPages} onClick={() => setPage((p) => Math.min(totalPages, p + 1))}>Next →</button>
        </div>
      </div>

      {/* ===== table (desktop) OR cards (mobile) ===== */}
      <div className="tbl-wrap">
        {!isMobile && (
          <table className="t">
            <thead>
              <tr>
                {VISIT_COLS.map((c) => {
                  if (c.k === 'check') {
                    if (!selectMode) return <th key="check" />;
                    return (
                      <th key="check" className="col-check">
                        <input type="checkbox" checked={pageAllSelected} onChange={toggleSelAll} />
                      </th>
                    );
                  }
                  if (c.k === 'star') return <th key="star" />;
                  const isSorted = sortField === c.k;
                  const arrow = isSorted ? (sortDir === 'asc' ? '↑' : '↓') : '';
                  return (
                    <th
                      key={c.k}
                      className={c.sort ? 'sort' : ''}
                      onClick={c.sort ? () => onSort(c.k) : undefined}
                    >
                      {c.label}
                      {arrow ? <span className="sI"> {arrow}</span> : null}
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {pageVisits.length === 0 ? (
                <tr>
                  <td colSpan={VISIT_COLS.length}>
                    <div className="empty">
                      <div className="emoji">🔎</div>
                      <div className="t">No visits</div>
                      <div className="s">Adjust filters or city tab</div>
                    </div>
                  </td>
                </tr>
              ) : pageVisits.map((v) => {
                const tier = tierFor(v);
                const st = visitStatus(v);
                const sg = visitStage(v);
                const sgDef = STAGE_BY_KEY[sg];
                const price = priceForVisit(v, properties);
                const owner = ownerFor(v);
                const nfc = nextFuClass(nextFuFor(v));
                const lfd = lastFollowupTakenForVisit(v, fuByVisit);
                const nudged = isVisitNudged(v, nudgesByVisit);
                const tlAsk = isVisitTlAsk(v, teamTasks);
                const checked = selected.has(v.id);
                const stLabel = STATUSES.find((s) => s.k === st)?.label || st;
                const sub = [v.unit_address_line1, v.unit_address_line2].filter(Boolean).join('-') || (v.listing_status || '');
                return (
                  <tr
                    key={v.id}
                    className={checked ? 'selected' : ''}
                    onClick={(e) => {
                      if (e.target.matches && e.target.matches('input[type="checkbox"]')) return;
                      onOpenBroker?.(v.cp_code, v.id);
                    }}
                  >
                    {selectMode
                      ? <td className="col-check"><input type="checkbox" checked={checked} onClick={(e) => e.stopPropagation()} onChange={() => toggleSel(v.id)} /></td>
                      : <td />}
                    <td className={'col-star ' + (v._starred ? 'on' : '')}>{v._starred ? '★' : '☆'}</td>
                    <td><span className="id-pill">VST{String(v.id).padStart(4, '0')}</span></td>
                    <td>
                      {fmtDate(v.visit_date)}
                      <div style={{ fontSize: '10.5px', color: 'var(--mut)', marginTop: 1 }}>{v.selected_time || ''}</div>
                    </td>
                    <td><span className="city-pill">{v.city || ''}</span></td>
                    <td>{v.sales_manager || '—'}</td>
                    <td>
                      <b>{v.society_name || '—'}</b>
                      <div style={{ fontSize: '10.5px', color: 'var(--mut)', marginTop: 1 }}>{sub}</div>
                    </td>
                    <td>
                      {v.buyer_name || '—'}
                      <div style={{ fontSize: '10.5px', color: 'var(--mut)', marginTop: 1 }}>{v.buyer_contact || ''}</div>
                    </td>
                    <td>
                      {v.broker_name || '—'} <span className={'tier-badge ' + tier}>{tier}</span>
                      <div style={{ fontSize: '10.5px', color: 'var(--mut)', marginTop: 1 }}>{v.company_name || ''}</div>
                    </td>
                    <td>
                      {owner ? (
                        <>
                          <div style={{ fontSize: '11.5px' }}><b>{(owner.name || '').split(' ')[0]}</b></div>
                          <span className={'role-pill ' + (TEAM_PILL[owner.team] || '')}>{owner.team}</span>
                        </>
                      ) : <span className="muted">—</span>}
                    </td>
                    <td><span className="muted" style={{ fontSize: '11px' }}>{(v.source || '').replace('channel_partner', 'CP').replace('direct', 'Dir')}</span></td>
                    <td><span className={'stpill ' + st}><span className="d" />{stLabel}</span></td>
                    <td><span className={'sgpill ' + sg}><span className="d" />{sgDef ? sgDef.label.replace(' Visit', '') : sg}</span></td>
                    <td><span className={'fu-chip ' + nfc.cls}><span className="d" />{nfc.label}</span></td>
                    <td className={'last-fu-cell ' + (lfd ? '' : 'none')}>
                      {lfd ? (
                        <>
                          <div className="lf-date">{fmtDate(lfd)}</div>
                          <div className="lf-ago">{fmtDay(lfd)}</div>
                        </>
                      ) : 'Not taken'}
                    </td>
                    <td>
                      {nudged ? <span className="prio-tag nudge">🔔 Nudge</span> : null}
                      {tlAsk ? <span className="prio-tag tl">{nudged ? ' ' : ''}📌 TL</span> : null}
                    </td>
                    <td style={{ fontWeight: 600, color: 'var(--accDark)' }}>{price ? fmtPrice(price) : '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}

        {isMobile && (
          <div className="m-card-list">
            {pageVisits.length === 0 ? (
              <div className="empty">
                <div className="emoji">🔎</div>
                <div className="t">No visits</div>
                <div className="s">Adjust filters or city</div>
              </div>
            ) : pageVisits.map((v) => {
              const tier = tierFor(v);
              const st = visitStatus(v);
              const sg = visitStage(v);
              const sgDef = STAGE_BY_KEY[sg];
              const price = priceForVisit(v, properties);
              const owner = ownerFor(v);
              const nfc = nextFuClass(nextFuFor(v));
              const lfd = lastFollowupTakenForVisit(v, fuByVisit);
              const nudged = isVisitNudged(v, nudgesByVisit);
              const tlAsk = isVisitTlAsk(v, teamTasks);
              const checked = selected.has(v.id);
              const stLabel = STATUSES.find((s) => s.k === st)?.label || st;
              const sub = [v.unit_address_line1, v.unit_address_line2].filter(Boolean).join('-') || (v.listing_status || '');
              return (
                <div
                  key={v.id}
                  className={'m-card' + (checked ? ' selected' : '')}
                  onClick={(e) => {
                    if (e.target.closest && e.target.closest('.qa')) return;
                    if (selectMode) { toggleSel(v.id); return; }
                    onOpenBroker?.(v.cp_code, v.id);
                  }}
                >
                  {selectMode ? <div className="mc-check">{checked ? '✓' : ''}</div> : null}
                  <div className="mc-top">
                    <div className="mc-title">
                      {v.society_name || '—'}
                      <span className="sub">{sub} · {v.city || ''}</span>
                    </div>
                    <div className="mc-right">
                      <div><b style={{ color: 'var(--accDark)', fontSize: '14px' }}>{price ? fmtPrice(price) : ''}</b></div>
                      <div>{fmtDate(v.visit_date)}{v.selected_time ? ` · ${v.selected_time}` : ''}</div>
                    </div>
                  </div>
                  <div className="mc-meta">
                    <span>👤 <b>{v.buyer_name || '—'}</b></span>
                    {v.buyer_contact ? <span style={{ color: 'var(--mut)' }}>{v.buyer_contact}</span> : null}
                    {v.lead_occurrence_count && +v.lead_occurrence_count > 1
                      ? <span style={{ color: 'var(--acc)', fontWeight: 600 }}>revisit #{v.lead_occurrence_count}</span> : null}
                  </div>
                  <div className="mc-meta">
                    <span>🤝 <b>{v.broker_name || '—'}</b></span>
                    <span className={'tier-badge ' + tier}>{tier}</span>
                    {v.company_name ? <span style={{ color: 'var(--mut)', fontSize: '11px' }}>{v.company_name}</span> : null}
                  </div>
                  <div className="mc-pills">
                    <span className={'stpill ' + st}><span className="d" />{stLabel}</span>
                    <span className={'sgpill ' + sg}><span className="d" />{sgDef ? sgDef.label.replace(' Visit', '') : sg}</span>
                    <span className={'fu-chip ' + nfc.cls}><span className="d" />Next: {nfc.label}</span>
                    {lfd
                      ? <span className="fu-chip later"><span className="d" />Last FU: {fmtDay(lfd)}</span>
                      : <span className="fu-chip overdue"><span className="d" />FU not taken</span>}
                    {nudged ? <span className="prio-tag nudge">🔔 Nudge</span> : null}
                    {tlAsk ? <span className="prio-tag tl">📌 TL Ask</span> : null}
                  </div>
                  <div className="mc-foot">
                    <span>
                      RM: <b>{v.sales_manager || '—'}</b>
                      {owner ? <> · Owner: <b>{(owner.name || '').split(' ')[0]}</b> <span className={'role-pill ' + (TEAM_PILL[owner.team] || '')}>{owner.team}</span></> : null}
                    </span>
                    <div className="quick-actions">
                      {v.buyer_contact ? <a className="qa call" href={`tel:${v.buyer_contact}`} onClick={(e) => e.stopPropagation()} title="Call buyer">📞</a> : null}
                      {v.cp_code ? <button className="qa wa" type="button" onClick={(e) => { e.stopPropagation(); openWa(v.cp_code); }} title="WhatsApp broker (draft picker)">💬</button> : null}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* ===== selection bar ===== */}
      {(selectMode || selected.size > 0) && (
        <div className="sel-bar">
          <span className="n">{selected.size}</span>
          <span>{selected.size === 1 ? 'visit' : 'visits'} selected</span>
          <button
            className="a"
            type="button"
            onClick={() => { if (selected.size > 0) setSelected(new Set()); else setSelectMode(false); }}
          >
            {selected.size > 0 ? 'Clear' : 'Exit select mode'}
          </button>
          {isAdminOrTL && selected.size > 0 && (
            <button className="a primary" type="button" onClick={() => toast('Reassign ' + selected.size + ' visits…')}>Reassign visits…</button>
          )}
        </div>
      )}
    </div>
  );
}
