// Complete or cancel a visit on Core, from the CRM (docs/crm_staging_api).
//
// Two completion paths, exactly as Core defines them:
//   OTP      — status + free-text sales_feedback only (the default: fast).
//   Assisted — adds lead_status + the 6 structured sm_demand_feedback fields.
// Core picks the path from the payload (sm_demand_feedback present => assisted),
// so the toggle here literally decides which fields we send.
//
// This is a WRITE TO CORE and cannot be undone from the CRM, so the confirm step
// spells that out, mirroring the Book Visits tab's warning.
import { useState } from 'react';
import { completeVisit } from '../api.js';
import { toast } from '../lib/toast.js';

// Suggested values from the Core spec. Free text is allowed, but offering the
// app's own options keeps CRM-entered feedback comparable with app-entered.
const SM_FIELDS = [
  { k: 'time_spent_on_site', label: 'Time spent on site',
    opts: ['Less than 5 min', '5 - 10 min', '10 - 15 min', '15 - 20 min', '20 - 30 min', '30 - 50 min', '50+ min'] },
  { k: 'society_amenity_tour', label: 'Society / amenity tour',
    opts: ['Skipped', 'Quick walk-through', 'Full amenity tour', 'Detailed tour & society enquiry'] },
  { k: 'price_discussion', label: 'Price discussed', opts: ['No', 'Yes'] },
  { k: 'client_queries', label: 'Client queries',
    opts: ["No — didn't ask", 'Casually asked 1 aspect', 'Asked multiple questions', 'Deep probing & compared'] },
  { k: 'closing_signal', label: 'Closing signal',
    opts: ['Non-committal — "will think about it"', 'Asked for brochure / floor plan',
           'Wants revisit or comparison visit', 'Asked about booking / token / timeline'] },
  { k: 'buyer_primary_concern', label: 'Buyer’s main concern (optional)',
    opts: ['Price too high', 'Location not preferred', 'No concern expressed'] },
];

const LEAD_STATUSES = [
  { k: 'hot', l: 'Hot' }, { k: 'warm', l: 'Warm' }, { k: 'cold', l: 'Cold' },
  { k: 'future_prospect', l: 'Future prospect' }, { k: 'dead', l: 'Dead' },
  { k: 'select_status', l: 'Not set' },
];

export default function VisitCompleteModal({ visit, onClose, onDone }) {
  const [mode, setMode] = useState('completed');      // 'completed' | 'cancelled'
  const [assisted, setAssisted] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [leadStatus, setLeadStatus] = useState('');
  const [sm, setSm] = useState({});
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  if (!visit) return null;
  const code = visit.id || visit.visit_code || '';
  const unit = [visit.unit_address_line1, visit.society_name].filter(Boolean).join(', ');

  // Core requires the visit's stored date + slot. If our row lacks them the backend
  // returns 409, so surface it here rather than letting the user hit a dead end.
  const missingSlot = !visit.selected_date || !visit.selected_time;

  async function submit() {
    setBusy(true); setErr('');
    try {
      const body = { visit_code: String(code), status: mode };
      if (mode === 'completed') {
        if (feedback.trim()) body.sales_feedback = feedback.trim();
        if (assisted) {
          if (leadStatus) body.lead_status = leadStatus;
          const picked = Object.fromEntries(
            Object.entries(sm).filter(([, v]) => String(v || '').trim()));
          if (Object.keys(picked).length) body.sm_demand_feedback = picked;
        }
      }
      const res = await completeVisit(body);
      toast(mode === 'completed' ? 'Visit marked completed' : 'Visit cancelled');
      onDone?.(res.visit);
      onClose?.();
    } catch (e) {
      setErr(e.message || 'Something went wrong');
      setConfirming(false);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="vc-backdrop" onClick={(e) => { if (e.target === e.currentTarget && !busy) onClose?.(); }}>
      <div className="vc-modal" role="dialog" aria-modal="true" aria-label="Complete or cancel visit">
        <div className="vc-head">
          <div>
            <div className="vc-title">{mode === 'completed' ? 'Mark visit completed' : 'Cancel visit'}</div>
            <div className="vc-sub">
              Visit <b>{code}</b>{unit ? <> · {unit}</> : null}
              {visit.buyer_name ? <> · {visit.buyer_name}</> : null}
            </div>
          </div>
          <button className="vc-x" type="button" onClick={onClose} disabled={busy} aria-label="Close">×</button>
        </div>

        {missingSlot ? (
          <div className="vc-body">
            <div className="vc-warn">
              This visit has no stored date/time slot, which the app requires to update it.
              Wait for the next sheet sync, or update it in the app.
            </div>
          </div>
        ) : confirming ? (
          <div className="vc-body">
            <div className="vc-confirm">
              <div className="vc-confirm-t">
                {mode === 'completed' ? 'Confirm completion' : 'Confirm cancellation'}
              </div>
              <ul className="vc-recap">
                <li><span>Visit</span><b>{code}</b></li>
                {unit ? <li><span>Unit</span><b>{unit}</b></li> : null}
                <li><span>Date / slot</span><b>{visit.selected_date} · {visit.selected_time}</b></li>
                <li><span>New status</span><b>{mode === 'completed' ? 'Completed' : 'Cancelled'}</b></li>
                {mode === 'completed' && assisted && leadStatus
                  ? <li><span>Lead status</span><b>{LEAD_STATUSES.find((s) => s.k === leadStatus)?.l}</b></li> : null}
                {mode === 'completed' && feedback.trim()
                  ? <li><span>Feedback</span><b>{feedback.trim().slice(0, 90)}</b></li> : null}
                <li><span>Path</span><b>{mode === 'cancelled' ? '—' : assisted ? 'Assisted (full form)' : 'OTP (feedback only)'}</b></li>
              </ul>
              <div className="vc-warn">
                This updates the visit in the OpenHouse app and <b>cannot be undone from the CRM</b>.
              </div>
            </div>
            {err ? <div className="vc-err">{err}</div> : null}
          </div>
        ) : (
          <div className="vc-body">
            <div className="vc-seg">
              <button type="button" className={'vc-segbtn' + (mode === 'completed' ? ' on' : '')}
                      onClick={() => setMode('completed')}>Completed</button>
              <button type="button" className={'vc-segbtn danger' + (mode === 'cancelled' ? ' on' : '')}
                      onClick={() => setMode('cancelled')}>Cancelled</button>
            </div>

            {mode === 'completed' ? (
              <>
                <label className="vc-label" htmlFor="vc-fb">Sales feedback</label>
                <textarea id="vc-fb" className="vc-textarea" rows={3} value={feedback}
                          placeholder="What happened on the visit?"
                          onChange={(e) => setFeedback(e.target.value)} />

                <label className="vc-check">
                  <input type="checkbox" checked={assisted} onChange={(e) => setAssisted(e.target.checked)} />
                  <span>Add full feedback form (lead status + visit detail)</span>
                </label>

                {assisted ? (
                  <div className="vc-assisted">
                    <label className="vc-label" htmlFor="vc-ls">Lead status</label>
                    <select id="vc-ls" className="vc-select" value={leadStatus}
                            onChange={(e) => setLeadStatus(e.target.value)}>
                      <option value="">— select —</option>
                      {LEAD_STATUSES.map((s) => <option key={s.k} value={s.k}>{s.l}</option>)}
                    </select>
                    {SM_FIELDS.map((f) => (
                      <div key={f.k}>
                        <label className="vc-label" htmlFor={'vc-' + f.k}>{f.label}</label>
                        <select id={'vc-' + f.k} className="vc-select" value={sm[f.k] || ''}
                                onChange={(e) => setSm((s) => ({ ...s, [f.k]: e.target.value }))}>
                          <option value="">— select —</option>
                          {f.opts.map((o) => <option key={o} value={o}>{o}</option>)}
                        </select>
                      </div>
                    ))}
                  </div>
                ) : null}
              </>
            ) : (
              <div className="vc-note">
                The visit will be marked <b>cancelled</b> in the app. No feedback is recorded on a cancellation.
              </div>
            )}
            {err ? <div className="vc-err">{err}</div> : null}
          </div>
        )}

        {!missingSlot ? (
          <div className="vc-foot">
            {confirming ? (
              <>
                <button className="vc-btn" type="button" disabled={busy}
                        onClick={() => setConfirming(false)}>← Back</button>
                <button className={'vc-btn ' + (mode === 'completed' ? 'primary' : 'danger')}
                        type="button" disabled={busy} onClick={submit}>
                  {busy ? 'Saving…' : mode === 'completed' ? 'Confirm & complete' : 'Confirm & cancel'}
                </button>
              </>
            ) : (
              <>
                <button className="vc-btn" type="button" onClick={onClose} disabled={busy}>Close</button>
                <button className="vc-btn primary" type="button" disabled={busy}
                        onClick={() => { setErr(''); setConfirming(true); }}>Review →</button>
              </>
            )}
          </div>
        ) : (
          <div className="vc-foot">
            <button className="vc-btn" type="button" onClick={onClose}>Close</button>
          </div>
        )}
      </div>
    </div>
  );
}
