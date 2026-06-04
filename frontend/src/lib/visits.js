// Visit stage/status derivation + scoping — ported verbatim from the legacy app
// (visitStage/visitStatus/visitsForUser) so behavior is identical, plus the new
// "Old Leads" (#6) and unit-number (#4) helpers.
import { TODAY, ymd } from './format.js';

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
  const st = visitStage(v);
  if (!['upcoming', 'cancelled', 'avfu'].includes(st)) return false;
  return !!v.visit_date && v.visit_date < OLD_LEADS_CUTOFF;
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
export function scopeVisits(visits, me, cpOwner = {}, properties = []) {
  if (!me || !me.id) return visits;
  if (isAdminOrTL(me)) {
    if (me.role === 'tl_closer' || (me.team === 'TL' && (me.cities || []).length === 1)) {
      return visits.filter((v) => (me.cities || []).includes(v.city));
    }
    return visits;
  }
  if (me.team === 'KAM') return visits.filter((v) => cpOwner[v.cp_code] === me.id);
  if (me.team === 'Ground') {
    const socs = new Set(properties.filter((p) => p.sales_manager === me.name).map((p) => p.society_name));
    return visits.filter((v) => socs.has(v.society_name) || cpOwner[v.cp_code] === me.id);
  }
  return [];
}
