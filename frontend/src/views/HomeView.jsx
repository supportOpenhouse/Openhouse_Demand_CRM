import { useMemo } from 'react';
import { fmtDateTime, fmtDay, initials, daysBetween } from '../lib/format.js';
import { activityForVisit, scopeVisits } from '../lib/visits.js';
import { usersBySlug } from '../lib/brokers.js';
import { TEAM_PILL } from '../lib/legacy.js';

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

  const scoped = useMemo(
    () => scopeVisits(seed.visits || [], me, cpOwner, properties, seed.pm_by_property || {}),
    [seed], // eslint-disable-line react-hooks/exhaustive-deps
  );

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
