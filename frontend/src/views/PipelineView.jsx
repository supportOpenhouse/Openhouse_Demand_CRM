// Pipeline — Revisits AND Negotiations in ONE tab (replaces the two separate ones).
// Holds the whole mid/late funnel: Revisit Scheduled, After Revisit FU, Negotiation and
// After Negotiation FU, plus buyers who actually came back to the same unit (🔁 Revisited).
// PipelineQueue picks the per-ROW confirm behaviour from that row's stage, so a revisit row
// still asks "did the revisit happen?" and a negotiation row still asks "is the meeting
// confirmed?" — byte-identical to the old tabs. In this tab it ALSO renders, without any
// click: the PM remark history, the manager remark box (TL/Admin), and a Transactional /
// Non-Transactional badge on each CP. This wrapper owns scoping + the SAME Visits filters +
// a combined revisit/negotiation date range + the stage tabs.
// KEEP the funnel IN SYNC with backend seed_snapshot.PIPELINE_STAGES (it bounds the remark
// history shipped in the seed).
import { useMemo, useDeferredValue } from 'react';
import { daysBetween } from '../lib/format.js';
import { visitStage, scopeVisits, nextFuFor, nextActivityFor, buildRevisitIndex } from '../lib/visits.js';
import { flatNo } from '../lib/propertyStatus.js';
import ChipBar from '../components/ChipBar.jsx';
import PipelineQueue from '../components/PipelineQueue.jsx';
import { useStickyState } from '../lib/sessionFilters.js';

const FUNNEL = ['revisit_scheduled', 'after_revisit_fu', 'negotiation', 'after_negotiation_fu', 'booking'];
const STAGE_TABS = [
  { k: 'all', label: 'All', cls: '' },
  { k: 'revisited', label: '🔁 Revisited', cls: 'sg-rev' },
  { k: 'revisit_scheduled', label: 'Revisit Scheduled', cls: 'sg-rev' },
  { k: 'after_revisit_fu', label: 'After Revisit FU', cls: 'sg-avfu' },
  { k: 'negotiation', label: 'Negotiation', cls: 'sg-nego' },
  { k: 'after_negotiation_fu', label: 'After Negotiation FU', cls: 'sg-avfu' },
  { k: 'booking', label: 'Booking', cls: 'sg-book' },
];
// one row's activity date = whichever of the two applies to its stage
const actDate = (v) => {
  const d = v._revisit_date || v._negotiation_date || '';
  return d ? String(d).slice(0, 10) : '';
};

export default function PipelineView({ seed, onOpenBroker, reloadSeed, search = '', filters = {}, onResetGlobalFilters }) {
  const me = seed.current_user || {};
  const cpOwner = seed.cp_owner || {};
  const properties = seed.properties || [];

  const scoped = useMemo(() => {
    const v = scopeVisits(seed.visits || [], me, cpOwner, properties, seed.pm_by_property || {}, seed.past_kam || {}, seed.dup_rm_names || []);
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

  const [stageTab, setStageTab] = useStickyState('pipeline:stageTab', []);
  const [revFrom, setRevFrom] = useStickyState('pipeline:from', '');
  const [revTo, setRevTo] = useStickyState('pipeline:to', '');
  const dq = useDeferredValue(search);
  const resetFilters = () => { setStageTab([]); setRevFrom(''); setRevTo(''); onResetGlobalFilters?.(); };

  // Revisit index over the FULL scoped set (chains complete within scope). An "actual
  // revisit" = the LATEST visit of a chain that has an earlier COMPLETED visit to the same
  // unit + broker + buyer. The Revisits tab = the follow-up-scheduled revisit funnel UNION
  // the actual revisits (which keep their own pipeline stage; surfaced here as a focus signal).
  const revIndex = useMemo(() => buildRevisitIndex(scoped), [scoped]);
  const isActualRev = (v) => { const r = revIndex.get(v.id); return !!(r && r.isRevisit && r.isChainLatest); };
  const funnel = useMemo(() => {
    const seen = new Set(); const out = [];
    for (const v of scoped) {
      if ((FUNNEL.includes(visitStage(v)) || isActualRev(v)) && !seen.has(v.id)) { seen.add(v.id); out.push(v); }
    }
    return out;
  }, [scoped, revIndex]); // eslint-disable-line react-hooks/exhaustive-deps

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
    // activity-date range — revisit date OR negotiation date, whichever this row has
    const rd = actDate(v);
    if (revFrom && !(rd && rd >= revFrom)) return false;
    if (revTo && !(rd && rd <= revTo)) return false;
    return true;
  }), [funnel, filters, dq, propBySociety, brokersByCode, revFrom, revTo]);

  const stageCounts = useMemo(() => {
    const c = { all: base.length, revisited: 0, revisit_scheduled: 0, after_revisit_fu: 0, negotiation: 0, after_negotiation_fu: 0, booking: 0 };
    base.forEach((v) => { const s = visitStage(v); c[s] = (c[s] || 0) + 1; if (isActualRev(v)) c.revisited += 1; });
    return c;
  }, [base, revIndex]); // eslint-disable-line react-hooks/exhaustive-deps

  const rows = useMemo(
    () => (stageTab.length
      ? base.filter((v) => stageTab.includes(visitStage(v)) || (stageTab.includes('revisited') && isActualRev(v)))
      : base),
    [base, stageTab, revIndex], // eslint-disable-line react-hooks/exhaustive-deps
  );

  return (
    <div className="rx-fade">
      <div className="neg-filters" style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10, marginBottom: 10 }}>
        <span style={{ fontWeight: 600, fontSize: 13 }}>Revisit / negotiation date</span>
        <input type="date" value={revFrom} onChange={(e) => setRevFrom(e.target.value)}
               style={{ padding: '6px 9px', border: '1px solid var(--line)', borderRadius: 7, fontSize: 13 }} />
        <span style={{ color: 'var(--mut)' }}>→</span>
        <input type="date" value={revTo} onChange={(e) => setRevTo(e.target.value)}
               style={{ padding: '6px 9px', border: '1px solid var(--line)', borderRadius: 7, fontSize: 13 }} />
        {(revFrom || revTo) && (
          <button type="button" className="btn sm" onClick={() => { setRevFrom(''); setRevTo(''); }}>Clear dates ✕</button>
        )}
        <button type="button" className="btn sm rx-reset-filters" onClick={resetFilters} title="Reset every filter on this tab">↺ Reset filters</button>
        <span style={{ color: 'var(--mut)', fontSize: 12.5, flexBasis: '100%', marginTop: 2 }}>
          Use the top-bar <b>Filters</b> for city, society, CP, RM, BHK, source, etc.
        </span>
      </div>

      <ChipBar label="Stage" options={STAGE_TABS} counts={stageCounts} value={stageTab} onChange={setStageTab} multi />

      <div className="neg-count" style={{ margin: '8px 2px', color: 'var(--mut)', fontSize: 13 }}>
        <b>{rows.length}</b> pipeline lead{rows.length === 1 ? '' : 's'} — revisits + negotiations, with PM &amp; manager remarks inline
      </div>

      <PipelineQueue seed={seed} rows={rows} mode="pipeline" onOpenBroker={onOpenBroker} onSaved={reloadSeed} revIndex={revIndex} />
    </div>
  );
}
