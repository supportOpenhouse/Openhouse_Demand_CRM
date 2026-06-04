import { useEffect, useMemo, useState } from 'react';
import { TODAY, ymd } from '../lib/format.js';

// Advanced Visits filters — faithful to crm.html's #modal-filters (society / locality /
// BHK / CP tier / CP / RM / source / visit-date range / next-followup).
const BHK = ['1 BHK', '2 BHK', '3 BHK', '4 BHK'];
const TIERS = [['T1', 'Tier 1 (Gold)'], ['T2', 'Tier 2 (Silver)'], ['T3', 'Tier 3'], ['T4', 'Tier 4']];
const SOURCES = [['channel_partner', 'via CP'], ['direct', 'Direct']];
const FU = [['overdue', 'Overdue'], ['today', 'Today'], ['tomorrow', 'Tomorrow'], ['week', 'Next 7 days'], ['none', 'No FU set']];
const DATE_PRESETS = [['today', 'Today'], ['yesterday', 'Yesterday'], ['week', 'This week'], ['month', 'This month'], ['last7', 'Last 7 days'], ['last30', 'Last 30 days']];

const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const EMPTY = { society: '', locality: '', bhk: [], tier: [], cp: '', rm: '', source: [], visitFrom: '', visitTo: '', followupDate: [] };

export default function FiltersModal({ seed, value, onApply, onClose }) {
  const [f, setF] = useState({ ...EMPTY, ...(value || {}) });
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const visits = seed.visits || [];
  const properties = seed.properties || [];
  const brokers = seed.brokers || [];

  const societies = useMemo(() => [...new Set([
    ...visits.map((v) => v.society_name), ...properties.map((p) => p.society_name),
  ].filter(Boolean))].sort(), [visits, properties]);
  const localities = useMemo(() => [...new Set([
    ...properties.map((p) => p.micro_market), ...properties.map((p) => p.locality_or_sector),
    ...brokers.flatMap((b) => (b.micro_markets || '').split(',').map((s) => s.trim())),
  ].filter(Boolean))].sort(), [properties, brokers]);
  const rms = useMemo(() => [...new Set(visits.map((v) => v.sales_manager).filter(Boolean))].sort(), [visits]);

  const togglePill = (key, v) => setF((p) => ({ ...p, [key]: p[key].includes(v) ? p[key].filter((x) => x !== v) : [...p[key], v] }));
  const setDate = (a, b) => setF((p) => ({ ...p, visitFrom: ymd(a), visitTo: ymd(b) }));
  const preset = (k) => {
    const t = TODAY, y = addDays(t, -1);
    const wk = addDays(t, -((t.getDay() + 6) % 7));
    const mo = new Date(t.getFullYear(), t.getMonth(), 1);
    if (k === 'today') setDate(t, t);
    else if (k === 'yesterday') setDate(y, y);
    else if (k === 'week') setDate(wk, t);
    else if (k === 'month') setDate(mo, t);
    else if (k === 'last7') setDate(addDays(t, -7), t);
    else if (k === 'last30') setDate(addDays(t, -30), t);
  };

  const Pills = ({ items, sel, onToggle }) => (
    <div className="rx-fu-pills">
      {items.map(([k, label]) => (
        <button key={k} type="button" className={'fu-pill' + (sel.includes(k) ? ' on' : '')} onClick={() => onToggle(k)}>{label}</button>
      ))}
    </div>
  );
  const lbl = { fontSize: 10.5, color: 'var(--mut2)', textTransform: 'uppercase', letterSpacing: '.5px', fontWeight: 700, marginBottom: 6, display: 'block' };

  return (
    <div className="rx-modal-bg" style={{ zIndex: 230 }} onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="rx-modal" style={{ width: 'min(880px, 95vw)' }} role="dialog" aria-modal="true">
        <div className="rx-modal-head"><h2>Filters</h2><button className="rx-x" onClick={onClose} aria-label="Close">✕</button></div>
        <div className="rx-modal-body">
          <div className="rx-flt-grid">
            <div>
              <label style={lbl}>Society</label>
              <input className="rx-inp" style={{ width: '100%' }} list="flt-soc" placeholder="Type or pick society…"
                     value={f.society} onChange={(e) => setF((p) => ({ ...p, society: e.target.value }))} />
              <datalist id="flt-soc">{societies.map((s) => <option key={s} value={s} />)}</datalist>
            </div>
            <div>
              <label style={lbl}>Locality / Micromarket</label>
              <input className="rx-inp" style={{ width: '100%' }} list="flt-loc" placeholder="Type or pick locality / MM…"
                     value={f.locality} onChange={(e) => setF((p) => ({ ...p, locality: e.target.value }))} />
              <datalist id="flt-loc">{localities.map((s) => <option key={s} value={s} />)}</datalist>
            </div>
            <div>
              <label style={lbl}>BHK</label>
              <Pills items={BHK.map((b) => [b, b])} sel={f.bhk} onToggle={(v) => togglePill('bhk', v)} />
            </div>
            <div>
              <label style={lbl}>CP Tier</label>
              <Pills items={TIERS} sel={f.tier} onToggle={(v) => togglePill('tier', v)} />
            </div>
            <div>
              <label style={lbl}>Channel Partner</label>
              <input className="rx-inp" style={{ width: '100%' }} list="flt-cp" placeholder="Type CP name / code / company…"
                     value={f.cp} onChange={(e) => setF((p) => ({ ...p, cp: e.target.value }))} />
              <datalist id="flt-cp">{brokers.slice(0, 4000).map((b) => <option key={b.cp_code} value={b.cp_code}>{b.name} · {b.cp_code} · {b.company_name || ''}</option>)}</datalist>
            </div>
            <div>
              <label style={lbl}>RM / sales_manager</label>
              <input className="rx-inp" style={{ width: '100%' }} list="flt-rm" placeholder="Type or pick RM…"
                     value={f.rm} onChange={(e) => setF((p) => ({ ...p, rm: e.target.value }))} />
              <datalist id="flt-rm">{rms.map((s) => <option key={s} value={s} />)}</datalist>
            </div>
            <div>
              <label style={lbl}>Source</label>
              <Pills items={SOURCES} sel={f.source} onToggle={(v) => togglePill('source', v)} />
            </div>
            <div className="rx-flt-full">
              <label style={lbl}>Visit date range</label>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <input className="rx-inp" type="date" value={f.visitFrom} onChange={(e) => setF((p) => ({ ...p, visitFrom: e.target.value }))} />
                <span className="muted">to</span>
                <input className="rx-inp" type="date" value={f.visitTo} onChange={(e) => setF((p) => ({ ...p, visitTo: e.target.value }))} />
                <button className="btn sm" type="button" onClick={() => setF((p) => ({ ...p, visitFrom: '', visitTo: '' }))}>Clear</button>
              </div>
              <div className="rx-fu-pills" style={{ marginTop: 8 }}>
                {DATE_PRESETS.map(([k, label]) => <button key={k} type="button" className="fu-pill" onClick={() => preset(k)}>{label}</button>)}
              </div>
            </div>
            <div className="rx-flt-full">
              <label style={lbl}>Next followup</label>
              <Pills items={FU} sel={f.followupDate} onToggle={(v) => togglePill('followupDate', v)} />
            </div>
          </div>
        </div>
        <div className="rx-modal-foot" style={{ justifyContent: 'space-between' }}>
          <button className="btn ghost" type="button" onClick={() => setF({ ...EMPTY })}>Reset</button>
          <div style={{ display: 'flex', gap: 9 }}>
            <button className="btn" type="button" onClick={onClose}>Cancel</button>
            <button className="btn primary" type="button" onClick={() => onApply(f)}>Apply</button>
          </div>
        </div>
      </div>
    </div>
  );
}

// count of active filters (for the topbar badge)
export function activeFilterCount(f) {
  if (!f) return 0;
  let n = 0;
  Object.values(f).forEach((v) => { if (Array.isArray(v) ? v.length : v) n++; });
  return n;
}
