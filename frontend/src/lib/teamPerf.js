// Team Performance metrics — computed client-side over the (admin) seed, the same
// way Analytics / Property Status derive from the snapshot. "Backend" columns are
// always recomputed here (read-only); "manual" columns come from team_perf_manual
// via the API and are admin-editable. Counts use COMPLETED visits only.
import { visitStage, isVisitCompleted } from './visits.js';

const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const TODAY = ymd(new Date());
const r1 = (x) => Math.round(x * 10) / 10;

// Column specs (order mirrors the planning sheet). kind: 'backend' = read-only,
// 'manual' = admin-editable. pct/dec are display hints.
export const GROUND_COLS = [
  { k: 'engagement_meetings', label: 'Engagement Meetings', kind: 'manual' },
  { k: 'props', label: 'Total Properties assigned', kind: 'backend' },
  { k: 'visit_per_prop', label: 'Visit per property', kind: 'backend', dec: 1 },
  { k: 't34', label: 'Visit Contribution · T3 & T4 CPs', kind: 'backend' },
  { k: 'neg_aligned', label: 'Negotiation Aligned', kind: 'backend' },
  { k: 'neg_conducted', label: 'Negotiation conducted', kind: 'backend' },
  { k: 'conv', label: 'Visit→sale conversion %', kind: 'backend', pct: true },
  { k: 'sale', label: 'Sale', kind: 'backend' },
  { k: 'sales_pending_l1', label: 'Sales pending L1', kind: 'manual' },
  { k: 'sales_pending_l2', label: 'Sales pending L2', kind: 'manual' },
];
export const KAM_COLS = [
  { k: 'total_dialled', label: 'Total Dialled', kind: 'manual' },
  { k: 'connected_pct', label: 'Total Connected %', kind: 'manual' },
  { k: 'engagement_meetings', label: 'Engagement Meetings', kind: 'manual' },
  { k: 'visit_per_cp', label: 'Visits per CP', kind: 'backend', dec: 1 },
  { k: 'neg_aligned', label: 'Negotiation Aligned', kind: 'backend' },
  { k: 'neg_conducted', label: 'Negotiation conducted', kind: 'backend' },
  { k: 'conv', label: 'Visit→sale conversion %', kind: 'backend', pct: true },
  { k: 'sale', label: 'Sale', kind: 'backend' },
  { k: 'sales_pending_l1', label: 'Sales pending L1', kind: 'manual' },
  { k: 'sales_pending_l2', label: 'Sales pending L2', kind: 'manual' },
  { k: 'sales_pending_l3', label: 'Sales pending L3', kind: 'manual' },
];
const MANUAL_KEYS = {
  ground: ['engagement_meetings', 'sales_pending_l1', 'sales_pending_l2'],
  kam: ['total_dialled', 'connected_pct', 'engagement_meetings', 'sales_pending_l1', 'sales_pending_l2', 'sales_pending_l3'],
};

function inRange(d, from, to) {
  if (!d) return false;
  const s = String(d).slice(0, 10);
  if (from && s < from) return false;
  if (to && s > to) return false;
  return true;
}

// Backend metrics from a set of visits (completed only) + the denominator count.
function compute(visits, denom, tierByCp) {
  const done = visits.filter(isVisitCompleted);
  const n = done.length;
  let t34 = 0, sale = 0, negA = 0, negC = 0;
  for (const v of done) {
    const tier = tierByCp[v.cp_code];
    if (tier === 'T3' || tier === 'T4') t34 += 1;
    const sg = visitStage(v);
    if (sg === 'booking' || sg === 'ats') sale += 1;
    else if (sg === 'after_negotiation_fu') negC += 1;
    else if (sg === 'negotiation' && v._negotiation_date && String(v._negotiation_date).slice(0, 10) >= TODAY) negA += 1;
  }
  return { _visits: n, t34, sale, neg_aligned: negA, neg_conducted: negC,
    conv: n ? r1((sale / n) * 100) : 0, per: denom ? r1(n / denom) : 0 };
}

const tierMap = (seed) => {
  const m = {}; (seed.brokers || []).forEach((b) => { m[b.cp_code] = b.tier; }); return m;
};
const usersMap = (seed) => {
  const m = {}; (seed.users || []).forEach((u) => { m[u.slug] = u; }); return m;
};
const pickManual = (man, keys) => {
  const o = {}; keys.forEach((k) => { o[k] = (man && man[k]) || ''; }); return o;
};

// sum the backend count columns; recompute ratios from the summed parts; manual blank.
function totalRow(rows, denomKey) {
  const t = { _visits: 0, _denom: 0, t34: 0, sale: 0, neg_aligned: 0, neg_conducted: 0 };
  rows.forEach((r) => {
    t._visits += r._visits || 0; t._denom += r[denomKey] || 0; t.t34 += r.t34 || 0;
    t.sale += r.sale || 0; t.neg_aligned += r.neg_aligned || 0; t.neg_conducted += r.neg_conducted || 0;
  });
  return { ...t, [denomKey]: t._denom,
    conv: t._visits ? r1((t.sale / t._visits) * 100) : 0,
    [denomKey === 'props' ? 'visit_per_prop' : 'visit_per_cp']: t._denom ? r1(t._visits / t._denom) : 0 };
}

// GROUND: one row per PM (under their dominant micro-market); region subtotals + grand total.
export function buildGround(seed, manual = {}, { from = '', to = '', cities = [] } = {}) {
  const props = seed.properties || [];
  const pmByProp = seed.pm_by_property || {};
  const tierByCp = tierMap(seed);
  const users = usersMap(seed);

  const pm = {}; const homeIdToPm = {};
  for (const p of props) {
    const slug = pmByProp[p.property_name];
    if (!slug) continue;
    const e = pm[slug] || (pm[slug] = { homeIds: new Set(), mm: {}, name: (users[slug] && users[slug].name) || slug });
    if (p.home_id) { e.homeIds.add(String(p.home_id)); homeIdToPm[String(p.home_id)] = slug; }
    const mm = (p.micro_market || '—').trim() || '—';
    e.mm[mm] = (e.mm[mm] || 0) + 1;
  }
  const visByPm = {};
  for (const v of (seed.visits || [])) {
    const slug = homeIdToPm[String(v.home_id)];
    if (!slug || !inRange(v.visit_date, from, to)) continue;
    if (cities.length && !cities.includes(v.city)) continue;
    (visByPm[slug] || (visByPm[slug] = [])).push(v);
  }
  const rows = Object.keys(pm).map((slug) => {
    const e = pm[slug];
    const mm = Object.entries(e.mm).sort((a, b) => b[1] - a[1])[0];
    const propCount = e.homeIds.size;
    const m = compute(visByPm[slug] || [], propCount, tierByCp);
    return { slug, name: e.name, mm: (mm && mm[0]) || '—', props: propCount, visit_per_prop: m.per,
      t34: m.t34, neg_aligned: m.neg_aligned, neg_conducted: m.neg_conducted, conv: m.conv, sale: m.sale,
      _visits: m._visits, ...pickManual(manual[slug], MANUAL_KEYS.ground) };
  });
  const byMm = {};
  rows.forEach((r) => { (byMm[r.mm] || (byMm[r.mm] = [])).push(r); });
  const groups = Object.keys(byMm).sort().map((mm) => ({
    mm, rows: byMm[mm].sort((a, b) => a.name.localeCompare(b.name)), subtotal: totalRow(byMm[mm], 'props') }));
  return { groups, grand: totalRow(rows, 'props') };
}

// KAM: flat list (one row per KAM) + an Overall row.
export function buildKam(seed, manual = {}, { from = '', to = '', cities = [] } = {}) {
  const cpOwner = seed.cp_owner || {};
  const tierByCp = tierMap(seed);
  const users = usersMap(seed);

  const kam = {};
  for (const b of (seed.brokers || [])) {
    const owner = cpOwner[b.cp_code];
    const u = owner && users[owner];
    if (!u || u.team !== 'KAM') continue;
    (kam[owner] || (kam[owner] = { cps: new Set(), name: u.name })).cps.add(b.cp_code);
  }
  const visByKam = {};
  for (const v of (seed.visits || [])) {
    const owner = cpOwner[v.cp_code];
    if (!owner || !kam[owner] || !inRange(v.visit_date, from, to)) continue;
    if (cities.length && !cities.includes(v.city)) continue;
    (visByKam[owner] || (visByKam[owner] = [])).push(v);
  }
  const rows = Object.keys(kam).map((slug) => {
    const e = kam[slug];
    const cpCount = e.cps.size;
    const m = compute(visByKam[slug] || [], cpCount, tierByCp);
    return { slug, name: e.name, cps: cpCount, visit_per_cp: m.per, t34: m.t34,
      neg_aligned: m.neg_aligned, neg_conducted: m.neg_conducted, conv: m.conv, sale: m.sale,
      _visits: m._visits, ...pickManual(manual[slug], MANUAL_KEYS.kam) };
  }).sort((a, b) => a.name.localeCompare(b.name));
  return { rows, overall: totalRow(rows, 'cps') };
}

// the set of cities present (for the City filter), from properties + visits
export function teamPerfCities(seed) {
  const s = new Set();
  (seed.properties || []).forEach((p) => { if (p.city) s.add(p.city); });
  (seed.visits || []).forEach((v) => { if (v.city) s.add(v.city); });
  return [...s].sort();
}

export function fmtCell(v, col) {
  if (v === '' || v == null) return col.kind === 'manual' ? '' : '—';
  if (col.pct) return `${v}%`;
  if (col.dec != null) return Number(v).toFixed(col.dec);
  return v;
}
