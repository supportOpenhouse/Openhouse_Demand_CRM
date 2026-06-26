import { useMemo, useRef, useState, useEffect, useCallback, forwardRef } from 'react';
import { TODAY, ymd, fmtDate } from '../lib/format.js';
import { parsePrice, fmtPrice } from '../lib/legacy.js';
import { toast } from '../lib/toast.js';
import useIsMobile from '../lib/useIsMobile.js';

const CITY_ORDER = ['Gurgaon', 'Noida', 'Ghaziabad'];

const CITY_CFG = {
  Gurgaon:   { sub: 'OpenHouse · Gurgaon Inventory' },
  Noida:     { sub: 'OpenHouse · Noida Inventory' },
  Ghaziabad: { sub: 'OpenHouse · Ghaziabad Inventory' },
};

// listing_status==='Coming Soon' drives the NEW badge (legacy isPropertyNew)
function isPropertyNew(p) { return p.listing_status === 'Coming Soon'; }

// strip the society prefix off the full property name, trim leading space/comma/dash, fallback '—'
function unitOf(p) {
  return (p.property_name || '').replace(p.society_name || '', '').replace(/^[ ,\-]+/, '') || '—';
}

// groupPropertiesByCity(): fixed city order, group by trimmed micro_market, micro-markets sorted alpha.
function groupPropertiesByCity(properties) {
  const result = {};
  CITY_ORDER.forEach((city) => {
    const props = properties.filter((p) => p.city_name === city);
    const mmGroups = {};
    props.forEach((p) => {
      const k = (p.micro_market || 'Other').trim();
      (mmGroups[k] = mmGroups[k] || []).push(p);
    });
    const ordered = Object.keys(mmGroups).sort();
    result[city] = { mmGroups, ordered, total: props.length };
  });
  return result;
}


// ---- reusable multi-select dropdown (dependency-free) — same pattern/classes as AnalyticsView ----
function MultiSelect({ label, options, value = [], onChange, width }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return;
    const h = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [open]);
  const opts = options.map((x) => (typeof x === 'string' ? { value: x, label: x } : x));
  const shown = q ? opts.filter((o) => o.label.toLowerCase().includes(q.toLowerCase())) : opts;
  const toggle = (val) => onChange(value.includes(val) ? value.filter((x) => x !== val) : [...value, val]);
  return (
    <div className="an-ms" ref={ref} style={width ? { width } : undefined}>
      <button type="button" className={'an-ms-btn' + (value.length ? ' has' : '')} onClick={() => setOpen((o) => !o)}>
        {label}{value.length ? <span className="an-ms-count">{value.length}</span> : null}<span className="an-ms-caret">▾</span>
      </button>
      {open && (
        <div className="an-ms-pop">
          <input className="an-ms-search" autoFocus placeholder={`Search ${label.toLowerCase()}…`} value={q} onChange={(e) => setQ(e.target.value)} />
          <div className="an-ms-actions">
            <button type="button" onClick={() => onChange(shown.map((o) => o.value))}>All</button>
            <button type="button" onClick={() => onChange([])}>Clear</button>
            <span className="an-ms-n">{value.length} selected</span>
          </div>
          <div className="an-ms-list">
            {shown.slice(0, 400).map((o) => (
              <label key={o.value} className="an-ms-opt">
                <input type="checkbox" checked={value.includes(o.value)} onChange={() => toggle(o.value)} />
                <span>{o.label}</span>
              </label>
            ))}
            {shown.length > 400 && <div className="an-ms-more">+{shown.length - 400} more — refine search</div>}
            {shown.length === 0 && <div className="an-ms-more">No matches</div>}
          </div>
        </div>
      )}
    </div>
  );
}

// price range → compact label fragment for the dynamic share title, e.g. "₹1.5–2 Cr", "≤₹2 Cr", "₹1.5 Cr+"
function priceLabel(min, max) {
  const lo = min != null ? fmtPrice(min) : null;
  const hi = max != null ? fmtPrice(max) : null;
  if (lo && hi) return `${lo}–${hi}`;
  if (hi) return `≤${hi}`;
  if (lo) return `${lo}+`;
  return null;
}

export default function SnapshotView({ seed }) {
  const me = seed.current_user || {};
  // Inventory snapshot is unscoped (full property list), matching legacy store.properties.
  const properties = useMemo(() => seed.properties || [], [seed]);

  /* ----------------------------- filter state ----------------------------- */
  const [fCities, setFCities] = useState([]);          // city_name multi
  const [fConfigs, setFConfigs] = useState([]);         // configuration multi
  const [fRegions, setFRegions] = useState([]);         // micro_market multi
  const [priceMin, setPriceMin] = useState('');         // ₹, numeric text
  const [priceMax, setPriceMax] = useState('');         // ₹, numeric text

  // distinct option lists, derived from the full property set (alpha sorted)
  const cityOpts = useMemo(
    () => CITY_ORDER.filter((c) => properties.some((p) => p.city_name === c)),
    [properties]);
  const configOpts = useMemo(() => {
    const s = new Set();
    properties.forEach((p) => { const c = (p.configuration || '').trim(); if (c) s.add(c); });
    return [...s].sort((a, b) => a.localeCompare(b));
  }, [properties]);
  const regionOpts = useMemo(() => {
    const s = new Set();
    properties.forEach((p) => { const m = (p.micro_market || '').trim(); if (m) s.add(m); });
    return [...s].sort((a, b) => a.localeCompare(b));
  }, [properties]);

  // inputs are in CRORES (natural unit for these listings) → convert to ₹ for comparison.
  // e.g. "1.5" → 1.5 Cr → 15,000,000. (0.75 = 75 L works for sub-crore ranges too.)
  const minRs = useMemo(() => { const n = parseFloat(priceMin); return Number.isFinite(n) && n > 0 ? n * 1e7 : null; }, [priceMin]);
  const maxRs = useMemo(() => { const n = parseFloat(priceMax); return Number.isFinite(n) && n > 0 ? n * 1e7 : null; }, [priceMax]);

  const hasFilters = fCities.length || fConfigs.length || fRegions.length || minRs != null || maxRs != null;

  // apply filters to the property list BEFORE grouping / poster
  const filtered = useMemo(() => properties.filter((p) => {
    if (fCities.length && !fCities.includes(p.city_name)) return false;
    if (fConfigs.length && !fConfigs.includes((p.configuration || '').trim())) return false;
    if (fRegions.length && !fRegions.includes((p.micro_market || '').trim())) return false;
    if (minRs != null || maxRs != null) {
      const v = parsePrice(p.listing_price);
      if (minRs != null && v < minRs) return false;
      if (maxRs != null && v > maxRs) return false;
    }
    return true;
  }), [properties, fCities, fConfigs, fRegions, minRs, maxRs]);

  const clearFilters = useCallback(() => {
    setFCities([]); setFConfigs([]); setFRegions([]); setPriceMin(''); setPriceMax('');
  }, []);

  // group / counts run off the FILTERED set so the page stays coherent with the filters
  const grouped = useMemo(() => groupPropertiesByCity(filtered), [filtered]);
  const totalReady = useMemo(() => filtered.filter((p) => p.listing_status === 'Ready').length, [filtered]);
  const totalCS = useMemo(() => filtered.filter((p) => p.listing_status === 'Coming Soon').length, [filtered]);

  // text-share modal state (WhatsApp-ready)
  const [share, setShare] = useState(null);       // { title, text }
  // image-export modal state
  const [img, setImg] = useState(null);           // { props, title, subtitle, filebase, dataUrl|null, loading, canvas }
  const posterRef = useRef(null);

  const countLabel = hasFilters
    ? `${filtered.length} units match · ${totalReady} ready · ${totalCS} coming soon`
    : `${properties.length} live properties · ${totalReady} ready · ${totalCS} coming soon · share-ready snapshot`;

  // build the dynamic title fragments from the active filters (used by the filtered share)
  const filterTitleBits = useMemo(() => {
    const bits = [];
    if (fConfigs.length) bits.push(fConfigs.join(' / '));
    if (fCities.length) bits.push(fCities.join(' & '));
    if (fRegions.length) bits.push(fRegions.join(' / '));
    const pl = priceLabel(minRs, maxRs);
    if (pl) bits.push(pl);
    return bits;
  }, [fConfigs, fCities, fRegions, minRs, maxRs]);

  /* ----------------------------- text share ----------------------------- */
  // build a WhatsApp-ready text block from any property list + a headline label.
  const buildShareText = useCallback((props, headline, sub) => {
    let body = `🏠 *${headline}*\n${sub ? sub + '\n' : ''}Updated ${fmtDate(TODAY)}\n\n`;
    const cities = CITY_ORDER.filter((c) => props.some((p) => p.city_name === c));
    // include any non-standard cities at the end, alpha
    [...new Set(props.map((p) => p.city_name))].sort().forEach((c) => { if (!cities.includes(c)) cities.push(c); });
    cities.forEach((c) => {
      const cityProps = props
        .filter((p) => p.city_name === c)
        .sort((a, b) => (a.micro_market || '').localeCompare(b.micro_market || ''));
      if (!cityProps.length) return;
      body += `━━━ ${(c || 'Other').toUpperCase()} (${cityProps.length} units) ━━━\n\n`;
      let lastMM = '';
      cityProps.forEach((p) => {
        if (p.micro_market !== lastMM) {
          if (lastMM) body += '\n';
          body += `*${p.micro_market}*\n`;
          lastMM = p.micro_market;
        }
        const unit = (p.property_name || '').replace(p.society_name || '', '').replace(/^[ ,\-]+/, '') || '';
        body += `${p.listing_status === 'Coming Soon' ? '🟡' : '🟢'} ${p.society_name}${unit ? ` ${unit}` : ''} · ${p.configuration || ''} · ${p.super_sqft || ''} sqft · ${p.listing_price || ''}${p.listing_status === 'Coming Soon' ? ' (CS)' : ''}\n`;
      });
      body += '\n';
    });
    const first = (me.name || '').split(' ')[0] || 'Team';
    body += `\nReach out for site visits, virtual tour, or pricing details.\n\n– ${first}, OpenHouse`;
    return body;
  }, [me.name]);

  // per-city share (operates on the filtered set so it matches what's on screen)
  const openShare = useCallback((cities) => {
    const props = filtered.filter((p) => cities.includes(p.city_name));
    setShare({
      title: `Inventory snapshot · ${cities.join(' & ')}`,
      text: buildShareText(props, `OpenHouse Live Inventory · ${cities.join(' & ')}`),
    });
  }, [filtered, buildShareText]);

  /* ----------------------------- image export ----------------------------- */
  const openImage = useCallback((props, title, subtitle, filebase) => {
    setImg({ props, title, subtitle, filebase, dataUrl: null, loading: true, canvas: null });
  }, []);
  const openCityImage = useCallback((cities) => {
    openImage(
      filtered.filter((p) => cities.includes(p.city_name)),
      `Snapshot · ${cities.join(' & ')}`,
      cities.join(' · '),
      cities.join('-').toLowerCase(),
    );
  }, [filtered, openImage]);
  const openFilteredImage = useCallback(() => {
    const bits = filterTitleBits.length ? filterTitleBits.join(' · ') : 'Full Inventory';
    openImage(
      filtered,
      `OpenHouse · ${bits}`,
      bits,
      'filtered',
    );
  }, [filtered, filterTitleBits, openImage]);

  // when an image modal is requested, render the off-screen poster then rasterize it
  useEffect(() => {
    if (!img || !img.loading) return;
    let cancelled = false;
    (async () => {
      try {
        const { default: html2canvas } = await import('html2canvas'); // code-split: only loaded on use
        // give the off-screen poster a frame to lay out
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        if (cancelled || !posterRef.current) return;
        const canvas = await html2canvas(posterRef.current, {
          scale: 2, backgroundColor: '#FFFFFF', logging: false, useCORS: true,
        });
        if (cancelled) return;
        setImg((cur) => (cur ? { ...cur, loading: false, dataUrl: canvas.toDataURL('image/png'), canvas } : cur));
      } catch (e) {
        if (cancelled) return;
        toast('Image generation failed', 'bad');
        setImg((cur) => (cur ? { ...cur, loading: false, dataUrl: null, canvas: null } : cur));
      }
    })();
    return () => { cancelled = true; };
  }, [img]);

  const cities = CITY_ORDER.filter((c) => grouped[c].total > 0);

  return (
    <div className="rx-fade">
      {/* ----------------------------- filter bar ----------------------------- */}
      <div className="snap-filters">
        <div className="snap-filters-row">
          <span className="snap-filters-lbl">Build a request-specific share</span>
          <MultiSelect label="City" options={cityOpts} value={fCities} onChange={setFCities} />
          <MultiSelect label="BHK / Config" options={configOpts} value={fConfigs} onChange={setFConfigs} />
          <MultiSelect label="Region" options={regionOpts} value={fRegions} onChange={setFRegions} />
          <div className="snap-price">
            <span className="snap-price-lbl">Price (₹ Cr)</span>
            <input
              type="number" inputMode="decimal" min="0" step="0.25" placeholder="1.5"
              className="snap-price-in" value={priceMin}
              onChange={(e) => setPriceMin(e.target.value)}
            />
            <span className="snap-price-dash">–</span>
            <input
              type="number" inputMode="decimal" min="0" step="0.25" placeholder="2"
              className="snap-price-in" value={priceMax}
              onChange={(e) => setPriceMax(e.target.value)}
            />
          </div>
          {hasFilters ? (
            <button type="button" className="an-chip clear" onClick={clearFilters}>Clear filters ✕</button>
          ) : null}
        </div>
        <div className="snap-filters-row">
          <span className={'snap-match' + (filtered.length ? '' : ' zero')}>
            <strong>{filtered.length}</strong> {filtered.length === 1 ? 'unit' : 'units'} match
            {filterTitleBits.length ? <span className="snap-match-sub"> · {filterTitleBits.join(' · ')}</span> : null}
          </span>
          <button
            type="button" className="btn primary"
            disabled={!filtered.length}
            onClick={openFilteredImage}
          >🖼 Share filtered selection</button>
        </div>
      </div>

      <div className="list-head" style={{ flexWrap: 'wrap', gap: 10 }}>
        <span id="snapCountLabel">{countLabel}</span>
        <div className="pager" style={{ flexWrap: 'wrap', gap: 6 }}>
          <span style={{ fontSize: 11, color: 'var(--mut)', alignSelf: 'center', marginRight: 6 }}>As image:</span>
          <button className="btn sm primary" onClick={() => openCityImage(['Gurgaon'])}>🖼 Gurgaon</button>
          <button className="btn sm primary" onClick={() => openCityImage(['Noida'])}>🖼 Noida</button>
          <button className="btn sm primary" onClick={() => openCityImage(['Ghaziabad'])}>🖼 Ghaziabad</button>
          <button className="btn sm primary" onClick={() => openCityImage(['Noida', 'Ghaziabad'])}>🖼 Noida + Ghaziabad</button>
          <span style={{ fontSize: 11, color: 'var(--mut)', alignSelf: 'center', margin: '0 6px' }}>As text:</span>
          <button className="btn sm" onClick={() => openShare(['Gurgaon'])}>📤 Gurgaon</button>
          <button className="btn sm" onClick={() => openShare(['Noida'])}>📤 Noida</button>
          <button className="btn sm" onClick={() => openShare(['Ghaziabad'])}>📤 Ghaziabad</button>
          <button className="btn sm" onClick={() => openShare(['Noida', 'Ghaziabad'])}>📤 NCR</button>
        </div>
      </div>

      <div id="snapBody">
        {cities.length === 0 ? (
          <div className="empty">
            <div className="emoji">📦</div>
            <div className="t">{hasFilters ? 'No units match these filters' : 'No inventory loaded'}</div>
          </div>
        ) : (
          cities.map((city) => <CityBlock key={city} city={city} g={grouped[city]} />)
        )}
      </div>

      {share && <ShareModal share={share} onClose={() => setShare(null)} />}
      {img && (
        <ImageModal img={img} onClose={() => setImg(null)}>
          {/* off-screen poster — html2canvas rasterizes this DOM node */}
          {img.loading && <Poster ref={posterRef} props={img.props} title={img.subtitle} />}
        </ImageModal>
      )}
    </div>
  );
}

/* ============================== city block ============================== */
function CityBlock({ city, g }) {
  const isMobile = useIsMobile();
  const cfg = CITY_CFG[city] || { sub: `OpenHouse · ${city} Inventory` };
  const readyCount = g.ordered.reduce(
    (n, mm) => n + g.mmGroups[mm].filter((p) => p.listing_status === 'Ready').length, 0);
  const csCount = g.total - readyCount;

  return (
    <div className="snap-city">
      <div className="snap-city-head">
        <div>
          <h2>{city} · {g.total} units</h2>
          <div className="sub">{cfg.sub}</div>
        </div>
        <div className="count-pills">
          <span className="cp">{readyCount} Ready</span>
          {csCount ? <span className="cp">{csCount} Coming Soon</span> : null}
        </div>
      </div>

      {g.ordered.map((mm) => {
        const props = g.mmGroups[mm]
          .slice()
          .sort((a, b) => (a.society_name || '').localeCompare(b.society_name || ''));
        return (
          <div className="snap-cluster" key={mm}>
            <div className="snap-cluster-head">{mm} · {props.length}</div>
            {isMobile ? (
              <div className="snap-mlist">
                {props.map((p, i) => {
                  const isNew = isPropertyNew(p);
                  return (
                    <div className="snap-mcard" key={(p.property_name || '') + i}>
                      <div className="smc-top">
                        <span className="smc-soc">{isNew ? <span className="new-badge">NEW</span> : null}{p.society_name || '—'}</span>
                        <span className={`status-pill ${p.listing_status === 'Ready' ? 'r' : 'cs'}`}>{p.listing_status || '—'}</span>
                      </div>
                      <div className="smc-meta">{unitOf(p)} · {p.configuration || '—'} · {p.super_sqft || '—'} sqft · {p.locality_or_sector || p.micro_market || '—'}</div>
                      <div className="smc-meta">PM · {p.sales_manager || '—'}</div>
                      <div className="smc-price">{p.listing_price || '—'}</div>
                    </div>
                  );
                })}
              </div>
            ) : (
            <table className="snap-tbl">
              <colgroup>
                <col className="col-soc" /><col className="col-unit" /><col className="col-area" />
                <col className="col-cfg" /><col className="col-loc" /><col className="col-status" /><col className="col-price" />
              </colgroup>
              <thead>
                <tr>
                  <th>Society</th><th>Unit</th><th>Area</th><th>Config</th>
                  <th>Locality</th><th>Status</th><th className="right">Ask Price</th>
                </tr>
              </thead>
              <tbody>
                {props.map((p, i) => {
                  const isNew = isPropertyNew(p);
                  return (
                    <tr key={(p.property_name || '') + i}>
                      <td className="cell-society" title={p.society_name || ''}>
                        <span className="society">
                          {isNew ? <span className="new-badge">NEW</span> : null}{p.society_name || '—'}
                        </span>
                        <div style={{ fontSize: 10.5, color: 'var(--mut)', fontWeight: 500, marginTop: 2 }}>PM · {p.sales_manager || '—'}</div>
                      </td>
                      <td className="cell-unit"><span className="unit">{unitOf(p)}</span></td>
                      <td className="cell-area"><span className="area">{p.super_sqft || '—'} sqft</span></td>
                      <td className="cell-cfg"><span className="cfg">{p.configuration || '—'}</span></td>
                      <td className="cell-loc" title={p.locality_or_sector || p.micro_market || ''}>
                        {p.locality_or_sector || p.micro_market || '—'}
                      </td>
                      <td className="cell-status">
                        <span className={`status-pill ${p.listing_status === 'Ready' ? 'r' : 'cs'}`}>
                          {p.listing_status || '—'}
                        </span>
                      </td>
                      <td className="cell-price right"><span className="ask-price">{p.listing_price || '—'}</span></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            )}
          </div>
        );
      })}
    </div>
  );
}

/* ============================== text share modal ============================== */
function ShareModal({ share, onClose }) {
  const [text, setText] = useState(share.text);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const copy = () => {
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text)
        .then(() => toast('Snapshot copied — paste in any chat', 'good'))
        .catch(() => toast('Copy failed', 'bad'));
    } else { toast('Clipboard unavailable', 'bad'); }
  };
  const sendWa = () => {
    window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, '_blank');
    onClose();
  };

  return (
    <div className="modal-bg" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal" style={{ width: 620, maxWidth: '96vw', maxHeight: '96vh' }}>
        <div className="modal-head">
          <h2>{share.title}</h2>
          <button className="x-btn" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body">
          <div style={{ fontSize: 11.5, color: 'var(--mut)', marginBottom: 8 }}>
            Inventory snapshot ready to share. Tap below to open WhatsApp with a recipient picker, or copy and paste anywhere.
          </div>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            style={{
              width: '100%', border: '1px solid var(--line)', borderRadius: 9, padding: '10px 12px',
              fontSize: 12.5, background: 'var(--panel)', outline: 'none', resize: 'vertical',
              minHeight: 300, maxHeight: '60vh', fontFamily: "'SF Mono',Menlo,monospace", lineHeight: 1.55,
            }}
          />
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 12, flexWrap: 'wrap' }}>
            <button className="btn" onClick={copy}>📋 Copy to clipboard</button>
            <button className="btn primary" onClick={sendWa}>📤 Share via WhatsApp</button>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ============================== image export modal ============================== */
function ImageModal({ img, onClose, children }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const filename = `openhouse-${img.filebase || 'inventory'}-${ymd(TODAY)}.png`;

  const download = () => {
    if (!img.dataUrl) return;
    const a = document.createElement('a');
    a.href = img.dataUrl; a.download = filename; a.click();
    toast('Image downloaded', 'good');
  };
  const copy = () => {
    if (!img.canvas) return;
    try {
      img.canvas.toBlob(async (blob) => {
        if (blob && navigator.clipboard?.write) {
          await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
          toast('Image copied to clipboard', 'good');
        } else { toast('Clipboard not supported — use Download', 'bad'); }
      }, 'image/png');
    } catch { toast('Copy failed — use Download', 'bad'); }
  };
  const whatsapp = () => {
    if (!img.dataUrl) return;
    const a = document.createElement('a');
    a.href = img.dataUrl; a.download = filename; a.click();
    setTimeout(() => {
      const txt = `${img.title} · ${fmtDate(TODAY)}\n\nAttached image has the latest unit list. Ping me for any visit / pricing detail.`;
      window.open(`https://wa.me/?text=${encodeURIComponent(txt)}`, '_blank');
      toast('Image downloaded — attach it in WhatsApp', 'good');
    }, 400);
  };

  return (
    <div id="modal-snap-img" className="modal-bg" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal" style={{ width: 880, maxWidth: '96vw', maxHeight: '96vh' }}>
        <div className="modal-head">
          <h2 id="snapImgTitle">{img.title}</h2>
          <button className="x-btn" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body" id="snapImgBody">
          {img.loading ? (
            <div className="snap-loading">
              <div className="spinner" style={{ display: 'inline-block', marginRight: 8 }} />
              Generating beautiful image…
            </div>
          ) : img.dataUrl ? (
            <div className="snap-preview"><img src={img.dataUrl} alt="Inventory snapshot" /></div>
          ) : (
            <div className="empty"><div className="emoji">⚠️</div><div className="t">Could not render image</div></div>
          )}
          {/* off-screen poster lives here during loading */}
          {children}
        </div>
        <div className="modal-foot">
          <span style={{ fontSize: 11.5, color: 'var(--mut)' }}>PNG · ready to share in WhatsApp/Email</span>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button className="btn" id="snapImgCopy" disabled={!img.canvas} onClick={copy}>📋 Copy image</button>
            <button className="btn" id="snapImgDownload" disabled={!img.dataUrl} onClick={download}>⬇️ Download PNG</button>
            <button className="btn primary" id="snapImgWhatsapp" disabled={!img.dataUrl} onClick={whatsapp}>📤 Open WhatsApp</button>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ============================== poster (off-screen, for html2canvas) ============================== */
// inline OpenHouse mark (the #oh-icon paths) — no symbol registry in the React app,
// so the poster carries the literal paths to render crisply for html2canvas.
const OH_ICON = (
  <svg viewBox="0 0 190 188">
    <path d="M79.5801 124.831C79.5801 122.469 81.9388 120.807 84.2094 121.569L108.648 129.771C110.065 130.247 111.018 131.559 111.018 133.033V174.825C111.018 176.229 110.152 177.493 108.83 178.019L84.3918 187.746C82.091 188.661 79.5801 186.994 79.5801 184.551V124.831Z" fill="#FA541C" />
    <path fillRule="evenodd" clipRule="evenodd" d="M189.614 94.4359C189.614 131.293 168.528 163.219 137.774 178.777C132.092 181.651 126.08 183.967 119.809 185.652V117.435C119.809 103.952 108.894 93.0228 95.4285 93.0228C81.9635 93.0228 71.0476 103.952 71.0476 117.435V185.721C64.7793 184.055 58.7673 181.76 53.083 178.906C22.1898 163.396 0.984863 131.396 0.984863 94.4359C0.984863 42.2806 43.2114 0 95.3001 0C147.389 0 189.614 42.2806 189.614 94.4359ZM171.649 94.4359C171.649 120.904 158.207 144.253 137.774 157.978V117.435C137.774 94.018 118.815 75.0349 95.4285 75.0349C86.3282 75.0349 77.8985 77.9092 70.9953 82.8005V21.9429C78.6298 19.3778 86.8028 17.9879 95.3001 17.9879C137.467 17.9879 171.649 52.2146 171.649 94.4359ZM53.1582 30.6778C32.5424 44.3665 18.9499 67.8117 18.9499 94.4359C18.9499 121.014 32.5046 144.448 53.083 158.149V117.435C53.083 116.579 53.1083 115.729 53.1582 114.886V30.6778Z" fill="#161C24" />
  </svg>
);

const Poster = forwardRef(function Poster({ props = [], title }, ref) {
    const ready = props.filter((p) => p.listing_status === 'Ready').length;
    // fixed-order cities first, then any extras alpha — so a filtered set still renders sensibly
    const cities = CITY_ORDER.filter((c) => props.some((p) => p.city_name === c));
    [...new Set(props.map((p) => p.city_name))].sort().forEach((c) => { if (!cities.includes(c)) cities.push(c); });

    return (
      <div className="poster" id="posterEl" ref={ref}>
        <div className="ph">
          {OH_ICON}
          <div>
            <div className="pht">OpenHouse · Live Inventory</div>
            <div className="phs">{title || cities.join(' · ')}</div>
          </div>
          <div className="phd">
            {fmtDate(TODAY)}
            <br />{props.length} units · {ready} ready
          </div>
        </div>

        {cities.map((city) => {
          const cityProps = props.filter((p) => p.city_name === city);
          if (!cityProps.length) return null;
          const cReady = cityProps.filter((p) => p.listing_status === 'Ready').length;
          const cs = cityProps.length - cReady;
          const mmGroups = {};
          cityProps.forEach((p) => { const k = p.micro_market || 'Other'; (mmGroups[k] = mmGroups[k] || []).push(p); });
          const mmOrder = Object.keys(mmGroups).sort();
          return (
            <div className="pcity" key={city || 'other'}>
              <div className="pcity-hd">
                <h3>{city || 'Other'} · {cityProps.length} units</h3>
                <div>
                  <span className="cnt">{cReady} Ready</span>
                  {cs ? <> <span className="cnt">{cs} CS</span></> : null}
                </div>
              </div>
              {mmOrder.map((mm) => {
                const list = mmGroups[mm]
                  .slice()
                  .sort((a, b) => (a.society_name || '').localeCompare(b.society_name || ''));
                return (
                  <div className="pcluster" key={mm}>
                    <div className="phl">{mm} · {list.length}</div>
                    <table>
                      <thead>
                        <tr>
                          <th>Society</th><th>Unit</th><th>Cfg</th><th>Sqft</th><th>Status</th>
                          <th style={{ textAlign: 'right' }}>Price</th>
                        </tr>
                      </thead>
                      <tbody>
                        {list.map((p, i) => (
                          <tr key={(p.property_name || '') + i}>
                            <td>
                              <span className="ps-soc">
                                {p.listing_status === 'Coming Soon' ? <span className="pnew">NEW</span> : null}
                                {p.society_name || '—'}
                              </span>
                            </td>
                            <td><span className="ps-unit">{unitOf(p)}</span></td>
                            <td>{p.configuration || '—'}</td>
                            <td>{p.super_sqft || '—'}</td>
                            <td>
                              <span className={`ps-status ${p.listing_status === 'Ready' ? 'r' : 'cs'}`}>
                                {p.listing_status || '—'}
                              </span>
                            </td>
                            <td style={{ textAlign: 'right' }}><span className="ps-price">{p.listing_price || '—'}</span></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                );
              })}
            </div>
          );
        })}

        <div className="pfoot">
          Reach out to your OpenHouse RM for site visits, virtual tour or pricing · Updated {fmtDate(TODAY)}
        </div>
      </div>
    );
});
