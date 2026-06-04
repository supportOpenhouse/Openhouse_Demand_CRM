import { useMemo, useState } from 'react';
import { bulkAssign } from '../api.js';
import { toast } from '../lib/toast.js';

const CITIES = ['Gurgaon', 'Noida', 'Ghaziabad'];
const TIERS = ['T1', 'T2', 'T3', 'T4'];

export default function QueueView({ seed, reloadSeed }) {
  const codes = useMemo(() => new Set(seed.to_assign_cps || []), [seed]);
  const ownerOptions = useMemo(() => (seed.users || []).slice().sort((a, b) => (a.name || '').localeCompare(b.name || '')), [seed]);
  const all = useMemo(() => (seed.brokers || []).filter((b) => codes.has(b.cp_code)), [seed, codes]);

  const [city, setCity] = useState('all');
  const [q, setQ] = useState('');
  const [selected, setSelected] = useState(() => new Set());
  const [bulkOwner, setBulkOwner] = useState('');
  const [bulkTier, setBulkTier] = useState('');
  const [busy, setBusy] = useState(false);

  const rows = useMemo(() => all.filter((b) => {
    if (city !== 'all' && b.city !== city) return false;
    if (q.trim()) {
      const s = q.trim().toLowerCase();
      if (!((b.name || '').toLowerCase().includes(s) || (b.cp_code || '').toLowerCase().includes(s)
        || (b.company_name || '').toLowerCase().includes(s) || (b.phone_number || '').includes(s))) return false;
    }
    return true;
  }), [all, city, q]);

  function toggle(cp) { setSelected((s) => { const n = new Set(s); if (n.has(cp)) n.delete(cp); else n.add(cp); return n; }); }
  function toggleAll() { setSelected((s) => (s.size === rows.length ? new Set() : new Set(rows.map((b) => b.cp_code)))); }

  async function bulkAssignSelected() {
    if (!bulkOwner) { toast('Pick an owner for the bulk assign', 'bad'); return; }
    const cps = [...selected];
    if (!cps.length) return;
    setBusy(true);
    try {
      await bulkAssign({ cp_codes: cps, owner_slug: bulkOwner, ...(bulkTier ? { tier: bulkTier } : {}) });
      toast(`Assigned ${cps.length} CP${cps.length === 1 ? '' : 's'}`, 'good');
      setSelected(new Set()); setBulkOwner(''); setBulkTier('');
      await reloadSeed();
    } catch (e) { toast('Bulk assign failed: ' + String(e.message || e).slice(0, 80), 'bad'); }
    finally { setBusy(false); }
  }

  return (
    <div className="rx-fade">
      <div className="rx-filters">
        <select className="rx-sel" value={city} onChange={(e) => setCity(e.target.value)}>
          <option value="all">All cities</option>{CITIES.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <input className="rx-inp" style={{ flex: 1, minWidth: 200 }} placeholder="Search name / CP code / company / phone…" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <div className="muted" style={{ fontSize: 12, margin: '6px 2px 10px' }}>{rows.length} CP{rows.length === 1 ? '' : 's'} awaiting assignment</div>

      {selected.size > 0 && (
        <div className="rx-bulkbar">
          <b>{selected.size} selected</b>
          <select className="rx-sel" value={bulkOwner} onChange={(e) => setBulkOwner(e.target.value)}>
            <option value="">Assign owner…</option>{ownerOptions.map((u) => <option key={u.slug} value={u.slug}>{u.name}</option>)}
          </select>
          <select className="rx-sel" value={bulkTier} onChange={(e) => setBulkTier(e.target.value)}>
            <option value="">Keep tier</option>{TIERS.map((t) => <option key={t} value={t}>Set {t}</option>)}
          </select>
          <button className="btn sm primary" disabled={busy} onClick={bulkAssignSelected}>{busy ? 'Assigning…' : 'Assign selected'}</button>
          <button className="btn sm" onClick={() => setSelected(new Set())}>Clear</button>
        </div>
      )}

      <div className="cp-tbl-wrap" style={{ borderRadius: 10 }}>
        <table className="t" style={{ minWidth: 1080 }}>
          <thead><tr>
            <th style={{ width: 30 }}><input type="checkbox" checked={rows.length > 0 && selected.size === rows.length} onChange={toggleAll} /></th>
            <th>Channel Partner</th><th>City · MM</th><th>CP Code</th><th>Activity</th><th>Tier</th><th>Assign owner</th><th />
          </tr></thead>
          <tbody>
            {rows.length ? rows.map((b) => (
              <QueueRow key={b.cp_code} b={b} ownerOptions={ownerOptions} reloadSeed={reloadSeed} selected={selected.has(b.cp_code)} onToggle={() => toggle(b.cp_code)} />
            )) : <tr><td colSpan={8}><div className="empty"><div className="emoji">✅</div><div className="t">Nothing to assign</div></div></td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function QueueRow({ b, ownerOptions, reloadSeed, selected, onToggle }) {
  const [owner, setOwner] = useState('');
  const [tier, setTier] = useState(b.tier || 'T4');
  const [busy, setBusy] = useState(false);

  async function assign() {
    if (!owner) { toast('Pick an owner first', 'bad'); return; }
    setBusy(true);
    try {
      await bulkAssign({ cp_codes: [b.cp_code], owner_slug: owner, tier });
      toast(`Assigned ${b.name || b.cp_code}`, 'good');
      await reloadSeed();
    } catch (e) { toast('Assign failed: ' + String(e.message || e).slice(0, 80), 'bad'); setBusy(false); }
  }

  return (
    <tr style={selected ? { background: 'var(--accBg)' } : undefined}>
      <td><input type="checkbox" checked={selected} onChange={onToggle} /></td>
      <td style={{ whiteSpace: 'normal', maxWidth: 190 }}><b>{b.name}</b><div className="rx-sub">{[b.company_name, b.phone_number].filter(Boolean).join(' · ')}</div></td>
      <td><span className="city-pill">{b.city || ''}</span><div className="rx-sub">{(b.micro_markets || '').split(',').slice(0, 2).join(',')}</div></td>
      <td><span className="id-pill">{b.cp_code}</span></td>
      <td className="rx-sub">{b.activity_category || '—'}</td>
      <td><select className="rx-sel" value={tier} onChange={(e) => setTier(e.target.value)}>{TIERS.map((t) => <option key={t} value={t}>{t}</option>)}</select></td>
      <td><select className="rx-sel" value={owner} onChange={(e) => setOwner(e.target.value)}><option value="">— select —</option>{ownerOptions.map((u) => <option key={u.slug} value={u.slug}>{u.name}</option>)}</select></td>
      <td><button className="btn xs primary" disabled={busy} onClick={assign}>{busy ? '…' : 'Assign'}</button></td>
    </tr>
  );
}
