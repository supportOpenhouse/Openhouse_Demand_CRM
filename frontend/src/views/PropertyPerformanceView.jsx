// Property Performance — the Property Status report (moved out of Analytics into its own
// tab) with a full filter bar: City / Region / Society / Config / Flat status / Responsible
// person / Ask-price range / Days-since-KH buckets. All filters are applied inside
// PropertyStatusTable (additive), so the table, KH editing and CSV are unchanged.
import { useState, useEffect, useMemo } from 'react';
import { loadKeyHandovers } from '../api.js';
import PropertyStatusTable from '../components/PropertyStatusTable.jsx';

const KH_BUCKETS = [['0-30', '0–30d'], ['31-60', '31–60d'], ['61-90', '61–90d'], ['91+', '90+ d'], ['none', 'No KH']];
const EMPTY = { cities: [], regions: [], societyQuery: '', configs: [], flatStatuses: [], responsible: '', priceMin: '', priceMax: '', khBuckets: [] };
const uniq = (arr) => [...new Set(arr.filter(Boolean))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

export default function PropertyPerformanceView({ seed }) {
  const [kh, setKh] = useState({ items: [], source: 'unset' });
  useEffect(() => {
    let alive = true;
    loadKeyHandovers().then((d) => alive && setKh(d)).catch(() => alive && setKh({ items: [], source: 'error' }));
    return () => { alive = false; };
  }, []);

  const [f, setF] = useState(EMPTY);
  const props = seed.properties || [];
  const opt = useMemo(() => ({
    cities: uniq(props.map((p) => p.city_name || p.city)),
    regions: uniq(props.map((p) => p.micro_market)),
    configs: uniq(props.map((p) => p.configuration)),
    flatStatuses: uniq(props.map((p) => p.listing_status)),
    responsibles: uniq(props.map((p) => p.sales_manager)),
  }), [props]);

  const toggle = (k, v) => setF((s) => ({ ...s, [k]: s[k].includes(v) ? s[k].filter((x) => x !== v) : [...s[k], v] }));
  const set = (k, v) => setF((s) => ({ ...s, [k]: v }));
  const active = [f.cities.length, f.regions.length, f.societyQuery.trim() ? 1 : 0, f.configs.length,
    f.flatStatuses.length, f.responsible ? 1 : 0, (f.priceMin || f.priceMax) ? 1 : 0, f.khBuckets.length]
    .filter(Boolean).length;

  const Pills = ({ label, items, sel, k }) => (
    <div className="pp-fg">
      <span className="pp-fl">{label}</span>
      <div className="pp-pills">
        {items.length === 0 && <span className="pp-none">—</span>}
        {items.map((it) => (
          <button key={it} type="button" className={'pp-pill' + (sel.includes(it) ? ' on' : '')} onClick={() => toggle(k, it)}>{it}</button>
        ))}
      </div>
    </div>
  );

  return (
    <div className="pp-root">
      <PpStyles />
      <div className="pp-head">
        <div className="pp-ic">🏢</div>
        <div>
          <div className="pp-h">Property Performance</div>
          <div className="pp-d">Per-unit visit performance &amp; key-handover ageing across the live inventory. Filter by any dimension, then export or open in Sheets.</div>
        </div>
      </div>

      <div className="pp-filters">
        <Pills label="City" items={opt.cities} sel={f.cities} k="cities" />
        <Pills label="Region" items={opt.regions} sel={f.regions} k="regions" />
        <Pills label="Flat status" items={opt.flatStatuses} sel={f.flatStatuses} k="flatStatuses" />
        <Pills label="Config" items={opt.configs} sel={f.configs} k="configs" />
        <div className="pp-fg">
          <span className="pp-fl">Days since KH</span>
          <div className="pp-pills">
            {KH_BUCKETS.map(([k, l]) => (
              <button key={k} type="button" className={'pp-pill' + (f.khBuckets.includes(k) ? ' on' : '')} onClick={() => toggle('khBuckets', k)}>{l}</button>
            ))}
          </div>
        </div>
        <div className="pp-frow">
          <div className="pp-fg pp-grow">
            <span className="pp-fl">Society</span>
            <input className="pp-in" placeholder="Type to filter society…" value={f.societyQuery} onChange={(e) => set('societyQuery', e.target.value)} />
          </div>
          <div className="pp-fg">
            <span className="pp-fl">Responsible person</span>
            <select className="pp-in" value={f.responsible} onChange={(e) => set('responsible', e.target.value)}>
              <option value="">Any</option>
              {opt.responsibles.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
          </div>
          <div className="pp-fg">
            <span className="pp-fl">Ask price (₹ Cr)</span>
            <div className="pp-price">
              <input className="pp-in sm" type="number" min="0" step="0.1" placeholder="min" value={f.priceMin} onChange={(e) => set('priceMin', e.target.value)} />
              <span className="pp-dash">–</span>
              <input className="pp-in sm" type="number" min="0" step="0.1" placeholder="max" value={f.priceMax} onChange={(e) => set('priceMax', e.target.value)} />
            </div>
          </div>
          {active > 0 && <button type="button" className="pp-clear" onClick={() => setF(EMPTY)}>Clear filters ({active})</button>}
        </div>
      </div>

      <PropertyStatusTable seed={seed} filters={f} khItems={kh.items} khOverrides={kh.overrides} khSource={kh.source} />
    </div>
  );
}

function PpStyles() {
  return (
    <style>{`
.pp-root{--pp-brand:#F4541C;--pp-line:#ECEAE6;--pp-line2:#E2DFD9;--pp-mut:#6E6E73;--pp-bg:#F6F4F0}
.pp-head{display:flex;align-items:flex-start;gap:12px;margin-bottom:14px}
.pp-ic{font-size:22px;line-height:1}
.pp-h{font-size:19px;font-weight:800;letter-spacing:-.02em}
.pp-d{font-size:12.5px;color:var(--pp-mut);margin-top:3px;line-height:1.5;max-width:760px}
.pp-filters{background:#fff;border:1px solid var(--pp-line);border-radius:13px;padding:13px 15px;margin-bottom:16px;display:flex;flex-direction:column;gap:11px}
.pp-fg{display:flex;align-items:flex-start;gap:9px}
.pp-fl{font-size:10.5px;text-transform:uppercase;letter-spacing:.5px;font-weight:700;color:var(--pp-mut);min-width:96px;padding-top:6px;flex:0 0 auto}
.pp-pills{display:flex;flex-wrap:wrap;gap:6px}
.pp-none{font-size:12px;color:#B4B2A9;padding-top:5px}
.pp-pill{border:1px solid var(--pp-line2);background:#fff;border-radius:999px;padding:5px 12px;font-size:12px;font-weight:600;color:#3C3C3C;cursor:pointer;font-family:inherit}
.pp-pill:hover{border-color:#cfccc4}
.pp-pill.on{background:var(--pp-brand);border-color:var(--pp-brand);color:#fff}
.pp-frow{display:flex;flex-wrap:wrap;align-items:flex-end;gap:16px;border-top:1px solid var(--pp-line);padding-top:11px}
.pp-frow .pp-fg{flex-direction:column;align-items:stretch;gap:5px}
.pp-frow .pp-fl{min-width:0;padding-top:0}
.pp-grow{flex:1;min-width:180px}
.pp-in{border:1px solid var(--pp-line2);border-radius:9px;padding:8px 11px;font-size:13px;outline:none;font-family:inherit;background:#fff;color:#1A1A1A}
.pp-in:focus{border-color:var(--pp-brand)}
.pp-in.sm{width:78px}
.pp-price{display:flex;align-items:center;gap:7px}
.pp-dash{color:var(--pp-mut)}
.pp-clear{margin-left:auto;border:1px solid var(--pp-line2);background:#fff;border-radius:9px;padding:8px 13px;font-size:12.5px;font-weight:700;color:#B91C1C;cursor:pointer;font-family:inherit}
.pp-clear:hover{background:#FCEBEB;border-color:#F09595}
    `}</style>
  );
}
