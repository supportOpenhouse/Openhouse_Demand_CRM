// Channel-partner scoping + a one-pass per-CP index. The legacy CP table was slow
// because every row re-scanned all visits (lastFU, societies, last visit). Here we
// build those once (buildCpIndex) so each row is O(1) — the real fix for #1.

export function usersBySlug(seed) {
  const m = {};
  (seed.users || []).forEach((u) => { m[u.slug] = u; });
  if (seed.current_user) m[seed.current_user.slug] = seed.current_user;
  return m;
}

function isAdminOrTL(me) {
  return me.team === 'Admin' || me.team === 'TL' || me.role === 'admin' || (me.role || '').includes('tl');
}

// Which CPs the viewer "owns"/sees (ported from brokersForUser). Used to flag _mine
// (sort own to top) and to scope T1/T2; T3/T4 are visible to everyone.
export function ownedCpCodes(brokers, me, cpOwner, properties, visits) {
  if (!me || !me.id) return new Set(brokers.map((b) => b.cp_code));
  if (isAdminOrTL(me)) {
    if (me.role === 'tl_closer') return new Set(brokers.filter((b) => (me.cities || []).includes(b.city)).map((b) => b.cp_code));
    return new Set(brokers.map((b) => b.cp_code));
  }
  const codes = new Set();
  if (me.team === 'KAM') {
    brokers.forEach((b) => { if (cpOwner[b.cp_code] === me.id) codes.add(b.cp_code); });
    return codes;
  }
  if (me.team === 'Ground') {
    const socs = new Set((properties || []).filter((p) => p.sales_manager === me.name).map((p) => p.society_name));
    brokers.forEach((b) => { if (cpOwner[b.cp_code] === me.id) codes.add(b.cp_code); });
    visits.forEach((v) => { if (socs.has(v.society_name) && v.cp_code) codes.add(v.cp_code); });
    brokers.forEach((b) => { if (b.added_by === me.name) codes.add(b.cp_code); });
    return codes;
  }
  return codes;
}

export function buildCpIndex(visits, ubs) {
  const idx = {}; // cp -> { fuDate, fuBy, lastVisit, socs:Set, units:[] }
  for (const v of visits) {
    const cp = v.cp_code;
    if (!cp) continue;
    let e = idx[cp];
    if (!e) e = idx[cp] = { fuDate: null, fuBy: '', lastVisit: null, socs: new Set(), units: [] };
    if (v.society_name) e.socs.add(v.society_name);
    const unit = [v.unit_address_line1, v.unit_address_line2, v.floor].filter(Boolean).join(' ');
    if (unit) e.units.push(unit.toLowerCase());
    if (v.visit_date && (!e.lastVisit || v.visit_date > e.lastVisit)) e.lastVisit = v.visit_date;
    const d = v.latest_followup_date;
    if (d && (!e.fuDate || d > e.fuDate)) {
      e.fuDate = d;
      e.fuBy = (v.latest_followup_by && ubs[v.latest_followup_by]?.name) || v.sales_manager || '';
    }
  }
  return idx;
}

export const TIERS = ['T1', 'T2', 'T3', 'T4'];
export const TIER_META = {
  T1: { label: 'Tier 1 · Gold',   desc: 'KAM-owned · 50% commission at ATS · founders certificate · listing reimbursement' },
  T2: { label: 'Tier 2 · Silver', desc: 'KAM-owned · 25% commission at ATS · early-access inventory · promotion path to T1' },
  T3: { label: 'Tier 3',          desc: 'Ground-Team owned · active but inconsistent · push to ≥3 visits/mo' },
  T4: { label: 'Tier 4',          desc: 'Ground-Team owned · inactive / dormant · periodic reactivation push' },
};

export function sortInTier(list, sort) {
  return list.slice().sort((a, b) => {
    if (!!a._mine !== !!b._mine) return (b._mine ? 1 : 0) - (a._mine ? 1 : 0);
    if (sort === 'rank') return (a.tier_rank || 9999) - (b.tier_rank || 9999);
    if (sort === 'd30') return (b.d30_visits || 0) - (a.d30_visits || 0);
    if (sort === 'all_time') return (b.all_time_visits || 0) - (a.all_time_visits || 0);
    return 0;
  });
}
