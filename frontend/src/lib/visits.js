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

// Stages that are CLOSED for follow-up purposes: the lead is parked (Future Prospect) or
// finished (Not Interested), so no "next follow-up" is expected and it must never read as
// overdue. NOTE: "Need More Props" is deliberately NOT here — it's an ACTIVE ask (the rep
// owes the buyer more options), so it always keeps a follow-up even if marked dead.
export const TERMINAL_STAGES = new Set(['future_prospect', 'not_interested']);

// True when a COMPLETED visit carries no pending follow-up — it drops out of the Overdue /
// Due / No-next-FU buckets and the Next-FU column reads "No FU". A lead is closed when its
// stage is terminal (Future Prospect / Not Interested) OR the buyer is explicitly Dead —
// EXCEPT "Need More Props", which stays active so the team is prompted to set a date.
export function isClosedLead(v) {
  if (TERMINAL_STAGES.has(visitStage(v))) return true;
  if (visitStatus(v) === 'dead' && visitStage(v) !== 'need_more') return true;
  return false;
}

// next scheduled FU — null for closed leads (terminal stage or dead, per isClosedLead) so
// the Next-FU column reads "No FU" and they stay out of the overdue filter.
export function nextFuFor(v) {
  if (isClosedLead(v)) return null;
  // ONLY a scheduled next-FU drives "Next FU" / overdue — no fallback to the last-FU
  // date. A visit with no scheduled next-FU reads "No FU" / "No next-FU set" (needs a
  // date), NOT "overdue" (which a past last-FU date would wrongly imply once a day passes).
  return v._next_followup_date || null;
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
  // not-yet-completed (Upcoming/Cancelled) and CLOSED leads (terminal stage, or dead but
  // NOT "Need More Props") carry no pending follow-up — see isClosedLead.
  if (!isVisitCompleted(v)) return false;
  if (isClosedLead(v)) return false;
  const next = nextFuFor(v);
  if (key === 'no_fu') return !next;          // completed, active, nothing scheduled → needs action
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
    // Negotiation does NOT auto-advance when the meeting date passes — the team confirms
    // whether the meeting happened in the Negotiations tab, so the lead stays 'negotiation'
    // until they act. (The revisit auto-advance above is intentionally unchanged.)
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
  if (isClosedLead(v)) return null;
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
// Cities with no KAM: the Ground PMs there see EVERY visit in the city (not just their
// assigned societies). KEEP IN SYNC with backend NO_KAM_GROUND_CITIES (seed_snapshot.py).
export const NO_KAM_GROUND_CITIES = new Set(['Ghaziabad']);

// A Sold/Archived unit is dead stock and no longer opens up its society's visits — that
// is what let a previous RM keep seeing a whole society through one sold unit. Visit
// scope only; the Properties tab still lists every unit a PM owns.
// KEEP IN SYNC with the backend DEAD_LISTING_STATUSES (seed_snapshot.py).
export const DEAD_LISTING_STATUSES = new Set(['Sold', 'Archived']);

// ── duplicate-RM-name identity guard ────────────────────────────────────────
// KEEP IN SYNC with backend seed_snapshot.py (_rm_text_is_me / _pm_text_is_me).
// When 2+ active users answer to the same RM name text (seed.dup_rm_names), the
// name cannot identify a person. For exactly those texts, match by hard identity:
// a visit's rm_core_id vs me.core_sales_manager_id (the visit's city as the
// pre-identity fallback), and a property's sales_manager_contact phone vs
// me.phone. Every other name takes the byte-identical legacy path.
const last10 = (s) => {
  const d = String(s || '').replace(/\D/g, '');
  return d.length >= 10 ? d.slice(-10) : '';
};
export const rmTextIsMe = (v, sm, me, dupRmNames, { allowFirst = true } = {}) => {
  if (!sm) return false;
  // The name must be MINE first — the dup guard only NARROWS a legacy grant, never
  // creates one. Without this the city fallback matched any user in the visit's city.
  const first = (me.name || '').split(' ')[0];
  const mine = sm === me.name || (allowFirst && !!first && sm === first);
  if ((dupRmNames || []).includes(sm)) {
    if (!mine) return false;           // someone else's namesake — never mine
    if (v.rm_core_id && me.core_sales_manager_id) return v.rm_core_id === me.core_sales_manager_id;
    return (me.cities || []).includes(v.city);
  }
  return mine;
};
export const pmTextIsMe = (p, me, dupRmNames, { allowFirst = true } = {}) => {
  const sm = p.sales_manager || '';
  if (!sm) return false;
  if ((dupRmNames || []).includes(sm)) {
    const c10 = last10(p.sales_manager_contact);
    return !!c10 && c10 === last10(me.phone);
  }
  const first = (me.name || '').split(' ')[0];
  return sm === me.name || (allowFirst && !!first && sm === first);
};

export function scopeVisits(visits, me, cpOwner = {}, properties = [], pmByProperty = {}, pastKam = {}, dupRmNames = []) {
  if (!me || !me.id) return visits;
  // MM-manager: micro-market scope takes precedence over team/city (mirrors the
  // backend scope_for_user). GATED to TL/Admin only — a manager-level grant, so
  // micro_markets on a Ground/KAM PM does NOT promote them; they fall through to
  // their normal team scope below. KEEP IN SYNC with backend seed_snapshot.py.
  const mms = me.micro_markets || [];
  if (mms.length && (me.team === 'TL' || me.team === 'Admin')) {
    const inScope = (p) => mms.includes(p.micro_market) || pmByProperty[p.property_name] === me.slug;
    // Society-wide grants from LIVE stock only (mirrors backend seed_snapshot.py):
    // a TL's own Sold/Archived unit outside their micro-markets must not keep opening
    // that whole society's visits. Own dead units keep their direct visits via mmHomes.
    const socGrant = (p) => mms.includes(p.micro_market)
      || (pmByProperty[p.property_name] === me.slug && !DEAD_LISTING_STATUSES.has(p.listing_status));
    const mmSocs = new Set(properties.filter(socGrant).map((p) => p.society_name));
    const mmHomes = new Set(properties.filter((p) => inScope(p) && p.home_id).map((p) => String(p.home_id)));
    return visits.filter((v) => (v.home_id && mmHomes.has(String(v.home_id))) || mmSocs.has(v.society_name) || rmTextIsMe(v, v.sales_manager_raw ?? v.sales_manager, me, dupRmNames, { allowFirst: false }));
  }
  if (isAdminOrTL(me)) {
    if (me.role === 'tl_closer' || (me.team === 'TL' && (me.cities || []).length === 1)) {
      return visits.filter((v) => (me.cities || []).includes(v.city));
    }
    return visits;
  }
  if (me.team === 'KAM') {
    // Mirrors the backend KAM scope exactly: own CPs, the CPs they held before the KAM
    // programme was retired, the LIVE societies they are now PM of, visits where they are
    // the current RM, plus any admin-granted extra city.
    const extra = me.extra_cities_enabled ? (me.extra_cities || []) : [];
    const socsK = new Set(properties
      .filter((p) => !DEAD_LISTING_STATUSES.has(p.listing_status)
        && (pmByProperty[p.property_name] === me.slug || pmTextIsMe(p, me, dupRmNames)))
      .map((p) => p.society_name));
    const pastMine = new Set(Object.keys(pastKam).filter((cp) => pastKam[cp] === me.slug));
    return visits.filter((v) => cpOwner[v.cp_code] === me.id || pastMine.has(v.cp_code)
      || socsK.has(v.society_name) || rmTextIsMe(v, v.sales_manager, me, dupRmNames)
      || (extra.length > 0 && extra.includes(v.city)));
  }
  if (me.team === 'Ground') {
    // PM's properties via the authoritative assignment (pm_by_property → slug), with the
    // sheet-name match as fallback. The sheet stores some PMs by FIRST NAME only
    // ("Anuj" vs "Anuj Kumar"), so match full name OR first name.
    // LIVE stock only — a sold unit no longer opens up its whole society.
    const socs = new Set(properties
      .filter((p) => !DEAD_LISTING_STATUSES.has(p.listing_status)
        && (pmByProperty[p.property_name] === me.slug || pmTextIsMe(p, me, dupRmNames)))
      .map((p) => p.society_name));
    // no-KAM cities (Ghaziabad): the PM also sees EVERY visit in those cities.
    const noKam = new Set((me.cities || []).filter((c) => NO_KAM_GROUND_CITIES.has(c)));
    // Match the CURRENT RM (`sales_manager`, already resolved to the unit's assigned PM
    // server-side), not the historical sheet RM — so a handover moves the leads too.
    return visits.filter((v) => socs.has(v.society_name) || cpOwner[v.cp_code] === me.id || rmTextIsMe(v, v.sales_manager, me, dupRmNames) || noKam.has(v.city));
  }
  return [];
}

// ---- Per-property REVISIT detection (display-only; no counts/data affected). A visit is a
// "revisit" when the SAME unit (home_id) + broker (cp_code) + buyer (lead_key, else phone)
// has an EARLIER visit whose status is 'completed'. This is a THIRD, distinct notion from:
//   • the follow-up-scheduled `revisit_scheduled`/`after_revisit_fu` STAGE (visitStage), and
//   • the buyer-total `lead_occurrence_count` badge (a buyer's visits across ALL homes).
// Returns Map(visit.id → { isRevisit, revisitSeq, isChainLatest, chainLatestId, chainSize,
// firstDate }). Only visits that belong to a genuine revisit chain appear in the map; every
// other visit is absent (treated as a normal standalone row). Pure O(n) over tiny groups.
const isCompletedStatus = (v) => (v.status || '').toLowerCase() === 'completed';
const isRealStatus = (v) => { const s = (v.status || '').toLowerCase(); return s === 'completed' || s === 'upcoming'; };
const visitDay = (v) => v.visit_date || v.selected_date || '';   // 'YYYY-MM-DD' (sorts lexically)
function revisitBuyerKey(v) {
  const ph = (v.buyer_contact || '').trim();
  if (ph.length >= 5) return 'ph:' + ph;          // phone = the stable buyer identity (name varies)
  const lk = (v.lead_key || '').trim().toLowerCase();
  return lk ? 'lk:' + lk : '';                     // fallback only when phone is blank/too short
}
// Can this visit be closed out on Core (docs/crm_staging_api)?
//
// Only an OPEN visit — a completed/cancelled one has nothing to update and Core
// would just re-stamp the same status. Past-dated visits ARE included on purpose:
// a visit still sitting at "upcoming" two weeks after its date is exactly the one
// that needs closing. Requires a numeric visit id, which is Core's {visit_id}.
//
// NOTE: visibility only. The backend re-checks permission (_can_edit_visit) and
// the UI already renders this inside an edit-gated branch.
export function canCompleteVisit(v) {
  if (!v) return false;
  const st = String(v.status || '').trim().toLowerCase();
  if (st !== 'upcoming') return false;
  return /^\d+$/.test(String(v.id || v.visit_code || '').trim());
}

// Can a REVISIT be booked off this visit (docs/CP_REVISIT_RESCHEDULE.md)?
//
// The mirror of canCompleteVisit: Core clones only a COMPLETED visit into a new
// upcoming one, and rejects anything else with
// "Revisit is only allowed when the prior visit is completed."
// Cancelled visits are excluded — Core refuses them, and a cancelled visit is not
// evidence the buyer saw the unit.
export function canRevisitVisit(v) {
  if (!v) return false;
  const st = String(v.status || '').trim().toLowerCase();
  if (st !== 'completed') return false;
  return /^\d+$/.test(String(v.id || v.visit_code || '').trim());
}

export function buildRevisitIndex(visits = []) {
  const groups = new Map();
  for (const v of visits) {
    const hid = String(v.home_id || '').trim();
    const cp = (v.cp_code || '').trim();
    const bk = revisitBuyerKey(v);
    if (!hid || !cp || !bk) continue;               // missing any key → never a revisit
    const key = hid + '|' + cp + '|' + bk;
    let g = groups.get(key);
    if (!g) { g = []; groups.set(key, g); }
    g.push(v);
  }
  const index = new Map();
  for (const [key, arr] of groups) {
    if (arr.length < 2) continue;                   // singletons are never revisits
    const sorted = arr.slice().sort((a, b) => (visitDay(a) || '9999-99-99').localeCompare(visitDay(b) || '9999-99-99'));
    const info = new Map();
    let anyRevisit = false;
    for (const v of sorted) {
      const day = visitDay(v);
      // a REVISIT iff a strictly-earlier visit in the group is 'completed'
      const priorCompleted = day ? sorted.filter((x) => x !== v && isCompletedStatus(x) && visitDay(x) && visitDay(x) < day).length : 0;
      const isRevisit = priorCompleted >= 1 && isRealStatus(v);   // a cancelled later visit is NOT a revisit
      if (isRevisit) anyRevisit = true;
      info.set(v, { isRevisit, revisitSeq: priorCompleted + 1 });
    }
    if (!anyRevisit) continue;                       // repeat rows but no completed-prior → not a revisit chain
    // representative row (shown in the Visits tab) = the LATEST real (completed/upcoming)
    // visit — never a cancelled one; falls back to latest-dated if somehow none are real.
    const real = sorted.filter((v) => visitDay(v) && isRealStatus(v));
    const latest = real[real.length - 1] || sorted[sorted.length - 1];
    const firstDated = sorted.find((v) => visitDay(v));
    const firstDate = firstDated ? visitDay(firstDated) : '';
    for (const v of sorted) {
      const s = info.get(v);
      index.set(v.id, {
        chainKey: key, chainSize: arr.length,
        isRevisit: s.isRevisit, revisitSeq: s.revisitSeq,
        isChainLatest: v.id === latest.id, chainLatestId: latest.id, firstDate,
      });
    }
  }
  return index;
}
