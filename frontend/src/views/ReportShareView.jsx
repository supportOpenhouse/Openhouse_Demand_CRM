// Report Share (BETA · admins only) — generate a seller-facing property performance
// report and drop it as a DRAFT into the triggering admin's own Gmail (they add the
// recipient and send). Self-contained, like the Book Visits / Hiring betas:
//   • reads only from `seed` (properties + current_user) to pick a unit; the report
//     itself is built server-side from live visit data (POST /api/reports/property),
//   • the draft is created server-side via the admin's own mailbox — nothing is sent,
//   • all styles are scoped under the `rp-` prefix below, so app.css is untouched.
// Admin gating is enforced in App.jsx AND on the backend (_require_admin).
import { useMemo, useState, useEffect, useRef } from 'react';
import { previewReport, createReportDraft } from '../api.js';
import { toast } from '../lib/toast.js';

const CITY_ORDER = ['Gurgaon', 'Noida', 'Ghaziabad'];
const unitOf = (p) => (p.property_name || '').replace(p.society_name || '', '').replace(/^[ ,\-]+/, '') || '—';

/* ---- compact searchable multi-select (same look as the other CRM filters) ---- */
function MultiSelect({ label, options, value, onChange }) {
  const [open, setOpen] = useState(false); const [q, setQ] = useState(''); const ref = useRef(null);
  useEffect(() => {
    if (!open) return;
    const h = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', h); return () => document.removeEventListener('mousedown', h);
  }, [open]);
  const shown = q ? options.filter((o) => o.toLowerCase().includes(q.toLowerCase())) : options;
  const toggle = (v) => onChange(value.includes(v) ? value.filter((x) => x !== v) : [...value, v]);
  return (
    <div className="rp-ms" ref={ref}>
      <button type="button" className={'rp-ms-btn' + (value.length ? ' has' : '')} onClick={() => setOpen((o) => !o)}>
        {label}{value.length ? <span className="rp-ms-count">{value.length}</span> : null}<span className="rp-ms-caret">▾</span>
      </button>
      {open && (
        <div className="rp-ms-pop">
          <input className="rp-ms-search" autoFocus placeholder={`Search ${label.toLowerCase()}…`} value={q} onChange={(e) => setQ(e.target.value)} />
          <div className="rp-ms-actions">
            <button type="button" onClick={() => onChange(shown.slice())}>All</button>
            <button type="button" onClick={() => onChange([])}>Clear</button>
            <span className="rp-ms-n">{value.length} selected</span>
          </div>
          <div className="rp-ms-list">
            {shown.slice(0, 300).map((o) => (
              <label key={o} className="rp-ms-opt">
                <input type="checkbox" checked={value.includes(o)} onChange={() => toggle(o)} /><span>{o}</span>
              </label>
            ))}
            {shown.length === 0 && <div className="rp-ms-more">No matches</div>}
          </div>
        </div>
      )}
    </div>
  );
}

export default function ReportShareView({ seed }) {
  const me = seed.current_user || {};
  // every live unit that maps to an app home_id (the report is keyed on home_id)
  const units = useMemo(() => (seed.properties || [])
    .filter((p) => p.home_id)
    .map((p) => ({
      society: p.society_name || '—', unit: unitOf(p), city: p.city_name || p.city || '',
      mm: p.micro_market || '—', cfg: p.configuration || '—', price: p.listing_price || '—',
      status: p.listing_status || '', pm: p.sales_manager || '', home_id: String(p.home_id),
      name: p.property_name || p.society_name || '—',
    })), [seed]);

  const [fCity, setFCity] = useState([]); const [fRegion, setFRegion] = useState([]); const [q, setQ] = useState('');
  // view: {mode:'pick'} | {mode:'preview', unit, loading, data, err, subject, sending, draft, draftErr}
  const [view, setView] = useState({ mode: 'pick' });

  const cityOpts = useMemo(() => [...new Set(units.map((u) => u.city).filter(Boolean))].sort(), [units]);
  const regionOpts = useMemo(() => [...new Set(units.map((u) => u.mm).filter(Boolean))].sort(), [units]);
  const hasFilters = fCity.length || fRegion.length || q;

  const filtered = useMemo(() => units.filter((u) => {
    if (fCity.length && !fCity.includes(u.city)) return false;
    if (fRegion.length && !fRegion.includes(u.mm)) return false;
    if (q) { const s = `${u.society} ${u.unit} ${u.pm}`.toLowerCase(); if (!s.includes(q.toLowerCase())) return false; }
    return true;
  }), [units, fCity, fRegion, q]);

  const byCity = useMemo(() => {
    const m = {}; filtered.forEach((u) => { (m[u.city] = m[u.city] || []).push(u); });
    return m;
  }, [filtered]);
  const cityKeys = useMemo(() => {
    const ks = Object.keys(byCity);
    return [...CITY_ORDER.filter((c) => ks.includes(c)), ...ks.filter((c) => !CITY_ORDER.includes(c)).sort()];
  }, [byCity]);

  const openPreview = async (u) => {
    setView({ mode: 'preview', unit: u, loading: true, data: null, err: null, subject: '', sending: false, draft: null, draftErr: null });
    try {
      const data = await previewReport(u.home_id);
      setView((v) => (v.unit && v.unit.home_id === u.home_id
        ? { ...v, loading: false, data, subject: data.subject || '' } : v));
    } catch (e) {
      setView((v) => (v.unit && v.unit.home_id === u.home_id ? { ...v, loading: false, err: e.message } : v));
    }
  };

  const createDraft = async () => {
    const { unit, data, subject } = view;
    if (!data) return;
    setView((v) => ({ ...v, sending: true, draftErr: null }));
    try {
      const draft = await createReportDraft({ home_id: unit.home_id, summary: data.summary || null, subject });
      setView((v) => ({ ...v, sending: false, draft }));
      toast('Draft created in your Gmail', 'good');
    } catch (e) {
      setView((v) => ({ ...v, sending: false, draftErr: e.message }));
      toast('Could not create draft', 'bad');
    }
  };

  return (
    <div className="rp-root">
      <RpStyles />

      <div className="rp-beta">
        <div className="rp-beta-ic">📧</div>
        <div className="rp-beta-tx">
          <div className="rp-kick">Beta · Admins only</div>
          <div className="rp-beta-h">Report Share</div>
          <div className="rp-beta-d">Generate a seller performance report and save it as a <b>draft in your own Gmail</b> ({me.email || me.name}). Add the recipient and send from there — nothing is emailed automatically.</div>
        </div>
      </div>

      {view.mode === 'pick' && (
        <>
          <div className="rp-filters">
            <span className="rp-flbl">Choose a property</span>
            <MultiSelect label="City" options={cityOpts} value={fCity} onChange={setFCity} />
            <MultiSelect label="Region" options={regionOpts} value={fRegion} onChange={setFRegion} />
            <div className="rp-searchbox">🔎 <input placeholder="Search society, unit or PM…" value={q} onChange={(e) => setQ(e.target.value)} /></div>
            {hasFilters ? <button type="button" className="rp-chip-clear" onClick={() => { setFCity([]); setFRegion([]); setQ(''); }}>Clear ✕</button> : null}
          </div>

          <div className="rp-countrow"><span className="rp-mut"><b>{filtered.length}</b> propert{filtered.length === 1 ? 'y' : 'ies'} with app inventory</span></div>

          <div className="rp-tablecard">
            <table className="rp-tbl">
              <thead><tr><th>Society</th><th>Unit</th><th>Config</th><th>Region</th><th>Owner / PM</th><th className="rp-right">Ask Price</th><th></th></tr></thead>
              <tbody>
                {filtered.length === 0 && <tr><td colSpan={7}><div className="rp-empty">📦 No properties match these filters</div></td></tr>}
                {cityKeys.map((city) => (
                  <FragmentGroup key={city} city={city} rows={byCity[city]} onPick={openPreview} />
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {view.mode === 'preview' && (
        <PreviewPanel
          view={view} me={me}
          onBack={() => setView({ mode: 'pick' })}
          onSubject={(s) => setView((v) => ({ ...v, subject: s }))}
          onRetry={() => openPreview(view.unit)}
          onCreate={createDraft}
        />
      )}
    </div>
  );
}

function FragmentGroup({ city, rows, onPick }) {
  return (
    <>
      <tr className="rp-grp"><td colSpan={7}>{city} · {rows.length}</td></tr>
      {rows.slice().sort((a, b) => a.society.localeCompare(b.society) || a.unit.localeCompare(b.unit)).map((u) => (
        <tr key={u.home_id}>
          <td><span className="rp-soc">{u.society}</span></td>
          <td>{u.unit}</td><td>{u.cfg}</td><td>{u.mm}</td>
          <td>{u.pm || <span className="rp-mut">—</span>}</td>
          <td className="rp-right rp-ask">{u.price}</td>
          <td><button type="button" className="rp-pickbtn" onClick={() => onPick(u)}>Generate report →</button></td>
        </tr>
      ))}
    </>
  );
}

function PreviewPanel({ view, me, onBack, onSubject, onRetry, onCreate }) {
  const { unit, loading, data, err, subject, sending, draft, draftErr } = view;
  const m = data?.metrics;
  return (
    <div className="rp-preview">
      <div className="rp-pv-head">
        <button type="button" className="rp-back" onClick={onBack}>← All properties</button>
        <div className="rp-pv-title">{unit.name}</div>
        <div className="rp-pv-sub">{unit.cfg} · {unit.mm} · {unit.city}{unit.pm ? ` · ${unit.pm}` : ''}</div>
      </div>

      {loading && <div className="rp-pv-load"><span className="rp-spin" /> Building report from live visit data…</div>}
      {err && <div className="rp-pv-err">⚠️ Couldn’t build the report — {err} <button className="rp-link" onClick={onRetry}>retry</button></div>}

      {data && (
        <>
          {/* metric chips */}
          <div className="rp-chips">
            <div className="rp-chip"><b>{m.last_7d}</b><span>Visits last 7 days</span></div>
            <div className="rp-chip"><b>{m.till_date}</b><span>Visits to date</span></div>
            <div className="rp-chip"><b>{m.unique_buyers}</b><span>Unique buyers</span></div>
            <div className="rp-chip accent"><b>{m.pipeline}</b><span>Hot + Warm pipeline</span></div>
          </div>
          <div className="rp-meta">
            {data.summary
              ? <span className="rp-ai ok">✦ AI feedback summary included ({data.feedback_count} notes summarised)</span>
              : <span className="rp-ai off">AI summary off — metrics-only report. {data.feedback_count > 0 ? 'Add ANTHROPIC_API_KEY to enable the feedback summary.' : 'No visit feedback to summarise.'}</span>}
          </div>

          {/* email preview (sandboxed iframe — the email HTML has no scripts) */}
          <div className="rp-emailwrap">
            <div className="rp-emailbar">Email preview</div>
            <iframe className="rp-iframe" title="Report preview" sandbox="" srcDoc={data.html} />
          </div>

          {/* compose row */}
          {!draft && (
            <div className="rp-compose">
              <label className="rp-lbl">Subject</label>
              <input className="rp-subject" value={subject} onChange={(e) => onSubject(e.target.value)} placeholder="Email subject" />
              <div className="rp-compose-actions">
                <div className="rp-compose-note">Saves to <b>{me.email || 'your Gmail'}</b> · Drafts. Recipient is left blank — you add it and send.</div>
                <button type="button" className="rp-btn primary" disabled={sending || !subject.trim()} onClick={onCreate}>
                  {sending ? 'Creating draft…' : '✉ Create Gmail draft'}
                </button>
              </div>
              {draftErr && <div className="rp-draft-err">⚠️ {draftErr}</div>}
            </div>
          )}

          {draft && (
            <div className="rp-done">
              <div className="rp-done-ic">✓</div>
              <div className="rp-done-tx">
                <div className="rp-done-h">Draft saved to your Gmail</div>
                <div className="rp-done-d">Subject: <b>{draft.subject}</b>. Open Gmail, add the seller’s email, review, and send.</div>
              </div>
              <a className="rp-btn primary" href={draft.gmail_url || 'https://mail.google.com/mail/u/0/#drafts'} target="_blank" rel="noreferrer">Open in Gmail ↗</a>
            </div>
          )}
        </>
      )}
    </div>
  );
}

/* ============================ scoped styles (rp- prefix only) ============================ */
function RpStyles() {
  return (
    <style>{`
.rp-root{--rp-brand:#F4541C;--rp-brand-press:#DA440D;--rp-tint:#FEEEE7;--rp-mut:#6E6E73;--rp-faint:#9A9AA0;--rp-line:#ECEAE6;--rp-line2:#E2DFD9;--rp-panel:#fff;--rp-bg:#F6F4F0;--rp-ink2:#3C3C3C;position:relative}
.rp-root .rp-mut{color:var(--rp-mut)}
.rp-beta{display:flex;align-items:center;gap:12px;background:linear-gradient(135deg,#FFF4EE,#FFE7DB);border:1px solid #FAD2BF;border-radius:14px;padding:12px 15px;margin-bottom:14px}
.rp-beta-ic{width:40px;height:40px;border-radius:11px;background:linear-gradient(135deg,#FB6A2E,var(--rp-brand));display:grid;place-items:center;font-size:19px;flex:0 0 auto}
.rp-beta-tx{flex:1;min-width:0}
.rp-kick{font-size:10px;font-weight:800;letter-spacing:.09em;color:var(--rp-brand);text-transform:uppercase}
.rp-beta-h{font-size:17px;font-weight:800;letter-spacing:-.02em;margin:1px 0}
.rp-beta-d{font-size:12.5px;color:#8a6f5f;line-height:1.5}
.rp-filters{display:flex;flex-wrap:wrap;gap:9px;align-items:center;background:var(--rp-panel);border:1px solid var(--rp-line2);border-radius:13px;padding:12px 13px;margin-bottom:12px}
.rp-flbl{font-size:11px;font-weight:800;letter-spacing:.06em;color:var(--rp-faint);text-transform:uppercase}
.rp-ms{position:relative}
.rp-ms-btn{display:inline-flex;align-items:center;gap:7px;background:#fff;border:1px solid var(--rp-line2);border-radius:10px;padding:9px 12px;font-size:13px;font-weight:600;color:var(--rp-ink2);cursor:pointer}
.rp-ms-btn.has{border-color:var(--rp-brand);color:var(--rp-brand);background:var(--rp-tint)}
.rp-ms-count{background:var(--rp-brand);color:#fff;border-radius:6px;font-size:11px;padding:0 6px;font-weight:700}
.rp-ms-caret{color:var(--rp-faint);font-size:11px}
.rp-ms-pop{position:absolute;z-index:40;top:calc(100% + 6px);left:0;width:262px;background:#fff;border:1px solid var(--rp-line2);border-radius:12px;box-shadow:0 18px 40px -16px rgba(0,0,0,.28);padding:9px}
.rp-ms-search{width:100%;border:1px solid var(--rp-line);border-radius:8px;padding:8px 10px;font-size:13px;outline:none;margin-bottom:7px}
.rp-ms-actions{display:flex;align-items:center;gap:8px;font-size:12px;margin-bottom:6px}
.rp-ms-actions button{background:none;border:none;color:var(--rp-brand);font-weight:700;font-size:12px;padding:0;cursor:pointer}
.rp-ms-n{color:var(--rp-faint);margin-left:auto}
.rp-ms-list{max-height:230px;overflow:auto}
.rp-ms-opt{display:flex;align-items:center;gap:8px;padding:6px 4px;font-size:13px;border-radius:7px;cursor:pointer}
.rp-ms-opt:hover{background:var(--rp-bg)}
.rp-ms-more{font-size:12px;color:var(--rp-faint);padding:8px 4px}
.rp-searchbox{flex:1;min-width:160px;display:flex;align-items:center;gap:8px;background:#fff;border:1px solid var(--rp-line2);border-radius:10px;padding:9px 12px;color:var(--rp-mut)}
.rp-searchbox input{border:none;outline:none;flex:1;font-size:13px;background:none}
.rp-chip-clear{background:#fff;border:1px solid var(--rp-line2);border-radius:999px;padding:8px 13px;font-size:12.5px;font-weight:600;color:var(--rp-ink2);cursor:pointer}
.rp-countrow{padding:2px 4px 10px;font-size:13px}
.rp-countrow b{color:#1A1A1A}
.rp-tablecard{background:var(--rp-panel);border:1px solid var(--rp-line);border-radius:13px;overflow:hidden}
.rp-tbl{width:100%;border-collapse:collapse}
.rp-tbl thead th{font-size:11px;font-weight:800;letter-spacing:.04em;text-transform:uppercase;color:var(--rp-faint);text-align:left;padding:11px 12px;background:#FBFAF8;border-bottom:1px solid var(--rp-line)}
.rp-tbl th.rp-right,.rp-tbl td.rp-right{text-align:right}
.rp-tbl tbody td{padding:10px 12px;border-bottom:1px solid var(--rp-line);font-size:13px;vertical-align:middle}
.rp-tbl tbody tr:hover{background:#FBFAF8}
.rp-soc{font-weight:700}
.rp-ask{font-weight:800;white-space:nowrap}
.rp-grp td{background:#F3F1EC;font-size:11px;font-weight:800;letter-spacing:.05em;text-transform:uppercase;color:var(--rp-brand);padding:7px 12px}
.rp-pickbtn{background:#fff;border:1px solid var(--rp-brand);color:var(--rp-brand);font-weight:700;font-size:12px;padding:6px 13px;border-radius:8px;white-space:nowrap;cursor:pointer}
.rp-pickbtn:hover{background:var(--rp-brand);color:#fff}
.rp-empty{text-align:center;padding:44px 20px;color:var(--rp-mut)}
.rp-link{background:none;border:none;color:var(--rp-brand);font-weight:700;cursor:pointer;font-size:12.5px;padding:0 4px}
/* preview */
.rp-preview{max-width:720px;margin:0 auto}
.rp-pv-head{margin-bottom:14px}
.rp-back{background:#fff;border:1px solid var(--rp-line2);border-radius:9px;padding:7px 12px;font-size:12.5px;font-weight:700;color:var(--rp-ink2);cursor:pointer;margin-bottom:10px}
.rp-pv-title{font-size:19px;font-weight:800;letter-spacing:-.02em}
.rp-pv-sub{font-size:13px;color:var(--rp-mut);margin-top:2px}
.rp-pv-load{display:flex;align-items:center;gap:10px;padding:30px 16px;color:var(--rp-mut);font-size:14px;justify-content:center}
.rp-spin{width:16px;height:16px;border:2px solid var(--rp-line2);border-top-color:var(--rp-brand);border-radius:50%;display:inline-block;animation:rp-rot .7s linear infinite}
@keyframes rp-rot{to{transform:rotate(360deg)}}
.rp-pv-err{background:#FFF1E9;border:1px solid #F6C7AE;color:#9A3412;font-size:13px;border-radius:11px;padding:12px 14px}
.rp-chips{display:grid;grid-template-columns:repeat(4,1fr);gap:9px;margin-bottom:9px}
.rp-chip{background:#fff;border:1px solid var(--rp-line);border-radius:11px;padding:12px 10px;text-align:center}
.rp-chip b{display:block;font-size:22px;font-weight:800;color:#1A1A1A;line-height:1}
.rp-chip span{display:block;font-size:10.5px;font-weight:700;color:var(--rp-faint);text-transform:uppercase;letter-spacing:.03em;margin-top:6px}
.rp-chip.accent b{color:var(--rp-brand)}
.rp-meta{margin-bottom:12px}
.rp-ai{font-size:12px;font-weight:600;border-radius:8px;padding:6px 10px;display:inline-block}
.rp-ai.ok{background:#E7F6EC;color:#147A3D}
.rp-ai.off{background:#FBF0DA;color:#8a5a00}
.rp-emailwrap{background:#fff;border:1px solid var(--rp-line);border-radius:13px;overflow:hidden;margin-bottom:13px}
.rp-emailbar{font-size:11px;font-weight:800;letter-spacing:.05em;text-transform:uppercase;color:var(--rp-faint);padding:9px 13px;border-bottom:1px solid var(--rp-line);background:#FBFAF8}
.rp-iframe{width:100%;height:680px;border:0;display:block;background:var(--rp-bg)}
.rp-compose{background:#fff;border:1px solid var(--rp-line);border-radius:13px;padding:14px 15px}
.rp-lbl{font-size:12px;font-weight:700;color:var(--rp-ink2);margin:0 0 6px;display:block}
.rp-subject{width:100%;border:1px solid var(--rp-line2);border-radius:9px;padding:10px 12px;font-size:13.5px;outline:none;font-family:inherit;box-sizing:border-box}
.rp-subject:focus{border-color:var(--rp-brand)}
.rp-compose-actions{display:flex;align-items:center;gap:12px;margin-top:11px}
.rp-compose-note{flex:1;font-size:12px;color:var(--rp-mut);line-height:1.5}
.rp-btn{background:#fff;border:1px solid var(--rp-line2);border-radius:10px;padding:10px 16px;font-size:13.5px;font-weight:700;color:var(--rp-ink2);cursor:pointer;text-decoration:none;display:inline-block;white-space:nowrap}
.rp-btn.primary{background:var(--rp-brand);border-color:var(--rp-brand);color:#fff}
.rp-btn.primary:hover{background:var(--rp-brand-press)}
.rp-btn:disabled{opacity:.5;cursor:not-allowed}
.rp-draft-err{margin-top:11px;background:#FFF1E9;border:1px solid #F6C7AE;color:#9A3412;font-size:12.5px;border-radius:10px;padding:10px 12px;line-height:1.5}
.rp-done{display:flex;align-items:center;gap:13px;background:#E7F6EC;border:1px solid #BDE5C8;border-radius:13px;padding:14px 16px}
.rp-done-ic{width:36px;height:36px;border-radius:50%;background:#147A3D;color:#fff;display:grid;place-items:center;font-size:18px;flex:0 0 auto}
.rp-done-tx{flex:1;min-width:0}
.rp-done-h{font-size:14.5px;font-weight:800;color:#0F5C2E}
.rp-done-d{font-size:12.5px;color:#2C6B43;margin-top:2px;line-height:1.5}
@media(max-width:680px){.rp-chips{grid-template-columns:repeat(2,1fr)}.rp-compose-actions{flex-direction:column;align-items:stretch}.rp-iframe{height:560px}}
`}</style>
  );
}
