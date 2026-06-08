// Shared derivation helpers ported verbatim from crm.html so every rebuilt view
// computes identically to the legacy app. Pure where possible; data-dependent
// helpers take their data (visits / nudgesByVisit / teamTasks / properties) as args
// (the legacy read globals `store.*`).
import { daysBetween, fmtDate } from './format.js';

export const TEAM_PILL = { Admin: 'admin', TL: 'tl', KAM: 'kam', Ground: 'ground' };
export const TEAM_LABEL = { Admin: 'Admin', TL: 'Team Lead', KAM: 'Key Account Manager', Ground: 'Ground Team' };

// ---- price parsing / formatting (e.g. "1.2 Cr", "85 L") ----
export const parsePrice = (s) => {
  if (!s) return 0;
  const m = String(s).match(/([\d.]+)\s*(L|Cr|K)?/i);
  if (!m) return 0;
  const n = parseFloat(m[1]) || 0;
  const u = (m[2] || '').toUpperCase();
  return u === 'CR' ? n * 1e7 : u === 'K' ? n * 1e3 : u === 'L' ? n * 1e5 : n;
};
export const fmtPrice = (p) => {
  if (!p) return '—';
  if (p >= 1e7) return '₹' + (p / 1e7).toFixed(p % 1e7 === 0 ? 0 : 2) + ' Cr';
  if (p >= 1e5) return '₹' + (p / 1e5).toFixed(p % 1e5 === 0 ? 0 : 2) + ' L';
  return '₹' + Math.round(p).toLocaleString('en-IN');
};

// ---- next-followup urgency chip (overdue / today / tomorrow / soon / later / none) ----
export function nextFuClass(date) {
  if (!date) return { cls: 'none', label: 'No FU' };
  const d = daysBetween(date);
  if (d == null) return { cls: 'none', label: '—' };
  if (d > 0) return { cls: 'overdue', label: d === 1 ? '1d overdue' : `${d}d overdue` };
  if (d === 0) return { cls: 'today', label: 'Today' };
  if (d === -1) return { cls: 'tomorrow', label: 'Tomorrow' };
  if (d > -7) return { cls: 'soon', label: `in ${-d}d` };
  return { cls: 'later', label: fmtDate(date) };
}

// ---- last followup taken ----
// The seed's latest_followup_date is the projection of the most recent followup,
// but a followup can exist in seed.followups while the projection is blank (visit
// outside the projection window, sheet quirks). So we overlay seed.followups,
// exactly like the legacy overlaid store.followupLog. Build the map once per render
// with buildFuByVisit(seed.followups) and thread it in.
export function buildFuByVisit(followups = []) {
  const m = {};
  followups.forEach((f) => {
    const d = (f.ts || '').slice(0, 10);
    if (!d || !f.visit_id) return;
    const cur = m[f.visit_id];
    if (!cur || d > cur.date) m[f.visit_id] = { date: d, by: f.by };
  });
  return m;
}
export function lastFollowupTakenForVisit(v, fuByVisit) {
  let d = v.latest_followup_date || null;
  const f = fuByVisit && fuByVisit[v.id];
  if (f && f.date && (!d || f.date > d)) d = f.date;
  return d || null;
}
// who took the latest FU: the projection author (slug), else the followups-log author.
export function lastFollowupByForVisit(v, fuByVisit) {
  if (v.latest_followup_by) return v.latest_followup_by;
  const f = fuByVisit && fuByVisit[v.id];
  return (f && f.by) || null;
}
export function lastFollowupTakenForCp(cp, visits = [], fuByVisit) {
  let d = null;
  visits.forEach((v) => {
    if (v.cp_code !== cp) return;
    const lf = lastFollowupTakenForVisit(v, fuByVisit);
    if (lf && (!d || lf > d)) d = lf;
  });
  return d;
}

// ---- priority flags ----
export function isVisitNudged(v, nudgesByVisit = {}) {
  const arr = nudgesByVisit[v.id];
  return !!(arr && arr.some((n) => !n.resolved));
}
export function isVisitTlAsk(v, teamTasks = {}) {
  if (!v.cp_code) return false;
  return Object.values(teamTasks).some((tt) => (tt.daily_calls || []).includes(v.cp_code));
}
export function isCpNudged(cp, visits = [], nudgesByVisit = {}) {
  return visits.some((v) => v.cp_code === cp && isVisitNudged(v, nudgesByVisit));
}
export function isCpTlAsk(cp, teamTasks = {}) {
  return Object.values(teamTasks).some((tt) => (tt.daily_calls || []).includes(cp));
}

// ---- price for a visit ----
// Primary: exact unit match via home_id (set on both visits + properties by the
// sheet sync) — the only reliable join when a society has several priced units.
// Fallback (home_id not mapped): society + unit-substring match, else society
// median. The substring guard (len >= 2) stops a 1-char tower letter like "A"
// from matching the society name ("oAsis") and returning a random unit's price.
export function priceForVisit(v, properties = []) {
  const vid = String(v.home_id || '').trim();
  if (vid) {
    const hit = properties.find((p) => String(p.home_id || '').trim() === vid);
    if (hit) return parsePrice(hit.listing_price);
  }
  const props = properties.filter((p) => p.society_name === v.society_name);
  if (!props.length) return 0;
  const u1 = (v.unit_address_line1 || '').trim().toLowerCase();
  const u2 = (v.unit_address_line2 || '').trim().toLowerCase();
  for (const p of props) {
    const n = (p.property_name || '').toLowerCase();
    if (u1.length >= 2 && n.includes(u1)) return parsePrice(p.listing_price);
    if (u2.length >= 2 && n.includes(u2)) return parsePrice(p.listing_price);
  }
  const prices = props.map((p) => parsePrice(p.listing_price)).filter(Boolean).sort((a, b) => a - b);
  return prices[Math.floor(prices.length / 2)] || 0;
}

// ---- visit "signals captured" intent block (broker popup / property modal) ----
export function classifyClosingSignal(s) {
  if (!s) return '';
  const l = s.toLowerCase();
  if (/(ready|positive|interested|will|book|yes)/.test(l) && !/non-committal/.test(l)) return 'good';
  if (/(non-committal|maybe|think|consider|later)/.test(l)) return 'warn';
  if (/(not|negative|no|reject)/.test(l)) return 'bad';
  return '';
}
export function visitIntentItems(v) {
  return [
    { k: 'Time on site', val: v.time_spent_on_site },
    { k: 'Amenity tour', val: v.society_amenity_tour },
    { k: 'Price discussion', val: v.price_discussion },
    { k: 'Client queries', val: v.client_queries, full: true },
    { k: 'Closing signal', val: v.closing_signal, full: true, signalClass: classifyClosingSignal(v.closing_signal) },
    { k: 'Primary concern', val: v.buyer_primary_concern, full: true },
    { k: 'Profession', val: v.profession },
    { k: 'Buyer feedback', val: v.buyer_feedback, full: true },
    { k: 'Sales feedback', val: v.sales_feedback, full: true },
  ].filter((it) => it.val && String(it.val).trim() && it.val !== 'None');
}
