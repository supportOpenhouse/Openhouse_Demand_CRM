import { useEffect, useMemo, useState } from 'react';
import { fmtDate, fmtDay } from '../lib/format.js';
import {
  STAGES, STAGE_BY_KEY, STATUSES, LAST_FU_PRESETS,
  visitStage, visitStatus, nextFuFor, matchLastFuFilter, scopeVisits,
} from '../lib/visits.js';
import { usersBySlug } from '../lib/brokers.js';
import {
  TEAM_PILL, fmtPrice, nextFuClass, lastFollowupTakenForVisit, buildFuByVisit,
  isVisitNudged, isVisitTlAsk, priceForVisit,
} from '../lib/legacy.js';
import { toast } from '../lib/toast.js';
import useIsMobile from '../lib/useIsMobile.js';
import ChipBar from '../components/ChipBar.jsx';

const CITIES = ['Gurgaon', 'Noida', 'Ghaziabad'];
const PAGE_SIZE = 60;

const STATUS_OPTS = [{ k: 'all', label: 'All', cls: '' }, ...STATUSES];
const STAGE_OPTS = [{ k: 'all', label: 'All', cls: '' }, ...STAGES];
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

export default function VisitsView({ seed, onOpenBroker }) {
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
    () => scopeVisits(seed.visits || [], me, cpOwner, properties),
    [seed], // eslint-disable-line react-hooks/exhaustive-deps
  );
  // overlay seed.followups so 'Last FU' reflects followups even when the visit
  // projection (latest_followup_date) is blank — matches legacy store.followupLog.
  const fuByVisit = useMemo(() => buildFuByVisit(seed.followups || []), [seed]);

  const isAdminOrTL = me.team === 'Admin' || me.team === 'TL' || me.role === 'admin' || (me.role || '').includes('tl');

  // --- filter state (matches legacy state.* defaults) ---
  const [city, setCity] = useState('all');
  const [status, setStatus] = useState('all');
  const [stage, setStage] = useState('all');
  const [lastFu, setLastFu] = useState('not_taken'); // legacy default: focus on visits with no FU taken yet
  const [priority, setPriority] = useState('all');
  const [unit, setUnit] = useState('');            // #4 typeable unit number
  const [q, setQ] = useState('');
  const [sortField, setSortField] = useState('visit_date');
  const [sortDir, setSortDir] = useState('desc');  // default visit_date desc
  const [page, setPage] = useState(1);
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState(() => new Set());

  // owner resolver (legacy USERS_BY_ID[store.cpOwner[cp]])
  const ownerFor = (v) => ubs[cpOwner[v.cp_code]] || null;

  // --- per-row helpers reused across counts/sort/render ---
  const tierFor = (v) => (brokersByCode[v.cp_code]?.tier) || 'T4';

  // city-scoped base — drives status & stage chip counts (legacy visitsForUser().filter(visibleCity))
  const cityBase = useMemo(
    () => scoped.filter((v) => city === 'all' || v.city === city),
    [scoped, city],
  );

  const statusCounts = useMemo(() => {
    const c = { all: cityBase.length, hot: 0, warm: 0, cold: 0, dead: 0, future_prospect: 0, unc: 0 };
    cityBase.forEach((v) => { const s = visitStatus(v); c[s] = (c[s] || 0) + 1; });
    return c;
  }, [cityBase]);

  const stageCounts = useMemo(() => {
    const c = { all: cityBase.length };
    STAGES.forEach((s) => { c[s.k] = 0; });
    cityBase.forEach((v) => { const s = visitStage(v); c[s] = (c[s] || 0) + 1; });
    return c;
  }, [cityBase]);

  // last-FU base = city base + status + stage (legacy renderLastFuChips)
  const lastFuBase = useMemo(() => cityBase.filter((v) => {
    if (status !== 'all' && visitStatus(v) !== status) return false;
    if (stage !== 'all' && visitStage(v) !== stage) return false;
    return true;
  }), [cityBase, status, stage]);

  const lastFuCounts = useMemo(() => {
    const c = {};
    LAST_FU_PRESETS.forEach((p) => {
      c[p.k] = lastFuBase.filter((v) => matchLastFuFilter(lastFollowupTakenForVisit(v, fuByVisit), p.k, v)).length;
    });
    return c;
  }, [lastFuBase]);

  // priority base = last-FU base + lastFu filter (legacy renderPriorityChips; lastFu match w/o visit arg)
  const priorityBase = useMemo(() => lastFuBase.filter((v) => {
    if (lastFu && lastFu !== 'all' && !matchLastFuFilter(lastFollowupTakenForVisit(v, fuByVisit), lastFu)) return false;
    return true;
  }), [lastFuBase, lastFu]);

  const priorityCounts = useMemo(() => ({
    all: priorityBase.length,
    nudged: priorityBase.filter((v) => isVisitNudged(v, nudgesByVisit)).length,
    tl_ask: priorityBase.filter((v) => isVisitTlAsk(v, teamTasks)).length,
  }), [priorityBase, nudgesByVisit, teamTasks]);

  // --- full filtered set (legacy filterVisits): search + status + stage + lastFu + priority + unit ---
  const filtered = useMemo(() => cityBase.filter((v) => {
    if (q.trim()) {
      const s = q.trim().toLowerCase();
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
    if (status !== 'all' && visitStatus(v) !== status) return false;
    if (stage !== 'all' && visitStage(v) !== stage) return false;
    if (lastFu && lastFu !== 'all' && !matchLastFuFilter(lastFollowupTakenForVisit(v, fuByVisit), lastFu, v)) return false;
    if (priority === 'nudged' && !isVisitNudged(v, nudgesByVisit)) return false;
    if (priority === 'tl_ask' && !isVisitTlAsk(v, teamTasks)) return false;
    if (unit.trim()) {
      const u = [v.unit_address_line1, v.unit_address_line2, v.floor].filter(Boolean).join(' ').toLowerCase();
      if (!u.includes(unit.trim().toLowerCase())) return false;
    }
    return true;
  }), [cityBase, q, status, stage, lastFu, priority, unit, nudgesByVisit, teamTasks]);

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
  useEffect(() => { setPage(1); }, [city, status, stage, lastFu, priority, unit, q, sortField, sortDir]);

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

  return (
    <div className="rx-fade">
      {/* ===== 4 chip-bars ===== */}
      <ChipBar
        label="Buyer status · Hot / Warm / Cold / Dead — set in AVFU"
        options={STATUS_OPTS}
        counts={statusCounts}
        value={status}
        onChange={setStatus}
      />
      <ChipBar
        label="Visit stage · operational pipeline"
        options={STAGE_OPTS}
        counts={stageCounts}
        value={stage}
        onChange={setStage}
      />
      <ChipBar
        label={'Last followup taken · default "Not taken" focuses on remaining work'}
        options={LAST_FU_PRESETS}
        counts={lastFuCounts}
        value={lastFu}
        onChange={setLastFu}
        showDots={false}
      />
      <ChipBar
        label="Priority · TL ask & nudges"
        options={PRIORITY_OPTS}
        counts={priorityCounts}
        value={priority}
        onChange={setPriority}
      />

      {/* ===== filter row: city / unit / search / select ===== */}
      <div className="rx-filters" style={{ marginTop: 4 }}>
        <select className="rx-sel" value={city} onChange={(e) => setCity(e.target.value)}>
          <option value="all">All cities</option>
          {CITIES.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <input
          className="rx-inp"
          style={{ width: 132 }}
          placeholder="Unit no. — 203"
          value={unit}
          onChange={(e) => setUnit(e.target.value)}
        />
        <input
          className="rx-inp"
          style={{ flex: 1, minWidth: 200 }}
          placeholder="Search visit, society, CP, buyer, phone…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
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
