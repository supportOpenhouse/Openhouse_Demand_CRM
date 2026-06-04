import { useMemo, useRef, useState } from 'react';
import { toast } from '../lib/toast.js';

const CITY_ORDER = ['Gurgaon', 'Noida', 'Ghaziabad'];

function unitOf(p) {
  const u = (p.property_name || '').replace(p.society_name || '', '').replace(/^[\s,\-]+/, '').trim();
  return u || p.property_name || '—';
}

export default function SnapshotView({ seed }) {
  const props = seed.properties || [];
  const byCity = useMemo(() => {
    const out = {};
    CITY_ORDER.forEach((c) => {
      const list = props.filter((p) => p.city_name === c);
      const mm = {};
      list.forEach((p) => { const k = (p.micro_market || 'Other').trim(); (mm[k] = mm[k] || []).push(p); });
      out[c] = { list, mm, order: Object.keys(mm).sort() };
    });
    return out;
  }, [props]);

  const cities = CITY_ORDER.filter((c) => byCity[c].list.length);
  const total = props.length;
  const ready = props.filter((p) => p.listing_status === 'Ready').length;

  if (!total) return <div className="empty"><div className="emoji">📦</div><div className="t">No inventory loaded</div></div>;

  return (
    <div className="rx-fade">
      <div className="muted" style={{ fontSize: 12, marginBottom: 14 }}>{total} live properties · {ready} ready · share-ready snapshot</div>
      {cities.map((c) => <CityBlock key={c} city={c} g={byCity[c]} />)}
    </div>
  );
}

function CityBlock({ city, g }) {
  const ref = useRef(null);
  const [busy, setBusy] = useState(false);

  function copyText() {
    let txt = `*OpenHouse · ${city} Inventory* — ${g.list.length} units\n`;
    g.order.forEach((mm) => {
      txt += `\n*${mm}*\n`;
      g.mm[mm].slice().sort((a, b) => (a.society_name || '').localeCompare(b.society_name || '')).forEach((p) => {
        txt += `• ${p.society_name || p.property_name} — ${p.configuration || ''}${p.super_sqft ? ` (${p.super_sqft} sqft)` : ''} — ${p.listing_status} — ${p.listing_price || '—'}\n`;
      });
    });
    if (navigator.clipboard) navigator.clipboard.writeText(txt).then(() => toast(`${city} snapshot copied`, 'good')).catch(() => toast('Copy failed', 'bad'));
    else toast('Clipboard unavailable', 'bad');
  }

  async function downloadImage() {
    if (!ref.current) return;
    setBusy(true);
    try {
      const { default: html2canvas } = await import('html2canvas');  // code-split: only loaded on use
      const bg = getComputedStyle(document.body).backgroundColor || '#ffffff';
      const canvas = await html2canvas(ref.current, { backgroundColor: bg, scale: 2, logging: false });
      const a = document.createElement('a');
      a.href = canvas.toDataURL('image/png');
      a.download = `OpenHouse-${city}-inventory.png`;
      a.click();
      toast(`${city} image downloaded`, 'good');
    } catch (e) { toast('Image export failed', 'bad'); }
    finally { setBusy(false); }
  }

  return (
    <div style={{ marginBottom: 24 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10, flexWrap: 'wrap' }}>
        <h3 style={{ margin: 0, fontSize: 15 }}>{city} · {g.list.length} units</h3>
        <button className="btn xs" onClick={copyText}>📋 Copy text</button>
        <button className="btn xs" disabled={busy} onClick={downloadImage}>{busy ? '…' : '📷 Image'}</button>
      </div>
      <div ref={ref} style={{ padding: 14, background: 'var(--bg)', borderRadius: 10 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 12 }}>
          <b style={{ fontSize: 15 }}>OpenHouse · {city}</b>
          <span className="muted" style={{ fontSize: 11.5 }}>{g.list.length} units · live inventory</span>
        </div>
        {g.order.map((mm) => {
          const list = g.mm[mm].slice().sort((a, b) => (a.society_name || '').localeCompare(b.society_name || ''));
          return (
            <div key={mm} style={{ marginBottom: 12 }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--mut)', margin: '4px 2px 6px' }}>{mm} · {list.length}</div>
              <div className="tbl-wrap" style={{ overflow: 'visible' }}>
                <table className="t" style={{ minWidth: 0, width: '100%' }}>
                  <thead><tr><th>Society</th><th>Unit</th><th>Area</th><th>Config</th><th>Status</th><th style={{ textAlign: 'right' }}>Ask price</th></tr></thead>
                  <tbody>
                    {list.map((p, i) => (
                      <tr key={(p.property_name || '') + i} style={{ cursor: 'default' }}>
                        <td><b>{p.society_name || '—'}</b></td>
                        <td>{unitOf(p)}</td>
                        <td>{p.super_sqft ? `${p.super_sqft} sqft` : '—'}</td>
                        <td>{p.configuration || '—'}</td>
                        <td><span className="rx-pill" style={{ background: 'var(--panel2)', color: p.listing_status === 'Ready' ? 'var(--good,#15803D)' : 'var(--txt)' }}>{p.listing_status || '—'}</span></td>
                        <td style={{ textAlign: 'right', fontWeight: 700, color: 'var(--accDark,var(--acc))' }}>{p.listing_price || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
