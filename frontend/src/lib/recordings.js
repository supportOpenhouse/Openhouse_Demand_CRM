// Read-only meeting-recording helpers over the seed's lightweight marker maps
// (meeting_recordings_by_cp / _by_visit). Each marker = {id,type,date,rm,method};
// the structured summary is fetched on expand (api.fetchMeetingSummary / RecordingDetail).
// Every helper is null-safe: with the feature dormant the maps are absent → empty.

export function recsForCp(seed, cpCode) {
  if (!cpCode) return [];
  return (seed?.meeting_recordings_by_cp || {})[cpCode] || [];
}

export function recsForVisit(seed, visitId) {
  if (visitId == null || visitId === '') return [];
  return (seed?.meeting_recordings_by_visit || {})[String(visitId)] || [];
}

export function hasCpRec(seed, cpCode) { return recsForCp(seed, cpCode).length > 0; }
export function hasVisitRec(seed, visitId) { return recsForVisit(seed, visitId).length > 0; }

export function recTypeLabel(t) {
  return t === 'visit' ? 'Site visit' : t === 'engagement' ? 'Engagement' : 'Meeting';
}

// "Site visit · 2026-06-12 · Aman Rawat"
export function recLabel(rec) {
  const d = (rec?.date || '').slice(0, 10);
  return [recTypeLabel(rec?.type), d, rec?.rm].filter(Boolean).join(' · ');
}

function humanize(k) {
  return String(k).replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

// Flatten a curated digest (from /api/meetings/{id}/summary) into [label, value] rows.
// Defensive — the digest shape varies by meeting type and may be partial.
export function digestRows(digest) {
  if (!digest || typeof digest !== 'object') return [];
  const rows = [];
  const s = digest.score;
  if (s && s.total != null) {
    rows.push(['Intent score', `${s.total}${s.out_of ? '/' + s.out_of : ''}${s.classification ? ' · ' + s.classification : ''}`]);
  }
  if (Array.isArray(digest.signals_met) && digest.signals_met.length) {
    rows.push(['Signals', digest.signals_met.map(humanize).join(', ')]);
  }
  const d = digest.details;
  if (d && typeof d === 'object') {
    for (const [k, v] of Object.entries(d)) {
      const val = Array.isArray(v) ? v.join('; ') : v == null ? '' : String(v);
      if (val) rows.push([humanize(k), val]);
    }
  }
  if (digest.raw) rows.push(['Summary', String(digest.raw)]);
  return rows;
}
