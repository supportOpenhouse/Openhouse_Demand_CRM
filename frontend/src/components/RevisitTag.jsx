// Per-property REVISIT badge: the buyer came back to the SAME unit (home_id) with the SAME
// broker, and an earlier visit was completed. Driven by buildRevisitIndex (lib/visits.js) —
// NOT the buyer-total `lead_occurrence_count`. Pass the index entry for a visit as `info`.
function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

export default function RevisitTag({ info, style }) {
  if (!info || !info.isRevisit) return null;
  const title = `Revisit — ${ordinal(info.revisitSeq)} visit to this unit with this broker`
    + (info.chainSize > 1 ? ` · ${info.chainSize} visits on this lead` : '');
  return (
    <span
      className="revisit-tag"
      title={title}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 3, padding: '0 6px',
        borderRadius: 999, fontSize: 10.5, fontWeight: 700, lineHeight: 1.7,
        color: 'var(--acc)', border: '1px solid var(--acc)', whiteSpace: 'nowrap',
        ...(style || {}),
      }}
    >
      🔁 Revisit #{info.revisitSeq}
    </span>
  );
}
