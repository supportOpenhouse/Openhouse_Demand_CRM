// Move a visit's date/slot on Core — one form, two Core endpoints
// (docs/CP_REVISIT_RESCHEDULE.md):
//
//   upcoming visit  → RESCHEDULE  (same visit id, moved to the new slot)
//   completed visit → REVISIT     (a NEW upcoming visit cloned from it)
//
// The mode is derived from the visit's status, not chosen by the user: Core enforces
// exactly this rule and rejects the wrong one, so offering a choice would only let
// people pick the option that 400s. The heading says which one will happen.
//
// Neither call sends a sales manager — Core keeps the visit's own SM, so moving a
// date can never silently reassign the visit. That's stated in the footnote because
// "who owns this visit now?" is the first question a TL asks after a reschedule.
import { useMemo, useState } from 'react';
import { revisitVisit, rescheduleVisit } from '../api.js';
import { toast } from '../lib/toast.js';
import { ymd, TODAY } from '../lib/format.js';

// Core stores slots SPACED ("11 - 1 PM"). The older booking flow uses the unspaced
// form ("11-1 PM") — do NOT reuse that list here, it would 400 on Core.
const SLOTS = ['9 - 11 AM', '11 - 1 PM', '1 - 3 PM', '3 - 5 PM', '5 - 7 PM', '7 - 9 PM'];

// Normalise whatever the sheet stored ("1-3 PM", "1 - 3 PM") to Core's spaced form,
// so the current slot preselects instead of showing a blank dropdown.
function toCoreSlot(s) {
  const raw = String(s || '').trim();
  if (!raw) return '';
  if (SLOTS.includes(raw)) return raw;
  const squashed = raw.replace(/\s+/g, '').toUpperCase();
  return SLOTS.find((x) => x.replace(/\s+/g, '').toUpperCase() === squashed) || '';
}

export default function VisitRescheduleModal({ visit, onClose, onDone }) {
  const isCompleted = String(visit?.status || '').trim().toLowerCase() === 'completed';
  const mode = isCompleted ? 'revisit' : 'reschedule';

  const [date, setDate] = useState('');
  const [slot, setSlot] = useState(() => toCoreSlot(visit?.selected_time));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const minDate = useMemo(() => ymd(TODAY), []);
  if (!visit) return null;

  const code = visit.id || visit.visit_code || '';
  const unit = [visit.unit_address_line1, visit.society_name].filter(Boolean).join(', ');
  const curDate = visit.selected_date || visit.visit_date || '';
  const canSave = !!date && !!slot && !busy;

  async function submit() {
    setBusy(true); setErr('');
    try {
      const body = { visit_code: String(code), selected_date: date, selected_time: slot };
      const res = mode === 'revisit' ? await revisitVisit(body) : await rescheduleVisit(body);
      const v = res.visit || {};
      toast(mode === 'revisit'
        ? `Revisit booked${v.id ? ` (visit ${v.id})` : ''}`
        : 'Visit rescheduled');
      onDone?.(v, mode);
      onClose?.();
    } catch (e) {
      setErr(e.message || 'Something went wrong');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="vc-backdrop" onClick={(e) => { if (e.target === e.currentTarget && !busy) onClose?.(); }}>
      <div className="vc-modal" role="dialog" aria-modal="true"
           aria-label={mode === 'revisit' ? 'Book a revisit' : 'Reschedule visit'}>
        <div className="vc-head">
          <div>
            <div className="vc-title">{mode === 'revisit' ? 'Book a revisit' : 'Reschedule visit'}</div>
            <div className="vc-sub">
              Visit <b>{code}</b>{unit ? <> · {unit}</> : null}
              {visit.buyer_name ? <> · {visit.buyer_name}</> : null}
            </div>
          </div>
          <button className="vc-x" type="button" onClick={onClose} disabled={busy} aria-label="Close">×</button>
        </div>

        <div className="vc-body">
          <div className="vc-current">
            <span>{mode === 'revisit' ? 'Original visit' : 'Currently'}</span>
            <b>{curDate || '—'}{visit.selected_time ? ` · ${visit.selected_time}` : ''}</b>
          </div>

          {mode === 'revisit' ? (
            <div className="vc-warn">
              This visit is <b>completed</b>, so this creates a <b>new upcoming visit</b> for the
              same buyer, CP and unit. The original stays as it is.
            </div>
          ) : null}

          <label className="vc-label" htmlFor="vr-date">New date</label>
          <input id="vr-date" className="vc-select" type="date" value={date} min={minDate}
                 disabled={busy} onChange={(e) => setDate(e.target.value)} />

          <label className="vc-label" htmlFor="vr-slot">Time slot</label>
          <select id="vr-slot" className="vc-select" value={slot} disabled={busy}
                  onChange={(e) => setSlot(e.target.value)}>
            <option value="">— select a slot —</option>
            {SLOTS.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>

          <div className="vc-note sm">
            {mode === 'revisit'
              ? 'The new visit keeps the original’s sales manager.'
              : 'The visit id and its sales manager do not change.'}
          </div>

          {err ? <div className="vc-err">{err}</div> : null}
        </div>

        <div className="vc-foot">
          <button className="vc-btn" type="button" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="vc-btn primary" type="button" disabled={!canSave} onClick={submit}>
            {busy ? 'Saving…' : mode === 'revisit' ? 'Book revisit' : 'Reschedule'}
          </button>
        </div>
        <div className="vc-footnote">
          Updates the visit in the OpenHouse app.
        </div>
      </div>
    </div>
  );
}
