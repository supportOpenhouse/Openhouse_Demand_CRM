// Negotiations — a focused queue for the negotiation funnel (Negotiation /
// After-Negotiation-FU / Booking). For a negotiation lead the team confirms
// whether the scheduled meeting happened, then fills the next step (or
// reschedules); for after-negotiation / booking leads they update the next step
// and capture the booking-received date. Reuses the SAME filters as Visits (the
// shared `filters` from FiltersModal) plus a negotiation-meeting-date range, and
// saves through the existing /api/followups (saveFollowup) — now also sending
// negotiation_happened + booking_received_date (migration 018).
import { useMemo, useState, useDeferredValue } from 'react';
import { fmtDate, fmtDateTime, daysBetween, TODAY, ymd } from '../lib/format.js';
import {
  visitStage, scopeVisits, nextFuFor, nextActivityFor, STAGE_BY_KEY,
} from '../lib/visits.js';
import { flatNo } from '../lib/propertyStatus.js';
import { toast } from '../lib/toast.js';
import { saveFollowup as apiSaveFollowup } from '../api.js';
import ChipBar from '../components/ChipBar.jsx';

// The funnel this tab manages (decision: negotiation + after_negotiation_fu + booking).
const FUNNEL = ['negotiation', 'after_negotiation_fu', 'booking'];
const STAGE_TABS = [
  { k: 'all', label: 'All', cls: '' },
  { k: 'negotiation', label: 'Negotiation', cls: 'sg-nego' },
  { k: 'after_negotiation_fu', label: 'After Negotiation FU', cls: 'sg-avfu' },
  { k: 'booking', label: 'Booking', cls: 'sg-book' },
];
// Next-step options by current funnel stage / meeting outcome.
const NEXT_IF_HAPPENED = ['after_negotiation_fu', 'booking', 'ats', 'future_prospect', 'not_interested'];
const NEXT_IF_NOT = ['negotiation', 'future_prospect', 'not_interested']; // 'negotiation' = reschedule
const NEXT_AFTER_NEG = ['after_negotiation_fu', 'booking', 'ats', 'future_prospect', 'not_interested'];
const NEXT_BOOKING = ['booking', 'ats', 'future_prospect', 'not_interested'];
const CLOSING = new Set(['booking', 'ats', 'not_interested', 'future_prospect']);

// Context-aware pill label (otherwise the canonical stage label).
function pillLabel(k, sg) {
  if (k === 'negotiation') return 'Reschedule meeting';
  if (k === 'after_negotiation_fu' && sg === 'after_negotiation_fu') return 'Keep following up';
  if (k === 'booking' && sg === 'booking') return 'Stay in booking';
  return STAGE_BY_KEY[k]?.label || k;
}
// buyer_status the follow-up must carry (VALID_BUYER_STATUSES), derived from the
// chosen next stage so the team doesn't re-rate the buyer here. Positive/in-progress
// stages keep a live temperature and NEVER fall through to dead/unc.
function statusForStage(stage, current) {
  if (stage === 'not_interested') return 'dead';
  if (stage === 'future_prospect') return 'future_prospect';
  return ['hot', 'warm', 'cold'].includes(current) ? current : 'hot';
}
const plusDays = (n) => { const d = new Date(TODAY); d.setDate(d.getDate() + n); return ymd(d); };
const dtLocal = (s) => (s ? String(s).slice(0, 16) : ''); // ISO ts -> datetime-local value

export default function NegotiationsView({ seed, onOpenBroker, reloadSeed, search = '', filters = {} }) {
  const me = seed.current_user || {};
  const cpOwner = seed.cp_owner || {};
  const properties = seed.properties || [];

  const scoped = useMemo(() => {
    const v = scopeVisits(seed.visits || [], me, cpOwner, properties, seed.pm_by_property || {});
    // Negotiations is intentionally narrower than Visits for KAMs: a KAM sees ONLY their
    // own (T1/T2) CP leads here — never the wider extra-cities pipeline they keep in Visits.
    // cpOwner[cp] holds the owner slug; me.id === slug. Gated on team==='KAM', so every other
    // role (Admin / TL / Ground / MM-manager) is byte-identical to before.
    return me.team === 'KAM' ? v.filter((x) => cpOwner[x.cp_code] === me.id) : v;
  }, [seed]); // eslint-disable-line react-hooks/exhaustive-deps
  const brokersByCode = useMemo(() => {
    const m = {}; (seed.brokers || []).forEach((b) => { m[b.cp_code] = b; }); return m;
  }, [seed]);
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
  // followups grouped per visit (seed list is newest-first) → derive the
  // scheduled-at / moved-to-booking-at timestamps without any new storage.
  const fuByVisit = useMemo(() => {
    const m = {};
    (seed.followups || []).forEach((f) => { (m[f.visit_id] = m[f.visit_id] || []).push(f); });
    return m;
  }, [seed]);
  const scheduledAt = (v) => (fuByVisit[v.id] || []).find((f) => f.stage === 'negotiation')?.ts || v._negotiation_date || '';
  const bookingAt = (v) => (fuByVisit[v.id] || []).find((f) => f.stage === 'booking')?.ts || '';

  const [stageTab, setStageTab] = useState([]); // multi-select; [] = all funnel stages
  const [negFrom, setNegFrom] = useState('');
  const [negTo, setNegTo] = useState('');
  const [expanded, setExpanded] = useState(() => new Set());
  const [drafts, setDrafts] = useState({});
  const [busy, setBusy] = useState(false);
  const dq = useDeferredValue(search);

  const funnel = useMemo(() => scoped.filter((v) => FUNNEL.includes(visitStage(v))), [scoped]);

  // SAME predicate as VisitsView.cityBase (ported), minus the lead-set segment,
  // plus the negotiation-meeting-date range. Keeps filtering identical to Visits.
  const base = useMemo(() => funnel.filter((v) => {
    if (filters.cities?.length && !filters.cities.includes(v.city)) return false;
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
    const F = filters || {};
    if (F.unit) {
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
    if (F.activityDate?.length) {
      const ad = nextActivityFor(v)?.date || null;
      let ok = F.activityDate.includes('none') && !ad;
      if (ad != null) {
        const d = daysBetween(ad);
        if (F.activityDate.includes('overdue') && d > 0) ok = true;
        if (F.activityDate.includes('today') && d === 0) ok = true;
        if (F.activityDate.includes('tomorrow') && d === -1) ok = true;
        if (F.activityDate.includes('week') && d <= 0 && d > -7) ok = true;
      }
      if (!ok) return false;
    }
    // NEW — negotiation-meeting-date range (YYYY-MM-DD compare on _negotiation_date)
    const nd = v._negotiation_date ? String(v._negotiation_date).slice(0, 10) : '';
    if (negFrom && !(nd && nd >= negFrom)) return false;
    if (negTo && !(nd && nd <= negTo)) return false;
    return true;
  }), [funnel, filters, dq, propBySociety, brokersByCode, negFrom, negTo]);

  const stageCounts = useMemo(() => {
    const c = { all: base.length, negotiation: 0, after_negotiation_fu: 0, booking: 0 };
    base.forEach((v) => { const s = visitStage(v); c[s] = (c[s] || 0) + 1; });
    return c;
  }, [base]);

  const rows = useMemo(() => {
    const list = stageTab.length ? base.filter((v) => stageTab.includes(visitStage(v))) : base;
    return list.slice().sort((a, b) => { // soonest meeting first; undated last
      const da = a._negotiation_date || '9999'; const db = b._negotiation_date || '9999';
      return da < db ? -1 : da > db ? 1 : 0;
    });
  }, [base, stageTab]);

  const setDraft = (vid, patch) => setDrafts((p) => ({ ...p, [vid]: { ...(p[vid] || {}), ...patch } }));
  const openEditor = (v) => setExpanded((p) => {
    const n = new Set(p); const k = String(v.id);
    if (n.has(k)) { n.delete(k); return n; }
    n.add(k);
    // seed the draft for the stage's editor
    const sg = visitStage(v);
    if (!drafts[v.id]) {
      if (sg === 'booking') setDraft(v.id, { stage: 'booking', booking_received_date: v.booking_received_date || '' });
      else if (sg === 'after_negotiation_fu') setDraft(v.id, { stage: '' });
      else setDraft(v.id, { happened: null, stage: '' });
    }
    return n;
  });

  async function save(v) {
    const d = drafts[v.id] || {};
    const sg = visitStage(v);
    let stage; let negotiation_date = null; let booking_received_date = null; let happened;

    if (sg === 'negotiation') {
      if (d.happened == null) { toast('Confirm whether the meeting happened', 'bad'); return; }
      happened = d.happened;
      stage = d.stage;
      if (!stage) { toast(d.happened ? 'Pick the next step' : 'Pick what happens next', 'bad'); return; }
      if (!d.happened && stage === 'negotiation') {
        if (!d.negotiation_date) { toast('Set the revised negotiation meeting date & time', 'bad'); return; }
        negotiation_date = d.negotiation_date;
      }
    } else {
      // after_negotiation_fu / booking — forward update, no Yes/No
      stage = d.stage || sg;
      happened = sg === 'after_negotiation_fu' ? true : (v.negotiation_happened ?? true);
    }
    // booking-received date is REQUIRED whenever the resulting stage is 'booking' (decision #3)
    if (stage === 'booking') {
      const br = d.booking_received_date || v.booking_received_date || '';
      if (!br) { toast('Booking needs the booking-received date', 'bad'); return; }
      booking_received_date = br;
    }
    if (!d.note || !d.note.trim()) { toast('Notes are mandatory — what was discussed / next action', 'bad'); return; }

    const buyer_status = statusForStage(stage, v.lead_status);
    setBusy(true);
    try {
      await apiSaveFollowup({
        visit_code: String(v.id),
        buyer_status,
        stage,
        note: d.note.trim(),
        next_followup_date: CLOSING.has(stage) ? null : (d.next_date || plusDays(2)),
        revisit_date: null,
        negotiation_date,
        negotiation_happened: happened,
        booking_received_date,
      });
      setDrafts((p) => { const n = { ...p }; delete n[v.id]; return n; });
      setExpanded((p) => { const n = new Set(p); n.delete(String(v.id)); return n; });
      toast('Negotiation updated', 'good');
      await reloadSeed?.();
    } catch (e) { toast('Save failed: ' + String(e.message || e).slice(0, 140), 'bad'); }
    finally { setBusy(false); }
  }

  const StagePills = ({ v, opts }) => {
    const sg = visitStage(v); const d = drafts[v.id] || {};
    return (
      <div className="fu-pills">
        {opts.map((s) => (
          <button key={s} type="button" className={'fu-pill ' + (d.stage === s ? 'on' : '')}
                  onClick={() => setDraft(v.id, { stage: s })}>{pillLabel(s, sg)}</button>
        ))}
      </div>
    );
  };

  return (
    <div className="neg-root">
      <div className="neg-filters" style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10, marginBottom: 10 }}>
        <span style={{ fontWeight: 600, fontSize: 13 }}>Negotiation meeting date</span>
        <input type="date" value={negFrom} onChange={(e) => setNegFrom(e.target.value)}
               style={{ padding: '6px 9px', border: '1px solid var(--line)', borderRadius: 7, fontSize: 13 }} />
        <span style={{ color: 'var(--mut)' }}>→</span>
        <input type="date" value={negTo} onChange={(e) => setNegTo(e.target.value)}
               style={{ padding: '6px 9px', border: '1px solid var(--line)', borderRadius: 7, fontSize: 13 }} />
        {(negFrom || negTo) && (
          <button type="button" className="btn sm" onClick={() => { setNegFrom(''); setNegTo(''); }}>Clear dates ✕</button>
        )}
        <span style={{ marginLeft: 'auto', color: 'var(--mut)', fontSize: 12.5 }}>
          Use the top-bar <b>Filters</b> for city, society, CP, RM, BHK, source, etc.
        </span>
      </div>

      <ChipBar label="Stage" options={STAGE_TABS} counts={stageCounts} value={stageTab} onChange={setStageTab} multi />

      <div className="neg-count" style={{ margin: '8px 2px', color: 'var(--mut)', fontSize: 13 }}>
        <b>{rows.length}</b> in the negotiation funnel
      </div>

      {rows.length === 0 && (
        <div className="empty"><div className="emoji">🤝</div><div className="t">No negotiations match these filters</div></div>
      )}

      <div className="neg-list" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {rows.map((v) => {
          const sg = visitStage(v);
          const d = drafts[v.id] || {};
          const open = expanded.has(String(v.id));
          const sch = scheduledAt(v);
          const bk = bookingAt(v);
          const sgDef = STAGE_BY_KEY[sg];
          // CP (channel-partner) name: prefer the canonical brokers record, fall back to
          // the name recorded on the visit (always present, scope-independent).
          const cpName = brokersByCode[v.cp_code]?.name || v.broker_name || '';
          const overdue = sg === 'negotiation' && v._negotiation_date && String(v._negotiation_date).slice(0, 10) < ymd(TODAY);
          return (
            <div key={v.id} className="neg-card" style={{ border: '1px solid var(--line)', borderRadius: 10, padding: '12px 14px', background: '#fff' }}>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
                <span className="role-pill" style={{ background: 'var(--blueBg)', color: '#1E40AF' }}>{sgDef?.label || sg}</span>
                <b style={{ fontSize: 14 }}>{v.buyer_name || 'Buyer'}</b>
                <span style={{ color: 'var(--mut)', fontSize: 13 }}>· {v.society_name || '—'}{v.unit_address_line1 ? ` · ${v.unit_address_line1}` : ''}</span>
                <span style={{ color: 'var(--mut)', fontSize: 12.5 }}>· {v.city || ''}</span>
                {v.cp_code && (
                  <button type="button" onClick={() => onOpenBroker?.(v.cp_code, v.id)} title="Open channel partner"
                          style={{ fontSize: 12.5, color: 'var(--acc, #2563EB)', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>
                    {cpName ? `${cpName} · ${v.cp_code}` : v.cp_code}
                  </button>
                )}
                <span style={{ marginLeft: 'auto', fontSize: 12.5, color: overdue ? 'var(--bad)' : 'var(--mut)' }}>
                  Meeting: <b>{v._negotiation_date ? fmtDateTime(v._negotiation_date) : '—'}</b>{overdue ? ' · date passed' : ''}
                </span>
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14, marginTop: 6, fontSize: 12, color: 'var(--mut)' }}>
                <span>RM: {v.sales_manager || '—'}</span>
                <span>Scheduled on: {sch ? fmtDate(sch) : '—'}</span>
                {bk && <span>Moved to booking: {fmtDate(bk)}</span>}
                {v.booking_received_date && <span style={{ color: 'var(--good, #16A34A)' }}>Booking received: {fmtDate(v.booking_received_date)}</span>}
                {v.negotiation_happened === true && <span>✅ meeting happened</span>}
                {v.negotiation_happened === false && <span>↩︎ last meeting didn’t happen</span>}
                <button type="button" className="btn sm" style={{ marginLeft: 'auto' }} onClick={() => openEditor(v)}>
                  {open ? 'Close' : 'Update'}
                </button>
              </div>

              {open && (
                <div className="fu-form" style={{ marginTop: 10, borderTop: '1px solid var(--line)', paddingTop: 10 }}>
                  {sg === 'negotiation' && (
                    <div className="fu-grp">
                      <label>Did the negotiation meeting happen? <span style={{ color: 'var(--bad)' }}>*</span></label>
                      <div className="fu-pills">
                        <button type="button" className={'fu-pill ' + (d.happened === true ? 'on' : '')}
                                onClick={() => setDraft(v.id, { happened: true, stage: '', negotiation_date: '' })}>✅ Yes</button>
                        <button type="button" className={'fu-pill ' + (d.happened === false ? 'on' : '')}
                                onClick={() => setDraft(v.id, { happened: false, stage: '', booking_received_date: '' })}>❌ No</button>
                      </div>
                    </div>
                  )}

                  {/* Next-step pills — set depends on the stage / meeting outcome */}
                  {sg === 'negotiation' && d.happened === true && (
                    <div className="fu-grp"><label>Next step <span style={{ color: 'var(--bad)' }}>*</span></label><StagePills v={v} opts={NEXT_IF_HAPPENED} /></div>
                  )}
                  {sg === 'negotiation' && d.happened === false && (
                    <div className="fu-grp"><label>What next? <span style={{ color: 'var(--bad)' }}>*</span></label><StagePills v={v} opts={NEXT_IF_NOT} /></div>
                  )}
                  {sg === 'after_negotiation_fu' && (
                    <div className="fu-grp"><label>Next step <span style={{ color: 'var(--bad)' }}>*</span></label><StagePills v={v} opts={NEXT_AFTER_NEG} /></div>
                  )}
                  {sg === 'booking' && (
                    <div className="fu-grp"><label>Next step</label><StagePills v={v} opts={NEXT_BOOKING} /></div>
                  )}

                  {/* Reschedule date — only for "No → reschedule" */}
                  {sg === 'negotiation' && d.happened === false && d.stage === 'negotiation' && (
                    <div className="fu-grp" style={{ background: 'var(--blueBg)', border: '1px solid #93C5FD', borderRadius: 8, padding: '10px 12px' }}>
                      <label style={{ color: '#1E40AF' }}>Revised negotiation meeting date &amp; time <span style={{ color: 'var(--bad)' }}>*</span></label>
                      <input type="datetime-local" value={dtLocal(d.negotiation_date)} onChange={(e) => setDraft(v.id, { negotiation_date: e.target.value })}
                             style={{ padding: '7px 10px', border: '1px solid var(--line)', borderRadius: 7, fontSize: 13, width: 240, maxWidth: '100%' }} />
                    </div>
                  )}

                  {/* Booking-received date — required whenever the resulting stage is 'booking' */}
                  {((d.stage === 'booking') || (sg === 'booking' && (d.stage || 'booking') === 'booking')) && (
                    <div className="fu-grp" style={{ background: 'var(--blueBg)', border: '1px solid #93C5FD', borderRadius: 8, padding: '10px 12px' }}>
                      <label style={{ color: '#1E40AF' }}>Booking received date <span style={{ color: 'var(--bad)' }}>*</span></label>
                      <input type="date" value={d.booking_received_date || ''} onChange={(e) => setDraft(v.id, { booking_received_date: e.target.value })}
                             style={{ padding: '7px 10px', border: '1px solid var(--line)', borderRadius: 7, fontSize: 13, width: 200 }} />
                    </div>
                  )}

                  <div className="fu-grp">
                    <label>Notes <span style={{ color: 'var(--bad)' }}>*</span></label>
                    <textarea placeholder="Required — what was discussed, the outcome, next action…" value={d.note || ''}
                              onChange={(e) => setDraft(v.id, { note: e.target.value })} />
                  </div>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <button className="btn primary sm" disabled={busy} onClick={() => save(v)}>Save</button>
                    <button className="btn sm" disabled={busy} onClick={() => openEditor(v)}>Cancel</button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
