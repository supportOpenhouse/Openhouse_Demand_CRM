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
import { saveFollowup as apiSaveFollowup } from '../api.js';
import useIsMobile from '../lib/useIsMobile.js';

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

export default function PipelineQueue({ seed, rows, mode, onOpenBroker, onSaved }) {
  const cfg = CFG[mode];
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
    const da = datePart(a[cfg.dateField]) || '9999-99-99';
    const db = datePart(b[cfg.dateField]) || '9999-99-99';
    const cmp = da < db ? -1 : da > db ? 1 : 0;
    return sortDir === 'asc' ? cmp : -cmp;
  }), [rows, cfg.dateField, sortDir]);

  const setDraft = (vid, patch) => setDrafts((p) => ({ ...p, [vid]: { ...(p[vid] || {}), ...patch } }));
  const ownerFor = (v) => ubs[cpOwner[v.cp_code]] || null;
  const tierFor = (v) => brokersByCode[v.cp_code]?.tier || 'T4';
  const cpName = (v) => brokersByCode[v.cp_code]?.name || v.broker_name || '';

  const seedDraft = (v) => {
    if (drafts[v.id]) return;
    const sg = visitStage(v);
    if (sg === cfg.scheduledStage) setDraft(v.id, { happened: null, stage: '' });
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
      toast(cfg.savedToast, 'good');
      await onSaved?.();
    } catch (e) { toast('Save failed: ' + String(e.message || e).slice(0, 140), 'bad'); }
    finally { setBusy(false); }
  }

  async function save(v) {
    const d = drafts[v.id] || {};
    const sg = visitStage(v);
    const onScheduled = sg === cfg.scheduledStage;
    if (onScheduled && d.happened == null) {
      toast(`Confirm whether the ${cfg.noun} is happening`, 'bad'); return;
    }
    // Pre-meeting CONFIRM (negotiation): Yes → meeting confirmed, lead STAYS in its stage,
    // reusing its existing meeting date; note optional; no advancement (outcome recorded later).
    if (onScheduled && cfg.preMeeting && d.happened === true) {
      const existing = v[cfg.dateField] || '';
      const payload = {
        visit_code: String(v.id),
        buyer_status: statusForStage(cfg.scheduledStage, v.lead_status),
        stage: cfg.scheduledStage,
        note: (d.note && d.note.trim()) || cfg.confirmNote,
        next_followup_date: null,
        revisit_date: cfg.scheduledStage === 'revisit_scheduled' ? existing : null,
        negotiation_date: cfg.scheduledStage === 'negotiation' ? existing : null,
      };
      if (cfg.sendsHappened) payload.negotiation_happened = true;
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
    if (cfg.sendsHappened) payload.negotiation_happened = onScheduled ? d.happened : (v.negotiation_happened ?? true);
    return submit(v, payload);
  }

  // ---- shared inline editor (used by the desktop expanded row + mobile card) ----
  const Editor = ({ v }) => {
    const sg = visitStage(v);
    const d = drafts[v.id] || {};
    const onScheduled = sg === cfg.scheduledStage;
    const isPreConfirm = onScheduled && cfg.preMeeting && d.happened === true;   // "Yes — confirmed"
    const showSteps = onScheduled ? (d.happened != null && !isPreConfirm) : true;
    const noteOptional = isPreConfirm;
    const opts = cfg.nextSteps(sg, d.happened);
    return (
      <div className="fu-form" style={{ marginTop: 10, borderTop: '1px solid var(--line)', paddingTop: 10 }}>
        {onScheduled && (
          <div className="fu-grp">
            <label>{cfg.confirmQuestion} <span style={{ color: 'var(--bad)' }}>*</span></label>
            <div className="fu-pills">
              <button type="button" className={'fu-pill ' + (d.happened === true ? 'on' : '')}
                      onClick={() => setDraft(v.id, { happened: true, stage: '', negotiation_date: '', revisit_date: '' })}>{cfg.yesLabel}</button>
              <button type="button" className={'fu-pill ' + (d.happened === false ? 'on' : '')}
                      onClick={() => setDraft(v.id, { happened: false, stage: '', booking_received_date: '' })}>{cfg.noLabel}</button>
            </div>
          </div>
        )}
        {isPreConfirm && (
          <div className="fu-grp" style={{ background: 'var(--goodBg, #ECFDF5)', border: '1px solid #6EE7B7', borderRadius: 8, padding: '10px 12px' }}>
            <div style={{ fontSize: 12.5, color: 'var(--good, #16A34A)', fontWeight: 600 }}>
              ✓ Confirmed — stays in {STAGE_BY_KEY[cfg.scheduledStage]?.label || cfg.scheduledStage}. Record the outcome later, after the {cfg.noun}.
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
    if (sg !== cfg.scheduledStage) {
      if (cfg.sendsHappened && v.negotiation_happened === true) return <span className="muted" style={{ fontSize: 11 }}>✅ confirmed</span>;
      return <span className="muted">—</span>;
    }
    const dk = datePart(v[cfg.dateField]);
    const today = ymd(TODAY);
    const due = dk && dk <= today;                 // due today or overdue → emphasize
    const confirmed = cfg.preMeeting && v.negotiation_happened === true;   // already confirmed
    return (
      <div className="fu-pills" style={{ gap: 4, alignItems: 'center' }}>
        {confirmed && <span title="Confirmed" style={{ fontSize: 11, color: 'var(--good,#16A34A)', fontWeight: 700 }}>✓</span>}
        <button type="button" title={cfg.preMeeting ? 'Confirmed — will happen' : `${cfg.noun} happened`} className="fu-pill" style={due ? { borderColor: 'var(--good,#16A34A)', fontWeight: 700 } : undefined}
                onClick={(e) => { e.stopPropagation(); quickConfirm(v, true); }}>✅</button>
        <button type="button" title={cfg.preMeeting ? "Won't happen / not confirmed" : `${cfg.noun} didn't happen`} className="fu-pill" style={due ? { borderColor: 'var(--bad)', fontWeight: 700 } : undefined}
                onClick={(e) => { e.stopPropagation(); quickConfirm(v, false); }}>❌</button>
      </div>
    );
  };

  const DateCell = ({ v }) => {
    const raw = v[cfg.dateField];
    const sg = visitStage(v);
    const overdue = sg === cfg.scheduledStage && datePart(raw) && datePart(raw) < ymd(TODAY);
    const dueToday = datePart(raw) === ymd(TODAY);
    return (
      <span style={{ fontWeight: 700, color: overdue ? 'var(--bad)' : dueToday ? 'var(--accDark)' : 'var(--ink)' }}>
        {raw ? fmtDateTime(raw) : '—'}{overdue ? <span style={{ fontSize: 10.5, color: 'var(--bad)' }}> · passed</span> : null}
      </span>
    );
  };

  const COLS = ['Visit', cfg.dateCol, 'City', 'RM', 'Society / Unit', 'Buyer', 'CP · Tier', 'CP Owner', 'Status', 'Stage', 'Next FU', 'Last FU', 'Price', 'Confirm', ''];

  if (rows.length === 0) {
    return <div className="empty"><div className="emoji">{cfg.icon}</div><div className="t">No {cfg.noun === 'meeting' ? 'negotiations' : 'revisits'} match these filters</div></div>;
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
                    <td>{v.buyer_name || '—'}<div style={{ fontSize: 10.5, color: 'var(--mut)', marginTop: 1 }}>{v.buyer_contact || ''}</div></td>
                    <td>
                      <button type="button" onClick={(e) => { e.stopPropagation(); onOpenBroker?.(v.cp_code, v.id); }} title="Open channel partner"
                              style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'var(--acc,#2563EB)', textAlign: 'left' }}>
                        {cpName(v) || '—'}
                      </button> <span className={'tier-badge ' + tier}>{tier}</span>
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
        const overdue = sg === cfg.scheduledStage && datePart(v[cfg.dateField]) && datePart(v[cfg.dateField]) < ymd(TODAY);
        return (
          <div key={v.id} className="m-card">
            <div className="mc-top">
              <div className="mc-title">{v.society_name || '—'}<span className="sub">{[v.unit_address_line1, v.unit_address_line2].filter(Boolean).join('-')} · {v.city || ''}</span></div>
              <div className="mc-right" style={{ color: overdue ? 'var(--bad)' : 'var(--accDark)' }}>
                <div style={{ fontSize: 11 }}>{cfg.dateCol}</div>
                <div><b>{v[cfg.dateField] ? fmtDateTime(v[cfg.dateField]) : '—'}</b></div>
              </div>
            </div>
            <div className="mc-meta">
              <span>👤 <b>{v.buyer_name || '—'}</b></span>
              <span className={'sgpill ' + sg}><span className="d" />{sgDef ? sgDef.label.replace(' Visit', '') : sg}</span>
            </div>
            <div className="mc-meta">
              <button type="button" onClick={() => onOpenBroker?.(v.cp_code, v.id)} style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'var(--acc,#2563EB)' }}>🤝 {cpName(v) || '—'}</button>
              <span className={'tier-badge ' + tierFor(v)}>{tierFor(v)}</span>
              <span style={{ color: 'var(--mut)' }}>RM: {v.sales_manager || '—'}</span>
            </div>
            <div className="mc-foot">
              {sg === cfg.scheduledStage ? <span><ConfirmCell v={v} /></span> : <span />}
              <button type="button" className="btn sm" onClick={() => toggleEditor(v)}>{open ? 'Close' : 'Update'}</button>
            </div>
            {open && <Editor v={v} />}
          </div>
        );
      })}
    </div>
  );
}
