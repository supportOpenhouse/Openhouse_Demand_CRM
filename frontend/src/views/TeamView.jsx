import { useMemo, useState } from 'react';
import UserModal from '../components/UserModal.jsx';

const TEAM_ORDER = ['Admin', 'TL', 'KAM', 'Ground'];

export default function TeamView({ seed, onOpenBroker, reloadSeed }) {
  const me = seed.current_user || {};
  const isAdmTL = me.team === 'Admin' || me.team === 'TL' || me.role === 'admin' || (me.role || '').includes('tl');
  const isAdmin = me.team === 'Admin' || me.role === 'admin';   // roster edits are Admin-only (backend gate)
  const users = seed.users || [];
  const cpOwner = seed.cp_owner || {};
  const teamTasks = seed.team_tasks || {};
  const [modal, setModal] = useState(null);   // { mode:'create'|'edit', user? }

  const ownedCount = useMemo(() => {
    const m = {};
    Object.values(cpOwner).forEach((slug) => { if (slug) m[slug] = (m[slug] || 0) + 1; });
    return m;
  }, [cpOwner]);

  // ---- My Day (non-admin): the CPs you own ----
  if (!isAdmTL) {
    const myCps = (seed.brokers || []).filter((b) => cpOwner[b.cp_code] === me.id)
      .sort((a, b) => (a.tier_rank || 9999) - (b.tier_rank || 9999));
    const calls = (teamTasks[me.slug]?.daily_calls) || [];
    return (
      <div className="rx-fade">
        <div className="muted" style={{ fontSize: 12, marginBottom: 14 }}>
          You own {myCps.length} CP{myCps.length === 1 ? '' : 's'}{calls.length ? ` · ${calls.length} call${calls.length === 1 ? '' : 's'} queued today` : ''}
        </div>
        {myCps.length ? (
          <div className="cp-tbl-wrap" style={{ borderRadius: 10 }}>
            <table className="t" style={{ minWidth: 700 }}>
              <thead><tr><th>Channel Partner</th><th>Tier</th><th>City</th><th>CP Code</th><th>Phone</th></tr></thead>
              <tbody>
                {myCps.map((b) => (
                  <tr key={b.cp_code} style={{ cursor: 'pointer' }} onClick={() => onOpenBroker?.(b.cp_code)}>
                    <td><b>{b.name}</b><div className="rx-sub">{b.company_name || ''}</div></td>
                    <td>{b.tier || '—'}</td>
                    <td><span className="city-pill">{b.city || ''}</span></td>
                    <td><span className="id-pill">{b.cp_code}</span></td>
                    <td className="rx-sub">{b.phone_number || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <div className="empty"><div className="emoji">📭</div><div className="t">No CPs assigned to you yet</div></div>}
      </div>
    );
  }

  // ---- Team & Assignments (admin/TL): roster grouped by team ----
  const groups = TEAM_ORDER
    .map((t) => ({ team: t, members: users.filter((u) => u.team === t).sort((a, b) => (a.name || '').localeCompare(b.name || '')) }))
    .filter((g) => g.members.length);

  return (
    <div className="rx-fade">
      <div className="rx-team-head">
        <div className="muted" style={{ fontSize: 12 }}>{users.length} people · {Object.keys(ownedCount).length} with assigned CPs</div>
        {isAdmin && <button className="btn primary sm" onClick={() => setModal({ mode: 'create' })}>＋ Add member</button>}
      </div>

      {groups.map((g) => (
        <div key={g.team} style={{ marginBottom: 18 }}>
          <h3 style={{ fontSize: 13, color: 'var(--mut)', textTransform: 'uppercase', letterSpacing: '.5px', margin: '0 0 8px' }}>{g.team} · {g.members.length}</h3>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 10 }}>
            {g.members.map((u, i) => {
              const calls = (teamTasks[u.slug]?.daily_calls) || [];
              return (
                <div key={u.slug} className="rx-membercard" style={{ '--i': i }}>
                  <div className="rx-membercard-top">
                    <div style={{ fontWeight: 600, fontSize: 13.5 }}>{u.name}{u.slug === me.slug ? ' (you)' : ''}</div>
                    {isAdmin && (
                      <button className="rx-card-edit" title="Edit member" onClick={() => setModal({ mode: 'edit', user: u })}>Edit</button>
                    )}
                  </div>
                  <div className="rx-sub" style={{ marginTop: 2 }}>{u.role} · {(u.cities || []).join(', ') || '—'}</div>
                  <div style={{ display: 'flex', gap: 14, marginTop: 8, fontSize: 12 }}>
                    <span><b>{ownedCount[u.slug] || 0}</b> <span className="muted">CPs</span></span>
                    {calls.length ? <span><b>{calls.length}</b> <span className="muted">calls today</span></span> : null}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ))}

      {modal && (
        <UserModal
          mode={modal.mode}
          user={modal.user}
          seed={seed}
          onClose={() => setModal(null)}
          onSaved={reloadSeed}
        />
      )}
    </div>
  );
}
