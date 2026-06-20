// API client. Same-origin in prod (Vercel rewrites /api,/auth,/health → Render)
// and via the Vite dev proxy locally, so no CORS and cookies "just work".
export async function apiFetch(path, opts = {}) {
  const res = await fetch(path, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
    ...opts,
  });
  if (res.status === 401) {
    // Not signed in → bounce to Google login, return here afterwards.
    window.location.href = `/auth/google/start?next=${encodeURIComponent(location.href)}`;
    return new Promise(() => {}); // suspend caller until redirect
  }
  return res;
}

export async function loadSeed() {
  const res = await apiFetch('/api/seed');
  if (!res.ok) throw new Error(`seed failed (HTTP ${res.status})`);
  return res.json();
}

// Full CP directory for the Book Visits picker (any signed-in user) — lets an RM pick
// any channel partner, not just the ones in their scoped seed. Callers fall back to the
// scoped seed.brokers if this fails, so the picker always works.
export async function loadAllCps() {
  const res = await apiFetch('/api/cps');
  if (!res.ok) throw new Error(`cps failed (HTTP ${res.status})`);
  return res.json();
}

export async function loadTopBrokers() {
  const res = await apiFetch('/api/top-brokers');
  if (!res.ok) throw new Error(`top-brokers failed (HTTP ${res.status})`);
  return res.json();
}

export async function setTopBrokerPhone(id, phone) {
  const res = await apiFetch(`/api/top-brokers/${id}/phone`, {
    method: 'POST', body: JSON.stringify({ phone }),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

// Key-handover dates from the external properties DB (Analytics Property-Status).
export async function loadKeyHandovers() {
  const res = await apiFetch('/api/key-handovers');
  if (!res.ok) throw new Error(`key-handovers failed (HTTP ${res.status})`);
  return res.json();   // { items:[{society,unit,kh_date}], overrides:{home_id:kh_date}, source, count }
}
// Admin: set/clear a manual KH-date override for a unit (by home_id). kh_date '' clears.
export async function setKhOverride(body) {
  const res = await apiFetch('/api/kh-override', { method: 'POST', body: JSON.stringify(body) });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function saveFollowup(body) {
  const res = await apiFetch('/api/followups', { method: 'POST', body: JSON.stringify(body) });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

// Book 1–10 visits on the Core app (admin-only). body = { visits: [...] }.
// Returns { booked, failed, results:[{home_id, ok, visit?, error?, remaining_days?}] }.
export async function bookVisits(body) {
  const res = await apiFetch('/api/visits/book', { method: 'POST', body: JSON.stringify(body) });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function setBrokerTier(cp, tier) {
  const res = await apiFetch(`/api/brokers/${encodeURIComponent(cp)}/tier`, { method: 'POST', body: JSON.stringify({ tier }) });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function setBrokerOwner(cp, owner_slug) {
  const res = await apiFetch(`/api/brokers/${encodeURIComponent(cp)}/owner`, { method: 'POST', body: JSON.stringify({ owner_slug: owner_slug || null }) });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function markNotifRead(id) {
  const res = await apiFetch(`/api/notifications/${encodeURIComponent(id)}/read`, { method: 'POST' });
  return res.ok;
}
export async function markAllNotifsRead() {
  const res = await apiFetch('/api/notifications/read_all', { method: 'POST' });
  return res.ok;
}
export async function bulkAssign(body) {
  const res = await apiFetch('/api/brokers/bulk_assign', { method: 'POST', body: JSON.stringify(body) });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}
export async function saveEngagement(body) {
  const res = await apiFetch('/api/engagements', { method: 'POST', body: JSON.stringify(body) });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}
export async function addNudge(body) {
  const res = await apiFetch('/api/nudges', { method: 'POST', body: JSON.stringify(body) });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

// --- Hiring planning (Admin only on the backend) ---
export async function loadHiring() {
  const res = await apiFetch('/api/hiring');
  if (!res.ok) throw new Error(`hiring failed (HTTP ${res.status})`);
  return res.json();
}
export async function setHiringMmOverride(body) {
  const res = await apiFetch('/api/hiring/mm-override', { method: 'POST', body: JSON.stringify(body) });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

// --- Team Performance manual cells (Admin only on the backend) ---
export async function loadTeamPerfManual() {
  const res = await apiFetch('/api/team-performance/manual');
  if (!res.ok) throw new Error(`team-performance failed (HTTP ${res.status})`);
  return res.json();   // { manual: { person_slug: { metric_key: value } } }
}
export async function setTeamPerfManual(body) {
  const res = await apiFetch('/api/team-performance/manual', { method: 'POST', body: JSON.stringify(body) });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

// --- Property Report mailer (Admin only on the backend) ---
// Pull the human-readable FastAPI {detail} out of an error response.
async function _errDetail(res) {
  const t = await res.text();
  try { return JSON.parse(t).detail || t; } catch { return t; }
}
// Build the report for a unit (metrics + optional Claude summary + rendered email HTML).
export async function previewReport(home_id) {
  const res = await apiFetch('/api/reports/property', { method: 'POST', body: JSON.stringify({ home_id }) });
  if (!res.ok) { const e = new Error(await _errDetail(res)); e.status = res.status; throw e; }
  return res.json();
}
// Drop the report as a DRAFT into the signed-in admin's own Gmail (recipient left blank).
export async function createReportDraft(body) {
  const res = await apiFetch('/api/reports/property/draft', { method: 'POST', body: JSON.stringify(body) });
  if (!res.ok) { const e = new Error(await _errDetail(res)); e.status = res.status; throw e; }
  return res.json();
}

// --- AI Suggestions (per-user daily morning brief; all roles) ---
export async function loadAiSuggestions() {
  const res = await apiFetch('/api/ai-suggestions');
  if (!res.ok) throw new Error(`ai-suggestions failed (HTTP ${res.status})`);
  return res.json();   // { payload:{counts,signals,brief,for_date,team}, generated_at, cached }
}
export async function refreshAiSuggestions() {
  const res = await apiFetch('/api/ai-suggestions/refresh', { method: 'POST' });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

// --- Roster admin (Admin only on the backend) ---
export async function createUser(body) {
  const res = await apiFetch('/api/users', { method: 'POST', body: JSON.stringify(body) });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}
export async function updateUser(slug, body) {
  const res = await apiFetch(`/api/users/${encodeURIComponent(slug)}`, { method: 'PATCH', body: JSON.stringify(body) });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}
