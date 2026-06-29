// Property Performance — the Property Status report (moved out of Analytics into its own
// tab) with a full filter bar: City / Region / Society / Config / Flat status / Responsible
// person / Ask-price range / Days-since-KH buckets. All filters are applied inside
// PropertyStatusTable (additive), so the table, KH editing and CSV are unchanged.
import { useState, useEffect, useMemo } from 'react';
import { useStickyState } from '../lib/sessionFilters.js';
import { loadKeyHandovers } from '../api.js';
import PropertyStatusTable from '../components/PropertyStatusTable.jsx';
import { buildPropertyStatusRows, buildKhMap } from '../lib/propertyStatus.js';

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

  const [f, setF] = useStickyState('propertyperf:f', EMPTY);
  const props = seed.properties || [];
  const opt = useMemo(() => ({
    cities: uniq(props.map((p) => p.city_name || p.city)),
    regions: uniq(props.map((p) => p.micro_market)),
    configs: uniq(props.map((p) => p.configuration)),
    flatStatuses: uniq(props.map((p) => p.listing_status)),
    responsibles: uniq(props.map((p) => p.sales_manager)),
  }), [props]);

  // Inventory-aging ladder (additive, read-only). Reuse the Property-Status ageing
  // (days_since_kh = today − key-handover date, via the SAME society/unit matcher the
  // table uses) and bucket the HELD-and-to-sell units (Ready / Coming Soon only —
  // Sold / Booked / Archived are gone or closing) on the research-backed 30/60/75/90-day
  // ladder. `props` is already user-scoped, so a PM sees only their societies, a TL
  // their city, an Admin everything — no new scoping logic.
  const agingRows = useMemo(
    () => buildPropertyStatusRows(props, [], buildKhMap(kh.items || []), kh.overrides || {}, kh.review || {}),
    [props, kh],
  );
  const aging = useMemo(() => {
    const held = (s) => ['ready', 'coming soon'].includes((s || '').toLowerCase().trim());
    const d30 = [], d60 = [], d75 = [], d90 = [], noKh = [];
    let heldTotal = 0;
    for (const r of agingRows) {
      if (!held(r.flat_status)) continue;
      heldTotal += 1;
      const d = r.days_since_kh;
      if (d == null) noKh.push(r);
      else if (d >= 90) d90.push(r);
      else if (d >= 75) d75.push(r);
      else if (d >= 60) d60.push(r);
      else if (d >= 30) d30.push(r);
      // d < 30 → fresh; counted in heldTotal only
    }
    const aged = [...d90, ...d75, ...d60].sort((a, b) => (b.days_since_kh || 0) - (a.days_since_kh || 0));
    return { d30, d60, d75, d90, noKh, aged, heldTotal };
  }, [agingRows]);

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

      {/* Inventory-aging alert ladder — read-only summary above the table. Held units
          (Ready / Coming Soon) bucketed by days held since key-handover on the 30/60/75/90
          ladder (<60d healthy · 90d+ = loss zone). Scoped: `props` is already this user's.
          Gated on KH having loaded so we never flash "all no-KH" during the fetch. */}
      {kh.source !== 'unset' && aging.heldTotal > 0 && (
        <div className="pp-aging">
          <div className="pp-aging-top">
            <span className="pp-aging-h">⏳ Inventory aging</span>
            <span className="pp-aging-sub">
              {aging.heldTotal} held unit{aging.heldTotal === 1 ? '' : 's'} (Ready / Coming Soon) · days held = today − key handover
            </span>
          </div>
          <div className="pp-ladder">
            <div className="pp-rung watch"><b>{aging.d30.length}</b><span>30–59d</span></div>
            <div className="pp-rung warn"><b>{aging.d60.length}</b><span>60–74d</span></div>
            <div className="pp-rung urgent"><b>{aging.d75.length}</b><span>75–89d</span></div>
            <div className="pp-rung crit"><b>{aging.d90.length}</b><span>90+d · loss zone</span></div>
            {aging.noKh.length > 0 && <div className="pp-rung mut"><b>{aging.noKh.length}</b><span>no KH date</span></div>}
          </div>
          {aging.aged.length > 0 && (
            <div className="pp-aged-list">
              {aging.aged.slice(0, 8).map((r, i) => {
                const d = r.days_since_kh;
                const tone = d >= 90 ? 'crit' : d >= 75 ? 'urgent' : 'warn';
                return (
                  <div key={i} className="pp-aged">
                    <span className="pp-aged-l">
                      <b>{r.society}{r.unit ? ' ' + r.unit : ''}</b>
                      <span className="pp-aged-sub">{r.flat_status}{r.responsible ? ' · ' + r.responsible : ''}</span>
                    </span>
                    <span className={'pp-aged-d ' + tone}>{d}d held{d < 90 ? ` · ${90 - d}d to loss line` : ' · in loss zone'}</span>
                  </div>
                );
              })}
              {aging.aged.length > 8 && (
                <div className="pp-aged-more">+{aging.aged.length - 8} more aged units — filter “Days since KH” below ↓</div>
              )}
            </div>
          )}
        </div>
      )}

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
          {active > 0 && <button type="button" className="pp-clear" onClick={() => setF(EMPTY)}>↺ Reset filters</button>}
        </div>
      </div>

      <PropertyStatusTable seed={seed} filters={f} khItems={kh.items} khOverrides={kh.overrides} review={kh.review} khSource={kh.source} />
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
.pp-aging{background:#fff;border:1px solid var(--pp-line);border-radius:13px;padding:14px 16px;margin-bottom:16px}
.pp-aging-top{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;margin-bottom:11px}
.pp-aging-h{font-size:14px;font-weight:800;letter-spacing:-.01em}
.pp-aging-sub{font-size:11.5px;color:var(--pp-mut)}
.pp-ladder{display:grid;grid-template-columns:repeat(auto-fit,minmax(96px,1fr));gap:9px}
.pp-rung{border:1px solid var(--pp-line2);border-radius:10px;padding:9px 10px;text-align:center;background:#FAFAF8}
.pp-rung b{display:block;font-size:20px;font-weight:800;line-height:1}
.pp-rung span{display:block;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.02em;color:var(--pp-mut);margin-top:4px}
.pp-rung.watch{background:#FEFCE8;border-color:#FDE68A}.pp-rung.watch b{color:#A16207}
.pp-rung.warn{background:#FFF7ED;border-color:#FED7AA}.pp-rung.warn b{color:#C2410C}
.pp-rung.urgent{background:#FFF1F0;border-color:#FDBA9E}.pp-rung.urgent b{color:#C0392B}
.pp-rung.crit{background:#FEF2F2;border-color:#FCA5A5}.pp-rung.crit b{color:#B91C1C}
.pp-rung.mut b{color:var(--pp-mut)}
.pp-aged-list{margin-top:12px;border-top:1px solid var(--pp-line);padding-top:6px;display:flex;flex-direction:column}
.pp-aged{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:7px 2px;border-bottom:1px solid var(--pp-line)}
.pp-aged-l{display:flex;flex-direction:column;gap:1px;min-width:0}
.pp-aged-l b{font-size:13px;font-weight:700;color:#1A1A1A}
.pp-aged-sub{font-size:11px;color:var(--pp-mut)}
.pp-aged-d{font-size:11.5px;font-weight:700;white-space:nowrap;padding:3px 9px;border-radius:999px}
.pp-aged-d.warn{background:#FFF7ED;color:#C2410C}
.pp-aged-d.urgent{background:#FFF1F0;color:#C0392B}
.pp-aged-d.crit{background:#FEF2F2;color:#B91C1C}
.pp-aged-more{font-size:11.5px;color:var(--pp-mut);padding-top:8px;font-weight:600}
    `}</style>
  );
}
