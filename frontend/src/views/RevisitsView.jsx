// Revisits — a focused TABULAR queue for leads in a revisit state (Revisit Scheduled /
// After Revisit FU), mirroring Negotiations. Day-of ✅/❌ "did the revisit happen?" then
// the next step (advance to negotiation / booking / close) or reschedule. The Yes/No is
// migration-free — it just routes the next step (which persists via the chosen stage);
// nothing is stored. Table + editor + save (saveFollowup with `revisit_date` on
// reschedule, NO negotiation_happened) live in the shared PipelineQueue. This wrapper owns
// scoping + the SAME Visits filters + a revisit-date range + the stage tabs.
import { useMemo, useState, useDeferredValue } from 'react';
import { daysBetween } from '../lib/format.js';
import { visitStage, scopeVisits, nextFuFor, nextActivityFor } from '../lib/visits.js';
import { flatNo } from '../lib/propertyStatus.js';
import ChipBar from '../components/ChipBar.jsx';
import PipelineQueue from '../components/PipelineQueue.jsx';

const FUNNEL = ['revisit_scheduled', 'after_revisit_fu'];
const STAGE_TABS = [
  { k: 'all', label: 'All', cls: '' },
  { k: 'revisit_scheduled', label: 'Revisit Scheduled', cls: 'sg-rev' },
  { k: 'after_revisit_fu', label: 'After Revisit FU', cls: 'sg-avfu' },
];

export default function RevisitsView({ seed, onOpenBroker, reloadSeed, search = '', filters = {} }) {
  const me = seed.current_user || {};
  const cpOwner = seed.cp_owner || {};
  const properties = seed.properties || [];

  const scoped = useMemo(() => {
    const v = scopeVisits(seed.visits || [], me, cpOwner, properties, seed.pm_by_property || {});
    return me.team === 'KAM' ? v.filter((x) => cpOwner[x.cp_code] === me.id) : v;
  }, [seed]); // eslint-disable-line react-hooks/exhaustive-deps
  const brokersByCode = useMemo(() => {
    const m = {}; (seed.brokers || []).forEach((b) => { m[b.cp_code] = b; }); return m;
  }, [seed]);
  const propBySociety = useMemo(() => {
    const m = {};
    properties.forEach((p) => {
      if (!p.society_name) return;
      const e = m[p.society_name] || (m[p.society_name] = { mms: new Set(), bhks: new Set() });
      if (p.micro_market) e.mms.add(p.micro_market);
      const dig = String(p.configuration || '').match(/([1-4])\s*BHK/i);
      if (dig) e.bhks.add(dig[1] + ' BHK');
    });
    return m;
  }, [properties]);

  const [stageTab, setStageTab] = useState([]);
  const [revFrom, setRevFrom] = useState('');
  const [revTo, setRevTo] = useState('');
  const dq = useDeferredValue(search);

  const funnel = useMemo(() => scoped.filter((v) => FUNNEL.includes(visitStage(v))), [scoped]);

  const base = useMemo(() => funnel.filter((v) => {
    if (filters.cities?.length && !filters.cities.includes(v.city)) return false;
    if (dq.trim()) {
      const s = dq.trim().toLowerCase();
      const hit = (v.id || '').toLowerCase().includes(s)
        || (v.society_name || '').toLowerCase().includes(s)
        || (v.broker_name || '').toLowerCase().includes(s)
        || (v.buyer_name || '').toLowerCase().includes(s)
        || (v.cp_code || '').toLowerCase().includes(s)
        || (v.broker_contact || '').includes(s)
        || (v.buyer_contact || '').includes(s)
        || (v.company_name || '').toLowerCase().includes(s)
        || (v.sales_manager || '').toLowerCase().includes(s);
      if (!hit) return false;
    }
    const F = filters || {};
    if (F.unit) {
      const target = flatNo(F.unit);
      const vno = flatNo(v.unit_address_line1) || flatNo([v.unit_address_line1, v.unit_address_line2].filter(Boolean).join(' '));
      if (target && vno !== target) return false;
    }
    if (F.society && v.society_name !== F.society) return false;
    if (F.locality) {
      const mms = propBySociety[v.society_name]?.mms;
      if (!(mms && mms.has(F.locality)) && !(v.society_name || '').toLowerCase().includes(F.locality.toLowerCase())) return false;
    }
    if (F.bhk?.length) {
      const bhks = propBySociety[v.society_name]?.bhks;
      if (!bhks || !F.bhk.some((b) => bhks.has(b))) return false;
    }
    if (F.tier?.length) { const b = brokersByCode[v.cp_code]; if (!b || !F.tier.includes(b.tier)) return false; }
    if (F.cp && v.cp_code !== F.cp) return false;
    if (F.rm && v.sales_manager !== F.rm) return false;
    if (F.source?.length && !F.source.includes(v.source)) return false;
    if (F.visitFrom && !(v.visit_date && v.visit_date >= F.visitFrom)) return false;
    if (F.visitTo && !(v.visit_date && v.visit_date <= F.visitTo)) return false;
    if (F.followupDate?.length) {
      const nf = nextFuFor(v);
      let ok = F.followupDate.includes('none') && !nf;
      if (nf != null) {
        const d = daysBetween(nf);
        if (F.followupDate.includes('overdue') && d > 0) ok = true;
        if (F.followupDate.includes('today') && d === 0) ok = true;
        if (F.followupDate.includes('tomorrow') && d === -1) ok = true;
        if (F.followupDate.includes('week') && d <= 0 && d > -7) ok = true;
      }
      if (!ok) return false;
    }
    if (F.activityDate?.length) {
      const ad = nextActivityFor(v)?.date || null;
      let ok = F.activityDate.includes('none') && !ad;
      if (ad != null) {
        const d = daysBetween(ad);
        if (F.activityDate.includes('overdue') && d > 0) ok = true;
        if (F.activityDate.includes('today') && d === 0) ok = true;
        if (F.activityDate.includes('tomorrow') && d === -1) ok = true;
        if (F.activityDate.includes('week') && d <= 0 && d > -7) ok = true;
      }
      if (!ok) return false;
    }
    // revisit-date range (YYYY-MM-DD compare on _revisit_date)
    const rd = v._revisit_date ? String(v._revisit_date).slice(0, 10) : '';
    if (revFrom && !(rd && rd >= revFrom)) return false;
    if (revTo && !(rd && rd <= revTo)) return false;
    return true;
  }), [funnel, filters, dq, propBySociety, brokersByCode, revFrom, revTo]);

  const stageCounts = useMemo(() => {
    const c = { all: base.length, revisit_scheduled: 0, after_revisit_fu: 0 };
    base.forEach((v) => { const s = visitStage(v); c[s] = (c[s] || 0) + 1; });
    return c;
  }, [base]);

  const rows = useMemo(
    () => (stageTab.length ? base.filter((v) => stageTab.includes(visitStage(v))) : base),
    [base, stageTab],
  );

  return (
    <div className="rx-fade">
      <div className="neg-filters" style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10, marginBottom: 10 }}>
        <span style={{ fontWeight: 600, fontSize: 13 }}>Revisit date</span>
        <input type="date" value={revFrom} onChange={(e) => setRevFrom(e.target.value)}
               style={{ padding: '6px 9px', border: '1px solid var(--line)', borderRadius: 7, fontSize: 13 }} />
        <span style={{ color: 'var(--mut)' }}>→</span>
        <input type="date" value={revTo} onChange={(e) => setRevTo(e.target.value)}
               style={{ padding: '6px 9px', border: '1px solid var(--line)', borderRadius: 7, fontSize: 13 }} />
        {(revFrom || revTo) && (
          <button type="button" className="btn sm" onClick={() => { setRevFrom(''); setRevTo(''); }}>Clear dates ✕</button>
        )}
        <span style={{ marginLeft: 'auto', color: 'var(--mut)', fontSize: 12.5 }}>
          Use the top-bar <b>Filters</b> for city, society, CP, RM, BHK, source, etc.
        </span>
      </div>

      <ChipBar label="Stage" options={STAGE_TABS} counts={stageCounts} value={stageTab} onChange={setStageTab} multi />

      <div className="neg-count" style={{ margin: '8px 2px', color: 'var(--mut)', fontSize: 13 }}>
        <b>{rows.length}</b> in the revisit funnel
      </div>

      <PipelineQueue seed={seed} rows={rows} mode="revisit" onOpenBroker={onOpenBroker} onSaved={reloadSeed} />
    </div>
  );
}
