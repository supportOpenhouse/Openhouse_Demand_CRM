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

export function fmtDate(d) {
  if (!d) return '—';
  const x = d instanceof Date ? d : new Date(d);
  if (isNaN(x)) return d;
  return x.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
}

// date + time, e.g. "14 Jun, 3:00 PM" — for scheduled revisit / negotiation meetings
export function fmtDateTime(d) {
  if (!d) return '—';
  const x = d instanceof Date ? d : new Date(d);
  if (isNaN(x)) return d;
  return x.toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true });
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
