import { useEffect, useMemo, useState } from 'react';
import { TODAY, ymd, fmtDate, fmtDay, initials } from '../lib/format.js';
import { STATUSES, STAGES, STAGE_BY_KEY, visitStage, visitStatus, nextFuFor } from '../lib/visits.js';
import { usersBySlug } from '../lib/brokers.js';
import { top99ForSociety } from '../lib/properties.js';
import { TEAM_PILL, nextFuClass, classifyClosingSignal, visitIntentItems } from '../lib/legacy.js';
import { loadTopBrokers, setTopBrokerPhone, saveFollowup, addNudge } from '../api.js';
import { toast } from '../lib/toast.js';
import useIsMobile from '../lib/useIsMobile.js';
import { SkeletonTable } from './Skeleton.jsx';

const STAGE_ORDER = ['upcoming', 'avfu', 'revisit_scheduled', 'after_revisit_fu', 'negotiation', 'booking', 'ats', 'future_prospect', 'not_interested', 'need_more', 'cancelled'];
const FU_STATUS = ['hot', 'warm', 'cold', 'dead', 'future_prospect'];
const FU_STAGES = ['avfu', 'revisit_scheduled', 'after_revisit_fu', 'negotiation', 'booking', 'ats', 'future_prospect', 'not_interested', 'need_more'];

const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const esc = (s) => String(s == null ? '' : s).replace(/</g, '&lt;');
const isAdmin = (u) => u && u.team === 'Admin';
const firstName = (n) => (n || '').split(' ')[0] || '';

// 'DD-Mon' prefix → ymd(current year), else null. (legacy parseFeedbackDate)
function parseFeedbackDate(line) {
  const m = String(line || '').match(/^(\d{1,2})-([A-Za-z]+)/);
  if (!m) return null;
  const months = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
  const mo = months[m[2]];
  if (mo == null) return null;
  return ymd(new Date(TODAY.getFullYear(), mo, parseInt(m[1], 10)));
}

function tbMatchClass(t) {
  const s = (t || '').toLowerCase();
  if (!s || s.includes('no match')) return 'tb-m-none';
  if (s.startsWith('agency')) return 'tb-m-agency';
  if (s.startsWith('broker')) return 'tb-m-broker';
  return 'tb-m-other';
}

export default function PropertyModal({ property: p, seed, onClose, onOpenBroker }) {
  const isMobile = useIsMobile();
  const me = seed.current_user || {};
  const ubs = useMemo(() => usersBySlug(seed), [seed]);
  const cpOwner = seed.cp_owner || {};
  const nudgesByVisit = seed.nudges_by_visit || {};
  const brokersByCode = useMemo(() => {
    const m = {};
    (seed.brokers || []).forEach((b) => { m[b.cp_code] = b; });
    return m;
  }, [seed]);
  const allVisits = seed.visits || [];
  // Scope to THIS unit, not the whole society. home_id is the authoritative join
  // (set on both visits + properties by the sheet sync); fall back to the old
  // society-wide match only when this property has no home_id mapped yet.
  const visits = useMemo(() => {
    const pid = String(p.home_id || '').trim();
    if (pid) return allVisits.filter((v) => String(v.home_id || '').trim() === pid);
    return allVisits.filter((v) => v.society_name === p.society_name);
  }, [allVisits, p.home_id, p.society_name]);

  const [tab, setTab] = useState('visits');
  const [stageTab, setStageTab] = useState('avfu');
  const [statusFilter, setStatusFilter] = useState('all');   // clickable Hot/Warm stat cards (#8)
  const [expanded, setExpanded] = useState(() => new Set());
  const [drafts, setDrafts] = useState({});                  // { vid:{status,stage,note,next_date,revisit_date} }
  const [sentNudges, setSentNudges] = useState(() => new Set()); // local "✓ Nudged" tracking
  const [nudgeComposer, setNudgeComposer] = useState(null);  // visit id of open composer

  // 99acres lazy load
  const [tb99, setTb99] = useState(null);
  const [tb99Err, setTb99Err] = useState(null);
  useEffect(() => {
    if (tab !== 'top_99' || tb99 || tb99Err) return;
    loadTopBrokers().then((d) => setTb99(d.items || [])).catch((e) => setTb99Err(e.message));
  }, [tab, tb99, tb99Err]);
  const tb99rows = useMemo(() => (tb99 ? top99ForSociety(tb99, p) : []), [tb99, p]);

  // ---- group visits by stage ----
  const byStage = useMemo(() => {
    const m = {};
    STAGES.forEach((s) => { m[s.k] = []; });
    visits.forEach((v) => { (m[visitStage(v)] || (m[visitStage(v)] = [])).push(v); });
    return m;
  }, [visits]);

  const tabsAvail = useMemo(() => STAGE_ORDER.filter((k) => (byStage[k] || []).length > 0), [byStage]);
  const activeStage = stageTab === 'all' ? 'all' : (tabsAvail.includes(stageTab) ? stageTab : (tabsAvail[0] || 'avfu'));
  // visit list = (active stage OR all) then the Hot/Warm status filter from the stat cards
  const shownVisits = useMemo(() => {
    const base = activeStage === 'all' ? visits : (byStage[activeStage] || []);
    const list = statusFilter === 'all' ? base : base.filter((v) => visitStatus(v) === statusFilter);
    return list.slice().sort((a, b) => (b.visit_date || '').localeCompare(a.visit_date || ''));
  }, [visits, byStage, activeStage, statusFilter]);

  // ---- stat cards ----
  const stats = useMemo(() => {
    let hot = 0, warm = 0;
    visits.forEach((v) => { const s = visitStatus(v); if (s === 'hot') hot++; else if (s === 'warm') warm++; });
    return { total: visits.length, hot, warm, upcoming: (byStage.upcoming || []).length, booking: (byStage.booking || []).length };
  }, [visits, byStage]);

  // ---- top CPs bringing buyers (max 15) ----
  const topCPs = useMemo(() => {
    const m = {};
    visits.forEach((v) => {
      const c = v.cp_code;
      if (!c) return;
      let e = m[c];
      if (!e) e = m[c] = { cp_code: c, name: v.broker_name, company: v.company_name, visits: 0, hot: 0, warm: 0, booking: 0 };
      e.visits++;
      const st = visitStatus(v);
      if (st in e) e[st]++;
      if (visitStage(v) === 'booking') e.booking++;
    });
    return Object.values(m).sort((a, b) => b.visits - a.visits).slice(0, 15);
  }, [visits]);

  // ---- top CPs · OpenHouse (current tab — visit count + Last FU taken/by, #9) ----
  const cpStats = useMemo(() => {
    const m = {};
    visits.forEach((v) => {
      const c = v.cp_code;
      if (!c) return;
      let e = m[c];
      if (!e) e = m[c] = { cp_code: c, name: v.broker_name, company: v.company_name, visits: 0, fuDate: null, fuBy: '' };
      e.visits++;
      const d = v.latest_followup_date;
      if (d && (!e.fuDate || d > e.fuDate)) {
        e.fuDate = d;
        e.fuBy = (v.latest_followup_by && ubs[v.latest_followup_by]?.name) || v.sales_manager || '';
      }
    });
    return Object.values(m).sort((a, b) => b.visits - a.visits);
  }, [visits, ubs]);

  // ---- timeline (max 40) ----
  const timeline = useMemo(() => {
    const out = [];
    visits.forEach((v) => {
      out.push({
        ts: v.visit_date, type: 'visit',
        t: `Visit: ${v.buyer_name || '—'} · ${v.status || ''}`,
        desc: `${v.broker_name || ''} (${v.cp_code || ''})${v.sales_manager ? ` · RM ${v.sales_manager}` : ''}`,
        by: v.sales_manager,
      });
      (v.all_feedback || '').split('\n').filter((l) => l.trim()).forEach((line) => {
        const m = line.match(/^([\d]{1,2})-([A-Za-z]+)\s*-\s*(.*)/);
        out.push({
          ts: parseFeedbackDate(line) || v.visit_date, type: 'note',
          t: m ? m[3] : line, desc: `Buyer ${v.buyer_name || ''} · ${v.broker_name || ''}`, by: v.sales_manager,
        });
      });
    });
    (seed.followups || []).filter((l) => visits.some((v) => String(v.id) === String(l.visit_id))).forEach((l) => {
      out.push({ ts: (l.ts || '').slice(0, 10), type: 'note', t: `Followup logged: ${l.status || ''} → ${l.stage || ''}`, desc: l.note || '', by: ubs[l.by]?.name });
    });
    return out.sort((a, b) => (b.ts || '').localeCompare(a.ts || '')).slice(0, 40);
  }, [visits, seed.followups, ubs]);

  function toggleExpand(vid) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(String(vid))) next.delete(String(vid)); else next.add(String(vid));
      return next;
    });
  }
  function patchDraft(vid, patch) {
    setDrafts((prev) => ({ ...prev, [vid]: { ...(prev[vid] || {}), ...patch } }));
  }
  function openBrokerAndClose(cp) {
    onClose?.();
    onOpenBroker?.(cp);
  }

  const propDetails = (
    <div className="kv">
      <div className="k">PM</div><div className="v">{p.sales_manager || '—'}</div>
      <div className="k">Status</div><div className="v">{p.listing_status}</div>
      <div className="k">Config</div><div className="v">{p.configuration || '—'}</div>
      <div className="k">Super</div><div className="v">{p.super_sqft || '—'} sqft</div>
      <div className="k">Carpet</div><div className="v">{p.carpet_sqft || '—'} sqft</div>
      <div className="k">Facing</div><div className="v">{p.exit_facing || '—'}</div>
      <div className="k">View</div><div className="v" style={{ fontSize: 11, textAlign: 'right' }}>{p.balcony_view || '—'}</div>
      <div className="k">Photos</div><div className="v">{p.photo_count || 0}{p.video_added === 'Yes' ? ' · video' : ''}</div>
    </div>
  );

  // ---- RIGHT panel (Top CPs + Timeline) ----
  const rightPanel = (
    <>
      <h4 style={{ fontSize: 10, color: 'var(--mut)', textTransform: 'uppercase', fontWeight: 700, letterSpacing: '.5px', marginBottom: 8 }}>Property details</h4>
      {propDetails}
      <h4 style={{ marginTop: 14, fontSize: 10, color: 'var(--mut)', textTransform: 'uppercase', fontWeight: 700, letterSpacing: '.5px', marginBottom: 8 }}>Top CPs bringing buyers</h4>
      {topCPs.length ? topCPs.map((c) => {
        const b = brokersByCode[c.cp_code];
        const owner = ubs[cpOwner[c.cp_code]];
        const tier = (b && b.tier) || 'T4';
        return (
          <div key={c.cp_code} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 0', borderBottom: '1px solid var(--line)', cursor: 'pointer' }} onClick={() => openBrokerAndClose(c.cp_code)}>
            <div className="avatar sm">{initials(c.name)}</div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 600, fontSize: 12 }}>{c.name}</div>
              <div style={{ fontSize: 10.5, color: 'var(--mut)' }}>{c.company || ''}</div>
              {owner ? <span className={'role-pill ' + (TEAM_PILL[owner.team] || '')} style={{ marginTop: 2 }}>{owner.team} · {firstName(owner.name)}</span> : null}
            </div>
            <div style={{ textAlign: 'right' }}>
              <div style={{ fontWeight: 700, fontSize: 13 }}>{c.visits}</div>
              <div style={{ fontSize: 9.5, color: 'var(--mut)' }}>visits</div>
            </div>
            <span className={'tier-badge ' + tier}>{tier}</span>
          </div>
        );
      }) : <div className="muted">No CPs yet.</div>}
      <h4 style={{ marginTop: 14, fontSize: 10, color: 'var(--mut)', textTransform: 'uppercase', fontWeight: 700, letterSpacing: '.5px', marginBottom: 8 }}>Timeline · all CP conversations</h4>
      <div className="tl">
        {timeline.length ? timeline.map((t, i) => (
          <div key={i} className={'tl-item ' + t.type}>
            <div className="tl-head"><span className="tl-t">{esc(t.t)}</span><span className="tl-d">{fmtDay(t.ts)}</span></div>
            {t.desc ? <div className="tl-desc">{esc(t.desc)}</div> : null}
            {t.by ? <div className="tl-by">by {t.by}</div> : null}
          </div>
        )) : <div className="muted" style={{ fontSize: 11 }}>No conversations yet.</div>}
      </div>
    </>
  );

  // ---- the 2-column legacy body (becomes single column on mobile) ----
  const visitsBody = (
    <div style={{ display: isMobile ? 'block' : 'grid', gridTemplateColumns: isMobile ? 'none' : '1fr 320px', gap: 0 }}>
      <div style={{ overflowY: 'auto', padding: isMobile ? '14px 14px 4px' : '4px 4px', background: 'transparent' }}>
        {/* 5 stat cards — clickable filters (#8) */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5,1fr)', gap: 8, marginBottom: 14 }}>
          {[
            { k: 'total', label: 'Total', val: stats.total, color: undefined, stage: 'all', status: 'all' },
            { k: 'hot', label: 'Hot', val: stats.hot, color: 'var(--bad)', stage: 'all', status: 'hot' },
            { k: 'warm', label: 'Warm', val: stats.warm, color: 'var(--warn)', stage: 'all', status: 'warm' },
            { k: 'upcoming', label: 'Upcoming', val: stats.upcoming, color: 'var(--blue)', stage: 'upcoming', status: 'all' },
            { k: 'booking', label: 'Booking', val: stats.booking, color: 'var(--good)', stage: 'booking', status: 'all' },
          ].map((c) => {
            const on = stageTab === c.stage && statusFilter === c.status;
            return (
              <button key={c.k} type="button" className={'prop-card' + (on ? ' on' : '')}
                      style={{ padding: 10, cursor: 'pointer', border: on ? '2px solid var(--acc)' : undefined, textAlign: 'left' }}
                      onClick={() => { if (on) { setStageTab('all'); setStatusFilter('all'); } else { setStageTab(c.stage); setStatusFilter(c.status); } }}>
                <div className="pc-stat"><div className="v" style={{ fontSize: 20, color: c.color }}>{c.val}</div><div className="l">{c.label}</div></div>
              </button>
            );
          })}
        </div>

        <h4 style={{ fontSize: 11, color: 'var(--mut)', textTransform: 'uppercase', letterSpacing: '.5px', fontWeight: 700, marginBottom: 8 }}>Buyer visits at this property</h4>

        {visits.length ? (
          <div className="stg-tabs">
            <button className={'sg-avfu' + (activeStage === 'all' ? ' on' : '')} onClick={() => { setStageTab('all'); setStatusFilter('all'); }}>
              <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'currentColor', opacity: .6 }} />
              All<span className="ct">{visits.length}</span>
            </button>
            {tabsAvail.map((sk) => {
              const def = STAGE_BY_KEY[sk];
              return (
                <button key={sk} className={def.cls + (activeStage === sk ? ' on' : '')} onClick={() => setStageTab(sk)}>
                  <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'currentColor', opacity: .6 }} />
                  {def.label}
                  <span className="ct">{(byStage[sk] || []).length}</span>
                </button>
              );
            })}
          </div>
        ) : null}

        <div id="propVisitsBody">
          {shownVisits.length ? shownVisits.map((v) => (
            <PropVisitRow
              key={v.id}
              v={v}
              p={p}
              me={me}
              owner={ubs[cpOwner[v.cp_code]] || null}
              broker={brokersByCode[v.cp_code] || {}}
              allVisits={allVisits}
              brokersByCode={brokersByCode}
              open={expanded.has(String(v.id))}
              draft={drafts[v.id] || {}}
              nudgeSent={sentNudges.has(String(v.id)) || ((nudgesByVisit[v.id] || []).some((n) => !n.resolved))}
              composerOpen={nudgeComposer === String(v.id)}
              onToggle={() => toggleExpand(v.id)}
              onPatch={(patch) => patchDraft(v.id, patch)}
              onOpenComposer={() => setNudgeComposer((c) => (c === String(v.id) ? null : String(v.id)))}
              onNudged={() => setSentNudges((prev) => new Set(prev).add(String(v.id)))}
              onCloseComposer={() => setNudgeComposer(null)}
              onSaved={() => { setExpanded((prev) => { const n = new Set(prev); n.delete(String(v.id)); return n; }); }}
              onOpenBrokerArrow={() => openBrokerAndClose(v.cp_code)}
            />
          )) : (
            <div className="empty"><div className="emoji">📭</div><div className="t">No visits in this stage</div></div>
          )}
        </div>

        {isMobile ? <div style={{ marginTop: 18 }}>{rightPanel}</div> : null}
      </div>

      {!isMobile ? (
        <div style={{ overflowY: 'auto', padding: '4px 4px 4px 18px', borderLeft: '1px solid var(--line)' }}>
          {rightPanel}
        </div>
      ) : null}
    </div>
  );

  return (
    <div className="rx-modal-bg" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="rx-modal" style={{ width: 'min(1280px,92vw)', maxWidth: '92vw' }}>
        <div className="rx-modal-head">
          <div style={{ flex: 1, minWidth: 0 }}>
            <h2>{p.property_name}</h2>
            <div className="muted" style={{ fontSize: 12, marginTop: 3 }}>{[p.society_name, p.micro_market, p.city_name].filter(Boolean).join(' · ')}</div>
          </div>
          <div style={{ textAlign: 'right', marginRight: 14 }}>
            <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--accDark)' }}>{p.listing_price || '—'}</div>
            <div className="muted" style={{ fontSize: 11 }}>{p.commission || ''}</div>
          </div>
          <button className="rx-x" onClick={onClose}>✕</button>
        </div>

        <div className="rx-modal-body">
          <div className="rx-tabs">
            <button className={'rx-tab' + (tab === 'visits' ? ' on' : '')} onClick={() => setTab('visits')}>Visits <span className="ct">{visits.length}</span></button>
            <button className={'rx-tab' + (tab === 'top_oh' ? ' on' : '')} onClick={() => setTab('top_oh')}>Top Brokers · OpenHouse <span className="ct">{cpStats.length}</span></button>
            <button className={'rx-tab' + (tab === 'top_99' ? ' on' : '')} onClick={() => setTab('top_99')}>Top Brokers · 99acres{tb99 ? <span className="ct">{tb99rows.length}</span> : null}</button>
          </div>

          {tab === 'visits' && <div className="rx-fade">{visitsBody}</div>}

          {tab === 'top_oh' && (
            <div className="rx-fade">
              {cpStats.length ? cpStats.map((c, i) => {
                const b = brokersByCode[c.cp_code] || {};
                return (
                  <div key={c.cp_code} className="rx-ohrow" style={{ cursor: 'pointer' }} onClick={() => openBrokerAndClose(c.cp_code)}>
                    <div style={{ width: 26, fontWeight: 700, color: 'var(--mut)', textAlign: 'center', fontSize: 12 }}>#{i + 1}</div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 600, fontSize: 13 }}>{c.name || '—'}</div>
                      <div className="rx-sub">{[c.company || b.company_name, b.phone_number].filter(Boolean).join(' · ') || c.cp_code}</div>
                    </div>
                    <div style={{ minWidth: 90, textAlign: 'center', fontSize: 12 }}><b>{c.visits}</b><div className="rx-sub">visits</div></div>
                    {/* #9 — Last FU taken + by */}
                    <div style={{ minWidth: 150, textAlign: 'right' }}>
                      {c.fuDate
                        ? <><div style={{ fontSize: 12 }}>{fmtDate(c.fuDate)} <span className="muted">({fmtDay(c.fuDate)})</span></div><div className="rx-sub">{c.fuBy ? `by ${c.fuBy}` : ''}</div></>
                        : <span className="muted" style={{ fontSize: 11.5 }}>No FU taken</span>}
                    </div>
                  </div>
                );
              }) : <div className="empty"><div className="emoji">👥</div><div className="t">No brokers have brought visits here yet</div></div>}
            </div>
          )}

          {tab === 'top_99' && (
            <Top99 rows={tb99rows} loading={!tb99 && !tb99Err} err={tb99Err} society={p.society_name} total={tb99 ? tb99.length : 0} onPhone={(id, phone) => setTb99((prev) => prev.map((r) => (r.id === id ? { ...r, phone } : r)))} />
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// renderPropVisitRow — expandable visit row with the followup editor
// ---------------------------------------------------------------------------
function PropVisitRow({
  v, p, me, owner, broker, allVisits, brokersByCode, open, draft, nudgeSent, composerOpen,
  onToggle, onPatch, onOpenComposer, onNudged, onCloseComposer, onSaved, onOpenBrokerArrow,
}) {
  const status = visitStatus(v);
  const stage = visitStage(v);
  const tier = broker.tier || 'T4';
  // sheet records some PMs/RMs by first name only ("Vinay" vs "Vinay Kumar") — match either
  const fn = (me.name || '').split(' ')[0];
  const nameMatch = (s) => !!s && (s === me.name || (fn && s === fn));
  const isMine = !!(owner && (owner.id === me.id || owner.slug === me.slug));
  const isMyProperty = nameMatch(p.sales_manager);
  const isMyVisit = nameMatch(v.sales_manager);   // the RM who actually ran this visit
  const canEdit = isAdmin(me) || me.team === 'TL' || isMine || isMyVisit || (me.team === 'Ground' && isMyProperty);
  const nfc = nextFuClass(nextFuFor(v));
  const nudgeOk = (!isMine && !!owner);
  const stDef = STATUSES.find((s) => s.k === status);
  const sgDef = STAGE_BY_KEY[stage];

  return (
    <div className={'vrow' + (open ? ' open' : '')} data-vid={v.id}>
      <div className="vrow-head" style={{ cursor: 'pointer' }} onClick={onToggle}>
        <span className="vh-caret">▶</span>
        <div className="vh-buyer">
          <div className="b">{v.buyer_name || '—'}</div>
          <div className="ph">{v.buyer_contact || ''}{v.lead_occurrence_count && +v.lead_occurrence_count > 1 ? ` · revisit #${v.lead_occurrence_count}` : ''}</div>
        </div>
        <div className="vh-prop" style={{ minWidth: 160 }}>
          <div className="p">{v.broker_name || '—'} <span className={'tier-badge ' + tier} style={{ marginLeft: 4 }}>{tier}</span></div>
          <div className="s">{v.company_name || ''} · {v.cp_code || ''}</div>
        </div>
        <div style={{ minWidth: 130 }}>
          <div style={{ fontSize: 11, color: 'var(--mut)' }}>CP Owner</div>
          {owner
            ? <><div style={{ fontSize: 12, fontWeight: 600 }}>{firstName(owner.name)}</div><span className={'role-pill ' + (TEAM_PILL[owner.team] || '')}>{owner.team}</span></>
            : <span className="muted">—</span>}
        </div>
        <div className="vh-date"><div className="d">{fmtDate(v.visit_date)}</div>{v.selected_time || ''}</div>
        <div className="vh-status">
          <span className={'stpill ' + status}><span className="d" />{stDef ? stDef.label : status}</span>
          <span className={'sgpill ' + stage}><span className="d" />{sgDef ? sgDef.label : stage}</span>
          <span className={'fu-chip ' + nfc.cls} style={{ marginLeft: 4 }}><span className="d" />{nfc.label}</span>
          {v._revisit_date ? <span className="fu-chip later" style={{ marginLeft: 4 }} title="Revisit scheduled"><span className="d" />↻ {fmtDate(v._revisit_date)}</span> : null}
        </div>
        {nudgeOk ? (
          <button
            className={'nudge-btn' + (nudgeSent ? ' sent' : '')}
            onClick={(e) => { e.stopPropagation(); onOpenComposer(); }}
          >{nudgeSent ? '✓ Nudged' : 'Nudge owner'}</button>
        ) : null}
      </div>

      {open ? (
        canEdit ? (
          <div className="vrow-body" style={{ display: 'block' }}>
            {(!isMine && !isAdmin(me)) ? (
              <div className="fu-recent" style={{ background: 'var(--accBg)', borderColor: '#FFD4B8', color: 'var(--accDark)' }}>
                📝 You are editing on behalf of <b>{owner?.name || 'unassigned'}</b> ({owner?.team || '—'}). This action will be logged in the activity timeline.
              </div>
            ) : null}

            <VisitIntent v={v} />
            <BuyerHistory v={v} allVisits={allVisits} brokersByCode={brokersByCode} />
            <RecentFeedback v={v} />

            {nudgeOk && composerOpen ? (
              <NudgeComposer v={v} owner={owner} onSent={() => { onNudged(); onCloseComposer(); }} onCancel={onCloseComposer} />
            ) : null}

            <FollowupForm v={v} draft={draft} onPatch={onPatch} onSaved={onSaved} />
          </div>
        ) : (
          <div className="vrow-body" style={{ display: 'block' }}>
            <div className="muted" style={{ padding: 10, fontSize: 11.5 }}>
              You don't have permission to edit this followup.{' '}
              <a href="#" onClick={(e) => { e.preventDefault(); onOpenBrokerArrow(); }}>View CP details →</a>
            </div>
          </div>
        )
      ) : null}
    </div>
  );
}

function VisitIntent({ v }) {
  const items = visitIntentItems(v);
  if (!items.length) return null;
  return (
    <div className="intent-block">
      <div className="ib-head">📊 Visit signals captured during property visit</div>
      <div className="ib-grid">
        {items.map((it, i) => {
          const sig = it.signalClass || classifyClosingSignal(it.k === 'Closing signal' ? it.val : '');
          return (
            <div key={i} className={'ib-item' + (it.full ? ' full' : '')}>
              <div className="k">{it.k}</div>
              <div className={'v' + (sig ? ' ib-signal-' + sig : '')}>{esc(it.val)}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function BuyerHistory({ v, allVisits, brokersByCode }) {
  const key = (v.lead_key || '').toLowerCase();
  const phone = (v.buyer_contact || '').trim();
  if (!key && !phone) return null;
  const others = allVisits.filter((x) => String(x.id) !== String(v.id) && (
    (key && (x.lead_key || '').toLowerCase() === key) ||
    (phone && phone.length >= 5 && (x.buyer_contact || '').trim() === phone)
  )).sort((a, b) => (b.visit_date || '').localeCompare(a.visit_date || '')).slice(0, 12);
  if (!others.length) return null;
  return (
    <div className="intent-block" style={{ background: 'linear-gradient(180deg,#F4F8FF,#fff)', borderColor: '#CFE0F7' }}>
      <div className="ib-head" style={{ color: '#1E40AF' }}>🧑 {v.buyer_name || 'Buyer'}'s other visits / property history ({others.length})</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 12 }}>
        {others.map((o) => {
          const stat = visitStatus(o);
          const stg = visitStage(o);
          const brk = brokersByCode[o.cp_code];
          const fb = (o.all_feedback || '').split('\n').filter((l) => l.trim()).slice(-1)[0] || o.sales_feedback || '';
          const stD = STATUSES.find((s) => s.k === stat);
          const sgD = STAGE_BY_KEY[stg];
          return (
            <div key={o.id} style={{ padding: '8px 10px', background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 7 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
                <div><b>{o.society_name || '—'}</b> {o.unit_address_line1 ? <span style={{ color: 'var(--mut)', fontWeight: 500 }}>{o.unit_address_line1}{o.unit_address_line2 ? '-' + o.unit_address_line2 : ''}</span> : null}</div>
                <div style={{ fontSize: 11, color: 'var(--mut)' }}>{fmtDate(o.visit_date)} · via {brk ? brk.name : (o.broker_name || '—')}</div>
              </div>
              <div style={{ display: 'flex', gap: 6, marginTop: 5, flexWrap: 'wrap' }}>
                <span className={'stpill ' + stat}><span className="d" />{stD ? stD.label : stat}</span>
                <span className={'sgpill ' + stg}><span className="d" />{sgD ? sgD.label : stg}</span>
                {o.lead_occurrence_count && +o.lead_occurrence_count > 1 ? <span className="prio-tag tl">revisit #{o.lead_occurrence_count}</span> : null}
              </div>
              {fb ? <div style={{ fontSize: 11, color: 'var(--mut)', marginTop: 5, fontStyle: 'italic' }}>"{esc(fb).slice(0, 140)}"</div> : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function RecentFeedback({ v }) {
  const lines = (v.all_feedback || '').split('\n').filter((l) => l.trim()).slice(-3).reverse();
  if (!lines.length) return null;
  return (
    <div className="fu-recent">
      <b>Recent feedback</b>
      {lines.map((l, i) => <div key={i}>· {esc(l)}</div>)}
    </div>
  );
}

function FollowupForm({ v, draft, onPatch, onSaved }) {
  const [saving, setSaving] = useState(false);
  // a Dead lead has no follow-up: the Next-FU date is disabled and never sent.
  const isDead = (draft.status || visitStatus(v)) === 'dead';
  async function save() {
    if (!(draft.note || '').trim()) { toast('Note is required', 'bad'); return; }
    if (!isDead && draft.stage === 'revisit_scheduled' && !draft.revisit_date) { toast('Revisit Scheduled needs a revisit date', 'bad'); return; }
    if (!isDead && draft.stage === 'negotiation' && !draft.negotiation_date) { toast('Negotiation needs a meeting date', 'bad'); return; }
    setSaving(true);
    try {
      await saveFollowup({
        visit_code: String(v.id),
        buyer_status: draft.status || visitStatus(v),
        stage: draft.stage || visitStage(v),
        note: (draft.note || '').trim(),
        next_followup_date: isDead ? null : (draft.next_date || null),
        revisit_date: isDead ? null : (draft.revisit_date || null),
        negotiation_date: isDead ? null : (draft.negotiation_date || null),
      });
      toast('Follow-up logged', 'good');
      onSaved?.();
    } catch (e) { toast('Follow-up failed: ' + String(e.message || e).slice(0, 100), 'bad'); }
    finally { setSaving(false); }
  }
  return (
    <div className="fu-form" style={{ paddingTop: 12 }}>
      <div className="fu-row">
        <div className="fu-grp">
          <label>Buyer Status (Hot / Warm / Cold / Dead)</label>
          <div className="fu-pills">
            {FU_STATUS.map((s) => (
              <button key={s} className={'fu-pill' + (draft.status === s ? ' on ' + s : '')} onClick={() => onPatch({ status: s })}>
                <span className="d" />{s.replace('_', ' ')}
              </button>
            ))}
          </div>
        </div>
        <div className="fu-grp">
          <label>Next Stage</label>
          <div className="fu-pills">
            {FU_STAGES.map((s) => (
              <button key={s} className={'fu-pill' + (draft.stage === s ? ' on' : '')} onClick={() => onPatch({ stage: s })}>
                <span className="d" />{STAGE_BY_KEY[s].label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {draft.stage === 'revisit_scheduled' ? (
        <div className="fu-grp" style={{ background: 'var(--blueBg)', border: '1px solid #93C5FD', borderRadius: 8, padding: '10px 12px', marginBottom: 10 }}>
          <label style={{ color: '#1E40AF' }}>Revisit date &amp; time <span style={{ color: 'var(--bad)', fontWeight: 700 }}>*</span></label>
          <input type="datetime-local" value={draft.revisit_date || ''} onChange={(e) => onPatch({ revisit_date: e.target.value })}
                 style={{ padding: '7px 10px', border: '1px solid var(--line)', borderRadius: 7, background: '#fff', fontSize: 13, width: 240, maxWidth: '100%' }} />
        </div>
      ) : null}

      {draft.stage === 'negotiation' ? (
        <div className="fu-grp" style={{ background: 'var(--blueBg)', border: '1px solid #93C5FD', borderRadius: 8, padding: '10px 12px', marginBottom: 10 }}>
          <label style={{ color: '#1E40AF' }}>Negotiation meeting date &amp; time <span style={{ color: 'var(--bad)', fontWeight: 700 }}>*</span></label>
          <input type="datetime-local" value={draft.negotiation_date || ''} onChange={(e) => onPatch({ negotiation_date: e.target.value })}
                 style={{ padding: '7px 10px', border: '1px solid var(--line)', borderRadius: 7, background: '#fff', fontSize: 13, width: 240, maxWidth: '100%' }} />
          <div style={{ fontSize: 11, color: '#1E40AF', marginTop: 4 }}>Once this date passes, the visit auto-moves to "After Negotiation FU".</div>
        </div>
      ) : null}

      <div className="fu-grp">
        <label>Notes <span style={{ color: 'var(--bad)', fontWeight: 700 }}>*</span> <span style={{ fontWeight: 500, color: 'var(--mut)', textTransform: 'none', letterSpacing: 0, fontSize: 10 }}>required</span></label>
        <textarea placeholder="Required — what was discussed, buyer's signal, next action…" value={draft.note || ''} onChange={(e) => onPatch({ note: e.target.value })} style={{ minHeight: 60 }} />
      </div>

      <div className="fu-actions">
        <div className="fu-grp" style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <label style={{ margin: 0 }}>Next FU</label>
          <input type="date" disabled={isDead}
                 value={isDead ? '' : (draft.next_date || ymd(addDays(TODAY, 2)))}
                 onChange={(e) => onPatch({ next_date: e.target.value })}
                 style={isDead ? { opacity: 0.5, cursor: 'not-allowed' } : undefined} />
          {isDead ? <span style={{ fontSize: 10.5, color: 'var(--mut)' }}>No follow-up for a dead lead</span> : null}
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          <button className="btn sm" disabled={saving} onClick={save}>{saving ? 'Saving…' : 'Save'}</button>
        </div>
      </div>
    </div>
  );
}

function NudgeComposer({ v, owner, onSent, onCancel }) {
  const [message, setMessage] = useState('');
  const [priority, setPriority] = useState('normal');
  const [saving, setSaving] = useState(false);
  async function send() {
    if (!message.trim()) { toast('Message is required', 'bad'); return; }
    setSaving(true);
    try {
      await addNudge({ visit_code: String(v.id), message: message.trim(), priority });
      toast('Nudge sent to ' + (owner?.name || 'CP owner'), 'good');
      onSent?.();
    } catch (e) { toast('Nudge failed: ' + String(e.message || e).slice(0, 100), 'bad'); }
    finally { setSaving(false); }
  }
  return (
    <div className="fu-grp" style={{ background: 'var(--warnBg)', border: '1px solid var(--warn)', borderRadius: 8, padding: '10px 12px', margin: '10px 0' }}>
      <label style={{ color: 'var(--warnDk)' }}>🔔 Nudge {owner?.name || 'CP owner'}</label>
      <textarea placeholder="e.g. Buyer seems serious, please push for a revisit." value={message} onChange={(e) => setMessage(e.target.value)} style={{ minHeight: 50 }} />
      <div className="fu-actions" style={{ marginTop: 8 }}>
        <select value={priority} onChange={(e) => setPriority(e.target.value)} style={{ padding: '5px 8px', border: '1px solid var(--line)', borderRadius: 6, fontSize: 12, background: 'var(--panel)' }}>
          <option value="low">Low</option><option value="normal">Normal</option><option value="high">High</option>
        </select>
        <div style={{ display: 'flex', gap: 6 }}>
          <button className="btn sm" onClick={onCancel}>Cancel</button>
          <button className="btn sm primary" disabled={saving} onClick={send}>{saving ? 'Sending…' : 'Send nudge'}</button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 99acres tab body + inline phone editor (10-digit validation) — preserved
// ---------------------------------------------------------------------------
function Top99({ rows, loading, err, society, total, onPhone }) {
  const [editId, setEditId] = useState(null);
  const [val, setVal] = useState('');
  const [err2, setErr2] = useState('');
  const [saving, setSaving] = useState(false);

  if (loading) return (
    <div className="rx-fade">
      <div className="muted" style={{ fontSize: 11.5, marginBottom: 10 }}>Loading 99acres brokers…</div>
      <SkeletonTable rows={5} cols={7} minWidth={1180} />
    </div>
  );
  if (err) return <div className="empty"><div className="emoji">⚠️</div><div className="t">Couldn’t load 99acres brokers</div><div className="s">{err}</div></div>;
  if (!rows.length) return <div className="empty"><div className="emoji">🔗</div><div className="t">No 99acres top-broker data for {society}</div><div className="s">Not in the 99acres dataset ({total} brokers loaded across all societies).</div></div>;

  function start(r) { setEditId(r.id); setVal((r.phone || '').replace(/\D/g, '').slice(-10)); setErr2(''); }
  async function save(r) {
    const digits = (val || '').replace(/\D/g, '');
    if (digits.length !== 10) { setErr2('Enter a 10-digit number'); return; }
    setSaving(true);
    try {
      const d = await setTopBrokerPhone(r.id, digits);
      onPhone(r.id, d.phone || '');
      setEditId(null);
    } catch (e) { setErr2(String(e.message || e).slice(0, 80)); }
    finally { setSaving(false); }
  }

  return (
    <div className="rx-fade">
      <div className="muted" style={{ fontSize: 11.5, marginBottom: 10 }}>Top {rows.length} broker{rows.length > 1 ? 's' : ''} in <b style={{ color: 'var(--txt)' }}>{rows[0].society}</b> — sourced from 99acres.</div>
      <div className="tbl-wrap">
        <table className="t" style={{ minWidth: 1180 }}>
          <thead><tr>
            <th style={{ textAlign: 'center' }}>Rank</th><th>Broker</th><th>Agency</th>
            <th style={{ textAlign: 'center' }}>30d</th><th style={{ textAlign: 'center' }}>90d</th><th style={{ textAlign: 'center' }}>180d</th><th style={{ textAlign: 'center' }}>All</th>
            <th>Latest listing</th><th>Other NCR societies</th><th>OH match</th>
          </tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} style={{ cursor: 'default' }}>
                <td style={{ textAlign: 'center' }}><span className={'tb-rank' + ((r.rank || 99) <= 3 ? ' top' : '')}>{r.rank ?? '—'}</span></td>
                <td style={{ whiteSpace: 'normal', maxWidth: 170 }}>
                  <b>{r.broker_name || '—'}</b>
                  <div style={{ marginTop: 3 }}>
                    {editId === r.id ? (
                      <span style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>
                        <input autoFocus value={val} maxLength={10} inputMode="numeric"
                               onChange={(e) => { setVal(e.target.value.replace(/\D/g, '').slice(0, 10)); setErr2(''); }}
                               onKeyDown={(e) => { if (e.key === 'Enter') save(r); if (e.key === 'Escape') setEditId(null); }}
                               style={{ width: 96, padding: '2px 6px', border: '1px solid var(--line)', borderRadius: 6, fontSize: 11, fontFamily: "'SF Mono',Menlo,monospace" }} />
                        <button className="btn xs primary" disabled={saving} onClick={() => save(r)}>✓</button>
                        <button className="btn xs" onClick={() => setEditId(null)}>✕</button>
                        {err2 ? <span style={{ color: 'var(--bad)', fontSize: 9.5 }}>{err2}</span> : null}
                      </span>
                    ) : r.phone ? (
                      <button className="rx-phone-btn" onClick={() => start(r)} title="Edit phone">📞 {r.phone}</button>
                    ) : (
                      <button className="rx-phone-add" onClick={() => start(r)}>+ phone</button>
                    )}
                  </div>
                </td>
                <td style={{ whiteSpace: 'normal', maxWidth: 200 }}>{r.agency || '—'}{r.agency_address ? <div className="rx-sub">{r.agency_address}</div> : null}</td>
                <td style={{ textAlign: 'center' }}>{r.listings_30d || 0}</td>
                <td style={{ textAlign: 'center' }}>{r.listings_90d || 0}</td>
                <td style={{ textAlign: 'center' }}>{r.listings_180d || 0}</td>
                <td style={{ textAlign: 'center', fontWeight: 700 }}>{r.listings_all || 0}</td>
                <td style={{ fontSize: 11.5, whiteSpace: 'nowrap' }}>{r.latest_listing_date ? fmtDate(r.latest_listing_date) : '—'}{r.latest_listing_link ? <div><a href={r.latest_listing_link} target="_blank" rel="noopener" style={{ color: 'var(--acc)', fontSize: 11 }}>🔗 listing</a></div> : null}</td>
                <td style={{ whiteSpace: 'normal', maxWidth: 280 }}>{(r.other_ncr_societies || '').split(';').map((x) => x.trim()).filter(Boolean).map((x, i) => <span key={i} className="rx-chip">{x}</span>) || '—'}</td>
                <td style={{ whiteSpace: 'normal', maxWidth: 340 }}><span className={'tb-pill ' + tbMatchClass(r.oh_match_type)}>{r.oh_match_type || 'No match'}</span>{r.oh_match_details ? <div className="tb-details">{r.oh_match_details}</div> : null}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
