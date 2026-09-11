// PipelineQueue — shared tabular queue for the Negotiations and Revisits tabs.
// Renders a Visits-style table (desktop) / card list (mobile) of pipeline leads with
// the relevant meeting date prominent, a day-of ✅/❌ confirm on the scheduled-meeting
// row, and an inline editor that saves through the existing /api/followups (saveFollowup).
//
// The ONLY per-tab differences live in CFG[mode]: which stages form the funnel's
// "scheduled meeting" stage, which date field/label, whether the confirm is stored
// (negotiation_happened — negotiations only), and the next-step options per stage.
// Everything else (table, sort, editor, save dispatch, date requirements) is shared.
// Scoping + tab filters + ChipBar + the date-range filter stay in the thin wrappers
// (NegotiationsView / RevisitsView) — this component only takes the final `rows`.
import { Fragment, useMemo, useState } from 'react';
import { fmtDate, fmtDay, fmtDateTime, ymd, TODAY } from '../lib/format.js';
import {
  visitStage, visitStatus, STAGE_BY_KEY, STATUSES, nextFuFor,
} from '../lib/visits.js';
import { usersBySlug } from '../lib/brokers.js';
import {
  TEAM_PILL, fmtPrice, priceForVisit, nextFuClass, lastFollowupTakenForVisit, buildFuByVisit,
} from '../lib/legacy.js';
import { toast } from '../lib/toast.js';
import { saveFollowup as apiSaveFollowup, addManagerRemark } from '../api.js';
import useIsMobile from '../lib/useIsMobile.js';
import RevisitTag from './RevisitTag.jsx';

const CLOSING = new Set(['booking', 'ats', 'not_interested', 'future_prospect']);
const plusDays = (n) => { const d = new Date(TODAY); d.setDate(d.getDate() + n); return ymd(d); };
const dtLocal = (s) => (s ? String(s).slice(0, 16) : '');     // ISO ts -> datetime-local value
const datePart = (s) => (s ? String(s).slice(0, 10) : '');

// buyer_status (VALID_BUYER_STATUSES) derived from the chosen next stage so the team
// doesn't re-rate the buyer; positive/in-progress stages keep a live temperature.
const statusForStage = (stage, current) =>
  stage === 'not_interested' ? 'dead'
    : stage === 'future_prospect' ? 'future_prospect'
      : (['hot', 'warm', 'cold'].includes(current) ? current : 'hot');

// Per-mode config. scheduledStage = the stage that shows the Yes/No confirm + means
// "the meeting is scheduled". nextSteps(sg, happened) = pills for the inline editor.
const CFG = {
  negotiation: {
    // PRE-meeting confirm: on/before the meeting day the team confirms whether the
    // meeting is going to happen. Yes → confirmed, the lead STAYS in negotiation (the
    // outcome is recorded later via the normal follow-up). No → reschedule / change stage.
    noun: 'meeting', icon: '🤝', dateField: '_negotiation_date', dateCol: 'Negotiation date',
    scheduledStage: 'negotiation', sendsHappened: true, savedToast: 'Negotiation updated',
    preMeeting: true,
    confirmQuestion: 'Will this meeting happen today (is it confirmed)?',
    yesLabel: '✅ Yes — confirmed', noLabel: "❌ No — won't happen", confirmNote: 'Meeting confirmed',
    nextSteps: (sg, happened) =>
      sg === 'negotiation'
        ? (happened === false ? ['negotiation', 'future_prospect', 'not_interested'] : [])  // Yes = confirm (no pills)
        : sg === 'after_negotiation_fu' ? ['after_negotiation_fu', 'booking', 'ats', 'future_prospect', 'not_interested']
          : sg === 'booking' ? ['booking', 'ats', 'future_prospect', 'not_interested'] : [],
  },
  revisit: {
    // Post-meeting outcome (unchanged): "did the revisit happen?" Yes → advance, No → reschedule.
    noun: 'revisit', icon: '↻', dateField: '_revisit_date', dateCol: 'Revisit date',
    scheduledStage: 'revisit_scheduled', sendsHappened: false, savedToast: 'Revisit updated',
    preMeeting: false,
    confirmQuestion: 'Did the revisit happen?', yesLabel: '✅ Yes', noLabel: '❌ No',
    nextSteps: (sg, happened) =>
      sg === 'revisit_scheduled'
        ? (happened === true ? ['negotiation', 'booking', 'ats', 'future_prospect', 'not_interested']
          : happened === false ? ['revisit_scheduled', 'future_prospect', 'not_interested'] : [])
        : sg === 'after_revisit_fu' ? ['negotiation', 'booking', 'ats', 'future_prospect', 'not_interested'] : [],
  },
};
const pillLabel = (k, cfg) => (k === cfg.scheduledStage ? 'Reschedule' : (STAGE_BY_KEY[k]?.label || k));

// The merged pipeline tab holds BOTH funnels, so the confirm/advance behaviour is chosen
// per ROW from its stage rather than once from the tab. mode 'revisit'/'negotiation' keep
// their single-config behaviour byte-identically.
const NEGO_STAGES = ['negotiation', 'after_negotiation_fu', 'booking'];

export default function PipelineQueue({ seed, rows, mode, onOpenBroker, onSaved, revIndex }) {
  const merged = mode === 'pipeline';
  const cfgFor = (v) => (merged ? (NEGO_STAGES.includes(visitStage(v)) ? CFG.negotiation : CFG.revisit) : CFG[mode]);
  const cfg = merged ? CFG.revisit : CFG[mode];          // defaults: column labels + empty state
  const dateOf = (v) => v[cfgFor(v).dateField] || '';
  // seed maps for the always-visible remark history (no click needed)
  const fuHistory = seed.followup_history || {};
  const mgrRemarks = seed.manager_remarks || {};
  const txnCps = useMemo(() => new Set(seed.transactional_cps || []), [seed]);
  const meUser = seed.current_user || {};
  const canManagerRemark = meUser.team === 'TL' || meUser.team === 'Admin' || meUser.role === 'admin';
  const [mgrDraft, setMgrDraft] = useState({});
  const setMgr = (id, patch) => setMgrDraft((m) => ({ ...m, [id]: { ...(m[id] || {}), ...patch } }));
  const isMobile = useIsMobile();
  const properties = seed.properties || [];
  const cpOwner = seed.cp_owner || {};
  const ubs = useMemo(() => usersBySlug(seed), [seed]);
  const brokersByCode = useMemo(() => {
    const m = {}; (seed.brokers || []).forEach((b) => { m[b.cp_code] = b; }); return m;
  }, [seed]);
  const fuByVisit = useMemo(() => buildFuByVisit(seed.followups || []), [seed]);

  const [sortDir, setSortDir] = useState('asc');   // by cfg.dateField — soonest first
  const [expanded, setExpanded] = useState(() => new Set());
  const [drafts, setDrafts] = useState({});
  const [busy, setBusy] = useState(false);

  const sorted = useMemo(() => rows.slice().sort((a, b) => {
    const da = datePart(dateOf(a)) || '9999-99-99';
    const db = datePart(dateOf(b)) || '9999-99-99';
    const cmp = da < db ? -1 : da > db ? 1 : 0;
    return sortDir === 'asc' ? cmp : -cmp;
  }), [rows, mode, sortDir]);

  const setDraft = (vid, patch) => setDrafts((p) => ({ ...p, [vid]: { ...(p[vid] || {}), ...patch } }));
  const ownerFor = (v) => ubs[cpOwner[v.cp_code]] || null;
  const tierFor = (v) => brokersByCode[v.cp_code]?.tier || 'T4';
  const cpName = (v) => brokersByCode[v.cp_code]?.name || v.broker_name || '';

  const seedDraft = (v) => {
    if (drafts[v.id]) return;
    const sg = visitStage(v);
    if (sg === cfgFor(v).scheduledStage) setDraft(v.id, { happened: null, stage: '' });
    else if (sg === 'booking') setDraft(v.id, { stage: 'booking', booking_received_date: v.booking_received_date || '' });
    else setDraft(v.id, { stage: '' });
  };
  const toggleEditor = (v) => setExpanded((p) => {
    const n = new Set(p); const k = String(v.id);
    if (n.has(k)) { n.delete(k); return n; }
    n.add(k); seedDraft(v); return n;
  });
  const quickConfirm = (v, val) => {            // inline ✅/❌ on the scheduled row → open editor pre-set
    setExpanded((p) => new Set(p).add(String(v.id)));
    setDraft(v.id, { happened: val, stage: '', negotiation_date: '', revisit_date: '', booking_received_date: '' });
  };

  async function submit(v, payload) {
    setBusy(true);
    try {
      await apiSaveFollowup(payload);
      setDrafts((p) => { const n = { ...p }; delete n[v.id]; return n; });
      setExpanded((p) => { const n = new Set(p); n.delete(String(v.id)); return n; });
      toast(cfgFor(v).savedToast, 'good');
      await onSaved?.();
    } catch (e) { toast('Save failed: ' + String(e.message || e).slice(0, 140), 'bad'); }
    finally { setBusy(false); }
  }

  async function save(v) {
    const d = drafts[v.id] || {};
    const sg = visitStage(v);
    const c = cfgFor(v);
    const onScheduled = sg === c.scheduledStage;
    if (onScheduled && d.happened == null) {
      toast(`Confirm whether the ${c.noun} is happening`, 'bad'); return;
    }
    // Pre-meeting CONFIRM (negotiation): Yes → meeting confirmed, lead STAYS in its stage,
    // reusing its existing meeting date; note optional; no advancement (outcome recorded later).
    if (onScheduled && c.preMeeting && d.happened === true) {
      const existing = v[c.dateField] || '';
      const payload = {
        visit_code: String(v.id),
        buyer_status: statusForStage(c.scheduledStage, v.lead_status),
        stage: c.scheduledStage,
        note: (d.note && d.note.trim()) || c.confirmNote,
        next_followup_date: null,
        revisit_date: c.scheduledStage === 'revisit_scheduled' ? existing : null,
        negotiation_date: c.scheduledStage === 'negotiation' ? existing : null,
      };
      if (c.sendsHappened) payload.negotiation_happened = true;
      return submit(v, payload);
    }
    const stage = d.stage || (sg === 'booking' ? 'booking' : '');
    if (!stage) { toast('Pick the next step', 'bad'); return; }
    // Date requirements by TARGET stage (mirrors the backend rules + the booking-date decision).
    let negotiation_date = null; let revisit_date = null; let booking_received_date = null;
    if (stage === 'negotiation') {
      if (!d.negotiation_date) { toast('Set the negotiation meeting date & time', 'bad'); return; }
      negotiation_date = d.negotiation_date;
    }
    if (stage === 'revisit_scheduled') {
      if (!d.revisit_date) { toast('Set the revisit date & time', 'bad'); return; }
      revisit_date = d.revisit_date;
    }
    if (stage === 'booking') {
      const br = d.booking_received_date || v.booking_received_date || '';
      if (!br) { toast('Booking needs the booking-received date', 'bad'); return; }
      booking_received_date = br;
    }
    if (!d.note || !d.note.trim()) { toast('Notes are mandatory — what was discussed / next action', 'bad'); return; }

    const payload = {
      visit_code: String(v.id),
      buyer_status: statusForStage(stage, v.lead_status),
      stage,
      note: d.note.trim(),
      next_followup_date: CLOSING.has(stage) ? null : (d.next_date || plusDays(2)),
      revisit_date,
      negotiation_date,
      booking_received_date,
    };
    // Negotiations persist the confirm flag (revisits are migration-free — outcome via stage).
    if (c.sendsHappened) payload.negotiation_happened = onScheduled ? d.happened : (v.negotiation_happened ?? true);
    return submit(v, payload);
  }

  // ---- shared inline editor (used by the desktop expanded row + mobile card) ----
  const Editor = ({ v }) => {
    const sg = visitStage(v);
    const d = drafts[v.id] || {};
    const c = cfgFor(v);
    const onScheduled = sg === c.scheduledStage;
    const isPreConfirm = onScheduled && c.preMeeting && d.happened === true;   // "Yes — confirmed"
    const showSteps = onScheduled ? (d.happened != null && !isPreConfirm) : true;
    const noteOptional = isPreConfirm;
    const opts = c.nextSteps(sg, d.happened);
    return (
      <div className="fu-form" style={{ marginTop: 10, borderTop: '1px solid var(--line)', paddingTop: 10 }}>
        {onScheduled && (
          <div className="fu-grp">
            <label>{c.confirmQuestion} <span style={{ color: 'var(--bad)' }}>*</span></label>
            <div className="fu-pills">
              <button type="button" className={'fu-pill ' + (d.happened === true ? 'on' : '')}
                      onClick={() => setDraft(v.id, { happened: true, stage: '', negotiation_date: '', revisit_date: '' })}>{c.yesLabel}</button>
              <button type="button" className={'fu-pill ' + (d.happened === false ? 'on' : '')}
                      onClick={() => setDraft(v.id, { happened: false, stage: '', booking_received_date: '' })}>{c.noLabel}</button>
            </div>
          </div>
        )}
        {isPreConfirm && (
          <div className="fu-grp" style={{ background: 'var(--goodBg, #ECFDF5)', border: '1px solid #6EE7B7', borderRadius: 8, padding: '10px 12px' }}>
            <div style={{ fontSize: 12.5, color: 'var(--good, #16A34A)', fontWeight: 600 }}>
              ✓ Confirmed — stays in {STAGE_BY_KEY[c.scheduledStage]?.label || c.scheduledStage}. Record the outcome later, after the {c.noun}.
            </div>
          </div>
        )}
        {showSteps && opts.length > 0 && (
          <div className="fu-grp">
            <label>{onScheduled && d.happened === false ? 'What next?' : 'Next step'} <span style={{ color: 'var(--bad)' }}>*</span></label>
            <div className="fu-pills">
              {opts.map((s) => (
                <button key={s} type="button" className={'fu-pill ' + (d.stage === s ? 'on' : '')}
                        onClick={() => setDraft(v.id, { stage: s })}>{pillLabel(s, cfg)}</button>
              ))}
            </div>
          </div>
        )}
        {/* Target-stage date inputs (required) */}
        {d.stage === 'negotiation' && (
          <div className="fu-grp" style={{ background: 'var(--blueBg)', border: '1px solid #93C5FD', borderRadius: 8, padding: '10px 12px' }}>
            <label style={{ color: '#1E40AF' }}>Negotiation meeting date &amp; time <span style={{ color: 'var(--bad)' }}>*</span></label>
            <input type="datetime-local" value={dtLocal(d.negotiation_date)} onChange={(e) => setDraft(v.id, { negotiation_date: e.target.value })}
                   style={{ padding: '7px 10px', border: '1px solid var(--line)', borderRadius: 7, fontSize: 13, width: 240, maxWidth: '100%' }} />
          </div>
        )}
        {d.stage === 'revisit_scheduled' && (
          <div className="fu-grp" style={{ background: 'var(--blueBg)', border: '1px solid #93C5FD', borderRadius: 8, padding: '10px 12px' }}>
            <label style={{ color: '#1E40AF' }}>Revisit date &amp; time <span style={{ color: 'var(--bad)' }}>*</span></label>
            <input type="datetime-local" value={dtLocal(d.revisit_date)} onChange={(e) => setDraft(v.id, { revisit_date: e.target.value })}
                   style={{ padding: '7px 10px', border: '1px solid var(--line)', borderRadius: 7, fontSize: 13, width: 240, maxWidth: '100%' }} />
          </div>
        )}
        {d.stage === 'booking' && (
          <div className="fu-grp" style={{ background: 'var(--blueBg)', border: '1px solid #93C5FD', borderRadius: 8, padding: '10px 12px' }}>
            <label style={{ color: '#1E40AF' }}>Booking received date <span style={{ color: 'var(--bad)' }}>*</span></label>
            <input type="date" value={d.booking_received_date || ''} onChange={(e) => setDraft(v.id, { booking_received_date: e.target.value })}
                   style={{ padding: '7px 10px', border: '1px solid var(--line)', borderRadius: 7, fontSize: 13, width: 200 }} />
          </div>
        )}
        <div className="fu-grp">
          <label>Notes {noteOptional ? <span style={{ color: 'var(--mut)', fontWeight: 400 }}>(optional)</span> : <span style={{ color: 'var(--bad)' }}>*</span>}</label>
          <textarea placeholder={noteOptional ? 'Optional — any note about the confirmation…' : 'Required — what was discussed, the outcome, next action…'} value={d.note || ''}
                    onChange={(e) => setDraft(v.id, { note: e.target.value })} />
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          <button className="btn primary sm" disabled={busy} onClick={() => save(v)}>Save</button>
          <button className="btn sm" disabled={busy} onClick={() => toggleEditor(v)}>Cancel</button>
        </div>
      </div>
    );
  };

  // ---- the day-of confirm cell (scheduled-meeting row only) ----
  const ConfirmCell = ({ v }) => {
    const sg = visitStage(v);
    const c = cfgFor(v);
    if (sg !== c.scheduledStage) {
      if (c.sendsHappened && v.negotiation_happened === true) return <span className="muted" style={{ fontSize: 11 }}>✅ confirmed</span>;
      return <span className="muted">—</span>;
    }
    const dk = datePart(v[c.dateField]);
    const today = ymd(TODAY);
    const due = dk && dk <= today;                 // due today or overdue → emphasize
    const confirmed = c.preMeeting && v.negotiation_happened === true;   // already confirmed
    return (
      <div className="fu-pills" style={{ gap: 4, alignItems: 'center' }}>
        {confirmed && <span title="Confirmed" style={{ fontSize: 11, color: 'var(--good,#16A34A)', fontWeight: 700 }}>✓</span>}
        <button type="button" title={c.preMeeting ? 'Confirmed — will happen' : `${c.noun} happened`} className="fu-pill" style={due ? { borderColor: 'var(--good,#16A34A)', fontWeight: 700 } : undefined}
                onClick={(e) => { e.stopPropagation(); quickConfirm(v, true); }}>✅</button>
        <button type="button" title={c.preMeeting ? "Won't happen / not confirmed" : `${c.noun} didn't happen`} className="fu-pill" style={due ? { borderColor: 'var(--bad)', fontWeight: 700 } : undefined}
                onClick={(e) => { e.stopPropagation(); quickConfirm(v, false); }}>❌</button>
      </div>
    );
  };

  const DateCell = ({ v }) => {
    const c = cfgFor(v);
    const raw = v[c.dateField];
    const sg = visitStage(v);
    const overdue = sg === c.scheduledStage && datePart(raw) && datePart(raw) < ymd(TODAY);
    const dueToday = datePart(raw) === ymd(TODAY);
    return (
      <span style={{ fontWeight: 700, color: overdue ? 'var(--bad)' : dueToday ? 'var(--accDark)' : 'var(--ink)' }}>
        {raw ? fmtDateTime(raw) : '—'}{overdue ? <span style={{ fontSize: 10.5, color: 'var(--bad)' }}> · passed</span> : null}
      </span>
    );
  };

  // CP transaction status. A CP is TRANSACTIONAL when it has actually closed — the union
  // of the CRM's own Booking/ATS pipeline and the demand-dashboard booking_details selling
  // CP (see seed_snapshot + main._demand_txn_cps). Shown only on the merged pipeline tab.
  // POSITIVE-ONLY badge: only a CP that has actually closed is marked. Most CPs have
  // not (18 of 140 pipeline leads today), so labelling the rest "NON-TXN" was pure
  // noise on the card — an unbadged CP simply means no booking closed yet.
  const CpTxnBadge = ({ cp }) => {
    if (!cp || !txnCps.has(cp)) return null;
    return (
      <span title="Transactional — this CP has closed a booking"
            style={{ marginLeft: 5, fontSize: 9.5, fontWeight: 700, padding: '1px 5px', borderRadius: 6,
                     border: '1px solid var(--good,#16A34A)', color: 'var(--good,#16A34A)',
                     background: 'rgba(22,163,74,.08)', whiteSpace: 'nowrap' }}>
        ₹ TXN
      </span>
    );
  };

  // The PM remark history + the manager remark box, rendered as a sub-row so the team can
  // read the running commentary WITHOUT opening the lead.
  const RemarksRow = ({ v, cols }) => {
    const hist = fuHistory[String(v.id)] || [];
    const mgr = mgrRemarks[String(v.id)] || [];
    const d = mgrDraft[v.id] || {};
    const saveMgr = async () => {
      if (d.called == null) { toast('Did the manager call? Pick Yes or No', 'bad'); return; }
      if (!d.called && !(d.note || '').trim()) { toast('Add a note when the manager did not call', 'bad'); return; }
      setMgr(v.id, { saving: true });
      try {
        await addManagerRemark({ visit_code: v.id, called: !!d.called, note: (d.note || '').trim() });
        toast('Manager remark saved', 'good');
        setMgr(v.id, { called: null, note: '', saving: false });
        await onSaved?.();
      } catch (e) {
        toast(String(e?.message || e).slice(0, 140), 'bad');
        setMgr(v.id, { saving: false });
      }
    };
    return (
      <tr className="pq-remarks">
        <td colSpan={cols} style={{ background: 'var(--bg2,#FAFAFB)', borderTop: 'none', padding: '6px 10px 9px' }}>
          <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', alignItems: 'flex-start',
                        position: 'sticky', left: 0, maxWidth: 'calc(100vw - 150px)' }}>
            <div style={{ flex: '1 1 420px', minWidth: 280 }}>
              <div style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--mut)', letterSpacing: .3 }}>PM REMARKS ({hist.length})</div>
              {hist.length === 0 ? (
                <div style={{ fontSize: 12, color: 'var(--mut)' }}>No remarks yet</div>
              ) : hist.slice(-4).map((h, i) => (
                <div key={i} style={{ fontSize: 12, marginTop: 2, lineHeight: 1.35 }}>
                  <span style={{ color: 'var(--mut)' }}>{fmtDate(h.at)} · <b>{h.by || '—'}</b> — </span>{h.note}
                </div>
              ))}
              {hist.length > 4 && <div style={{ fontSize: 11, color: 'var(--mut)', marginTop: 2 }}>+{hist.length - 4} earlier</div>}
            </div>
            <div style={{ flex: '1 1 340px', minWidth: 260 }}>
              <div style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--mut)', letterSpacing: .3 }}>MANAGER REMARKS ({mgr.length})</div>
              {mgr.map((m, i) => (
                <div key={i} style={{ fontSize: 12, marginTop: 2, lineHeight: 1.35 }}>
                  <span style={{ color: 'var(--mut)' }}>{fmtDate(m.at)} · <b>{m.by || '—'}</b> · </span>
                  <b style={{ color: m.called ? 'var(--good,#16A34A)' : 'var(--bad)' }}>{m.called ? 'Called' : 'Not called'}</b>
                  {m.note ? <span> — {m.note}</span> : null}
                </div>
              ))}
              {canManagerRemark && (
                <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 5, flexWrap: 'wrap' }}>
                  <button type="button" className="fu-pill" aria-pressed={d.called === true}
                          style={d.called === true ? { borderColor: 'var(--good,#16A34A)', fontWeight: 700 } : undefined}
                          onClick={() => setMgr(v.id, { called: true })}>✅ Called</button>
                  <button type="button" className="fu-pill" aria-pressed={d.called === false}
                          style={d.called === false ? { borderColor: 'var(--bad)', fontWeight: 700 } : undefined}
                          onClick={() => setMgr(v.id, { called: false })}>❌ Not called</button>
                  <input value={d.note || ''} onChange={(e) => setMgr(v.id, { note: e.target.value })}
                         placeholder="Manager remark…" style={{ flex: '1 1 150px', minWidth: 120, padding: '4px 7px',
                         border: '1px solid var(--line)', borderRadius: 6, fontSize: 12 }} />
                  <button type="button" className="btn sm primary" disabled={!!d.saving} onClick={saveMgr}>
                    {d.saving ? 'Saving…' : 'Save'}
                  </button>
                </div>
              )}
            </div>
          </div>
        </td>
      </tr>
    );
  };

  const COLS = ['Visit', merged ? 'Revisit / Nego date' : cfg.dateCol, 'City', 'RM', 'Society / Unit', 'Buyer', 'CP · Tier', 'CP Owner', 'Status', 'Stage', 'Next FU', 'Last FU', 'Price', 'Confirm', ''];

  if (rows.length === 0) {
    return <div className="empty"><div className="emoji">{cfg.icon}</div><div className="t">No {merged ? 'pipeline leads' : (cfg.noun === 'meeting' ? 'negotiations' : 'revisits')} match these filters</div></div>;
  }

  // ---------- desktop table ----------
  if (!isMobile) {
    return (
      <div className="tbl-wrap">
        <table className="t">
          <thead>
            <tr>
              {COLS.map((c, i) => (
                <th key={c || i} className={i === 1 ? 'sort' : ''} onClick={i === 1 ? () => setSortDir((s) => (s === 'asc' ? 'desc' : 'asc')) : undefined}>
                  {c}{i === 1 ? <span className="sI"> {sortDir === 'asc' ? '↑' : '↓'}</span> : null}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sorted.map((v) => {
              const sg = visitStage(v); const sgDef = STAGE_BY_KEY[sg];
              const st = visitStatus(v); const stLabel = STATUSES.find((s) => s.k === st)?.label || st;
              const tier = tierFor(v); const owner = ownerFor(v);
              const price = priceForVisit(v, properties);
              const nfc = nextFuClass(nextFuFor(v));
              const lfd = lastFollowupTakenForVisit(v, fuByVisit);
              const sub = [v.unit_address_line1, v.unit_address_line2].filter(Boolean).join('-') || (v.listing_status || '');
              const open = expanded.has(String(v.id));
              return (
                <Fragment key={v.id}>
                  <tr onClick={() => toggleEditor(v)} style={{ cursor: 'pointer' }} className={open ? 'selected' : ''}>
                    <td><span className="id-pill">VST{String(v.id).padStart(4, '0')}</span></td>
                    <td><DateCell v={v} /></td>
                    <td><span className="city-pill">{v.city || ''}</span></td>
                    <td>{v.sales_manager || '—'}</td>
                    <td><b>{v.society_name || '—'}</b><div style={{ fontSize: 10.5, color: 'var(--mut)', marginTop: 1 }}>{sub}</div></td>
                    <td>{v.buyer_name || '—'} {revIndex?.get(v.id)?.isRevisit && <RevisitTag info={revIndex.get(v.id)} />}<div style={{ fontSize: 10.5, color: 'var(--mut)', marginTop: 1 }}>{v.buyer_contact || ''}</div></td>
                    <td>
                      <button type="button" onClick={(e) => { e.stopPropagation(); onOpenBroker?.(v.cp_code, v.id); }} title="Open channel partner"
                              style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'var(--acc,#2563EB)', textAlign: 'left' }}>
                        {cpName(v) || '—'}
                      </button> <span className={'tier-badge ' + tier}>{tier}</span>
                      {merged && <CpTxnBadge cp={v.cp_code} />}
                      <div style={{ fontSize: 10.5, color: 'var(--mut)', marginTop: 1 }}>{v.company_name || ''}</div>
                    </td>
                    <td>{owner ? (<><div style={{ fontSize: 11.5 }}><b>{(owner.name || '').split(' ')[0]}</b></div><span className={'role-pill ' + (TEAM_PILL[owner.team] || '')}>{owner.team}</span></>) : <span className="muted">—</span>}</td>
                    <td><span className={'stpill ' + st}><span className="d" />{stLabel}</span></td>
                    <td><span className={'sgpill ' + sg}><span className="d" />{sgDef ? sgDef.label.replace(' Visit', '') : sg}</span></td>
                    <td><span className={'fu-chip ' + nfc.cls}><span className="d" />{nfc.label}</span></td>
                    <td className={'last-fu-cell ' + (lfd ? '' : 'none')}>{lfd ? (<><div className="lf-date">{fmtDate(lfd)}</div><div className="lf-ago">{fmtDay(lfd)}</div></>) : 'Not taken'}</td>
                    <td style={{ fontWeight: 600, color: 'var(--accDark)' }}>{price ? fmtPrice(price) : '—'}</td>
                    <td onClick={(e) => e.stopPropagation()}><ConfirmCell v={v} /></td>
                    <td><button type="button" className="btn sm" onClick={(e) => { e.stopPropagation(); toggleEditor(v); }}>{open ? 'Close' : 'Update'}</button></td>
                  </tr>
                  {merged && <RemarksRow v={v} cols={COLS.length} />}
                  {open && (
                    <tr key={v.id + '-ed'}><td colSpan={COLS.length}><Editor v={v} /></td></tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    );
  }

  // ---------- mobile cards ----------
  return (
    <div className="m-card-list">
      {sorted.map((v) => {
        const sg = visitStage(v); const sgDef = STAGE_BY_KEY[sg];
        const open = expanded.has(String(v.id));
        const c = cfgFor(v);
        const overdue = sg === c.scheduledStage && datePart(v[c.dateField]) && datePart(v[c.dateField]) < ymd(TODAY);
        return (
          <div key={v.id} className="m-card">
            <div className="mc-top">
              <div className="mc-title">{v.society_name || '—'}<span className="sub">{[v.unit_address_line1, v.unit_address_line2].filter(Boolean).join('-')} · {v.city || ''}</span></div>
              <div className="mc-right" style={{ color: overdue ? 'var(--bad)' : 'var(--accDark)' }}>
                <div style={{ fontSize: 11 }}>{c.dateCol}</div>
                <div><b>{v[c.dateField] ? fmtDateTime(v[c.dateField]) : '—'}</b></div>
              </div>
            </div>
            <div className="mc-meta">
              <span>👤 <b>{v.buyer_name || '—'}</b></span>
              {revIndex?.get(v.id)?.isRevisit ? <RevisitTag info={revIndex.get(v.id)} /> : null}
              <span className={'sgpill ' + sg}><span className="d" />{sgDef ? sgDef.label.replace(' Visit', '') : sg}</span>
            </div>
            <div className="mc-meta">
              <button type="button" onClick={() => onOpenBroker?.(v.cp_code, v.id)} style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'var(--acc,#2563EB)' }}>🤝 {cpName(v) || '—'}</button>
              <span className={'tier-badge ' + tierFor(v)}>{tierFor(v)}</span>
              <span style={{ color: 'var(--mut)' }}>RM: {v.sales_manager || '—'}</span>
            </div>
            <div className="mc-foot">
              {sg === c.scheduledStage ? <span><ConfirmCell v={v} /></span> : <span />}
              <button type="button" className="btn sm" onClick={() => toggleEditor(v)}>{open ? 'Close' : 'Update'}</button>
            </div>
            {open && <Editor v={v} />}
          </div>
        );
      })}
    </div>
  );
}
