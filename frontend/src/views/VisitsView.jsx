import { useMemo, useState } from 'react';
import { fmtDate, fmtDay } from '../lib/format.js';
import {
  STAGES, STAGE_BY_KEY, STATUSES, LAST_FU_PRESETS,
  visitStage, visitStatus, isOldLead, matchesUnit, visitUnitText, scopeVisits,
  matchLastFuFilter, lastFollowupTaken, isVisitNudged, isVisitTlAsk,
} from '../lib/visits.js';
import ChipBar from '../components/ChipBar.jsx';

const CITIES = ['Gurgaon', 'Noida', 'Ghaziabad'];
const STATUS_COLOR = { hot: 'var(--bad,#B91C1C)', warm: '#B45309', cold: '#1E40AF', dead: 'var(--mut)' };
const PRIORITY_OPTS = [
  { k: 'all', label: 'All', cls: '' },
  { k: 'nudged', label: '🔔 Nudged', cls: 'pr-nudged' },
  { k: 'tl_ask', label: '📌 TL Ask', cls: 'pr-tl' },
];

export default function VisitsView({ seed, onOpenBroker }) {
  const me = seed.current_user || {};
  const cpOwner = seed.cp_owner || {};
  const properties = seed.properties || [];
  const nudgesByVisit = seed.nudges_by_visit || {};
  const teamTasks = seed.team_tasks || {};
  const scoped = useMemo(
    () => scopeVisits(seed.visits || [], me, cpOwner, properties),
    [seed], // eslint-disable-line react-hooks/exhaustive-deps
  );

  const [city, setCity] = useState('all');
  const [status, setStatus] = useState('all');
  const [stage, setStage] = useState('all');
  const [lastFu, setLastFu] = useState('all');     // daily-triage filter (overdue / not-taken / today …)
  const [priority, setPriority] = useState('all');
  const [leadSet, setLeadSet] = useState('active'); // #6 active | old | all
  const [unit, setUnit] = useState('');             // #4 typeable unit number
  const [q, setQ] = useState('');

  // L0 — city + lead-set scope; drives the status/stage chip counts
  const L0 = useMemo(() => scoped.filter((v) => {
    if (city !== 'all' && v.city !== city) return false;
    const old = isOldLead(v);
    if (leadSet === 'active' && old) return false;
    if (leadSet === 'old' && !old) return false;
    return true;
  }), [scoped, city, leadSet]);

  const statusCounts = useMemo(() => {
    const c = { all: L0.length };
    L0.forEach((v) => { const s = visitStatus(v); c[s] = (c[s] || 0) + 1; });
    return c;
  }, [L0]);
  const stageCounts = useMemo(() => {
    const c = { all: L0.length };
    STAGES.forEach((s) => { c[s.k] = 0; });
    L0.forEach((v) => { const s = visitStage(v); c[s] = (c[s] || 0) + 1; });
    return c;
  }, [L0]);

  // L1 — after status + stage; drives the last-followup chip counts
  const L1 = useMemo(() => L0.filter((v) =>
    (status === 'all' || visitStatus(v) === status) &&
    (stage === 'all' || visitStage(v) === stage)), [L0, status, stage]);
  const lastFuCounts = useMemo(() => {
    const c = {};
    LAST_FU_PRESETS.forEach((p) => { c[p.k] = L1.filter((v) => matchLastFuFilter(lastFollowupTaken(v), p.k, v)).length; });
    return c;
  }, [L1]);

  // L2 — after last-followup; drives the priority chip counts
  const L2 = useMemo(() => L1.filter((v) => matchLastFuFilter(lastFollowupTaken(v), lastFu, v)), [L1, lastFu]);
  const priorityCounts = useMemo(() => ({
    all: L2.length,
    nudged: L2.filter((v) => isVisitNudged(v, nudgesByVisit)).length,
    tl_ask: L2.filter((v) => isVisitTlAsk(v, teamTasks)).length,
  }), [L2, nudgesByVisit, teamTasks]);

  const oldCount = useMemo(() => scoped.filter(isOldLead).length, [scoped]);

  const rows = useMemo(() => L2.filter((v) => {
    if (priority === 'nudged' && !isVisitNudged(v, nudgesByVisit)) return false;
    if (priority === 'tl_ask' && !isVisitTlAsk(v, teamTasks)) return false;
    if (unit.trim() && !matchesUnit(v, unit.trim())) return false;
    if (q.trim()) {
      const s = q.trim().toLowerCase();
      const hay = `${v.buyer_name} ${v.society_name} ${v.broker_name} ${v.cp_code} ${v.sales_manager} ${v.company_name} ${visitUnitText(v)}`.toLowerCase();
      if (!hay.includes(s)) return false;
    }
    return true;
  }).sort((a, b) => (b.visit_date || '').localeCompare(a.visit_date || '')), [L2, priority, unit, q, nudgesByVisit, teamTasks]);

  return (
    <div className="rx-fade">
      <ChipBar label="Buyer status · Hot / Warm / Cold / Dead — set in AVFU"
               options={[{ k: 'all', label: 'All', cls: '' }, ...STATUSES]}
               counts={statusCounts} value={status} onChange={(k) => setStatus((s) => (s === k ? 'all' : k))} />
      <ChipBar label="Visit stage · operational pipeline"
               options={[{ k: 'all', label: 'All', cls: '' }, ...STAGES]}
               counts={stageCounts} value={stage} onChange={(k) => setStage((s) => (s === k ? 'all' : k))} />
      <ChipBar label="Last followup taken"
               options={LAST_FU_PRESETS}
               counts={lastFuCounts} value={lastFu} onChange={setLastFu} />
      <ChipBar label="Priority · TL ask & nudges"
               options={PRIORITY_OPTS}
               counts={priorityCounts} value={priority} onChange={setPriority} />

      <div className="rx-filters" style={{ marginTop: 4 }}>
        <select className="rx-sel" value={city} onChange={(e) => setCity(e.target.value)}>
          <option value="all">All cities</option>
          {CITIES.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <div className="rx-segment" title="Old Leads = pre-1-May visits still Upcoming / Cancelled / After-Visit-FU">
          {[['active', 'Active'], ['old', `Old Leads${oldCount ? ` · ${oldCount}` : ''}`], ['all', 'All']].map(([k, l]) => (
            <button key={k} className={'rx-seg' + (leadSet === k ? ' on' : '')} onClick={() => setLeadSet(k)}>{l}</button>
          ))}
        </div>
        <input className="rx-inp" style={{ width: 132 }} placeholder="Unit no. — 203" value={unit} onChange={(e) => setUnit(e.target.value)} />
        <input className="rx-inp" style={{ flex: 1, minWidth: 200 }} placeholder="Search buyer / society / CP / RM…" value={q} onChange={(e) => setQ(e.target.value)} />
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
