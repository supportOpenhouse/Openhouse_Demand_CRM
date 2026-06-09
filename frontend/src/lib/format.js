// Date / display helpers — ported from the legacy app so output matches exactly.
export const TODAY = new Date();

const startOfDay = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate());

export function ymd(d) {
  const x = d instanceof Date ? d : new Date(d);
  return x.getFullYear() + '-' + String(x.getMonth() + 1).padStart(2, '0') + '-' + String(x.getDate()).padStart(2, '0');
}

export function daysBetween(d) {
  if (!d) return null;
  const x = d instanceof Date ? d : new Date(d);
  if (isNaN(x)) return null;
  return Math.round((startOfDay(TODAY) - startOfDay(x)) / 86400000); // +ve = in the past
}

// All date formatting below is built MANUALLY (no toLocale*) so it's identical on
// every OS/browser. Locale formatters let the OS pick day-vs-month order, which made
// Windows show mm/dd and Mac dd/mm — we force day-first dd/mm/yyyy everywhere.
export const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad2 = (n) => String(n).padStart(2, '0');
export function fmtMonth(d) {
  const x = d instanceof Date ? d : new Date(d);
  return isNaN(x) ? '' : MONTHS[x.getMonth()];
}

// dd/mm/yyyy — deterministic, day-first.
export function fmtDate(d) {
  if (!d) return '—';
  const x = d instanceof Date ? d : new Date(d);
  if (isNaN(x)) return d;
  return `${pad2(x.getDate())}/${pad2(x.getMonth() + 1)}/${x.getFullYear()}`;
}

// dd/mm/yyyy, h:mm AM/PM — for scheduled revisit / negotiation meetings.
export function fmtDateTime(d) {
  if (!d) return '—';
  const x = d instanceof Date ? d : new Date(d);
  if (isNaN(x)) return d;
  let h = x.getHours();
  const ap = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${fmtDate(x)}, ${h}:${pad2(x.getMinutes())} ${ap}`;
}

export function fmtDay(d) {
  if (!d) return '—';
  const dd = daysBetween(d);
  if (dd == null) return d;
  if (dd === 0) return 'Today';
  if (dd === 1) return 'Yesterday';
  if (dd === -1) return 'Tomorrow';
  if (dd > 0 && dd < 7) return dd + 'd ago';
  if (dd < 0 && dd > -7) return 'in ' + (-dd) + 'd';
  return fmtDate(d);
}

export function initials(name = '') {
  return name.trim().split(/\s+/).slice(0, 2).map((w) => w[0] || '').join('').toUpperCase() || '?';
}
