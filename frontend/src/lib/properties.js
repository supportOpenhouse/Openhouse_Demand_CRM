// Property scoping (ported from propertiesForUser) + 99acres society matching.

export function propertiesForUser(properties, me) {
  if (!me || !me.id) return properties;
  const admTL = me.team === 'Admin' || me.team === 'TL' || me.role === 'admin' || (me.role || '').includes('tl');
  if (admTL) {
    if (me.role === 'tl_closer') return properties.filter((p) => (me.cities || []).includes(p.city_name));
    return properties;
  }
  if (me.team === 'Ground') return properties.filter((p) => p.sales_manager === me.name);
  return properties; // KAMs see all
}

export function normSoc(s) { return (s || '').toLowerCase().replace(/[^a-z0-9]+/g, ''); }

// 99acres "Top Brokers" rows for a property's society (exact-normalized, else loose
// contains, with the property's city preferred when the society spans cities).
export function top99ForSociety(rows, p) {
  const want = normSoc(p.society_name);
  if (!want) return [];
  let out = rows.filter((r) => normSoc(r.society) === want);
  if (!out.length) out = rows.filter((r) => { const s = normSoc(r.society); return s && (s.includes(want) || want.includes(s)); });
  if (p.city_name && out.some((r) => r.city === p.city_name)) out = out.filter((r) => r.city === p.city_name);
  return out.slice().sort((a, b) => (a.rank || 999) - (b.rank || 999));
}
