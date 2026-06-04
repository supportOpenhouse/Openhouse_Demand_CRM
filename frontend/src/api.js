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

export async function saveFollowup(body) {
  const res = await apiFetch('/api/followups', { method: 'POST', body: JSON.stringify(body) });
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
