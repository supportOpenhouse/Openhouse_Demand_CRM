// Upcoming Visits — the close-out queue: every visit still open in the app, ONE LINE each,
// with the "Complete visit" action right there in the row.
//
// The action itself is NOT reimplemented here: it opens the same VisitCompleteModal the
// property/CP pop-ups use, which carries Core's three paths — complete via OTP (status +
// free-text feedback), complete assisted (adds lead status + the 6 structured fields), or
// cancel. That modal is the single place those payloads are built, so this tab cannot drift
// from the app's flow.
//
// Rows stay one line on purpose. Anything extra (full history, follow-ups, the CP's other
// visits) is reached the usual way — click the CP to open the broker pop-up.
import { useMemo, useState, useDeferredValue } from 'react';
import { fmtDateTime, ymd, TODAY } from '../lib/format.js';
import { scopeVisits, canCompleteVisit, visitStatus, STATUSES } from '../lib/visits.js';
import VisitCompleteModal from '../components/VisitCompleteModal.jsx';
import VisitRescheduleModal from '../components/VisitRescheduleModal.jsx';
import ChipBar from '../components/ChipBar.jsx';
import { useStickyState } from '../lib/sessionFilters.js';

const WHEN_TABS = [
  { k: 'all', label: 'All', cls: '' },
  { k: 'overdue', label: '⚠️ Date passed', cls: 'sg-avfu' },
  { k: 'today', label: 'Today', cls: 'sg-rev' },
  { k: 'upcoming', label: 'Later', cls: 'sg-nego' },
];

const dayOf = (v) => String(v.visit_date || v.selected_date || '').slice(0, 10);

export default function UpcomingVisitsView({ seed, onOpenBroker, reloadSeed, search = '', filters = {}, onResetSearch, onResetGlobalFilters }) {
  const me = seed.current_user || {};
  const cpOwner = seed.cp_owner || {};
  const properties = seed.properties || [];
  const [whenTab, setWhenTab] = useStickyState('upcoming:whenTab', []);
  const [completing, setCompleting] = useState(null);
  const [rescheduling, setRescheduling] = useState(null);   // move an upcoming visit's slot
  const dq = useDeferredValue(search);

  const scoped = useMemo(
    () => scopeVisits(seed.visits || [], me, cpOwner, properties, seed.pm_by_property || {}, seed.past_kam || {}, seed.dup_rm_names || []),
    [seed], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const brokersByCode = useMemo(() => {
    const m = {}; (seed.brokers || []).forEach((b) => { m[b.cp_code] = b; }); return m;
  }, [seed]);

  // Every visit the app still holds open — including past-dated ones, which are exactly
  // the ones needing closure. canCompleteVisit is the same gate the pop-ups use.
  const open = useMemo(() => scoped.filter(canCompleteVisit), [scoped]);

  const today = ymd(TODAY);
  const base = useMemo(() => open.filter((v) => {
    if (filters.cities?.length && !filters.cities.includes(v.city)) return false;
    const F = filters || {};
    if (F.society && v.society_name !== F.society) return false;
    if (F.cp && v.cp_code !== F.cp) return false;
    if (F.rm && v.sales_manager !== F.rm) return false;
    if (F.source?.length && !F.source.includes(v.source)) return false;
    if (dq.trim()) {
      const s = dq.trim().toLowerCase();
      const hit = (v.id || '').toLowerCase().includes(s)
        || (v.society_name || '').toLowerCase().includes(s)
        || (v.broker_name || '').toLowerCase().includes(s)
        || (v.buyer_name || '').toLowerCase().includes(s)
        || (v.cp_code || '').toLowerCase().includes(s)
        || (v.buyer_contact || '').includes(s)
        || (v.sales_manager || '').toLowerCase().includes(s);
      if (!hit) return false;
    }
    return true;
  }), [open, filters, dq]);

  const bucket = (v) => {
    const d = dayOf(v);
    if (!d) return 'upcoming';
    return d < today ? 'overdue' : d === today ? 'today' : 'upcoming';
  };
  const counts = useMemo(() => {
    const c = { all: base.length, overdue: 0, today: 0, upcoming: 0 };
    base.forEach((v) => { c[bucket(v)] += 1; });
    return c;
  }, [base]); // eslint-disable-line react-hooks/exhaustive-deps

  const rows = useMemo(() => {
    const r = whenTab.length ? base.filter((v) => whenTab.includes(bucket(v))) : base;
    // soonest-overdue first: the queue is ordered by how long it has been sitting
    return r.slice().sort((a, b) => (dayOf(a) || '9999-99-99').localeCompare(dayOf(b) || '9999-99-99'));
  }, [base, whenTab]); // eslint-disable-line react-hooks/exhaustive-deps

  const resetFilters = () => { setWhenTab([]); onResetSearch?.(); onResetGlobalFilters?.(); };

  return (
    <div className="rx-fade">
      <div className="neg-filters" style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10, marginBottom: 10 }}>
        <span style={{ fontWeight: 600, fontSize: 13 }}>Upcoming Visits</span>
        <span style={{ color: 'var(--mut)', fontSize: 12.5 }}>
          visits still open in the app — close each one out with <b>Complete visit</b>
        </span>
        <button type="button" className="btn sm rx-reset-filters" onClick={resetFilters} title="Reset every filter on this tab">↺ Reset filters</button>
      </div>

      <ChipBar label="When" options={WHEN_TABS} counts={counts} value={whenTab} onChange={setWhenTab} multi />

      <div className="neg-count" style={{ margin: '8px 2px', color: 'var(--mut)', fontSize: 13 }}>
        <b>{rows.length}</b> open visit{rows.length === 1 ? '' : 's'}
        {counts.overdue ? <> · <b style={{ color: 'var(--bad)' }}>{counts.overdue}</b> past their date</> : null}
      </div>

      {rows.length === 0 ? (
        <div className="empty"><div className="emoji">✅</div><div className="t">Nothing open</div>
          <div className="s">Every visit in your scope has been completed or cancelled.</div></div>
      ) : (
        <div className="tbl-wrap">
          <table className="t">
            <thead>
              <tr>
                <th>Visit</th><th>When</th><th>City</th><th>RM</th>
                <th>Society / Unit</th><th>Buyer</th><th>CP · Tier</th><th>Status</th><th></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((v) => {
                const b = bucket(v);
                const tier = brokersByCode[v.cp_code]?.tier || 'T4';
                const st = visitStatus(v);
                const stLabel = STATUSES.find((x) => x.k === st)?.label || st;
                const sub = [v.unit_address_line1, v.unit_address_line2].filter(Boolean).join('-') || (v.listing_status || '');
                return (
                  <tr key={v.id}>
                    <td><span className="id-pill">VST{String(v.id).padStart(4, '0')}</span></td>
                    <td style={{ whiteSpace: 'nowrap', color: b === 'overdue' ? 'var(--bad)' : undefined, fontWeight: b === 'overdue' ? 700 : 500 }}>
                      {v.visit_date || v.selected_date ? fmtDateTime(v.visit_date || v.selected_date) : '—'}
                      {v.selected_time ? <div style={{ fontSize: 10.5, color: 'var(--mut)' }}>{v.selected_time}</div> : null}
                      {b === 'overdue' ? <div style={{ fontSize: 10.5 }}>date passed</div> : null}
                    </td>
                    <td><span className="city-pill">{v.city || ''}</span></td>
                    <td style={{ fontSize: 12 }}>{v.sales_manager || '—'}</td>
                    <td><b>{v.society_name || '—'}</b>
                      <div style={{ fontSize: 10.5, color: 'var(--mut)', marginTop: 1 }}>{sub}</div></td>
                    <td>{v.buyer_name || '—'}
                      <div style={{ fontSize: 10.5, color: 'var(--mut)', marginTop: 1 }}>{v.buyer_contact || ''}</div></td>
                    <td>
                      <button type="button" onClick={() => onOpenBroker?.(v.cp_code, v.id)} title="Open channel partner"
                              style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'var(--acc,#2563EB)', textAlign: 'left' }}>
                        {brokersByCode[v.cp_code]?.name || v.broker_name || '—'}
                      </button> <span className={'tier-badge ' + tier}>{tier}</span>
                    </td>
                    <td><span className={'stpill ' + st}><span className="d" />{stLabel}</span></td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      <button type="button" className="btn sm primary" onClick={() => setCompleting(v)}>
                        Complete visit
                      </button>{' '}
                      <button type="button" className="btn sm" onClick={() => setRescheduling(v)}
                              title="Move this visit to another date / slot in the app">
                        Reschedule
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {completing && (
        <VisitCompleteModal
          visit={completing}
          onClose={() => setCompleting(null)}
          onDone={() => { setCompleting(null); reloadSeed?.(); }}
        />
      )}

      {rescheduling && (
        <VisitRescheduleModal
          visit={rescheduling}
          onClose={() => setRescheduling(null)}
          onDone={() => { setRescheduling(null); reloadSeed?.(); }}
        />
      )}
    </div>
  );
}
