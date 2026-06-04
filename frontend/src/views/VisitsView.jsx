import { useMemo, useState } from 'react';
import { fmtDate, fmtDay } from '../lib/format.js';
import {
  STAGES, STAGE_BY_KEY, visitStage, visitStatus,
  isOldLead, matchesUnit, visitUnitText, scopeVisits,
} from '../lib/visits.js';

const CITIES = ['Gurgaon', 'Noida', 'Ghaziabad'];
const STATUS_COLOR = {
  hot: 'var(--bad,#B91C1C)', warm: '#B45309', cold: '#1E40AF', dead: 'var(--mut)',
};

export default function VisitsView({ seed, onOpenBroker }) {
  const me = seed.current_user || {};
  const cpOwner = seed.cp_owner || {};
  const properties = seed.properties || [];
  const scoped = useMemo(
    () => scopeVisits(seed.visits || [], me, cpOwner, properties),
    [seed], // eslint-disable-line react-hooks/exhaustive-deps
  );

  const [city, setCity] = useState('all');
  const [status, setStatus] = useState('all');      // #8 — clickable Hot/Warm/etc.
  const [stage, setStage] = useState('all');
  const [leadSet, setLeadSet] = useState('active');  // #6 — active | old | all
  const [unit, setUnit] = useState('');              // #4 — typeable unit number
  const [q, setQ] = useState('');

  // city + lead-set scoped base (drives the stat boxes)
  const base = useMemo(() => scoped.filter((v) => {
    if (city !== 'all' && v.city !== city) return false;
    const old = isOldLead(v);
    if (leadSet === 'active' && old) return false;
    if (leadSet === 'old' && !old) return false;
    return true;
  }), [scoped, city, leadSet]);

  const counts = useMemo(() => {
    const c = { total: base.length, hot: 0, warm: 0, cold: 0, upcoming: 0, booking: 0 };
    base.forEach((v) => {
      const st = visitStatus(v); if (st in c) c[st]++;
      const sg = visitStage(v); if (sg === 'upcoming') c.upcoming++; if (sg === 'booking') c.booking++;
    });
    return c;
  }, [base]);
  const oldCount = useMemo(() => scoped.filter(isOldLead).length, [scoped]);

  const rows = useMemo(() => base.filter((v) => {
    if (status !== 'all' && visitStatus(v) !== status) return false;
    if (stage !== 'all' && visitStage(v) !== stage) return false;
    if (unit.trim() && !matchesUnit(v, unit.trim())) return false;
    if (q.trim()) {
      const s = q.trim().toLowerCase();
      const hay = `${v.buyer_name} ${v.society_name} ${v.broker_name} ${v.cp_code} ${v.sales_manager} ${v.company_name} ${visitUnitText(v)}`.toLowerCase();
      if (!hay.includes(s)) return false;
    }
    return true;
  }).sort((a, b) => (b.visit_date || '').localeCompare(a.visit_date || '')), [base, status, stage, unit, q]);

  function statCard(key, label, value, color, kind) {
    const active = kind === 'status' ? status === key
      : kind === 'stage' ? stage === key
      : (status === 'all' && stage === 'all');
    const onClick = () => {
      if (kind === 'status') setStatus((s) => (s === key ? 'all' : key));
      else if (kind === 'stage') setStage((s) => (s === key ? 'all' : key));
      else { setStatus('all'); setStage('all'); }
    };
    return (
      <button className={'rx-stat' + (active ? ' on' : '')} onClick={onClick}
              style={active ? { borderColor: color } : undefined}>
        <div className="rx-stat-v" style={{ color }}>{value}</div>
        <div className="rx-stat-l">{label}</div>
      </button>
    );
  }

  return (
    <div className="rx-fade">
      <div className="rx-stats">
        {statCard(null, 'Total', counts.total, 'var(--txt)', 'clear')}
        {statCard('hot', 'Hot', counts.hot, STATUS_COLOR.hot, 'status')}
        {statCard('warm', 'Warm', counts.warm, STATUS_COLOR.warm, 'status')}
        {statCard('cold', 'Cold', counts.cold, STATUS_COLOR.cold, 'status')}
        {statCard('upcoming', 'Upcoming', counts.upcoming, '#1E40AF', 'stage')}
        {statCard('booking', 'Booking', counts.booking, 'var(--good,#15803D)', 'stage')}
      </div>

      <div className="rx-filters">
        <select className="rx-sel" value={city} onChange={(e) => setCity(e.target.value)}>
          <option value="all">All cities</option>
          {CITIES.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <select className="rx-sel" value={stage} onChange={(e) => setStage(e.target.value)}>
          <option value="all">All stages</option>
          {STAGES.map((s) => <option key={s.k} value={s.k}>{s.label}</option>)}
        </select>
        <div className="rx-segment" title="Old Leads = pre-1-May visits still Upcoming / Cancelled / After-Visit-FU">
          {[['active', 'Active'], ['old', `Old Leads${oldCount ? ` · ${oldCount}` : ''}`], ['all', 'All']].map(([k, l]) => (
            <button key={k} className={'rx-seg' + (leadSet === k ? ' on' : '')} onClick={() => setLeadSet(k)}>{l}</button>
          ))}
        </div>
        <input className="rx-inp" style={{ width: 132 }} placeholder="Unit no. — 203" value={unit}
               onChange={(e) => setUnit(e.target.value)} />
        <input className="rx-inp" style={{ flex: 1, minWidth: 200 }} placeholder="Search buyer / society / CP / RM…"
               value={q} onChange={(e) => setQ(e.target.value)} />
      </div>

      <div className="muted" style={{ fontSize: 12, margin: '6px 2px 10px' }}>
        {rows.length} visit{rows.length === 1 ? '' : 's'}
        {leadSet === 'active' ? ' · old leads hidden' : leadSet === 'old' ? ' · old leads only' : ''}
      </div>

      <div className="tbl-wrap">
        <table className="t" style={{ minWidth: 1100 }}>
          <thead><tr>
            <th>Buyer</th><th>Society</th><th>Unit</th><th>Channel Partner</th><th>RM</th>
            <th>Status</th><th>Stage</th><th>Visit date</th><th>Last FU</th>
          </tr></thead>
          <tbody>
            {rows.length ? rows.map((v, i) => {
              const st = visitStatus(v);
              const sg = visitStage(v);
              const sd = STAGE_BY_KEY[sg];
              return (
                <tr key={v.id || i} style={{ cursor: 'default' }}>
                  <td><b>{v.buyer_name || '—'}</b>{isOldLead(v) ? <span className="rx-tag-old">OLD</span> : null}</td>
                  <td style={{ whiteSpace: 'normal', maxWidth: 200 }}>{v.society_name || '—'}<div className="rx-sub">{v.city || ''}</div></td>
                  <td style={{ whiteSpace: 'normal', maxWidth: 180 }}>{visitUnitText(v) || '—'}</td>
                  <td style={{ whiteSpace: 'normal', maxWidth: 200 }}>
                    {v.cp_code
                      ? <b style={{ fontWeight: 600, color: 'var(--acc)', cursor: 'pointer' }} onClick={() => onOpenBroker?.(v.cp_code)}>{v.broker_name || v.cp_code}</b>
                      : <b style={{ fontWeight: 600 }}>{v.broker_name || '—'}</b>}
                    <div className="rx-sub">{v.company_name || v.cp_code || ''}</div>
                  </td>
                  <td>{v.sales_manager || '—'}</td>
                  <td>{st === 'unc' ? <span className="muted">—</span> : <span className="rx-pill" style={{ background: 'var(--panel2)', color: STATUS_COLOR[st] || 'var(--txt)' }}>{st}</span>}</td>
                  <td><span className={'sgpill ' + sg}><span className="d" />{sd ? sd.label : sg}</span></td>
                  <td>{fmtDate(v.visit_date)}<div className="rx-sub">{fmtDay(v.visit_date)}</div></td>
                  <td>{v.latest_followup_date ? fmtDate(v.latest_followup_date) : <span className="muted">—</span>}</td>
                </tr>
              );
            }) : (
              <tr><td colSpan={9}><div className="empty"><div className="emoji">🔍</div><div className="t">No visits match these filters</div></div></td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
