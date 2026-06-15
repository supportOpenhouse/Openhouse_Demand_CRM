// Hiring (BETA · admins only) — a city × micro-market planning table off all_properties:
// property bifurcation (Ready / Coming Soon / Archived) + total + currently-assigned PMs.
// Admins can fill the micro-market for blank-MM (mostly Archived) societies; that fill is
// stored server-side (hiring_mm_overrides) and applied ONLY as a fallback (a unit's real
// MM always wins). Self-contained: styles scoped under `hr-`, so app.css is untouched.
// Reads /api/hiring and writes only /api/hiring/mm-override (both Admin-gated server-side).
import { useState, useEffect, useCallback, useMemo } from 'react';
import { loadHiring, setHiringMmOverride } from '../api.js';
import { toast } from '../lib/toast.js';

const CITY_ORDER = ['Gurgaon', 'Noida', 'Ghaziabad'];
const cityRank = (c) => { const i = CITY_ORDER.indexOf(c); return i < 0 ? 99 : i; };

export default function HiringView() {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [drafts, setDrafts] = useState({});   // "city|society" -> typed MM
  const [busy, setBusy] = useState(null);     // key currently saving

  const refresh = useCallback(() => {
    setErr(null);
    loadHiring().then(setData).catch((e) => setErr(e.message));
  }, []);
  useEffect(() => { refresh(); }, [refresh]);

  // existing MMs per city — offered as a datalist when filling a blank
  const mmByCity = useMemo(() => {
    const m = {};
    (data?.rows || []).forEach((r) => { (m[r.city] = m[r.city] || new Set()).add(r.mm); });
    (data?.overrides || []).forEach((o) => { (m[o.city] = m[o.city] || new Set()).add(o.micro_market); });
    return Object.fromEntries(Object.entries(m).map(([c, s]) => [c, [...s].filter(Boolean).sort()]));
  }, [data]);

  const rows = useMemo(() => (data?.rows || []).slice().sort(
    (a, b) => cityRank(a.city) - cityRank(b.city) || (a.city || '').localeCompare(b.city || '') || b.total - a.total
  ), [data]);

  const grand = useMemo(() => rows.reduce((g, r) => ({
    ready: g.ready + r.ready, coming_soon: g.coming_soon + r.coming_soon,
    archived: g.archived + r.archived, total: g.total + r.total,
  }), { ready: 0, coming_soon: 0, archived: 0, total: 0 }), [rows]);

  const blanks = useMemo(() => (data?.blanks || []).slice().sort(
    (a, b) => cityRank(a.city) - cityRank(b.city) || b.n - a.n
  ), [data]);
  const overrides = data?.overrides || [];

  const save = async (city, society_name, micro_market) => {
    const key = city + '|' + society_name;
    setBusy(key);
    try {
      await setHiringMmOverride({ city, society_name, micro_market });
      toast(micro_market ? `Set ${society_name} → ${micro_market}` : `Cleared ${society_name}`, 'good');
      setDrafts((d) => { const n = { ...d }; delete n[key]; return n; });
      refresh();
    } catch (e) { toast('Save failed: ' + e.message, 'bad'); }
    finally { setBusy(null); }
  };

  return (
    <div className="hr-root">
      <HrStyles />
      <div className="hr-beta">
        <div className="hr-beta-ic">🧮</div>
        <div className="hr-beta-tx">
          <div className="hr-kick">Beta · Admins only</div>
          <div className="hr-beta-h">Hiring — properties &amp; PMs by micro-market</div>
          <div className="hr-beta-d">Property load (Ready / Coming Soon / Archived) vs currently-assigned property managers, per city &amp; micro-market. Source: all-properties inventory.</div>
        </div>
        <button type="button" className="hr-refresh" onClick={refresh}>↻ Refresh</button>
      </div>

      {err && <div className="hr-empty">⚠️ Couldn’t load hiring data — {err} <button className="hr-link" onClick={refresh}>retry</button></div>}
      {!data && !err && <div className="hr-empty">Loading…</div>}

      {data && (
        <>
          <div className="hr-card">
            <table className="hr-tbl">
              <thead>
                <tr>
                  <th>City</th><th>Micro-market</th>
                  <th className="hr-r">Ready</th><th className="hr-r">Coming Soon</th><th className="hr-r">Archived</th>
                  <th className="hr-r">Total</th><th className="hr-r">PMs assigned</th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 && <tr><td colSpan={7}><div className="hr-empty">No properties found.</div></td></tr>}
                {rows.map((r, i) => {
                  const firstOfCity = i === 0 || rows[i - 1].city !== r.city;
                  return (
                    <tr key={r.city + '|' + r.mm} className={firstOfCity ? 'hr-citytop' : ''}>
                      <td className="hr-city">{firstOfCity ? r.city : ''}</td>
                      <td className="hr-mm">{r.mm}</td>
                      <td className="hr-r">{r.ready}</td>
                      <td className="hr-r">{r.coming_soon}</td>
                      <td className="hr-r">{r.archived}</td>
                      <td className="hr-r hr-total">{r.total}</td>
                      <td className="hr-r"><span className={'hr-pm' + (r.pms === 0 ? ' zero' : '')}>{r.pms}</span></td>
                    </tr>
                  );
                })}
              </tbody>
              {rows.length > 0 && (
                <tfoot>
                  <tr className="hr-grand">
                    <td>Total</td><td className="hr-mm">{rows.length} micro-markets</td>
                    <td className="hr-r">{grand.ready}</td><td className="hr-r">{grand.coming_soon}</td>
                    <td className="hr-r">{grand.archived}</td><td className="hr-r hr-total">{grand.total}</td>
                    <td className="hr-r hr-dash">—</td>
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
          <div className="hr-note">PMs assigned = distinct property managers with a current assignment in that micro-market (authoritative). Per-MM, so the total row doesn’t sum them (a PM can cover several MMs).</div>

          {/* fill missing micro-markets */}
          <div className="hr-fillcard">
            <div className="hr-fill-h">
              Fill missing micro-markets
              <span className="hr-badge">{blanks.length}</span>
            </div>
            {blanks.length === 0 ? (
              <div className="hr-fill-done">✓ Every property has a micro-market — nothing to fill.</div>
            ) : (
              <>
                <div className="hr-fill-sub">These societies (mostly Archived) have no micro-market. Assign one so they roll into the right row above. The real inventory MM always wins — this only fills blanks.</div>
                {blanks.map((b) => {
                  const key = b.city + '|' + b.society_name;
                  const listId = 'hr-mm-' + b.city.replace(/\W/g, '');
                  return (
                    <div className="hr-fill-row" key={key}>
                      <div className="hr-fill-soc">
                        <b>{b.society_name}</b>
                        <span className="hr-fill-meta">{b.city} · {b.n} unit{b.n > 1 ? 's' : ''}</span>
                      </div>
                      <input
                        className="hr-fill-in" list={listId} placeholder="Micro-market…"
                        value={drafts[key] ?? ''}
                        onChange={(e) => setDrafts((d) => ({ ...d, [key]: e.target.value }))}
                        onKeyDown={(e) => { if (e.key === 'Enter' && (drafts[key] || '').trim()) save(b.city, b.society_name, drafts[key].trim()); }}
                      />
                      <button
                        type="button" className="hr-btn primary"
                        disabled={busy === key || !(drafts[key] || '').trim()}
                        onClick={() => save(b.city, b.society_name, (drafts[key] || '').trim())}
                      >{busy === key ? 'Saving…' : 'Save'}</button>
                    </div>
                  );
                })}
                {CITY_ORDER.concat(Object.keys(mmByCity).filter((c) => !CITY_ORDER.includes(c))).map((c) => (
                  mmByCity[c] && mmByCity[c].length ? (
                    <datalist id={'hr-mm-' + c.replace(/\W/g, '')} key={c}>
                      {mmByCity[c].map((mm) => <option key={mm} value={mm} />)}
                    </datalist>
                  ) : null
                ))}
              </>
            )}

            {overrides.length > 0 && (
              <div className="hr-ov">
                <div className="hr-ov-h">Manually filled ({overrides.length})</div>
                {overrides.map((o) => (
                  <div className="hr-ov-row" key={o.city + '|' + o.society_name}>
                    <span><b>{o.society_name}</b> <span className="hr-fill-meta">{o.city}</span> → <b>{o.micro_market}</b></span>
                    <button type="button" className="hr-link" disabled={busy === (o.city + '|' + o.society_name)}
                            onClick={() => save(o.city, o.society_name, '')}>clear</button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function HrStyles() {
  return (
    <style>{`
.hr-root{--hr-brand:#F4541C;--hr-mut:#6E6E73;--hr-faint:#9A9AA0;--hr-line:#ECEAE6;--hr-line2:#E2DFD9;--hr-ink2:#3C3C3C;--hr-bg:#F6F4F0}
.hr-beta{display:flex;align-items:center;gap:12px;background:linear-gradient(135deg,#FFF4EE,#FFE7DB);border:1px solid #FAD2BF;border-radius:14px;padding:12px 15px;margin-bottom:14px}
.hr-beta-ic{width:40px;height:40px;border-radius:11px;background:linear-gradient(135deg,#FB6A2E,var(--hr-brand));display:grid;place-items:center;font-size:19px;flex:0 0 auto}
.hr-beta-tx{flex:1;min-width:0}
.hr-kick{font-size:10px;font-weight:800;letter-spacing:.09em;color:var(--hr-brand);text-transform:uppercase}
.hr-beta-h{font-size:17px;font-weight:800;letter-spacing:-.02em;margin:1px 0}
.hr-beta-d{font-size:12.5px;color:#8a6f5f}
.hr-refresh{flex:0 0 auto;background:#fff;border:1px solid var(--hr-line2);border-radius:10px;padding:8px 13px;font-size:12.5px;font-weight:700;color:var(--hr-ink2);cursor:pointer}
.hr-empty{text-align:center;padding:40px 20px;color:var(--hr-mut);font-size:14px}
.hr-link{background:none;border:none;color:var(--hr-brand);font-weight:700;cursor:pointer;font-size:12.5px;padding:0 4px}
.hr-card{background:#fff;border:1px solid var(--hr-line);border-radius:13px;overflow:hidden}
.hr-tbl{width:100%;border-collapse:collapse}
.hr-tbl thead th{font-size:11px;font-weight:800;letter-spacing:.04em;text-transform:uppercase;color:var(--hr-faint);text-align:left;padding:11px 12px;background:#FBFAF8;border-bottom:1px solid var(--hr-line);white-space:nowrap}
.hr-tbl th.hr-r,.hr-tbl td.hr-r{text-align:right}
.hr-tbl tbody td{padding:10px 12px;border-bottom:1px solid var(--hr-line);font-size:13px;vertical-align:middle}
.hr-tbl tbody tr:hover{background:#FBFAF8}
.hr-tbl tr.hr-citytop td{border-top:2px solid var(--hr-line2)}
.hr-city{font-weight:800}
.hr-mm{font-weight:600}
.hr-total{font-weight:800}
.hr-pm{display:inline-block;min-width:24px;text-align:center;font-weight:700;padding:2px 8px;border-radius:7px;background:#E7F6EC;color:#147A3D}
.hr-pm.zero{background:#FCEBEB;color:#B91C1C}
.hr-tbl tfoot td{padding:11px 12px;font-size:13px;background:#FBFAF8;border-top:2px solid var(--hr-line2);font-weight:800}
.hr-dash{color:var(--hr-faint)}
.hr-note{font-size:11.5px;color:var(--hr-mut);margin:8px 2px 16px;line-height:1.5}
.hr-fillcard{background:#fff;border:1px solid var(--hr-line);border-radius:13px;padding:14px 15px;margin-bottom:18px}
.hr-fill-h{font-size:14px;font-weight:800;display:flex;align-items:center;gap:9px;margin-bottom:4px}
.hr-badge{background:var(--hr-brand);color:#fff;font-size:11px;font-weight:800;border-radius:999px;min-width:20px;height:20px;padding:0 6px;display:inline-grid;place-items:center}
.hr-fill-sub{font-size:12px;color:var(--hr-mut);margin-bottom:11px;line-height:1.5}
.hr-fill-done{font-size:13px;color:#147A3D;font-weight:600}
.hr-fill-row{display:flex;align-items:center;gap:10px;padding:8px 0;border-top:1px solid var(--hr-line)}
.hr-fill-soc{flex:1;min-width:0;font-size:13px}
.hr-fill-meta{color:var(--hr-mut);font-size:11.5px;margin-left:7px}
.hr-fill-in{width:200px;border:1px solid var(--hr-line2);border-radius:9px;padding:8px 11px;font-size:13px;outline:none;font-family:inherit}
.hr-fill-in:focus{border-color:var(--hr-brand)}
.hr-btn{background:#fff;border:1px solid var(--hr-line2);border-radius:9px;padding:8px 14px;font-size:13px;font-weight:700;color:var(--hr-ink2);cursor:pointer}
.hr-btn.primary{background:var(--hr-brand);border-color:var(--hr-brand);color:#fff}
.hr-btn:disabled{opacity:.5;cursor:not-allowed}
.hr-ov{margin-top:14px;border-top:1px solid var(--hr-line);padding-top:11px}
.hr-ov-h{font-size:11px;font-weight:800;letter-spacing:.05em;text-transform:uppercase;color:var(--hr-faint);margin-bottom:7px}
.hr-ov-row{display:flex;align-items:center;justify-content:space-between;font-size:12.5px;padding:4px 0}
@media(max-width:680px){.hr-fill-in{width:130px}.hr-tbl thead th,.hr-tbl tbody td{padding:9px 8px}}
`}</style>
  );
}
