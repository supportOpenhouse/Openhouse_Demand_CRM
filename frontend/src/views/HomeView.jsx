import { useEffect, useMemo, useState } from 'react';
import { TODAY, ymd, fmtDateTime, fmtDay, fmtMonth, initials, daysBetween } from '../lib/format.js';
import { activityForVisit, isVisitCompleted, scopeVisits } from '../lib/visits.js';
import { usersBySlug } from '../lib/brokers.js';
import { TEAM_PILL } from '../lib/legacy.js';

// count-up animation (easeOutCubic) — the "live" number ticks up on mount
function CountUp({ value, duration = 1400 }) {
  const [n, setN] = useState(0);
  useEffect(() => {
    let raf, start;
    const tick = (t) => {
      if (start == null) start = t;
      const p = Math.min(1, (t - start) / duration);
      setN(Math.round(value * (1 - Math.pow(1 - p, 3))));
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value, duration]);
  return <>{n.toLocaleString('en-IN')}</>;
}

// Activity types shown on the Home board, kept visually distinct (not one list).
const TYPES = [
  { k: 'revisit',     label: 'Revisits',             icon: '🔁', cls: 'sg-rev' },
  { k: 'negotiation', label: 'Negotiation Meetings', icon: '🤝', cls: 'sg-nego' },
  { k: 'followup',    label: 'Follow-ups Due',       icon: '☎️', cls: 'sg-avfu' },
];

function ActivityItem({ it, onOpen }) {
  const v = it.v;
  const unit = [v.unit_address_line1, v.unit_address_line2].filter(Boolean).join('-');
  const when = it.type === 'followup' ? fmtDay(it.date) : fmtDateTime(it.date);
  return (
    <div className="home-item" onClick={() => v.cp_code && onOpen?.(v.cp_code)}>
      <div className="hi-top">
        <b>{v.buyer_name || 'Buyer'}</b>
        <span className="hi-when">{when}</span>
      </div>
      <div className="hi-sub">{v.society_name || '—'}{unit ? ` · ${unit}` : ''}</div>
      <div className="hi-meta">
        {v.broker_name || ''}{v.broker_name && v.sales_manager ? ' · ' : ''}
        {v.sales_manager ? `RM ${v.sales_manager.split(' ')[0]}` : ''}
      </div>
    </div>
  );
}

function DayBoard({ title, items, onOpen }) {
  return (
    <div className="home-day">
      <div className="home-day-h">{title}<span className="home-day-n">{items.length}</span></div>
      <div className="home-types">
        {TYPES.map((t) => {
          const list = items.filter((it) => it.type === t.k);
          return (
            <div className="home-type" key={t.k}>
              <div className={'home-type-h ' + t.cls}>{t.icon} {t.label}<span className="home-type-n">{list.length}</span></div>
              {list.length
                ? list.map((it) => <ActivityItem key={it.v.id} it={it} onOpen={onOpen} />)
                : <div className="home-empty">Nothing scheduled</div>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default function HomeView({ seed, onOpenBroker }) {
  const me = seed.current_user || {};
  const cpOwner = seed.cp_owner || {};
  const properties = seed.properties || [];
  const ubs = useMemo(() => usersBySlug(seed), [seed]);
  const isAdminTL = me.team === 'Admin' || me.team === 'TL' || me.role === 'admin' || (me.role || '').includes('tl');

  const brokersByCode = useMemo(() => {
    const m = {};
    (seed.brokers || []).forEach((b) => { m[b.cp_code] = b; });
    return m;
  }, [seed]);

  const scoped = useMemo(
    () => scopeVisits(seed.visits || [], me, cpOwner, properties, seed.pm_by_property || {}),
    [seed], // eslint-disable-line react-hooks/exhaustive-deps
  );

  // this month's COMPLETED visits brought by Gold (T1) + Silver (T2) channel partners.
  // Excludes Upcoming/Cancelled (not real activity) — matches the visits-sheet count.
  const monthKey = ymd(TODAY).slice(0, 7);             // 'YYYY-MM'
  const gs = useMemo(() => {
    let gold = 0, silver = 0;
    scoped.forEach((v) => {
      const d = v.visit_date || v.selected_date;
      if (!d || String(d).slice(0, 7) !== monthKey) return;
      if (!isVisitCompleted(v)) return;                // only completed visits count
      const tier = brokersByCode[v.cp_code]?.tier;
      if (tier === 'T1') gold += 1;
      else if (tier === 'T2') silver += 1;
    });
    return { gold, silver, total: gold + silver };
  }, [scoped, brokersByCode, monthKey]);

  // every scoped visit with a Today/Tomorrow activity → a flat item list
  const items = useMemo(() => {
    const out = [];
    scoped.forEach((v) => {
      const act = activityForVisit(v);
      if (!act) return;
      const d = daysBetween(act.date);            // +ve past, 0 today, -1 tomorrow
      if (d === 0 || d === -1) out.push({ v, type: act.type, date: act.date, day: d === 0 ? 'today' : 'tomorrow' });
    });
    return out;
  }, [scoped]);

  // who owns the activity (CP owner → KAM, else the RM) — used for the admin grouping
  const personFor = (v) => {
    const o = ubs[cpOwner[v.cp_code]];
    if (o) return { key: o.slug, name: o.name, team: o.team };
    return { key: 'rm:' + (v.sales_manager || '—'), name: v.sales_manager || 'Unassigned', team: 'RM' };
  };

  const byPerson = useMemo(() => {
    if (!isAdminTL) return null;
    const m = {};
    items.forEach((it) => {
      const p = personFor(it.v);
      (m[p.key] || (m[p.key] = { ...p, items: [] })).items.push(it);
    });
    return Object.values(m).sort((a, b) => b.items.length - a.items.length);
  }, [items, isAdminTL]); // eslint-disable-line react-hooks/exhaustive-deps

  const today = items.filter((it) => it.day === 'today');
  const tomorrow = items.filter((it) => it.day === 'tomorrow');
  const count = (list, t) => list.filter((it) => it.type === t).length;

  return (
    <div className="view rx-fade" id="view-home">
      <div className="list-head">
        <span>🏠 {isAdminTL ? 'Team activities' : 'Your activities'} · Today & Tomorrow</span>
      </div>

      {/* live monthly Gold + Silver visit counter */}
      <div className="home-hero">
        <div className="hh-badge"><span className="hh-dot" /> LIVE</div>
        <div className="hh-label">{fmtMonth(TODAY)} {TODAY.getFullYear()} · completed visits from Gold + Silver CPs</div>
        <div className="hh-num"><CountUp value={gs.total} /></div>
        <div className="hh-break">
          <span className="hh-pill gold">🥇 Gold <b>{gs.gold.toLocaleString('en-IN')}</b></span>
          <span className="hh-pill silver">🥈 Silver <b>{gs.silver.toLocaleString('en-IN')}</b></span>
        </div>
      </div>

      {/* summary tiles */}
      <div className="home-summary">
        <div className="home-tile"><div className="n">{today.length}</div><div className="l">Today</div></div>
        <div className="home-tile"><div className="n">{tomorrow.length}</div><div className="l">Tomorrow</div></div>
        {TYPES.map((t) => (
          <div className="home-tile" key={t.k}>
            <div className="n">{count(today, t.k)}<span style={{ fontSize: 13, color: 'var(--mut)', fontWeight: 600 }}> / {count(tomorrow, t.k)}</span></div>
            <div className="l">{t.icon} {t.label}</div>
          </div>
        ))}
      </div>

      {items.length === 0 ? (
        <div className="empty"><div className="emoji">🎉</div><div className="t">All clear</div><div className="s">No revisits, negotiation meetings or follow-ups due today or tomorrow.</div></div>
      ) : isAdminTL ? (
        byPerson.map((p) => (
          <div className="home-person" key={p.key}>
            <div className="home-person-h">
              <span className="avatar sm">{initials(p.name)}</span>
              <b>{p.name}</b>
              <span className={'role-pill ' + (TEAM_PILL[p.team] || '')}>{p.team}</span>
              <span className="muted" style={{ fontSize: 12 }}>{p.items.length} activit{p.items.length === 1 ? 'y' : 'ies'}</span>
            </div>
            <div className="home-board">
              <DayBoard title="Today" items={p.items.filter((it) => it.day === 'today')} onOpen={onOpenBroker} />
              <DayBoard title="Tomorrow" items={p.items.filter((it) => it.day === 'tomorrow')} onOpen={onOpenBroker} />
            </div>
          </div>
        ))
      ) : (
        <div className="home-board">
          <DayBoard title="Today" items={today} onOpen={onOpenBroker} />
          <DayBoard title="Tomorrow" items={tomorrow} onOpen={onOpenBroker} />
        </div>
      )}
    </div>
  );
}
