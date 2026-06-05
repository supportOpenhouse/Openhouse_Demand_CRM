// Visit stage/status derivation + scoping — ported verbatim from the legacy app
// (visitStage/visitStatus/visitsForUser) so behavior is identical, plus the new
// "Old Leads" (#6) and unit-number (#4) helpers.
import { TODAY, ymd, daysBetween } from './format.js';

// Buyer-status chips (colored), ported from the legacy STATUSES.
export const STATUSES = [
  { k: 'hot',  label: 'Hot',  cls: 'st-hot' },
  { k: 'warm', label: 'Warm', cls: 'st-warm' },
  { k: 'cold', label: 'Cold', cls: 'st-cold' },
  { k: 'dead', label: 'Dead', cls: 'st-dead' },
  { k: 'future_prospect', label: 'Future', cls: 'st-warm' },
  { k: 'unc',  label: 'Not Updated', cls: 'st-unc' },
];

// "Last followup taken" presets — the daily-triage filter from the legacy app.
export const LAST_FU_PRESETS = [
  { k: 'all',       label: 'All' },
  { k: 'overdue',   label: '🚨 Overdue' },
  { k: 'not_taken', label: '⚠️ Not taken yet', cls: 'pr-tl' },
  { k: 'today',     label: 'Today' },
  { k: 'yesterday', label: 'Yesterday' },
  { k: 'last3',     label: 'Last 3 days' },
  { k: 'last7',     label: 'Last 7 days' },
  { k: '2w',        label: '2 weeks ago' },
  { k: '3w',        label: '3 weeks ago' },
  { k: 'older',     label: 'Older' },
];

// next scheduled FU (in-session save) → else the latest taken date
export function nextFuFor(v) {
  return v._next_followup_date || v.latest_followup_date || null;
}
// latest followup date taken on this visit (seed projection = the real latest)
export function lastFollowupTaken(v) {
  return v.latest_followup_date || null;
}
export function matchLastFuFilter(lfDate, key, v) {
  if (key === 'all') return true;
  if (key === 'overdue') {              // next FU is in the past, regardless of last taken
    const next = v ? nextFuFor(v) : null;
    return !!next && daysBetween(next) > 0;
  }
  if (key === 'not_taken') return !lfDate;
  if (!lfDate) return false;
  const d = daysBetween(lfDate);
  if (d == null) return false;
  if (key === 'today') return d === 0;
  if (key === 'yesterday') return d === 1;
  if (key === 'last3') return d >= 0 && d <= 3;
  if (key === 'last7') return d >= 0 && d <= 7;
  if (key === '2w') return d >= 8 && d <= 14;
  if (key === '3w') return d >= 15 && d <= 21;
  if (key === 'older') return d > 21;
  return true;
}

// Priority flags (TL ask & nudges), ported from the legacy app.
export function isVisitNudged(v, nudgesByVisit = {}) {
  const arr = nudgesByVisit[v.id];
  return !!(arr && arr.some((n) => !n.resolved));
}
export function isVisitTlAsk(v, teamTasks = {}) {
  if (!v.cp_code) return false;
  return Object.values(teamTasks).some((tt) => (tt.daily_calls || []).includes(v.cp_code));
}

export const STAGES = [
  { k: 'upcoming',          label: 'Upcoming Visit',   cls: 'sg-up' },
  { k: 'avfu',              label: 'After Visit FU',   cls: 'sg-avfu' },
  { k: 'revisit_scheduled', label: 'Revisit Scheduled', cls: 'sg-rev' },
  { k: 'after_revisit_fu',  label: 'After Revisit FU', cls: 'sg-avfu' },
  { k: 'negotiation',       label: 'Negotiation',      cls: 'sg-nego' },
  { k: 'booking',           label: 'Booking',          cls: 'sg-book' },
  { k: 'ats',               label: 'ATS',              cls: 'sg-ats' },
  { k: 'future_prospect',   label: 'Future Prospect',  cls: 'sg-fp' },
  { k: 'not_interested',    label: 'Not Interested',   cls: 'sg-ni' },
  { k: 'need_more',         label: 'Need More Props',  cls: 'sg-nmp' },
  { k: 'cancelled',         label: 'Cancelled',        cls: 'sg-canc' },
];
export const STAGE_BY_KEY = Object.fromEntries(STAGES.map((s) => [s.k, s]));

export function visitStage(v) {
  if (v._stage) {
    if (v._stage === 'revisit_scheduled' && v._revisit_date && v._revisit_date < ymd(TODAY)) return 'after_revisit_fu';
    if (v._stage === 'revisit') {
      if (v._revisit_date && v._revisit_date < ymd(TODAY)) return 'after_revisit_fu';
      return 'revisit_scheduled';
    }
    return v._stage;
  }
  const s = (v.status || '').toLowerCase();
  if (s === 'upcoming') return 'upcoming';
  if (s === 'cancelled') return 'cancelled';
  const ls = (v.lead_status || '').toLowerCase();
  if (ls === 'future_prospect') return 'future_prospect';
  if (ls === 'dead') {
    const note = (v.latest_followup_note || '').toLowerCase();
    if (note.includes('not interested')) return 'not_interested';
    if (note.includes('more propert')) return 'need_more';
    return 'not_interested';
  }
  return 'avfu';
}

export function visitStatus(v) {
  const ls = (v.lead_status || '').toLowerCase();
  return ['hot', 'warm', 'cold', 'dead', 'future_prospect'].includes(ls) ? ls : 'unc';
}

// ---- #6 Old Leads: pre-cutoff visits still sitting in Upcoming / Cancelled /
// After-Visit-FU. Hidden from the default list; surfaced via the "Old Leads" filter.
export const OLD_LEADS_CUTOFF = '2026-05-01';
export function isOldLead(v) {
  // Prefer the persisted DB flag (old pre-1-May AND never actioned in the app).
  if (typeof v.is_old_lead === 'boolean') return v.is_old_lead;
  // Fallback for an older seed without the column.
  const st = visitStage(v);
  return ['upcoming', 'cancelled', 'avfu'].includes(st) && !!v.visit_date && v.visit_date < OLD_LEADS_CUTOFF;
}

// ---- #4 typeable unit-number filter (matches the unit address lines + floor)
export function visitUnitText(v) {
  return [v.unit_address_line1, v.unit_address_line2, v.floor].filter(Boolean).join(' ');
}
export function matchesUnit(v, q) {
  if (!q) return true;
  return visitUnitText(v).toLowerCase().includes(q.toLowerCase());
}

// ---- role scoping (ported from legacy visitsForUser)
function isAdminOrTL(me) {
  return me.team === 'Admin' || me.team === 'TL' || me.role === 'admin' || (me.role || '').startsWith('tl');
}
export function scopeVisits(visits, me, cpOwner = {}, properties = [], pmByProperty = {}) {
  if (!me || !me.id) return visits;
  if (isAdminOrTL(me)) {
    if (me.role === 'tl_closer' || (me.team === 'TL' && (me.cities || []).length === 1)) {
      return visits.filter((v) => (me.cities || []).includes(v.city));
    }
    return visits;
  }
  if (me.team === 'KAM') return visits.filter((v) => cpOwner[v.cp_code] === me.id);
  if (me.team === 'Ground') {
    // PM's properties via the authoritative assignment (pm_by_property → slug), with the
    // sheet-name match as fallback (sheet stores some PMs by first name only).
    const socs = new Set(properties
      .filter((p) => pmByProperty[p.property_name] === me.slug || p.sales_manager === me.name)
      .map((p) => p.society_name));
    return visits.filter((v) => socs.has(v.society_name) || cpOwner[v.cp_code] === me.id);
  }
  return [];
}
