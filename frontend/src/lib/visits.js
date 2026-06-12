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

// Follow-up filter presets — now driven by the NEXT follow-up (pending work),
// not the last one taken. "Due Today" = your follow-ups due today, etc. These
// only apply to COMPLETED visits (Upcoming/Cancelled have no pending FU).
export const FU_PRESETS = [
  { k: 'all',      label: 'All' },
  { k: 'overdue',  label: '🚨 Overdue' },
  { k: 'today',    label: 'Due Today' },
  { k: 'tomorrow', label: 'Due Tomorrow' },
  { k: 'week',     label: 'Due This Week' },
  { k: 'no_fu',    label: '⚠️ No next-FU set', cls: 'pr-tl' },
];

// next scheduled FU (in-session save) → else the latest taken date
export function nextFuFor(v) {
  // A dead lead carries no follow-up — never derive a "next FU" for it (even if it
  // has a last-FU date or a stage like Upcoming/After-FU). Keeps the column "No FU"
  // and drops dead leads out of the overdue filter.
  if (visitStatus(v) === 'dead') return null;
  return v._next_followup_date || v.latest_followup_date || null;
}
// latest followup date taken on this visit (seed projection = the real latest)
export function lastFollowupTaken(v) {
  return v.latest_followup_date || null;
}

// A visit is "completed" (has happened) → a follow-up can be pending on it.
// Upcoming/Cancelled visits aren't completed, so they never count as pending work.
export function isVisitCompleted(v) {
  return !['upcoming', 'cancelled'].includes(visitStage(v));
}

// Pending-work follow-up filter, per visit. Operates on the NEXT follow-up date.
export function matchFuFilter(v, key) {
  if (key === 'all') return true;
  // dead leads & not-yet-completed visits carry no pending follow-up
  if (visitStatus(v) === 'dead') return false;
  if (!isVisitCompleted(v)) return false;
  const next = nextFuFor(v);
  if (key === 'no_fu') return !next;          // completed, nothing scheduled → needs action
  if (!next) return false;
  const d = daysBetween(next);                // +ve = past, 0 = today, -ve = future
  if (d == null) return false;
  if (key === 'overdue')  return d > 0;
  if (key === 'today')    return d === 0;
  if (key === 'tomorrow') return d === -1;
  if (key === 'week')     return d <= 0 && d >= -7;   // today → next 7 days
  return false;
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
  { k: 'after_negotiation_fu', label: 'After Negotiation FU', cls: 'sg-avfu' },
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
    // once the negotiation-meeting date passes, the visit auto-moves to After Negotiation FU
    if (v._stage === 'negotiation' && v._negotiation_date && v._negotiation_date < ymd(TODAY)) return 'after_negotiation_fu';
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

// Next scheduled in-person activity (revisit or negotiation meeting) — drives the
// Visits "Next Activity" column and the Home view. Returns {date, kind, label} | null.
export function nextActivityFor(v) {
  const sg = visitStage(v);
  if (v._revisit_date && (sg === 'revisit_scheduled' || sg === 'after_revisit_fu'))
    return { date: v._revisit_date, kind: 'revisit', label: 'Revisit date & time' };
  if (v._negotiation_date && (sg === 'negotiation' || sg === 'after_negotiation_fu'))
    return { date: v._negotiation_date, kind: 'negotiation', label: 'Negotiation meeting date & time' };
  // fall back to whichever scheduled date exists, so the column isn't blank after a stage shift
  if (v._revisit_date) return { date: v._revisit_date, kind: 'revisit', label: 'Revisit date & time' };
  if (v._negotiation_date) return { date: v._negotiation_date, kind: 'negotiation', label: 'Negotiation meeting date & time' };
  return null;
}

export function visitStatus(v) {
  const ls = (v.lead_status || '').toLowerCase();
  return ['hot', 'warm', 'cold', 'dead', 'future_prospect'].includes(ls) ? ls : 'unc';
}

// The single actionable task for a visit, used by the Home view: a scheduled
// revisit, a negotiation meeting, or a due follow-up — whichever applies.
// Returns { type:'revisit'|'negotiation'|'followup', date } | null.
export function activityForVisit(v) {
  const sg = visitStage(v);
  if (sg === 'revisit_scheduled' && v._revisit_date) return { type: 'revisit', date: v._revisit_date };
  if (sg === 'negotiation' && v._negotiation_date) return { type: 'negotiation', date: v._negotiation_date };
  if (visitStatus(v) === 'dead') return null;
  const next = nextFuFor(v);
  if (next && isVisitCompleted(v)) return { type: 'followup', date: next };
  return null;
}

// ---- #6 Old Leads: visits whose unit is no longer live inventory (Sold /
// Archived / Booked, or no listing). Hidden from the default list; surfaced via
// the "Old Leads" filter. The backend (sheet_sync.sync_inactive_leads) maintains
// the is_old_lead flag off all_properties' status and marks these visits Dead.
export const OLD_LEADS_CUTOFF = '2026-05-01';
export function isOldLead(v) {
  // Prefer the persisted DB flag (property-status based).
  if (typeof v.is_old_lead === 'boolean') return v.is_old_lead;
  // Fallback for an older seed without the column (legacy pre-1-May date rule).
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
    // sheet-name match as fallback. The sheet stores some PMs by FIRST NAME only
    // ("Anuj" vs "Anuj Kumar"), so match full name OR first name.
    const first = (me.name || '').split(' ')[0];
    const isPm = (sm) => !!sm && (sm === me.name || (first && sm === first));
    const socs = new Set(properties
      .filter((p) => pmByProperty[p.property_name] === me.slug || isPm(p.sales_manager))
      .map((p) => p.society_name));
    // also: visits the PM personally ran (they are the RM), even at others' properties.
    return visits.filter((v) => socs.has(v.society_name) || cpOwner[v.cp_code] === me.id || isPm(v.sales_manager));
  }
  return [];
}
