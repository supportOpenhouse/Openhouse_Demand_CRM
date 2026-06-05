// Analytics aggregation engine — pure, dependency-free. Operates over seed.visits.
// Every chart/metric is computed client-side from the already-loaded visits.

// ---- derived dimensions ----------------------------------------------------
export function apartmentOf(v) {
  // spec: concat(Unit Address 2, Unit Address 1, Society Name)
  return [v.unit_address_line2, v.unit_address_line1, v.society_name]
    .map((x) => (x || '').trim())
    .filter(Boolean)
    .join(' · ') || '—';
}

export function sourceLabel(v) {
  const s = (v.source || '').toLowerCase();
  if (s === 'direct') return 'Direct';
  if (s === 'channel_partner' || s === 'cp') return 'CP';
  return 'Other';
}

export const STATUS_OPTS = ['completed', 'upcoming', 'cancelled'];
export const STATUS_LABEL = { completed: 'Completed', upcoming: 'Upcoming', cancelled: 'Cancelled' };

export const LEAD_STATUS_OPTS = ['hot', 'warm', 'cold', 'dead', 'future_prospect', 'select_status'];
export const LEAD_STATUS_LABEL = {
  hot: 'Hot', warm: 'Warm', cold: 'Cold', dead: 'Dead',
  future_prospect: 'Future Prospect', select_status: 'Not Updated',
};

export function brokerLabel(v) {
  const name = (v.broker_name || '').trim();
  const co = (v.company_name || '').trim();
  const cp = (v.cp_code || '').trim();
  let s = name || cp || '—';
  if (co && co.toLowerCase() !== 'individual') s += ` · ${co}`;
  if (cp) s += ` (${cp})`;
  return s;
}

// "added by" — sheet stores e.g. "Sales : Rahul Singh" or "Broker : Naveen".
export function addedByOf(v) {
  const raw = (v.first_added_by || v.added_by || '').trim();
  if (!raw) return { kind: 'Unknown', name: '—', label: '— (Unknown)' };
  const m = raw.split(':');
  const kindRaw = (m[0] || '').trim().toLowerCase();
  const name = (m.slice(1).join(':') || raw).trim() || '—';
  const kind = kindRaw.startsWith('sales') ? 'Sales Manager' : kindRaw.startsWith('broker') ? 'Broker' : 'Other';
  return { kind, name, label: `${name} · ${kind}` };
}

// ---- distinct-count keys ---------------------------------------------------
const propKey = (v) => (v.society_name || '').trim().toLowerCase();
const aptKey = (v) => apartmentOf(v).toLowerCase();
const cpKey = (v) => (v.cp_code || '').trim();
const buyerKey = (v) => (v.lead_key || v.buyer_contact || `${v.buyer_name}|${v.buyer_contact}` || '').trim();

export const uniq = (rows, fn) => {
  const s = new Set();
  for (const r of rows) { const k = fn(r); if (k) s.add(k); }
  return s.size;
};
export const uniqProps = (rows) => uniq(rows, propKey);
export const uniqApts = (rows) => uniq(rows, aptKey);
export const uniqCps = (rows) => uniq(rows, cpKey);
export const uniqBuyers = (rows) => uniq(rows, buyerKey);
export const perProperty = (rows) => { const p = uniqProps(rows); return p ? rows.length / p : 0; };

// ---- filtering -------------------------------------------------------------
// f = filter-bar state; cross = single-value cross-filters from chart clicks.
export function applyFilters(visits, f = {}, cross = {}) {
  const has = (arr) => Array.isArray(arr) && arr.length > 0;
  const buyerQ = (f.buyerQuery || '').trim().toLowerCase();
  return visits.filter((v) => {
    const d = v.selected_date || v.visit_date || '';
    if (f.dateFrom && d && d < f.dateFrom) return false;
    if (f.dateTo && d && d > f.dateTo) return false;
    if (f.dateFrom && !d) return false;
    if (has(f.statuses) && !f.statuses.includes((v.status || '').toLowerCase())) return false;
    if (has(f.leadStatuses) && !f.leadStatuses.includes((v.lead_status || '').toLowerCase())) return false;
    if (has(f.sources) && !f.sources.includes(sourceLabel(v))) return false;
    if (has(f.cities) && !f.cities.includes(v.city || '')) return false;
    if (has(f.societies) && !f.societies.includes(v.society_name || '')) return false;
    if (has(f.apartments) && !f.apartments.includes(apartmentOf(v))) return false;
    if (has(f.salesManagers) && !f.salesManagers.includes(v.sales_manager || '')) return false;
    if (has(f.brokers) && !f.brokers.includes(v.cp_code || '')) return false;
    if (has(f.listingStatuses) && !f.listingStatuses.includes((v.listing_status || '').trim() || '(blank)')) return false;
    if (buyerQ) {
      const hay = `${v.buyer_name || ''} ${v.buyer_contact || ''}`.toLowerCase();
      if (!hay.includes(buyerQ)) return false;
    }
    // cross-filters (from clicking a chart bar/row)
    if (cross.month && (d.slice(0, 7) !== cross.month)) return false;
    if (cross.day && (d.slice(0, 10) !== cross.day)) return false;
    if (cross.apartment && apartmentOf(v) !== cross.apartment) return false;
    if (cross.city && (v.city || '') !== cross.city) return false;
    if (cross.salesManager && (v.sales_manager || '') !== cross.salesManager) return false;
    if (cross.broker && (v.cp_code || '') !== cross.broker) return false;
    if (cross.source && sourceLabel(v) !== cross.source) return false;
    if (cross.addedBy && addedByOf(v).label !== cross.addedBy) return false;
    return true;
  });
}

// ---- generic group + metrics ----------------------------------------------
// keyFn -> bucket key (string); labelFn -> display; metrics computed per bucket.
export function groupAgg(rows, keyFn, metricsFn, { sortBy = 'primary', limit = 0 } = {}) {
  const buckets = new Map();
  for (const r of rows) {
    const k = keyFn(r);
    if (k == null || k === '') continue;
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push(r);
  }
  let out = [];
  for (const [k, rs] of buckets) out.push({ key: k, rows: rs, ...metricsFn(rs) });
  out.sort((a, b) => (b[sortBy] ?? b.primary) - (a[sortBy] ?? a.primary));
  if (limit) out = out.slice(0, limit);
  return out;
}

// ---- per-chart builders ----------------------------------------------------
const ym = (v) => (v.selected_date || v.visit_date || '').slice(0, 7);
const ymd = (v) => (v.selected_date || v.visit_date || '').slice(0, 10);

export function chartMonth(rows) { // Chart 1
  return groupAgg(rows, ym, (rs) => ({
    primary: rs.length, visits: rs.length, buyers: uniqBuyers(rs), perProp: perProperty(rs),
  }), { sortBy: 'key_asc' }).sort((a, b) => (a.key < b.key ? -1 : 1));
}
export function chartApartment(rows, limit = 20) { // Chart 2
  return groupAgg(rows, (v) => apartmentOf(v), (rs) => ({ primary: rs.length, visits: rs.length, cps: uniqCps(rs) }), { limit });
}
export function chartDay(rows) { // Chart 3 (line)
  const m = new Map();
  for (const v of rows) { const d = ymd(v); if (!d) continue; m.set(d, (m.get(d) || 0) + 1); }
  return [...m.entries()].map(([day, n]) => ({ day, n })).sort((a, b) => (a.day < b.day ? -1 : 1));
}
export function chartBroker(rows, limit = 20) { // Chart 4
  return groupAgg(rows, (v) => v.cp_code || '', (rs) => ({
    primary: rs.length, visits: rs.length, props: uniqProps(rs), label: brokerLabel(rs[0]),
  }), { limit });
}
export function chartSM(rows, limit = 25) { // Chart 5
  return groupAgg(rows, (v) => v.sales_manager || '', (rs) => ({ primary: rs.length, visits: rs.length, apts: uniqApts(rs) }), { limit });
}
export function chartAddedBy(rows, limit = 25) { // Chart 6
  return groupAgg(rows, (v) => addedByOf(v).label, (rs) => ({ primary: rs.length, visits: rs.length, kind: addedByOf(rs[0]).kind }), { limit });
}
export function chartCity(rows) { // Chart 7
  return groupAgg(rows, (v) => v.city || '', (rs) => ({
    primary: rs.length, visits: rs.length, apts: uniqApts(rs), perProp: perProperty(rs),
    buyers: uniqBuyers(rs), buyersPerProp: uniqProps(rs) ? uniqBuyers(rs) / uniqProps(rs) : 0,
  }));
}
export function chartSource(rows) { // Chart 8
  return groupAgg(rows, (v) => sourceLabel(v), (rs) => ({ primary: rs.length, visits: rs.length, perProp: perProperty(rs) }));
}

// ---- KPI summary -----------------------------------------------------------
export function kpis(rows) {
  return {
    visits: rows.length,
    buyers: uniqBuyers(rows),
    cps: uniqCps(rows),
    properties: uniqProps(rows),
    apartments: uniqApts(rows),
    perProperty: perProperty(rows),
  };
}

// ---- distinct option lists for filter dropdowns ----------------------------
export function optionLists(visits) {
  const set = (fn) => [...new Set(visits.map(fn).filter((x) => x && x !== '—'))].sort();
  return {
    cities: set((v) => v.city || ''),
    societies: set((v) => v.society_name || ''),
    apartments: set((v) => apartmentOf(v)),
    salesManagers: set((v) => v.sales_manager || ''),
    brokers: [...new Map(visits.filter((v) => v.cp_code).map((v) => [v.cp_code, brokerLabel(v)])).entries()]
      .map(([cp, label]) => ({ value: cp, label })).sort((a, b) => a.label.localeCompare(b.label)),
    listingStatuses: set((v) => (v.listing_status || '').trim() || '(blank)'),
  };
}

// ---- CSV -------------------------------------------------------------------
const CSV_COLS = [
  ['selected_date', 'Selected Date'], ['visit_date', 'Visit Date'], ['city', 'City'],
  ['society_name', 'Society'], ['apartment', 'Apartment'], ['listing_status', 'Listing Status'],
  ['status', 'Status'], ['lead_status', 'Lead Status'], ['source', 'Source'],
  ['sales_manager', 'Sales Manager'], ['added_by', 'Added By'],
  ['broker_name', 'Broker'], ['company_name', 'Company'], ['cp_code', 'CP Code'],
  ['buyer_name', 'Buyer'], ['buyer_contact', 'Buyer Contact'],
];
function csvCell(s) {
  const t = s == null ? '' : String(s);
  return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
}
export function visitsToCsv(rows) {
  const head = CSV_COLS.map(([, h]) => csvCell(h)).join(',');
  const body = rows.map((v) => CSV_COLS.map(([k]) => csvCell(k === 'apartment' ? apartmentOf(v)
    : k === 'source' ? sourceLabel(v) : v[k])).join(',')).join('\n');
  return head + '\n' + body;
}
export function downloadCsv(rows, name = 'oh-analytics') {
  const blob = new Blob([visitsToCsv(rows)], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `${name}-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
