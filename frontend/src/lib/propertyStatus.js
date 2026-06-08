// Property-Status report (Analytics tab): per-unit ageing + visit-bucket report.
// Joins live inventory (seed.properties) + visits (counts) + the external
// key-handover dates (/api/key-handovers), matching on society + unit "mix & match".
import { TODAY, ymd, daysBetween } from './format.js';
import { visitStage, visitStatus } from './visits.js';
import { parsePrice } from './legacy.js';

const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };

// society → canonical (alnum, upper) so "Gaur City 2 - 14th Avenue" == "Gaur City 2 14th Avenue"
export const normSoc = (s) => (s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

// unit → sorted set of alnum tokens (digits de-zeroed) so order/punctuation/zero-pad
// don't matter: "G - 805" == "805 G", "F-0105" == "F 105". This is the "mix & match".
export function unitKey(s) {
  return (s || '')
    .toUpperCase()
    .split(/[^A-Z0-9]+/)
    .filter(Boolean)
    // strip leading zeros (012 == 12) without a float round-trip (preserves long tokens)
    .map((t) => (/^\d+$/.test(t) ? t.replace(/^0+(?=\d)/, '') : t))
    .sort()
    .join('|');
}

// our property_name is "{unit}, {society}" → the unit is the part before the first
// comma. If there's no comma we can't tell the unit apart from the society, so return
// '' (no unit) rather than mis-using the whole name.
export const unitNoOf = (p) => {
  const name = p.property_name || '';
  return name.includes(',') ? name.split(',')[0].trim() : '';
};
const visitUnitKey = (v) => unitKey(`${v.unit_address_line1 || ''} ${v.unit_address_line2 || ''}`);

// KH match key: the external "properties" DB stores unit_no compactly ("405B",
// "12A04") with tower/block letters that DON'T agree with our "{tower} - {flat}"
// naming, so matching on letters yields ~0. The flat NUMBER agrees, so we key the
// key-handover lookup on society + the de-zeroed digit-runs only.
export const unitDigitKey = (s) => [...new Set(((s || '').match(/\d+/g) || []).map((d) => d.replace(/^0+(?=\d)/, '')))].sort().join('|');

// flat number ONLY — drop tower/block letters, keep the longest digit run (de-zeroed).
// "A-704" → "704", "704" → "704", "Tower 2, 1204" → "1204", "G-15" → "15".
// Used by the cascading unit filter so "A-704" and "704" collapse to one option ("704")
// and picking it matches every tower's unit-704.
export const flatNo = (s) => {
  const runs = ((s || '').match(/\d+/g) || []).map((d) => d.replace(/^0+(?=\d)/, ''));
  return runs.length ? runs.reduce((a, b) => (b.length >= a.length ? b : a)) : '';
};
const khKey = (society, unit) => `${normSoc(society)}#${unitDigitKey(unit)}`;

export function buildKhMap(items = []) {
  const m = {};
  items.forEach((it) => {
    const dk = unitDigitKey(it.unit);
    if (!dk || !it.kh_date) return;                 // need a flat number + date
    const k = `${normSoc(it.society)}#${dk}`;
    if (!m[k] || it.kh_date < m[k]) m[k] = it.kh_date;   // earliest wins → deterministic
  });
  return m;
}

export function weekWindows(today = TODAY) {
  const d0 = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const dow = (d0.getDay() + 6) % 7;                 // 0 = Monday
  const thisMon = addDays(d0, -dow);
  return {
    lastFrom: ymd(addDays(thisMon, -7)), lastTo: ymd(addDays(thisMon, -1)),
    prevFrom: ymd(addDays(thisMon, -14)), prevTo: ymd(addDays(thisMon, -8)),
  };
}

// stage → which bucket column it lands in (null = not counted)
function stageBucket(sg) {
  if (sg === 'revisit_scheduled' || sg === 'after_revisit_fu') return 'revisit';
  if (sg === 'negotiation') return 'negotiation';
  if (sg === 'booking') return 'booking';
  if (sg === 'not_interested') return 'not_interested';
  if (sg === 'need_more') return 'need_more';
  if (sg === 'future_prospect') return 'future_prospect';
  return null;
}

// ---- per-UNIT visit matching (fixes the society-wide-count bug) -------------
// home_id is the authoritative join (the sheet sync sets it on both visits AND
// properties); fall back to society + unit token-set only when a property has no
// home_id mapped (~4%). Build the index once, then visitsForProperty is O(1).
export function indexVisitsByProperty(visits = []) {
  const byHome = {}; const bySoc = {};
  visits.forEach((v) => {
    const h = String(v.home_id || '').trim();
    if (h) (byHome[h] = byHome[h] || []).push(v);
    const s = normSoc(v.society_name);
    if (s) (bySoc[s] = bySoc[s] || []).push(v);
  });
  return { byHome, bySoc };
}
export function visitsForProperty(p, idx) {
  const h = String(p.home_id || '').trim();
  if (h) return idx.byHome[h] || [];           // exact unit (or genuinely 0 — never society-wide)
  const uk = unitKey(unitNoOf(p));
  if (!uk) return [];
  return (idx.bySoc[normSoc(p.society_name)] || []).filter((v) => visitUnitKey(v) === uk);
}

export function buildPropertyStatusRows(properties = [], visits = [], khMap = {}) {
  const w = weekWindows();
  const idx = indexVisitsByProperty(visits);
  return properties.map((p) => {
    const unit = unitNoOf(p);
    const vs = visitsForProperty(p, idx);
    const c = {
      total: vs.length, lastWeek: 0, prevWeek: 0, hot: 0, warm: 0, cold: 0,
      revisit: 0, negotiation: 0, booking: 0, not_interested: 0, need_more: 0, future_prospect: 0,
    };
    vs.forEach((v) => {
      const d = v.visit_date || '';
      if (d >= w.lastFrom && d <= w.lastTo) c.lastWeek += 1;
      if (d >= w.prevFrom && d <= w.prevTo) c.prevWeek += 1;
      const st = visitStatus(v);
      if (st === 'hot' || st === 'warm' || st === 'cold') c[st] += 1;
      const b = stageBucket(visitStage(v));
      if (b) c[b] += 1;
    });
    const kh = khMap[khKey(p.society_name, unit)] || '';
    return {
      region: p.micro_market || '', society: p.society_name || '', unit,
      config: p.configuration || '', flat_status: p.listing_status || '',
      ask_price: p.listing_price || '', responsible: p.sales_manager || '',
      city: p.city_name || p.city || '',
      kh_date: kh, days_since_kh: kh ? daysBetween(kh) : null,
      ...c,
    };
  });
}

// columns: label + sort type. text | num | price
export const PS_COLUMNS = [
  { k: 'region', label: 'Region', type: 'text' },
  { k: 'society', label: 'Society Name', type: 'text' },
  { k: 'unit', label: 'Unit No', type: 'text' },
  { k: 'config', label: 'Config', type: 'text' },
  { k: 'flat_status', label: 'Flat Status', type: 'text' },
  { k: 'ask_price', label: 'Ask Price', type: 'price' },
  { k: 'responsible', label: 'Responsible Person', type: 'text' },
  { k: 'kh_date', label: 'KH Date', type: 'text' },
  { k: 'days_since_kh', label: 'Days Since KH', type: 'num' },
  { k: 'total', label: 'Total Visits', type: 'num' },
  { k: 'lastWeek', label: 'Last Week (Mon-Sun)', type: 'num' },
  { k: 'prevWeek', label: 'Prev Week', type: 'num' },
  { k: 'hot', label: 'Hot Leads', type: 'num' },
  { k: 'warm', label: 'Warm Leads', type: 'num' },
  { k: 'cold', label: 'Cold Leads', type: 'num' },
  { k: 'revisit', label: 'Revisit', type: 'num' },
  { k: 'negotiation', label: 'Negotiation', type: 'num' },
  { k: 'booking', label: 'Booking', type: 'num' },
  { k: 'not_interested', label: 'Not Interested', type: 'num' },
  { k: 'need_more', label: 'Need More Props', type: 'num' },
  { k: 'future_prospect', label: 'Future Prospect', type: 'num' },
];

export function sortRows(rows, key, dir) {
  const col = PS_COLUMNS.find((c) => c.k === key);
  if (!col) return rows;
  const sgn = dir === 'asc' ? 1 : -1;
  const val = (r) => {
    if (col.type === 'num') { const n = r[key]; return n == null ? (dir === 'asc' ? Infinity : -Infinity) : n; }
    if (col.type === 'price') return parsePrice(r[key]);
    return (r[key] || '').toString().toLowerCase();
  };
  return rows.slice().sort((a, b) => { const x = val(a), y = val(b); return (x > y ? 1 : x < y ? -1 : 0) * sgn; });
}

export function psToCsv(rows) {
  const esc = (s) => { const t = String(s ?? ''); return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };
  const head = PS_COLUMNS.map((c) => c.label).join(',');
  const body = rows.map((r) => PS_COLUMNS.map((c) => esc(c.k === 'days_since_kh' ? (r[c.k] == null ? '' : r[c.k]) : r[c.k])).join(',')).join('\n');
  return head + '\n' + body;
}
