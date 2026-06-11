import { useMemo, useState } from 'react';
import { TODAY, ymd, fmtDate, fmtDay, fmtMonth, initials } from '../lib/format.js';
import {
  STATUSES, STAGES, STAGE_BY_KEY, visitStage, visitStatus,
} from '../lib/visits.js';
import { usersBySlug } from '../lib/brokers.js';
import {
  TEAM_PILL, isVisitNudged, isVisitTlAsk, isCpTlAsk, visitIntentItems,
} from '../lib/legacy.js';
import {
  saveFollowup as apiSaveFollowup, setBrokerTier, setBrokerOwner,
  saveEngagement as apiSaveEngagement, addNudge as apiAddNudge,
} from '../api.js';
import { toast } from '../lib/toast.js';
import useIsMobile from '../lib/useIsMobile.js';

const STAGE_ORDER = ['all', 'upcoming', 'avfu', 'revisit_scheduled', 'after_revisit_fu', 'negotiation', 'booking', 'ats', 'future_prospect', 'not_interested', 'need_more', 'cancelled'];
const STATUS_PILLS = ['hot', 'warm', 'cold', 'dead', 'future_prospect'];
const STAGE_PILLS = ['avfu', 'revisit_scheduled', 'after_revisit_fu', 'negotiation', 'booking', 'ats', 'future_prospect', 'not_interested', 'need_more'];
const TIERS = ['T1', 'T2', 'T3', 'T4'];
// engagement call-disposition labels (Close/HubSpot 2-axis model)
const CONNECTED_LABEL = { connected: 'Connected', no_answer: 'No answer', busy: 'Busy', switched_off: 'Switched off', wrong_number: 'Wrong number' };
const OUTCOME_LABEL = { interested: 'Interested', bringing_buyer: 'Bringing a buyer', callback_requested: 'Callback requested', no_inventory_match: 'No inventory match', not_interested: 'Not interested' };

function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }

/* ===============================================================
   BrokerModal — full-fidelity port of the legacy CP popup
   =============================================================== */
export default function BrokerModal({ cpCode, seed, reloadSeed, onClose }) {
  const isMobile = useIsMobile();
  const me = seed.current_user || {};
  const ubs = useMemo(() => usersBySlug(seed), [seed]);
  const users = seed.users || [];
  const isAdmin = me.team === 'Admin' || me.role === 'admin';
  const isAdminOrTl = isAdmin || me.team === 'TL' || me.role === 'kam_tl';

  const broker = useMemo(
    () => (seed.brokers || []).find((b) => b.cp_code === cpCode) || { cp_code: cpCode, name: cpCode },
    [seed, cpCode],
  );
  const cpOwner = seed.cp_owner || {};
  const nudgesByVisit = seed.nudges_by_visit || {};
  const teamTasks = seed.team_tasks || {};
  const properties = seed.properties || [];
  const followupLog = seed.followups || [];
  const engagements = (seed.engagements || {})[cpCode] || [];

  const visits = useMemo(
    () => (seed.visits || []).filter((v) => v.cp_code === cpCode)
      .sort((a, b) => (b.visit_date || '').localeCompare(a.visit_date || '')),
    [seed, cpCode],
  );

  // ---- popup-level state ----
  const [popupTab, setPopupTab] = useState('visits');     // visits | engagement | timeline
  const [popupStage, setPopupStage] = useState('all');
  const [focusVid, setFocusVid] = useState(null);
  const [expanded, setExpanded] = useState(() => new Set());
  const [showSide, setShowSide] = useState(false);        // mobile Info tab
  const [busy, setBusy] = useState(false);

  // followup drafts keyed by visit id; engagement draft (single shared)
  const [fuDrafts, setFuDrafts] = useState({});
  const [egDraft, setEgDraft] = useState({});

  // satellite modals
  const [waCp, setWaCp] = useState(null);
  const [nudgeVid, setNudgeVid] = useState(null);

  const ownerId = cpOwner[cpCode] || '';
  const ownerName = ownerId ? (ubs[ownerId]?.name || '—') : '—';

  // ---- stage groups + available tabs ----
  const groups = useMemo(() => {
    const g = {};
    STAGES.forEach((s) => { g[s.k] = []; });
    visits.forEach((v) => { (g[visitStage(v)] = g[visitStage(v)] || []).push(v); });
    g.all = visits.slice();
    return g;
  }, [visits]);
  const tabsAvailable = STAGE_ORDER.filter((s) => (groups[s] || []).length > 0);
  const activeStage = tabsAvailable.includes(popupStage) ? popupStage : (tabsAvailable[0] || 'all');
  const currentVisits = (groups[activeStage] || []).slice().sort((a, c) => {
    if (String(a.id) === String(focusVid)) return -1;
    if (String(c.id) === String(focusVid)) return 1;
    return (c.visit_date || '').localeCompare(a.visit_date || '');
  });

  // ---- banner data ----
  const cpVisitIds = new Set(visits.map((v) => String(v.id)));
  const activeNudges = [];
  Object.entries(nudgesByVisit).forEach(([vid, arr]) => {
    if (!cpVisitIds.has(String(vid))) return;
    (arr || []).forEach((n) => {
      if (!n.resolved && (n.to === me.id || isAdmin || me.team === 'TL')) activeNudges.push({ ...n, visitId: vid });
    });
  });
  const tlMessages = (teamTasks[me.id]?.messages || []).slice(0, 2);
  const isOnTlList = isCpTlAsk(cpCode, teamTasks);

  // ---- helpers ----
  function toggleExpand(vid) {
    setExpanded((prev) => {
      const next = new Set(prev);
      const k = String(vid);
      if (next.has(k)) next.delete(k); else next.add(k);
      return next;
    });
  }
  function jumpToVisit(vid) {
    const visit = visits.find((x) => String(x.id) === String(vid));
    setPopupTab('visits');
    setFocusVid(String(vid));
    if (visit) setPopupStage(visitStage(visit));
    setExpanded((prev) => new Set(prev).add(String(vid)));
    setShowSide(false);
    setTimeout(() => {
      const row = document.querySelector(`.bp-main .vrow[data-vid="${vid}"]`);
      row?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 60);
  }
  function selectStage(sk) {
    setPopupStage(sk);
    setExpanded(() => { const s = new Set(); if (focusVid) s.add(String(focusVid)); return s; });
  }
  function setFuDraft(vid, patch) {
    setFuDrafts((prev) => ({ ...prev, [vid]: { ...(prev[vid] || {}), ...patch } }));
  }

  // ---- write actions (server first, then reloadSeed) ----
  async function changeTier(tier) {
    setBusy(true);
    try { await setBrokerTier(cpCode, tier); toast('Tier updated', 'good'); await reloadSeed(); }
    catch (e) { toast('Tier change failed: ' + String(e.message || e).slice(0, 80), 'bad'); }
    finally { setBusy(false); }
  }
  async function changeOwner(slug) {
    setBusy(true);
    try { await setBrokerOwner(cpCode, slug || ''); toast('CP owner updated', 'good'); await reloadSeed(); }
    catch (e) { toast('Owner change failed: ' + String(e.message || e).slice(0, 80), 'bad'); }
    finally { setBusy(false); }
  }
  async function saveFollowup(vid, act) {
    const draft = fuDrafts[vid] || {};
    const v = visits.find((x) => String(x.id) === String(vid));
    if (!draft.status && !draft.stage) { toast('Pick a status or next stage', 'bad'); return; }
    if (!draft.note || !draft.note.trim()) {
      toast('Notes are mandatory — write what was discussed', 'bad');
      const ta = document.querySelector(`.vrow[data-vid="${vid}"] textarea`);
      if (ta) { ta.focus(); ta.style.borderColor = 'var(--bad)'; setTimeout(() => { ta.style.borderColor = ''; }, 2000); }
      return;
    }
    const buyerStatus = draft.status || (v && v.lead_status === 'select_status' ? 'unc' : (v && v.lead_status)) || 'unc';
    const isDead = buyerStatus === 'dead';   // dead leads carry no follow-up
    if (!isDead && draft.stage === 'revisit_scheduled' && !draft.revisit_date) {
      toast('Revisit Scheduled needs a revisit date & time', 'bad'); return;
    }
    if (!isDead && draft.stage === 'negotiation' && !draft.negotiation_date) {
      toast('Negotiation needs a meeting date & time', 'bad'); return;
    }
    const stage = draft.stage || (v ? visitStage(v) : 'avfu') || 'avfu';
    setBusy(true);
    try {
      await apiSaveFollowup({
        visit_code: String(vid),
        buyer_status: buyerStatus,
        stage,
        note: draft.note.trim(),
        next_followup_date: isDead ? null : (draft.next_date || null),
        revisit_date: isDead ? null : (draft.revisit_date || null),
        negotiation_date: isDead ? null : (draft.negotiation_date || null),
      });
      setFuDrafts((prev) => { const n = { ...prev }; delete n[vid]; return n; });
      // "Save & close" collapses just this visit's follow-up form and keeps the CP
      // modal open, so the user can move to the next visit without re-opening the CP.
      // (Closing the whole CP stays available via the × button.)
      if (act === 'save-close') setExpanded((prev) => { const n = new Set(prev); n.delete(String(vid)); return n; });
      toast('Followup saved', 'good');
      await reloadSeed();
    } catch (e) { toast('Save failed: ' + String(e.message || e).slice(0, 120), 'bad'); }
    finally { setBusy(false); }
  }
  async function sendNudge(vid, message) {
    setBusy(true);
    try {
      await apiAddNudge({ visit_code: String(vid), message: message || 'Please follow up', priority: 'normal' });
      toast('Nudge sent', 'good');
      setNudgeVid(null);
      await reloadSeed();
    } catch (e) { toast('Nudge failed: ' + String(e.message || e).slice(0, 120), 'bad'); }
    finally { setBusy(false); }
  }
  async function saveEngagement() {
    const d = egDraft;
    if (!d.notes || !d.notes.trim()) {
      toast('Notes are mandatory for the engagement', 'bad');
      const ta = document.querySelector('.bp-main [data-eg-fld="notes"]');
      if (ta) { ta.focus(); ta.style.borderColor = 'var(--bad)'; setTimeout(() => { ta.style.borderColor = ''; }, 2000); }
      return;
    }
    setBusy(true);
    try {
      await apiSaveEngagement({
        cp_code: cpCode,
        notes: d.notes.trim(),
        inventory_shared: d.inventoryShared ? d.inventoryShared === 'yes' : null,
        recording_done: d.recordingDone ? d.recordingDone === 'yes' : null,
        listing_done: d.listingDone ? d.listingDone === 'yes' : null,
        listing_link: d.listingLink || null,
        listing_followup_date: d.listingFollowupDate || null,
        support_asked: d.supportAsked ? d.supportAsked === 'yes' : null,
        support_details: d.supportDetails || null,
        remarks: d.remarks || null,
        connected: d.connected || null,
        outcome: d.connected === 'connected' ? (d.outcome || null) : null,
        followup_date: d.followupDate || null,
      });
      setEgDraft({});
      toast('Engagement saved', 'good');
      await reloadSeed();
    } catch (e) { toast('Engagement failed: ' + String(e.message || e).slice(0, 120), 'bad'); }
    finally { setBusy(false); }
  }

  const visitCount = visits.length;

  return (
    <div id="modal-broker" className={'modal-bg' + (isMobile && showSide ? ' show-side' : '')} style={{ zIndex: 210 }} onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal">
        <div className="bp">
          {/* HEAD */}
          <div className="bp-head">
            <div className="avatar lg">{initials(broker.name)}</div>
            <div style={{ minWidth: 260 }}>
              <div className="bp-id">{broker.cp_code} · {broker.id || ''}</div>
              <div className="bp-name">
                {broker.name}{' '}
                <span className={'tier-badge ' + (broker.tier || 'T4')} style={{ marginLeft: 8, fontSize: 11, padding: '3px 9px', verticalAlign: 'middle' }}>
                  {broker.tier || 'T4'}{broker.tier_rank ? ' · #' + broker.tier_rank : ''}
                </span>
              </div>
              <div className="bp-sub">
                <span>📞 <b style={{ color: 'var(--txt)' }}>{broker.phone_number}</b></span>
                {broker.alternate_number ? <><span className="sd" /><span>alt {broker.alternate_number}</span></> : null}
                <span className="sd" /><span>{broker.company_name}</span>
                <span className="sd" /><span className="city-pill">{broker.city}</span>
                <span className="sd" /><span>CP Owner: <b style={{ color: 'var(--txt)' }}>{ownerName}</b></span>
                <span className="sd" /><span>Onboarded by: <b style={{ color: 'var(--txt)' }}>{broker.added_by || '—'}</b></span>
              </div>
            </div>
            <div className="bp-stats">
              <div className="bp-stat"><div className="v">{broker.d30_visits || 0}</div><div className="l">D30 visits</div></div>
              <div className="bp-stat"><div className="v">{broker.d90_visits || 0}</div><div className="l">D90</div></div>
              <div className="bp-stat"><div className="v">{broker.all_time_visits || 0}</div><div className="l">All time</div></div>
              <div className="bp-stat"><div className="v">{broker.bookings_apr_may || 0}</div><div className="l">Bookings (Apr-May)</div></div>
              <div className="bp-stat"><div className="v">{broker.has_sold === 'Yes' ? '✓' : '—'}</div><div className="l">Has sold</div></div>
            </div>
            <div className="bp-act">
              <a className="btn" href={`tel:${broker.phone_number}`}><span>📞</span> Call</a>
              <button className="btn" onClick={() => setWaCp(cpCode)}><span>💬</span> WhatsApp</button>
              <button className="x-btn" onClick={onClose}>✕</button>
            </div>
          </div>

          {/* MOBILE TOGGLE */}
          {isMobile && (
            <div className="bp-mtoggle">
              <button className={popupTab === 'visits' && !showSide ? 'on' : ''} onClick={() => { setShowSide(false); setPopupTab('visits'); }}>📋 Visits</button>
              <button className={popupTab === 'engagement' && !showSide ? 'on' : ''} onClick={() => { setShowSide(false); setPopupTab('engagement'); }}>📞 Engagement</button>
              <button className={popupTab === 'timeline' && !showSide ? 'on' : ''} onClick={() => { setShowSide(false); setPopupTab('timeline'); }}>🕓 Timeline</button>
              <button className={showSide ? 'on' : ''} onClick={() => setShowSide(true)}>ℹ️ Info</button>
            </div>
          )}

          <div className="bp-body">
            {/* MAIN PANEL */}
            <div className="bp-main">
              {/* BANNER STRIP */}
              {(activeNudges.length || tlMessages.length || isOnTlList) ? (
                <div className="bp-banner">
                  {activeNudges.map((n) => {
                    const vv = visits.find((x) => String(x.id) === String(n.visitId));
                    const fr = ubs[n.from];
                    return (
                      <div key={n.id} className="bp-banner-item nudge" onClick={() => jumpToVisit(n.visitId)}>
                        <div className="bbi-ic">🔔</div>
                        <div className="bbi-body">
                          <span className="bbi-from">Nudge from {fr ? fr.name : 'team'} {fr ? <span className={'role-pill ' + (TEAM_PILL[fr.team] || '')}>{fr.team}</span> : null}</span>
                          <div className="bbi-text">{n.message || 'Please follow up'}</div>
                          <div className="bbi-meta">about {vv ? vv.buyer_name : ''} @ {vv ? vv.society_name : ''} · {fmtDay(n.ts)} · tap to jump</div>
                        </div>
                      </div>
                    );
                  })}
                  {isOnTlList ? (
                    <div className="bp-banner-item tl_ask">
                      <div className="bbi-ic">📌</div>
                      <div className="bbi-body">
                        <span className="bbi-from">On TL daily call list</span>
                        <div className="bbi-text">Priority CP — pinned by your team lead for today's calls</div>
                      </div>
                    </div>
                  ) : null}
                  {tlMessages.map((m, i) => {
                    const fr = ubs[m.from];
                    return (
                      <div key={'m' + i} className="bp-banner-item message">
                        <div className="bbi-ic">📣</div>
                        <div className="bbi-body">
                          <span className="bbi-from">{fr ? fr.name : 'TL'} {fr ? <span className={'role-pill ' + (TEAM_PILL[fr.team] || '')}>{fr.team || ''}</span> : null} {m.priority === 'high' ? <span className="prio-tag tl">HIGH</span> : null}</span>
                          <div className="bbi-text">{m.text || ''}</div>
                          <div className="bbi-meta">{fmtDay(m.ts)}</div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : null}

              {/* MAIN TAB BAR */}
              <div style={{ display: 'flex', gap: 0, margin: '-2px -2px 14px', background: 'var(--panel)', padding: '0 4px', borderRadius: '8px 8px 0 0', borderTop: '1px solid var(--line)', borderLeft: '1px solid var(--line)', borderRight: '1px solid var(--line)', borderBottom: 0 }}>
                {[['visits', `📋 Visits (${visitCount})`], ['engagement', `📞 Engagement (${engagements.length})`], ['timeline', '🕓 Timeline']].map(([k, label]) => (
                  <button key={k} onClick={() => setPopupTab(k)} style={{ padding: '10px 18px', color: popupTab === k ? 'var(--acc)' : 'var(--mut)', fontWeight: 600, fontSize: 13, border: 0, background: 'none', cursor: 'pointer', borderBottom: '2px solid ' + (popupTab === k ? 'var(--acc)' : 'transparent'), marginBottom: -1 }}>{label}</button>
                ))}
              </div>

              {/* TAB CONTENT */}
              {popupTab === 'engagement' ? (
                <EngagementTab
                  broker={broker} engagements={engagements} ubs={ubs}
                  draft={egDraft} setDraft={setEgDraft} onSave={saveEngagement} busy={busy}
                />
              ) : popupTab === 'visits' ? (
                <>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
                    <h3 style={{ fontSize: 12, fontWeight: 700, color: 'var(--mut)', textTransform: 'uppercase', letterSpacing: '.5px' }}>Buyer visits across stages</h3>
                    <span style={{ background: 'var(--accBg)', color: 'var(--accDark)', padding: '2px 8px', borderRadius: 8, fontSize: 11, fontWeight: 700 }}>{visitCount} total</span>
                  </div>
                  {tabsAvailable.length > 1 && (
                    <div className="stg-tabs">
                      {tabsAvailable.map((sk) => {
                        const on = activeStage === sk;
                        if (sk === 'all') {
                          return <button key={sk} className={on ? 'on' : ''} style={on ? { background: 'var(--ink)', color: '#fff' } : undefined} onClick={() => selectStage(sk)}>All<span className="ct">{(groups[sk] || []).length}</span></button>;
                        }
                        const def = STAGE_BY_KEY[sk];
                        return (
                          <button key={sk} className={def.cls + (on ? ' on' : '')} onClick={() => selectStage(sk)}>
                            <span style={{ width: 7, height: 7, borderRadius: '50%', background: 'currentColor', opacity: .6 }} />{def.label}<span className="ct">{(groups[sk] || []).length}</span>
                          </button>
                        );
                      })}
                    </div>
                  )}
                  <div className="bpStageBody">
                    {currentVisits.length ? currentVisits.map((v) => (
                      <VisitRow
                        key={v.id} v={v} visits={visits}
                        open={expanded.has(String(v.id))}
                        isPriority={String(v.id) === String(focusVid)}
                        onToggle={() => toggleExpand(v.id)}
                        draft={fuDrafts[v.id] || {}}
                        setDraft={(patch) => setFuDraft(v.id, patch)}
                        onSave={saveFollowup}
                        onNudge={() => setNudgeVid(v.id)}
                        nudgesByVisit={nudgesByVisit} teamTasks={teamTasks}
                        ownerId={ownerId} me={me} busy={busy}
                        nudgeSent={false}
                      />
                    )) : (visitCount === 0
                      ? <div className="empty"><div className="emoji">📭</div><div className="t">No visits</div><div className="s">This CP has no visits yet.</div></div>
                      : <div className="empty"><div className="emoji">📭</div><div className="t">No visits in this stage</div></div>)}
                  </div>
                </>
              ) : (
                <TimelineTab broker={broker} visits={visits} followupLog={followupLog} nudgesByVisit={nudgesByVisit} engagements={engagements} ubs={ubs} />
              )}
            </div>

            {/* SIDE PANEL */}
            <div className="bp-side">
              <SidePanel
                broker={broker} visits={visits} properties={properties}
                ownerId={ownerId} ubs={ubs} users={users} isAdmin={isAdmin} busy={busy}
                onChangeOwner={changeOwner} onChangeTier={changeTier} onClose={onClose}
              />
            </div>
          </div>
        </div>
      </div>

      {/* SATELLITE: WhatsApp picker */}
      {waCp && (
        <WaPicker
          broker={broker} visits={visits} properties={properties} me={me}
          onClose={() => setWaCp(null)}
        />
      )}

      {/* SATELLITE: Nudge composer */}
      {nudgeVid != null && (
        <NudgeComposer
          visit={visits.find((x) => String(x.id) === String(nudgeVid))}
          broker={broker} ubs={ubs} ownerId={ownerId} me={me} busy={busy}
          onSend={(msg) => sendNudge(nudgeVid, msg)} onClose={() => setNudgeVid(null)}
        />
      )}
    </div>
  );
}

/* ===============================================================
   VISIT ROW
   =============================================================== */
function VisitRow({ v, visits, open, isPriority, onToggle, draft, setDraft, onSave, onNudge, nudgesByVisit, teamTasks, ownerId, me, busy }) {
  const status = visitStatus(v);
  const stage = visitStage(v);
  const recent = (v.all_feedback || '').split('\n').filter((l) => l.trim()).slice(-3).reverse();
  const nudged = isVisitNudged(v, nudgesByVisit);
  const tlAsk = isVisitTlAsk(v, teamTasks);
  const nudgeOk = !!(ownerId && ownerId !== me.id);
  const unit = [v.unit_address_line1, v.unit_address_line2].filter(Boolean).join('-');
  const nextDefault = draft.next_date != null ? draft.next_date : ymd(addDays(TODAY, 2));
  const isDead = (draft.status || visitStatus(v)) === 'dead';   // dead → no follow-up date

  return (
    <div className={'vrow' + (open ? ' open' : '') + (isPriority ? ' priority' : '')} data-vid={v.id}>
      <div className="vrow-head" onClick={(e) => { if (e.target.closest('.vrow-body')) return; onToggle(); }}>
        <span className="vh-caret">▶</span>
        <div className="vh-buyer">
          <div className="b">{v.buyer_name || '—'}</div>
          <div className="ph">{v.buyer_contact || ''}{v.lead_occurrence_count && +v.lead_occurrence_count > 1 ? ` · revisit #${v.lead_occurrence_count}` : ''}</div>
        </div>
        <div className="vh-prop">
          <div className="p">{v.society_name || '—'} {unit ? <span className="muted" style={{ fontWeight: 500, fontSize: 11 }}>{unit}</span> : null}</div>
          <div className="s">RM: {v.sales_manager || '—'} · {(v.source || '').replace('channel_partner', 'via CP')}{stage === 'revisit_scheduled' && v._revisit_date ? ` · Revisit ${fmtDate(v._revisit_date)}` : ''}</div>
        </div>
        <div className="vh-date"><div className="d">{fmtDate(v.visit_date)}</div>{v.selected_time || ''}</div>
        <div className="vh-status">
          <span className={'stpill ' + status}><span className="d" />{STATUSES.find((s) => s.k === status)?.label}</span>
          <span className={'sgpill ' + stage}><span className="d" />{STAGE_BY_KEY[stage]?.label}</span>
          {nudged ? <span className="prio-tag nudge">🔔 Nudge</span> : null}
          {tlAsk ? <span className="prio-tag tl">📌 TL</span> : null}
        </div>
        {nudgeOk ? (
          <button className="nudge-btn" onClick={(e) => { e.stopPropagation(); onNudge(); }} disabled={busy}>Nudge owner</button>
        ) : null}
      </div>

      <div className="vrow-body">
        <VisitIntent v={v} />
        <BuyerHistory v={v} visits={visits} />
        {recent.length ? (
          <div className="fu-recent"><b>Recent feedback</b><br />{recent.map((l, i) => <span key={i}>· {l}<br /></span>)}</div>
        ) : null}
        {(v.latest_followup_date || v.latest_followup_note) ? (
          <div className="fu-recent"><b>Latest FU ({fmtDate(v.latest_followup_date)})</b>: {v.latest_followup_note || '—'}</div>
        ) : null}

        <div className="fu-form">
          <div className="fu-row">
            <div className="fu-grp">
              <label>Buyer Status (Hot / Warm / Cold / Dead)</label>
              <div className="fu-pills" data-set="status">
                {STATUS_PILLS.map((s) => (
                  <button key={s} className={'fu-pill ' + (draft.status === s ? 'on ' + s : '')} onClick={(e) => { e.stopPropagation(); setDraft({ status: s }); }}>
                    <span className="d" />{s.replace('_', ' ')}
                  </button>
                ))}
              </div>
            </div>
            <div className="fu-grp">
              <label>Next Stage</label>
              <div className="fu-pills" data-set="stage">
                {STAGE_PILLS.map((s) => (
                  <button key={s} className={'fu-pill ' + (draft.stage === s ? 'on' : '')} onClick={(e) => { e.stopPropagation(); setDraft({ stage: s }); }}>
                    <span className="d" />{STAGE_BY_KEY[s].label}
                  </button>
                ))}
              </div>
            </div>
          </div>
          {draft.stage === 'revisit_scheduled' && (
            <div className="fu-grp" style={{ background: 'var(--blueBg)', border: '1px solid #93C5FD', borderRadius: 8, padding: '10px 12px', marginBottom: 10 }}>
              <label style={{ color: '#1E40AF' }}>Revisit date &amp; time <span style={{ color: 'var(--bad)', fontWeight: 700 }}>*</span></label>
              <input type="datetime-local" value={draft.revisit_date || ''} onChange={(e) => setDraft({ revisit_date: e.target.value })}
                style={{ padding: '7px 10px', border: '1px solid var(--line)', borderRadius: 7, background: '#fff', fontSize: 13, width: 240, maxWidth: '100%' }} />
              <div style={{ fontSize: 11, color: '#1E40AF', marginTop: 4 }}>Once this date passes, the visit auto-moves to "After Revisit FU".</div>
            </div>
          )}
          {draft.stage === 'negotiation' && (
            <div className="fu-grp" style={{ background: 'var(--blueBg)', border: '1px solid #93C5FD', borderRadius: 8, padding: '10px 12px', marginBottom: 10 }}>
              <label style={{ color: '#1E40AF' }}>Negotiation meeting date &amp; time <span style={{ color: 'var(--bad)', fontWeight: 700 }}>*</span></label>
              <input type="datetime-local" value={draft.negotiation_date || ''} onChange={(e) => setDraft({ negotiation_date: e.target.value })}
                style={{ padding: '7px 10px', border: '1px solid var(--line)', borderRadius: 7, background: '#fff', fontSize: 13, width: 240, maxWidth: '100%' }} />
              <div style={{ fontSize: 11, color: '#1E40AF', marginTop: 4 }}>Once this date passes, the visit auto-moves to "After Negotiation FU".</div>
            </div>
          )}
          <div className="fu-grp">
            <label>Notes <span style={{ color: 'var(--bad)', fontWeight: 700 }}>*</span> <span style={{ fontWeight: 500, color: 'var(--mut)', textTransform: 'none', letterSpacing: 0, fontSize: 10 }}>required</span></label>
            <textarea placeholder="Required — what was discussed, buyer's signal, next action…" value={draft.note || ''} onChange={(e) => setDraft({ note: e.target.value })} />
          </div>
          <div className="fu-actions">
            <div className="fu-grp" style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <label style={{ margin: 0 }}>Next FU</label>
              <input type="date" disabled={isDead}
                     value={isDead ? '' : nextDefault}
                     onChange={(e) => setDraft({ next_date: e.target.value })}
                     style={isDead ? { opacity: 0.5, cursor: 'not-allowed' } : undefined} />
              {isDead ? <span style={{ fontSize: 10.5, color: 'var(--mut)' }}>No follow-up for a dead lead</span> : null}
            </div>
            <div style={{ display: 'flex', gap: 6 }}>
              <button className="btn sm" disabled={busy} onClick={(e) => { e.stopPropagation(); onSave(v.id, 'save'); }}>Save &amp; continue</button>
              <button className="btn primary sm" disabled={busy} onClick={(e) => { e.stopPropagation(); onSave(v.id, 'save-close'); }}>Save &amp; close</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ===============================================================
   VISIT INTENT
   =============================================================== */
function VisitIntent({ v }) {
  const items = visitIntentItems(v);
  if (!items.length) return null;
  return (
    <div className="intent-block">
      <div className="ib-head">📊 Visit signals captured during property visit</div>
      <div className="ib-grid">
        {items.map((it, i) => (
          <div key={i} className={'ib-item ' + (it.full ? 'full' : '')}>
            <div className="k">{it.k}</div>
            <div className={'v ' + (it.signalClass ? 'ib-signal-' + it.signalClass : '')}>{String(it.val)}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ===============================================================
   BUYER HISTORY
   =============================================================== */
function buyerOtherVisits(v, visits) {
  const key = (v.lead_key || '').toLowerCase();
  const phone = (v.buyer_contact || '').trim();
  if (!key && !phone) return [];
  return visits.filter((x) => String(x.id) !== String(v.id) && (
    (key && (x.lead_key || '').toLowerCase() === key)
    || (phone && phone.length >= 5 && (x.buyer_contact || '').trim() === phone)
  ));
}
function BuyerHistory({ v, visits }) {
  const others = buyerOtherVisits(v, visits);
  if (!others.length) return null;
  const sorted = others.slice().sort((a, b) => (b.visit_date || '').localeCompare(a.visit_date || '')).slice(0, 12);
  return (
    <div className="intent-block" style={{ background: 'linear-gradient(180deg,#F4F8FF,#fff)', borderColor: '#CFE0F7' }}>
      <div className="ib-head" style={{ color: '#1E40AF' }}>🧑 {v.buyer_name || 'Buyer'}'s other visits / property history ({others.length})</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 12 }}>
        {sorted.map((o) => {
          const stat = visitStatus(o); const stg = visitStage(o);
          const unit = [o.unit_address_line1, o.unit_address_line2].filter(Boolean).join('-');
          const fb = (o.all_feedback || '').split('\n').filter((l) => l.trim()).slice(-1)[0] || o.sales_feedback || '';
          return (
            <div key={o.id} style={{ padding: '8px 10px', background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 7 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
                <div><b>{o.society_name || '—'}</b> {o.unit_address_line1 ? <span style={{ color: 'var(--mut)', fontWeight: 500 }}>{unit}</span> : null}</div>
                <div style={{ fontSize: 11, color: 'var(--mut)' }}>{fmtDate(o.visit_date)} · via {o.broker_name || '—'}</div>
              </div>
              <div style={{ display: 'flex', gap: 6, marginTop: 5, flexWrap: 'wrap' }}>
                <span className={'stpill ' + stat}><span className="d" />{STATUSES.find((s) => s.k === stat)?.label || stat}</span>
                <span className={'sgpill ' + stg}><span className="d" />{STAGE_BY_KEY[stg]?.label || stg}</span>
                {o.lead_occurrence_count && +o.lead_occurrence_count > 1 ? <span className="prio-tag tl">revisit #{o.lead_occurrence_count}</span> : null}
              </div>
              {fb ? <div style={{ fontSize: 11, color: 'var(--mut)', marginTop: 5, fontStyle: 'italic' }}>"{String(fb).slice(0, 140)}"</div> : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ===============================================================
   TIMELINE
   =============================================================== */
const TIMELINE_ICON = { visit_booked: '📅', visit_completed: '🏠', visit_cancelled: '❌', feedback: '💬', followup: '📝', nudge: '🔔', nudge_resolved: '✅', onboarded: '🎉', assign: '📥', engagement: '📞' };
function timelineIcon(kind) { return TIMELINE_ICON[kind] || '·'; }

function parseFeedbackDate(line) {
  const m = String(line).match(/^(\d{1,2})-([A-Za-z]+)\s*-/);
  if (!m) return null;
  const d = new Date(`${m[1]} ${m[2]} ${TODAY.getFullYear()}`);
  return isNaN(d) ? null : ymd(d);
}

function buildCpTimeline(broker, visits, followupLog, nudgesByVisit, engagements, ubs) {
  const items = [];
  const cpCode = broker.cp_code;
  const sorted = visits.slice().sort((a, b) => (b.visit_date || '').localeCompare(a.visit_date || ''));
  sorted.forEach((v) => {
    if (v.created_at) {
      const unitTxt = v.unit_address_line1 ? '· ' + v.unit_address_line1 + (v.unit_address_line2 ? '-' + v.unit_address_line2 : '') : '';
      items.push({ ts: v.created_at.slice(0, 10), kind: 'visit_booked', t: `Visit booked: ${v.buyer_name || 'Buyer'} for ${v.society_name || ''}`, sub: `${v.bhk || v.configuration || ''} ${unitTxt} · ${v.selected_time || ''}`, by: v.first_added_by || v.added_by || '' });
    }
    if (v.visit_date && v.status === 'completed') {
      items.push({ ts: v.visit_date, kind: 'visit_completed', t: `Visit completed: ${v.buyer_name || 'Buyer'} @ ${v.society_name || ''}`, sub: `Status: ${visitStatus(v)} · Stage: ${STAGE_BY_KEY[visitStage(v)]?.label || visitStage(v)}`, by: v.sales_manager || '' });
    }
    if (v.visit_date && v.status === 'cancelled') {
      items.push({ ts: v.visit_date, kind: 'visit_cancelled', t: `Visit cancelled: ${v.buyer_name || 'Buyer'} @ ${v.society_name || ''}`, by: v.sales_manager || '' });
    }
  });
  sorted.forEach((v) => {
    (v.all_feedback || '').split('\n').forEach((line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      const m = trimmed.match(/^(\d{1,2})-([A-Za-z]+)\s*-\s*(.*)/);
      const tsGuess = m ? parseFeedbackDate(trimmed) : v.visit_date;
      items.push({ ts: tsGuess || v.visit_date, kind: 'feedback', t: m ? m[3] : trimmed, sub: `Buyer: ${v.buyer_name || ''} @ ${v.society_name || ''}`, by: v.sales_manager || '' });
    });
  });
  followupLog.filter((f) => f.cp_code === cpCode).forEach((f) => {
    const v = visits.find((x) => String(x.id) === String(f.visit_id));
    items.push({
      ts: (f.ts || '').slice(0, 10),
      kind: f.kind || 'followup',
      t: f.kind === 'nudge' ? 'Nudged: ' + (f.note || '') : f.kind === 'assign' ? f.note : `Followup logged · ${f.status || ''}${f.stage ? ' → ' + (STAGE_BY_KEY[f.stage]?.label || f.stage) : ''}`,
      sub: f.note ? `"${f.note}"` + (v ? ` · Buyer ${v.buyer_name || ''}` : '') : (v ? `Buyer ${v.buyer_name || ''} @ ${v.society_name || ''}` : ''),
      by: ubs[f.by]?.name || f.by,
    });
  });
  Object.entries(nudgesByVisit).forEach(([vid, arr]) => {
    const v = visits.find((x) => String(x.id) === String(vid));
    if (!v || v.cp_code !== cpCode) return;
    (arr || []).forEach((n) => {
      items.push({ ts: (n.ts || '').slice(0, 10), kind: 'nudge', t: `Nudge sent: "${n.message || 'follow up needed'}"`, sub: `From ${ubs[n.from]?.name || '?'} (${ubs[n.from]?.team || ''}) → ${ubs[n.to]?.name || '?'} (${ubs[n.to]?.team || ''}) · Buyer ${v.buyer_name || ''}`, by: ubs[n.from]?.name });
      if (n.resolved && n.resolved_ts) {
        items.push({ ts: n.resolved_ts.slice(0, 10), kind: 'nudge_resolved', t: 'Nudge resolved', sub: `Followup taken by ${ubs[n.resolved_by]?.name || ''} on buyer ${v.buyer_name || ''}`, by: ubs[n.resolved_by]?.name });
      }
    });
  });
  engagements.forEach((e) => {
    const tags = [];
    if (e.inventoryShared === 'yes') tags.push('inventory shared');
    if (e.recordingDone === 'yes') tags.push('recording done');
    if (e.listingDone === 'yes') tags.push('listing done');
    if (e.supportAsked === 'yes') tags.push('support asked');
    items.push({ ts: (e.ts || '').slice(0, 10), kind: 'engagement', t: `Engagement logged${tags.length ? ': ' + tags.join(', ') : ''}`, sub: (e.notes || '') + (e.remarks ? ' · ' + e.remarks : '') + (e.listingLink ? ' · listing: ' + e.listingLink : ''), by: ubs[e.by]?.name });
  });
  if (broker.created_at) {
    items.push({ ts: broker.created_at.slice(0, 10), kind: 'onboarded', t: 'CP onboarded', sub: `By ${broker.added_by || 'team'} · ${broker.city || ''} · ${broker.company_name || 'Individual'}`, by: broker.added_by });
  }
  items.sort((a, c) => (c.ts || '').localeCompare(a.ts || ''));
  return items;
}

function TimelineTab({ broker, visits, followupLog, nudgesByVisit, engagements, ubs }) {
  const items = useMemo(
    () => buildCpTimeline(broker, visits, followupLog, nudgesByVisit, engagements, ubs),
    [broker, visits, followupLog, nudgesByVisit, engagements, ubs],
  );
  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
        <h3 style={{ fontSize: 12, fontWeight: 700, color: 'var(--mut)', textTransform: 'uppercase', letterSpacing: '.5px' }}>Complete activity timeline for {broker.name}</h3>
      </div>
      <div className="tl">
        {items.length ? items.map((it, i) => (
          <div key={i} className={'tl-item ' + it.kind}>
            <div className="tl-head"><span className="tl-t">{timelineIcon(it.kind)} {it.t}</span><span className="tl-d">{fmtDay(it.ts)}</span></div>
            {it.sub ? <div className="tl-desc">{it.sub}</div> : null}
            {it.by ? <div className="tl-by">by {it.by}</div> : null}
          </div>
        )) : <div className="empty"><div className="emoji">🕓</div><div className="t">No activity yet</div></div>}
      </div>
    </>
  );
}

/* ===============================================================
   ENGAGEMENT TAB
   =============================================================== */
function EngagementTab({ broker, engagements, ubs, draft, setDraft, onSave, busy }) {
  const list = engagements.slice().sort((a, c) => (c.ts || '').localeCompare(a.ts || ''));
  const setPill = (field, val) => setDraft((d) => ({ ...d, [field]: val }));
  const setFld = (field, val) => setDraft((d) => ({ ...d, [field]: val }));
  const inputStyle = { marginTop: 8, width: '100%', padding: '8px 11px', border: '1px solid var(--line)', borderRadius: 7, fontSize: 13, background: 'var(--panel)', outline: 'none' };
  const taStyle = { marginTop: 8, width: '100%', border: '1px solid var(--line)', borderRadius: 7, padding: '8px 11px', fontSize: 13, background: 'var(--panel)', outline: 'none', resize: 'vertical', minHeight: 60 };

  const Pills = ({ field, opts }) => (
    <div className="fu-pills" data-eg={field}>
      {opts.map(([val, label]) => (
        <button key={val} className={'fu-pill ' + (draft[field] === val ? 'on' : '')} onClick={() => setPill(field, val)}>{label}</button>
      ))}
    </div>
  );

  return (
    <div>
      <div style={{ marginBottom: 14 }}>
        <h3 style={{ fontSize: 12, fontWeight: 700, color: 'var(--mut)', textTransform: 'uppercase', letterSpacing: '.5px', marginBottom: 6 }}>Log a new engagement with {(broker.name || '').split(' ')[0]}</h3>
        <div style={{ background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 11, padding: '14px 16px' }}>
          <div className="fu-grp" style={{ marginBottom: 12 }}>
            <label>Was the CP connected?</label>
            <Pills field="connected" opts={[['connected', '✓ Connected'], ['no_answer', 'No answer'], ['busy', 'Busy'], ['switched_off', 'Switched off'], ['wrong_number', 'Wrong number']]} />
            {draft.connected === 'connected' && (
              <select data-eg-fld="outcome" value={draft.outcome || ''} onChange={(e) => setFld('outcome', e.target.value)} style={{ ...inputStyle, maxWidth: 300 }}>
                <option value="">— Call outcome —</option>
                <option value="interested">Interested</option>
                <option value="bringing_buyer">Bringing a buyer</option>
                <option value="callback_requested">Callback requested</option>
                <option value="no_inventory_match">No inventory match</option>
                <option value="not_interested">Not interested</option>
              </select>
            )}
          </div>
          <div className="fu-grp" style={{ marginBottom: 12 }}>
            <label>1. Was inventory shared during this engagement?</label>
            <Pills field="inventoryShared" opts={[['yes', '✓ Yes'], ['no', '✗ No']]} />
          </div>
          <div className="fu-grp" style={{ marginBottom: 12 }}>
            <label>2. Recording done?</label>
            <Pills field="recordingDone" opts={[['yes', '✓ Yes'], ['no', '✗ No']]} />
          </div>
          <div className="fu-grp" style={{ marginBottom: 12 }}>
            <label>3. Listing already done by CP?</label>
            <Pills field="listingDone" opts={[['yes', '✓ Yes — share link'], ['no', '✗ No — set followup']]} />
            {draft.listingDone === 'yes' && (
              <input type="url" data-eg-fld="listingLink" placeholder="Paste listing link (99acres / housing / magicbricks…)" value={draft.listingLink || ''} onChange={(e) => setFld('listingLink', e.target.value)} style={inputStyle} />
            )}
            {draft.listingDone === 'no' && (
              <div style={{ marginTop: 8, display: 'flex', gap: 8, alignItems: 'center' }}>
                <label style={{ fontSize: 11, color: 'var(--mut)', margin: 0 }}>Listing followup by</label>
                <input type="date" data-eg-fld="listingFollowupDate" value={draft.listingFollowupDate || ymd(addDays(TODAY, 3))} onChange={(e) => setFld('listingFollowupDate', e.target.value)} style={{ padding: '6px 9px', border: '1px solid var(--line)', borderRadius: 6, fontSize: 12.5 }} />
              </div>
            )}
          </div>
          <div className="fu-grp" style={{ marginBottom: 12 }}>
            <label>4. Did CP ask for product / marketing support?</label>
            <Pills field="supportAsked" opts={[['yes', '✓ Yes — details'], ['no', '✗ No']]} />
            {draft.supportAsked === 'yes' && (
              <textarea data-eg-fld="supportDetails" placeholder="What support / marketing / product gap was raised?" value={draft.supportDetails || ''} onChange={(e) => setFld('supportDetails', e.target.value)} style={taStyle} />
            )}
          </div>
          <div className="fu-grp" style={{ marginBottom: 12 }}>
            <label>5. Additional remarks</label>
            <textarea data-eg-fld="remarks" placeholder="Anything else worth capturing about this engagement…" value={draft.remarks || ''} onChange={(e) => setFld('remarks', e.target.value)} style={{ ...taStyle, marginTop: 0 }} />
          </div>
          <div className="fu-grp" style={{ marginBottom: 12 }}>
            <label>Schedule a follow-up with this CP <span style={{ fontWeight: 500, color: 'var(--mut)', textTransform: 'none', letterSpacing: 0, fontSize: 10 }}>optional</span></label>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8 }}>
              <input type="date" data-eg-fld="followupDate" value={draft.followupDate || ''} onChange={(e) => setFld('followupDate', e.target.value)} style={{ padding: '6px 9px', border: '1px solid var(--line)', borderRadius: 6, fontSize: 12.5 }} />
              {draft.followupDate ? <button className="btn xs" onClick={() => setFld('followupDate', '')}>clear</button> : null}
            </div>
          </div>
          <div className="fu-grp" style={{ marginBottom: 12 }}>
            <label>Notes <span style={{ color: 'var(--bad)', fontWeight: 700 }}>*</span> <span style={{ fontWeight: 500, color: 'var(--mut)', textTransform: 'none', letterSpacing: 0, fontSize: 10 }}>required — capture the conversation</span></label>
            <textarea data-eg-fld="notes" placeholder="Required — summary of the conversation, tone, next steps" value={draft.notes || ''} onChange={(e) => setFld('notes', e.target.value)} style={{ ...taStyle, marginTop: 0, minHeight: 80 }} />
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <button className="btn sm" onClick={() => setDraft({})}>Clear draft</button>
            <button className="btn primary sm" disabled={busy} onClick={onSave}>Save engagement</button>
          </div>
        </div>
      </div>

      <h3 style={{ fontSize: 12, fontWeight: 700, color: 'var(--mut)', textTransform: 'uppercase', letterSpacing: '.5px', marginBottom: 8 }}>Past engagements ({list.length})</h3>
      {list.length ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {list.map((e) => {
            const by = ubs[e.by];
            return (
              <div key={e.id} style={{ background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 9, padding: '12px 14px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8, marginBottom: 6 }}>
                  <b style={{ fontSize: 13 }}>{by ? by.name : 'Team'} {by ? <span className={'role-pill ' + (TEAM_PILL[by.team] || '')}>{by.team}</span> : null}</b>
                  <span style={{ fontSize: 11, color: 'var(--mut)' }}>{fmtDay(e.ts)}</span>
                </div>
                {(e.connected || e.followupDate) ? (
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 6 }}>
                    {e.connected ? (
                      <span style={{ fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 6, border: '1px solid var(--line)', color: e.connected === 'connected' ? 'var(--good)' : 'var(--mut)' }}>
                        {e.connected === 'connected' ? '📞 ' : '📵 '}{CONNECTED_LABEL[e.connected] || e.connected}{e.connected === 'connected' && e.outcome ? ' · ' + (OUTCOME_LABEL[e.outcome] || e.outcome) : ''}
                      </span>
                    ) : null}
                    {e.followupDate ? <span style={{ fontSize: 11, color: 'var(--acc)', fontWeight: 600 }}>↻ Follow-up {fmtDate(e.followupDate)}</span> : null}
                  </div>
                ) : null}
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(180px,1fr))', gap: '5px 14px', fontSize: 11.5, color: 'var(--mut)', marginBottom: 6 }}>
                  <div>Inventory shared: <b style={{ color: e.inventoryShared === 'yes' ? 'var(--good)' : 'var(--bad)' }}>{e.inventoryShared === 'yes' ? 'Yes' : 'No'}</b></div>
                  <div>Recording: <b style={{ color: e.recordingDone === 'yes' ? 'var(--good)' : 'var(--bad)' }}>{e.recordingDone === 'yes' ? 'Yes' : 'No'}</b></div>
                  <div>Listing: <b style={{ color: e.listingDone === 'yes' ? 'var(--good)' : 'var(--bad)' }}>{e.listingDone === 'yes' ? 'Yes' : 'No'}</b>{e.listingLink ? <> · <a href={e.listingLink} target="_blank" rel="noreferrer">link↗</a></> : null}{e.listingFollowupDate ? ` · FU ${fmtDate(e.listingFollowupDate)}` : ''}</div>
                  <div>Support ask: <b style={{ color: e.supportAsked === 'yes' ? 'var(--warn)' : 'var(--mut)' }}>{e.supportAsked === 'yes' ? 'Yes' : 'No'}</b></div>
                </div>
                {e.supportDetails ? <div style={{ fontSize: 12, color: 'var(--txt)', marginBottom: 4 }}><b>Support detail:</b> {e.supportDetails}</div> : null}
                {e.remarks ? <div style={{ fontSize: 12, color: 'var(--mut)', marginBottom: 4, fontStyle: 'italic' }}>Remarks: {e.remarks}</div> : null}
                <div style={{ fontSize: 12.5, color: 'var(--txt)', background: '#FFFCF5', border: '1px solid var(--line)', borderRadius: 6, padding: '7px 10px' }}><b>Notes:</b> {e.notes}</div>
              </div>
            );
          })}
        </div>
      ) : <div className="muted" style={{ fontSize: 12.5, padding: '8px 0' }}>No past engagements logged yet.</div>}
    </div>
  );
}

/* ===============================================================
   SIDE PANEL
   =============================================================== */
function SidePanel({ broker: b, visits, properties, ownerId, ubs, users, isAdmin, busy, onChangeOwner, onChangeTier, onClose }) {
  const monthlyVisits = Array(6).fill(0);
  const monthLabels = [];
  for (let i = 5; i >= 0; i--) { const d = new Date(TODAY); d.setMonth(d.getMonth() - i); monthLabels.push(fmtMonth(d)); }
  visits.forEach((v) => {
    if (!v.visit_date) return;
    const dv = new Date(v.visit_date);
    if (isNaN(dv)) return;
    const m = (TODAY.getFullYear() * 12 + TODAY.getMonth()) - (dv.getFullYear() * 12 + dv.getMonth());
    if (m >= 0 && m < 6) monthlyVisits[5 - m]++;
  });
  const maxV = Math.max(1, ...monthlyVisits);
  const maxMonth = Math.max(...monthlyVisits);
  const buyers = new Set(visits.map((v) => v.lead_key).filter(Boolean));
  const hotCount = visits.filter((v) => visitStatus(v) === 'hot').length;
  const warmCount = visits.filter((v) => visitStatus(v) === 'warm').length;

  const mms = (b.micro_markets || '').split(',').map((s) => s.trim()).filter(Boolean);
  const societies = (b.societies || b.societies_worked || '').split(',').map((s) => s.trim()).filter(Boolean).slice(0, 12);
  const matches = properties.filter((p) => mms.includes(p.micro_market) && p.listing_status === 'Ready').slice(0, 4);
  const ownerUser = ownerId ? ubs[ownerId] : null;
  const kam = users.filter((u) => u.team === 'KAM');
  const ground = users.filter((u) => u.team === 'Ground');

  return (
    <>
      <h4>Channel Partner</h4>
      <div className="kv">
        <div className="k">Tier</div><div className="v"><span className={'tier-badge ' + (b.tier || 'T4')}>{b.tier || 'T4'}</span>{b.tier_rank ? ` · #${b.tier_rank}` : ''}</div>
        <div className="k">CP Code</div><div className="v" style={{ fontFamily: "'SF Mono',Menlo,monospace", fontSize: 11 }}>{b.cp_code}</div>
        <div className="k">Onboarded</div><div className="v">{fmtDate(b.created_at)}</div>
        <div className="k">Phone</div><div className="v">{b.phone_number}</div>
        <div className="k">Alt</div><div className="v">{b.alternate_number || '—'}</div>
        <div className="k">Activity</div><div className="v">{b.activity_category || '—'}</div>
        <div className="k">Has sold</div><div className="v">{b.has_sold || '—'}</div>
        <div className="k">Sales attrib.</div><div className="v">{b.sales_attributed || 0}</div>
        <div className="k">Bookings (Apr-May)</div><div className="v">{b.bookings_apr_may || 0}</div>
      </div>

      <h4>Preferred markets</h4>
      <div className="taglist">{mms.length ? mms.map((m, i) => <span key={i} className="tagchip on">{m}</span>) : <span className="muted" style={{ fontSize: 11 }}>No MMs captured</span>}</div>

      <h4>Preferred societies</h4>
      <div className="taglist">{societies.length ? societies.map((m, i) => <span key={i} className="tagchip">{m}</span>) : <span className="muted" style={{ fontSize: 11 }}>—</span>}</div>

      <h4>Visit trend (6m)</h4>
      <div className="bars">
        {monthlyVisits.map((v, i) => <div key={i} className={'bar' + (v === maxMonth ? ' hl' : '')} style={{ height: Math.max(4, (v / maxV) * 50) }} title={String(v)} />)}
      </div>
      <div className="bar-labels">{monthLabels.map((l, i) => <span key={i}>{l}</span>)}</div>

      <h4>Demand mix</h4>
      <div className="kv">
        <div className="k">Total visits</div><div className="v">{visits.length}</div>
        <div className="k">Unique buyers</div><div className="v">{buyers.size}</div>
        <div className="k">Hot leads</div><div className="v" style={{ color: 'var(--bad)' }}>{hotCount}</div>
        <div className="k">Warm leads</div><div className="v" style={{ color: 'var(--warn)' }}>{warmCount}</div>
      </div>

      <h4>Suggest matching inventory</h4>
      {matches.length ? matches.map((p, i) => (
        <div key={i} style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', borderBottom: '1px solid var(--line)', cursor: 'pointer', fontSize: 11.5 }} onClick={onClose}>
          <div><b>{p.society_name}</b><div style={{ color: 'var(--mut)', fontSize: 10.5 }}>{p.configuration} · {p.super_sqft}sf</div></div>
          <div style={{ color: 'var(--accDark)', fontWeight: 700 }}>{p.listing_price}</div>
        </div>
      )) : <div className="muted" style={{ fontSize: 11 }}>No live inventory in preferred MMs.</div>}

      <h4>CP Owner</h4>
      {isAdmin ? (
        <select value={ownerId || ''} disabled={busy} onChange={(e) => onChangeOwner(e.target.value)} style={{ width: '100%', padding: '7px 10px', border: '1px solid var(--line)', borderRadius: 7, fontSize: 12, background: 'var(--panel)' }}>
          <option value="">— Unassigned —</option>
          <optgroup label="KAM (Calling)">{kam.map((u) => <option key={u.id} value={u.id}>{u.name} ({(u.cities || []).join(',')})</option>)}</optgroup>
          <optgroup label="Ground (PMs)">{ground.map((u) => <option key={u.id} value={u.id}>{u.name} ({(u.cities || []).join(',')})</option>)}</optgroup>
        </select>
      ) : (
        <>
          <div className="kv">
            <div className="k">Owner</div><div className="v">{ownerUser ? ownerUser.name : '—'}</div>
            {ownerUser ? <><div className="k">Role</div><div className="v"><span className={'role-pill ' + (TEAM_PILL[ownerUser.team] || '')}>{ownerUser.team}</span></div></> : null}
          </div>
          <div style={{ fontSize: 10.5, color: 'var(--mut)', fontStyle: 'italic' }}>Only admin can change CP owner</div>
        </>
      )}

      <h4>Tier</h4>
      {isAdmin ? (
        <select value={b.tier || 'T4'} disabled={busy} onChange={(e) => onChangeTier(e.target.value)} style={{ width: '100%', padding: '7px 10px', border: '1px solid var(--line)', borderRadius: 7, fontSize: 12, background: 'var(--panel)' }}>
          {TIERS.map((t) => <option key={t} value={t}>Tier {t.slice(1)}{t === 'T1' ? ' (Gold)' : t === 'T2' ? ' (Silver)' : ''}</option>)}
        </select>
      ) : (
        <>
          <div className="kv"><div className="k">Current</div><div className="v"><span className={'tier-badge ' + (b.tier || 'T4')}>{b.tier || 'T4'}</span>{b.tier_rank ? ` · #${b.tier_rank}` : ''}</div></div>
          <div style={{ fontSize: 10.5, color: 'var(--mut)', fontStyle: 'italic' }}>Only admin can change tier</div>
        </>
      )}
    </>
  );
}

/* ===============================================================
   WHATSAPP PICKER
   =============================================================== */
function waOpen(phone, body) {
  const num = (phone || '').replace(/\D/g, '');
  const full = num.length === 10 ? '91' + num : num;
  window.open(`https://wa.me/${full}?text=${encodeURIComponent(body)}`, '_blank', 'noopener');
}
function firstName(n) { return (n || '').split(' ')[0]; }
function waTemplate7DayVisits(b, visits, me) {
  const since = addDays(TODAY, -7);
  const vs = visits.filter((v) => v.cp_code === b.cp_code && v.visit_date && new Date(v.visit_date) >= since);
  let body = `Hi ${firstName(b.name)},\n\nQuick summary of visits you brought us in the last 7 days:\n\n`;
  if (!vs.length) body += "No visits booked yet in the last 7 days. Let's plan a few site visits this week — I can share the live inventory.\n";
  else vs.forEach((v) => {
    const s = visitStatus(v);
    const statusTxt = (s && s !== 'unc') ? ` · status: ${s}` : '';
    body += `• ${fmtDate(v.visit_date)} — ${v.buyer_name || 'Buyer'} at ${v.society_name || ''}${v.unit_address_line1 ? ` (${v.unit_address_line1}${v.unit_address_line2 ? '-' + v.unit_address_line2 : ''})` : ''}${statusTxt}\n`;
  });
  body += `\nTotal: ${vs.length} visit${vs.length === 1 ? '' : 's'}. Can you share buyer status for any of these?\n\n– ${firstName(me.name)}, OpenHouse`;
  return body;
}
function waTemplateOpenVisits(b, visits, me) {
  const open = visits.filter((v) => v.cp_code === b.cp_code && !['booking', 'ats', 'not_interested', 'need_more', 'cancelled'].includes(visitStage(v)));
  let body = `Hi ${firstName(b.name)},\n\nThese buyers you brought are still active in our pipeline:\n\n`;
  if (!open.length) body += 'No active buyers in pipeline at the moment.\n';
  else open.slice(0, 20).forEach((v) => {
    const stat = visitStatus(v); const stage = visitStage(v);
    const tag = stat === 'hot' ? '🔥 Hot' : stat === 'warm' ? '🟡 Warm' : stat === 'cold' ? '❄️ Cold' : stat === 'unc' ? '🕓 Pending status' : '•';
    body += `${tag} ${v.buyer_name || 'Buyer'} — ${v.society_name || ''} — ${STAGE_BY_KEY[stage]?.label || stage}\n`;
  });
  body += `\nTotal: ${open.length} open. Can you help close any this week? Let me know if you want to schedule a revisit or negotiation.\n\n– ${firstName(me.name)}, OpenHouse`;
  return body;
}
function waTemplateInventoryCity(b, cities, properties, me) {
  const cityList = Array.isArray(cities) ? cities : [cities];
  const props = properties.filter((p) => cityList.includes(p.city_name) && p.listing_status !== 'Sold' && p.listing_status !== 'Archived');
  let body = `Hi ${firstName(b.name)},\n\nHere are our live OpenHouse inventor${cityList.length > 1 ? 'ies' : 'y'} in ${cityList.join(' & ')} you can share with your buyers:\n\n`;
  if (!props.length) body += 'No active properties available at the moment.\n';
  else props.slice(0, 30).forEach((p) => {
    body += `🏠 ${p.society_name} — ${p.configuration || ''} — ${p.super_sqft || ''} sqft — ${p.listing_price || ''} — ${p.micro_market || ''}${p.listing_status === 'Coming Soon' ? ' (CS)' : ''}\n`;
  });
  body += `\nReach out for site visits, virtual tour, or pricing details.\n\n– ${firstName(me.name)}, OpenHouse`;
  return body;
}

function WaPicker({ broker: b, visits, properties, me, onClose }) {
  const [screen, setScreen] = useState('list');
  const [tplId, setTplId] = useState(null);
  const templates = [
    { id: 'visits7d', ic: '📅', t: '7-day visit summary', s: 'Recap all visits this CP brought in the last 7 days', build: () => waTemplate7DayVisits(b, visits, me), test: true },
    { id: 'open', ic: '📋', t: 'Open buyers pipeline', s: 'List buyers still in AVFU / Revisit / Negotiation / Booking', build: () => waTemplateOpenVisits(b, visits, me), test: true },
    { id: 'invCity', ic: '🏠', t: `Live inventory · ${b.city || ''}`, s: "All active properties in CP's registered city", build: () => waTemplateInventoryCity(b, [b.city], properties, me), test: !!b.city },
    { id: 'invNcr', ic: '🏘', t: 'Inventory · Noida + Ghaziabad', s: 'Combined NCR inventory for CPs working both markets', build: () => waTemplateInventoryCity(b, ['Noida', 'Ghaziabad'], properties, me), test: b.city === 'Noida' || b.city === 'Ghaziabad' },
  ].filter((t) => t.test);

  const tpl = templates.find((t) => t.id === tplId);
  const [text, setText] = useState('');
  function pick(id) {
    if (id === 'direct') { waOpen(b.phone_number, ''); return; }
    const t = templates.find((x) => x.id === id);
    setTplId(id); setText(t.build()); setScreen('preview');
  }

  return (
    <div className="modal-bg" style={{ zIndex: 220 }} onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal" style={{ width: 520, maxWidth: '94vw' }}>
        <div className="modal-head"><h2>WhatsApp · {b.name}</h2><button className="x-btn" onClick={onClose}>✕</button></div>
        <div className="modal-body">
          {screen === 'list' ? (
            <>
              <div style={{ fontSize: 12, color: 'var(--mut)', marginBottom: 12 }}>Pick a draft. You'll preview it and then send via WhatsApp.</div>
              <div className="wa-list">
                <button className="wa-opt" onClick={() => pick('direct')}>
                  <div className="wa-ic">💬</div>
                  <div className="wa-meta"><div className="wa-t">Open WhatsApp blank</div><div className="wa-s">No template — just start a conversation</div></div>
                  <div className="wa-arrow">→</div>
                </button>
                {templates.map((t) => (
                  <button key={t.id} className="wa-opt" onClick={() => pick(t.id)}>
                    <div className="wa-ic">{t.ic}</div>
                    <div className="wa-meta"><div className="wa-t">{t.t}</div><div className="wa-s">{t.s}</div></div>
                    <div className="wa-arrow">→</div>
                  </button>
                ))}
              </div>
              <div style={{ marginTop: 12, fontSize: 11, color: 'var(--mut)', fontStyle: 'italic' }}>Phone: {b.phone_number} · {b.company_name || ''}</div>
            </>
          ) : (
            <>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                <button className="wa-back" onClick={() => setScreen('list')}>← Pick another</button>
                <div style={{ fontSize: 12, color: 'var(--mut)' }}>{tpl?.t}</div>
              </div>
              <div style={{ fontSize: 11.5, color: 'var(--mut)', marginBottom: 8 }}>You can edit the message before sending:</div>
              <textarea value={text} onChange={(e) => setText(e.target.value)} style={{ width: '100%', border: '1px solid var(--line)', borderRadius: 9, padding: '10px 12px', fontSize: 13, background: 'var(--panel)', outline: 'none', resize: 'vertical', minHeight: 200, maxHeight: '50vh', fontFamily: 'inherit', lineHeight: 1.5 }} />
              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 12 }}>
                <button className="btn" onClick={() => { navigator.clipboard?.writeText(text); toast('Message copied to clipboard', 'good'); }}>Copy to clipboard</button>
                <button className="btn primary" onClick={() => { waOpen(b.phone_number, text); onClose(); }}>Send via WhatsApp →</button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/* ===============================================================
   NUDGE COMPOSER
   =============================================================== */
const NUDGE_TPLS = [
  ['Serious buyer — push revisit', 'Spoke to broker, buyer seems serious. Please push for revisit.'],
  ['Owner asked for update', 'Owner asked for an update — pending from your end.'],
  ['Buyer waiting for pricing', 'Buyer waiting for price details. Please share within today.'],
  ['Pre-weekend push', 'Quick follow-up needed before weekend.'],
];
function NudgeComposer({ visit, broker, ubs, ownerId, me, busy, onSend, onClose }) {
  const [text, setText] = useState('');
  const owner = ownerId ? ubs[ownerId] : null;
  if (!visit) return null;
  const bad = !owner || ownerId === me.id;
  return (
    <div className="modal-bg" style={{ zIndex: 220 }} onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal" style={{ width: 440, maxWidth: '94vw' }}>
        <div className="modal-head"><h2>Nudge CP owner</h2><button className="x-btn" onClick={onClose}>✕</button></div>
        <div className="modal-body">
          {bad ? (
            <div className="nudge-ctx">{!owner ? 'No CP owner assigned.' : 'You own this CP — take the followup directly.'}</div>
          ) : (
            <>
              <div className="nudge-ctx">
                📌 Nudging <b>{owner.name}</b> ({owner.team}) about <b>{visit.buyer_name || 'buyer'}</b>'s visit to <b>{visit.society_name || ''}</b> on {fmtDate(visit.visit_date)}.
                {' '}Buyer status: <b>{visitStatus(visit)}</b>{broker.tier ? ` · CP: ${broker.name} (${broker.tier})` : ''}.
              </div>
              <label style={{ fontSize: 10, color: 'var(--mut)', textTransform: 'uppercase', letterSpacing: '.4px', fontWeight: 700 }}>Message / context</label>
              <textarea value={text} onChange={(e) => setText(e.target.value)} placeholder="Why is this urgent? What context should the owner know?" />
              <div className="nudge-templates">
                {NUDGE_TPLS.map(([label, full]) => (
                  <button key={label} className="ntpl" onClick={() => setText(full)}>{label}</button>
                ))}
              </div>
            </>
          )}
        </div>
        <div className="modal-foot">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={busy || bad} onClick={() => onSend(text.trim())}>Send nudge</button>
        </div>
      </div>
    </div>
  );
}
