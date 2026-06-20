// Book Visits (BETA · super-admins only) — schedule app visits from the CRM, single or
// in bulk (max 10). This view is intentionally SELF-CONTAINED:
//   • reads only from `seed` (properties + brokers + current_user) — never writes,
//   • all styles are scoped under the `bv-` prefix in the <style> block below, so it
//     cannot affect any other view's CSS,
//   • BOOKING IS NOT LIVE: the app-backend API isn't wired yet, so Confirm runs a
//     local PREVIEW and creates nothing. When the API is ready, set BOOKING_LIVE=true
//     and implement bookVisits() to POST to it — that is the ONLY change needed here.
// Gating to the two super-admins is enforced in App.jsx; this file assumes it is allowed.
import { useMemo, useState, useEffect, useRef, useCallback } from 'react';
import { parsePrice } from '../lib/legacy.js';
import { TODAY, ymd } from '../lib/format.js';
import { bookVisits } from '../api.js';
import { toast } from '../lib/toast.js';
import useIsMobile from '../lib/useIsMobile.js';

const MAX_BOOK = 10;
const BOOKING_LIVE = true;   // app booking API connected (CRM → Core /crm/schedule-visits)
const TIME_SLOTS = ['9-11 AM', '11-1 PM', '1-3 PM', '3-5 PM', '5-7 PM', '7-9 PM'];
const SLOT_START_HR = { '9-11 AM': 9, '11-1 PM': 11, '1-3 PM': 13, '3-5 PM': 15, '5-7 PM': 17, '7-9 PM': 19 };
const CITY_ORDER = ['Gurgaon', 'Noida', 'Ghaziabad'];
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const initials = (n) => (n || '').split(' ').filter(Boolean).slice(0, 2).map((x) => x[0]).join('').toUpperCase() || '?';
const unitOf = (p) => (p.property_name || '').replace(p.society_name || '', '').replace(/^[ ,\-]+/, '') || '—';
function next7() {
  const out = []; const base = new Date(TODAY.getFullYear(), TODAY.getMonth(), TODAY.getDate());
  for (let i = 0; i < 7; i++) { const d = new Date(base); d.setDate(base.getDate() + i); out.push(d); }
  return out;
}
// human label for a failed booking row
function errLabel(r) {
  if (r.error === 'locked') return `Locked — buyer registered with another CP${r.remaining_days != null ? ` for ${r.remaining_days} more day${r.remaining_days === 1 ? '' : 's'}` : ''}`;
  const m = {
    home_not_found: 'Home not found on the app', broker_not_found: 'Broker not found on the app',
    buyer_create_failed: 'Could not create the buyer', lock_check_failed: 'Buyer lock-check failed',
    no_result: 'No response from the app',
  };
  return m[r.error] || (r.error ? String(r.error).replace(/_/g, ' ') : 'Failed');
}

/* ---- compact searchable multi-select (same look as the rest of the CRM filters) ---- */
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
    <div className="bv-ms" ref={ref}>
      <button type="button" className={'bv-ms-btn' + (value.length ? ' has' : '')} onClick={() => setOpen((o) => !o)}>
        {label}{value.length ? <span className="bv-ms-count">{value.length}</span> : null}<span className="bv-ms-caret">▾</span>
      </button>
      {open && (
        <div className="bv-ms-pop">
          <input className="bv-ms-search" autoFocus placeholder={`Search ${label.toLowerCase()}…`} value={q} onChange={(e) => setQ(e.target.value)} />
          <div className="bv-ms-actions">
            <button type="button" onClick={() => onChange(shown.slice())}>All</button>
            <button type="button" onClick={() => onChange([])}>Clear</button>
            <span className="bv-ms-n">{value.length} selected</span>
          </div>
          <div className="bv-ms-list">
            {shown.slice(0, 300).map((o) => (
              <label key={o} className="bv-ms-opt">
                <input type="checkbox" checked={value.includes(o)} onChange={() => toggle(o)} /><span>{o}</span>
              </label>
            ))}
            {shown.length === 0 && <div className="bv-ms-more">No matches</div>}
          </div>
        </div>
      )}
    </div>
  );
}

/* ---- searchable CP picker ---- */
function CpPicker({ cps, value, onPick }) {
  const [open, setOpen] = useState(false); const [q, setQ] = useState(''); const ref = useRef(null);
  useEffect(() => {
    if (!open) return;
    const h = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', h); return () => document.removeEventListener('mousedown', h);
  }, [open]);
  const shown = (q ? cps.filter((c) => `${c.name} ${c.cp_code} ${c.company} ${c.phone}`.toLowerCase().includes(q.toLowerCase())) : cps).slice(0, 60);
  return (
    <div className="bv-cpsel" ref={ref}>
      <button type="button" className="bv-inp bv-cpbtn" onClick={() => setOpen((o) => !o)}>
        {value
          ? <span className="bv-cpopt" style={{ padding: 0 }}><span className="bv-av">{initials(value.name)}</span><span style={{ minWidth: 0 }}><b>{value.name}</b> <span className="bv-mut">{value.cp_code} · {value.city || '—'}{value.phone ? ' · 📞 ' + value.phone : ''}{value.company ? ' · ' + value.company : ''}</span></span></span>
          : <span className="bv-mut">Select channel partner…</span>}
        <span style={{ marginLeft: 'auto', color: 'var(--mut)' }}>▾</span>
      </button>
      {open && (
        <div className="bv-cppop">
          <input className="bv-ms-search" autoFocus placeholder="Search CP by name or code…" value={q} onChange={(e) => setQ(e.target.value)} />
          {shown.map((c) => (
            <div key={c.cp_code} className="bv-cpopt" onClick={() => { onPick(c); setOpen(false); }}>
              <span className="bv-av">{initials(c.name)}</span>
              <span style={{ minWidth: 0 }}><b>{c.name}</b>
                <div className="bv-mut">{c.cp_code} · {c.city || '—'}</div>
                {(c.company || c.phone) && <div className="bv-mut">{[c.company, c.phone && ('📞 ' + c.phone)].filter(Boolean).join(' · ')}</div>}
              </span>
              <span className={'bv-tier ' + (c.tier || 'T4')}>{c.tier || '—'}</span>
            </div>
          ))}
          {shown.length === 0 && <div className="bv-ms-more">No CP matches</div>}
        </div>
      )}
    </div>
  );
}

export default function BookVisitsView({ seed }) {
  const me = seed.current_user || {};
  const isMobile = useIsMobile();   // ≤900px → render tappable cards instead of the wide table
  // mapped to a Core SalesManager? (undefined on an older seed → assume yes so we don't block pre-deploy)
  const canBook = me.can_book_visits === undefined ? true : !!me.can_book_visits;
  // bookable inventory — Ready, Coming Soon and Booked units that map to an app home_id
  const units = useMemo(() => (seed.properties || [])
    .filter((p) => (p.listing_status === 'Ready' || p.listing_status === 'Coming Soon' || p.listing_status === 'Booked') && p.home_id)
    .map((p) => ({
      society: p.society_name || '—', unit: unitOf(p), city: p.city_name || '', mm: p.micro_market || '—',
      cfg: p.configuration || '—', sqft: p.super_sqft || '—', price: p.listing_price || '—',
      status: p.listing_status, home_id: String(p.home_id),
    })), [seed]);
  const cps = useMemo(() => (seed.brokers || [])
    .filter((b) => b.cp_code)
    .map((b) => ({ cp_code: b.cp_code, name: b.name || b.cp_code, city: b.city || '', tier: b.tier || '', broker_id: b.id, company: b.company_name || '', phone: b.phone_number || '' }))
    .sort((a, b) => (a.tier > b.tier ? 1 : a.tier < b.tier ? -1 : (a.name || '').localeCompare(b.name || ''))), [seed]);

  const [fCity, setFCity] = useState([]); const [fCfg, setFCfg] = useState([]); const [fRegion, setFRegion] = useState([]);
  const [pmin, setPmin] = useState(''); const [pmax, setPmax] = useState(''); const [q, setQ] = useState('');
  const [selected, setSelected] = useState(() => new Set());
  const [draft, setDraft] = useState(null);

  const cityOpts = useMemo(() => [...new Set(units.map((u) => u.city).filter(Boolean))].sort(), [units]);
  const cfgOpts = useMemo(() => [...new Set(units.map((u) => u.cfg).filter(Boolean))].sort(), [units]);
  const regionOpts = useMemo(() => [...new Set(units.map((u) => u.mm).filter(Boolean))].sort(), [units]);
  const minRs = useMemo(() => { const n = parseFloat(pmin); return Number.isFinite(n) && n > 0 ? n * 1e7 : null; }, [pmin]);
  const maxRs = useMemo(() => { const n = parseFloat(pmax); return Number.isFinite(n) && n > 0 ? n * 1e7 : null; }, [pmax]);
  const hasFilters = fCity.length || fCfg.length || fRegion.length || minRs != null || maxRs != null || q;

  const filtered = useMemo(() => units.filter((u) => {
    if (fCity.length && !fCity.includes(u.city)) return false;
    if (fCfg.length && !fCfg.includes(u.cfg)) return false;
    if (fRegion.length && !fRegion.includes(u.mm)) return false;
    if (minRs != null || maxRs != null) { const v = parsePrice(u.price); if (minRs != null && v < minRs) return false; if (maxRs != null && v > maxRs) return false; }
    if (q) { const s = `${u.society} ${u.unit}`.toLowerCase(); if (!s.includes(q.toLowerCase())) return false; }
    return true;
  }), [units, fCity, fCfg, fRegion, minRs, maxRs, q]);

  const byCity = useMemo(() => {
    const m = {}; filtered.forEach((u) => { (m[u.city] = m[u.city] || []).push(u); });
    return m;
  }, [filtered]);
  const cityKeys = useMemo(() => {
    const ks = Object.keys(byCity);
    return [...CITY_ORDER.filter((c) => ks.includes(c)), ...ks.filter((c) => !CITY_ORDER.includes(c)).sort()];
  }, [byCity]);

  const ready = filtered.filter((u) => u.status === 'Ready').length;
  const comingSoon = filtered.filter((u) => u.status === 'Coming Soon').length;
  const booked = filtered.filter((u) => u.status === 'Booked').length;
  const unitByHome = useMemo(() => Object.fromEntries(units.map((u) => [u.home_id, u])), [units]);

  const toggleSel = useCallback((home_id) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(home_id)) next.delete(home_id);
      else { if (next.size >= MAX_BOOK) return prev; next.add(home_id); }
      return next;
    });
  }, []);
  const atCap = selected.size >= MAX_BOOK;

  const openDrawer = useCallback((unitList) => {
    setDraft({
      units: unitList, step: 1,
      shared: { cp: null, date: ymd(next7()[0]), time: null, sameBuyer: false, buyer: '', mobile: '' },
      rows: Object.fromEntries(unitList.map((u) => [u.home_id, { buyer: '', mobile: '' }])),
      results: null,
    });
  }, []);
  const closeDrawer = useCallback(() => setDraft(null), []);
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') setDraft(null); };
    document.addEventListener('keydown', onKey); return () => document.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="bv-root">
      <BvStyles />

      <div className="bv-beta">
        <div className="bv-beta-ic">📅</div>
        <div className="bv-beta-tx">
          <div className="bv-kick">Beta · Super-admins only</div>
          <div className="bv-beta-h">Book Visits</div>
          <div className="bv-beta-d">Schedule visits on the OpenHouse app — one or up to <b>{MAX_BOOK}</b> at a time. Booking as <b>{me.name || me.slug}</b>.</div>
        </div>
        {!BOOKING_LIVE && <span className="bv-pill-preview">Preview — API not live</span>}
      </div>

      {!canBook && (
        <div className="bv-warn" style={{ marginBottom: 14 }}>
          ⚠ <b>You're not set up to book yet.</b> Your account isn't linked to an OpenHouse Sales Manager, so bookings will be rejected. Ask the app team to add you (and confirm your Sales Manager ID), then reload.
        </div>
      )}

      {/* filters */}
      <div className="bv-filters">
        <span className="bv-flbl">Filter inventory</span>
        <MultiSelect label="City" options={cityOpts} value={fCity} onChange={setFCity} />
        <MultiSelect label="BHK / Config" options={cfgOpts} value={fCfg} onChange={setFCfg} />
        <MultiSelect label="Region" options={regionOpts} value={fRegion} onChange={setFRegion} />
        <div className="bv-price">
          <span className="bv-mut" style={{ fontWeight: 700, fontSize: 12 }}>₹ Cr</span>
          <input type="number" min="0" step="0.25" placeholder="min" value={pmin} onChange={(e) => setPmin(e.target.value)} />
          <span className="bv-mut">–</span>
          <input type="number" min="0" step="0.25" placeholder="max" value={pmax} onChange={(e) => setPmax(e.target.value)} />
        </div>
        <div className="bv-searchbox">🔎 <input placeholder="Search society or unit…" value={q} onChange={(e) => setQ(e.target.value)} /></div>
        {hasFilters ? <button type="button" className="bv-chip-clear" onClick={() => { setFCity([]); setFCfg([]); setFRegion([]); setPmin(''); setPmax(''); setQ(''); }}>Clear ✕</button> : null}
      </div>

      <div className="bv-countrow">
        <span className="bv-mut"><b>{filtered.length}</b> units · <b>{ready}</b> ready · <b>{comingSoon}</b> coming soon{booked ? <> · <b>{booked}</b> booked</> : null}{selected.size ? <span className="bv-selnote"> · {selected.size} of {MAX_BOOK} selected</span> : null}</span>
      </div>

      {isMobile ? (
        <div className="bv-cards">
          {filtered.length === 0 && <div className="bv-empty">📦 No units match these filters</div>}
          {cityKeys.map((city) => {
            const groups = {}; byCity[city].forEach((u) => { (groups[u.mm] = groups[u.mm] || []).push(u); });
            return Object.keys(groups).sort().map((mm) => (
              <CardGroup key={city + '|' + mm} city={city} mm={mm} rows={groups[mm]}
                selected={selected} atCap={atCap} onToggle={toggleSel} onBook={(u) => openDrawer([u])} />
            ));
          })}
        </div>
      ) : (
        <div className="bv-tablecard">
          <table className="bv-tbl">
            <thead><tr><th className="bv-cb"></th><th>Society</th><th>Unit</th><th>Config</th><th>Area</th><th>Locality</th><th>Status</th><th className="bv-right">Ask Price</th><th></th></tr></thead>
            <tbody>
              {filtered.length === 0 && <tr><td colSpan={9}><div className="bv-empty">📦 No units match these filters</div></td></tr>}
              {cityKeys.map((city) => {
                const groups = {}; byCity[city].forEach((u) => { (groups[u.mm] = groups[u.mm] || []).push(u); });
                return Object.keys(groups).sort().map((mm) => (
                  <FragmentGroup key={city + '|' + mm} city={city} mm={mm} rows={groups[mm]}
                    selected={selected} atCap={atCap} onToggle={toggleSel} onBook={(u) => openDrawer([u])} />
                ));
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* sticky bulk bar */}
      {selected.size > 0 && (
        <div className="bv-bulkbar">
          <span className="bv-bb-n"><b>{selected.size}</b> of {MAX_BOOK} selected</span>
          <button type="button" className="bv-clr" onClick={() => setSelected(new Set())}>Clear</button>
          <button type="button" className="bv-btn primary" onClick={() => openDrawer([...selected].map((h) => unitByHome[h]).filter(Boolean))}>Book selected →</button>
        </div>
      )}

      {draft && (
        <BookingDrawer
          draft={draft} setDraft={setDraft} cps={cps} me={me} canBook={canBook}
          onClose={closeDrawer}
          onDone={() => { setSelected(new Set()); closeDrawer(); }}
        />
      )}
    </div>
  );
}

function FragmentGroup({ city, mm, rows, selected, atCap, onToggle, onBook }) {
  return (
    <>
      <tr className="bv-grp"><td colSpan={9}>{city} · {mm} · {rows.length}</td></tr>
      {rows.slice().sort((a, b) => a.society.localeCompare(b.society)).map((u) => {
        const on = selected.has(u.home_id);
        return (
          <tr key={u.home_id} className={on ? 'bv-sel' : ''}>
            <td className="bv-cb"><input type="checkbox" checked={on} disabled={!on && atCap} onChange={() => onToggle(u.home_id)} /></td>
            <td><span className="bv-soc">{u.status === 'Coming Soon' ? <span className="bv-new">NEW</span> : null}{u.society}</span></td>
            <td>{u.unit}</td><td>{u.cfg}</td><td>{u.sqft} sqft</td><td>{u.mm}</td>
            <td><span className={'bv-status ' + (u.status === 'Ready' ? 'r' : u.status === 'Booked' ? 'bk' : 'cs')}>{u.status}</span></td>
            <td className="bv-right bv-ask">{u.price}</td>
            <td><button type="button" className="bv-book" onClick={() => onBook(u)}>Book</button></td>
          </tr>
        );
      })}
    </>
  );
}

// Mobile card layout — one tappable card per unit (no horizontal scrolling). Mirrors
// FragmentGroup's grouping/selection; the Book button stays visible on every card.
function CardGroup({ city, mm, rows, selected, atCap, onToggle, onBook }) {
  return (
    <>
      <div className="bv-cgrp">{city} · {mm} · {rows.length}</div>
      {rows.slice().sort((a, b) => a.society.localeCompare(b.society)).map((u) => {
        const on = selected.has(u.home_id);
        return (
          <div key={u.home_id} className={'bv-card' + (on ? ' on' : '')}>
            <input type="checkbox" className="bv-card-cb" checked={on} disabled={!on && atCap} onChange={() => onToggle(u.home_id)} />
            <div className="bv-card-b">
              <div className="bv-card-soc">{u.status === 'Coming Soon' ? <span className="bv-new">NEW</span> : null}{u.society}</div>
              <div className="bv-card-m">{u.unit} · {u.cfg} · {u.sqft} sqft</div>
              <div className="bv-card-m">{u.mm} · <span className={'bv-status ' + (u.status === 'Ready' ? 'r' : u.status === 'Booked' ? 'bk' : 'cs')}>{u.status}</span></div>
              <div className="bv-card-f">
                <span className="bv-ask">{u.price}</span>
                <button type="button" className="bv-book" onClick={() => onBook(u)}>Book →</button>
              </div>
            </div>
          </div>
        );
      })}
    </>
  );
}

/* ============================ booking drawer ============================ */
function BookingDrawer({ draft, setDraft, cps, me, canBook, onClose, onDone }) {
  const d = draft; const bulk = d.units.length > 1;
  const [submitting, setSubmitting] = useState(false);
  const cpObj = d.shared.cp ? cps.find((c) => c.cp_code === d.shared.cp) : null;
  const set = (mut) => setDraft((cur) => { const n = { ...cur, shared: { ...cur.shared }, rows: { ...cur.rows } }; mut(n); return n; });
  const isToday = d.shared.date === ymd(next7()[0]);
  const nowMin = (() => { const n = new Date(); return n.getHours() * 60 + n.getMinutes(); })();

  // One buyer (name + mobile) is used for EVERY selected unit — per-unit buyers
  // are not offered.
  const detailsValid = useMemo(() => {
    if (!d.shared.cp || !d.shared.date || !d.shared.time) return false;
    return !!(d.shared.buyer.trim() && d.shared.mobile.length >= 5);
  }, [d]);

  const payloads = useMemo(() => d.units.map((u) => (
    { unit: u, cp: cpObj, buyer: d.shared.buyer.trim(), mobile: d.shared.mobile, date: d.shared.date, time: d.shared.time }
  )), [d, cpObj]);

  const confirm = async () => {
    if (submitting) return;
    if (!canBook) { toast("You're not set up to book — ask the app team to add you as a Sales Manager.", 'bad'); return; }
    if (!BOOKING_LIVE) {   // preview fallback when the flag is off
      setDraft((cur) => ({ ...cur, step: 3, results: payloads.map((p) => ({ unit: p.unit, ok: true, preview: true })) }));
      return;
    }
    setSubmitting(true);
    try {
      const body = { visits: payloads.map((p) => ({
        home_id: p.unit.home_id,
        broker_id: p.cp.broker_id != null ? String(p.cp.broker_id) : undefined,
        cp_code: p.cp.cp_code,
        buyer_name: p.buyer,
        buyer_mobile: p.mobile,
        selected_date: p.date,
        selected_time: p.time,
        source: 'channel_partner',
      })) };
      const resp = await bookVisits(body);
      const byHome = {};
      (resp.results || []).forEach((r) => { byHome[String(r.home_id)] = r; });
      const results = payloads.map((p) => {
        const r = byHome[String(p.unit.home_id)] || {};
        return { unit: p.unit, ok: !!r.ok, error: r.error, remaining_days: r.remaining_days, visit: r.visit };
      });
      setDraft((cur) => ({ ...cur, step: 3, results }));
    } catch (e) {
      toast('Booking failed: ' + String(e.message || e).slice(0, 160), 'bad');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <>
      <div className="bv-scrim" onClick={onClose} />
      <aside className="bv-drawer">
        <div className="bv-dhead">
          <div style={{ flex: 1 }}>
            <div className="bv-dh-title">{d.step === 1 ? (bulk ? `Book ${d.units.length} visits` : 'Book a visit') : d.step === 2 ? 'Review & confirm' : 'Done'}</div>
            <div className="bv-dh-sub">{d.step === 1 ? (bulk ? 'Set the partner, date, time & one buyer for all units.' : `${d.units[0].society} · ${d.units[0].unit}`) : d.step === 2 ? 'Check every detail — this cannot be undone.' : ''}</div>
          </div>
          <button type="button" className="bv-xbtn" onClick={onClose}>✕</button>
        </div>

        <div className="bv-dbody">
          <div className="bv-steps"><span className={'s' + (d.step >= 1 ? ' on' : '')} /><span className={'s' + (d.step >= 2 ? ' on' : '')} /><span className={'s' + (d.step >= 3 ? ' on' : '')} /></div>

          {d.step === 1 && (
            <>
              <div className="bv-sect">
                <div className="bv-sect-t">{bulk ? 'Shared for all visits' : 'Visit details'}</div>
                <div className="bv-field"><label className="bv-lbl">Channel Partner <span className="bv-req">*</span></label>
                  <CpPicker cps={cps} value={cpObj} onPick={(c) => set((n) => { n.shared.cp = c.cp_code; })} /></div>
                <div className="bv-field"><label className="bv-lbl">Date <span className="bv-req">*</span></label>
                  <div className="bv-chips">{next7().map((dt, i) => (
                    <button type="button" key={i} className={'bv-datechip' + (d.shared.date === ymd(dt) ? ' on' : '')} onClick={() => set((n) => { n.shared.date = ymd(dt); n.shared.time = null; })}>
                      <div className="dow">{i === 0 ? 'Today' : DOW[dt.getDay()]}</div><div className="dd">{dt.getDate()} {MON[dt.getMonth()]}</div>
                    </button>))}</div></div>
                <div className="bv-field"><label className="bv-lbl">Time slot <span className="bv-req">*</span></label>
                  <div className="bv-slots">{TIME_SLOTS.map((s) => {
                    // today: a slot stays bookable until 1 hour into it (e.g. 7-9 PM until 8:00, 9-11 AM until 10:00)
                    const dis = isToday && nowMin >= (SLOT_START_HR[s] + 1) * 60;
                    return <button type="button" key={s} disabled={dis} className={'bv-slot' + (d.shared.time === s ? ' on' : '') + (dis ? ' dis' : '')} onClick={() => set((n) => { n.shared.time = s; })}>{s}</button>;
                  })}</div></div>
              </div>

              <div className="bv-sect">
                <div className="bv-sect-t">Buyer{bulk ? ` (same for all ${d.units.length})` : ''} <span className="bv-req">*</span></div>
                <BuyerInputs r={d.shared} onName={(v) => set((n) => { n.shared.buyer = v; })} onMobile={(v) => set((n) => { n.shared.mobile = v; })} />
              </div>

              {bulk && (
                <div className="bv-sect">
                  <div className="bv-sect-t">Units ({d.units.length})</div>
                  {d.units.map((u) => (
                    <div className="bv-urow" key={u.home_id}>
                      <div className="bv-urow-top">
                        <div><div className="bv-urow-soc">{u.society}</div><div className="bv-urow-un">{u.unit} · {u.cfg} · {u.price} · home {u.home_id}</div></div>
                        {d.units.length > 1 && <button type="button" className="bv-rm" title="Remove" onClick={() => set((n) => {
                          n.units = n.units.filter((x) => x.home_id !== u.home_id); delete n.rows[u.home_id];
                        })}>×</button>}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}

          {d.step === 2 && (
            <>
              <div className="bv-warn">
                ⚠ <b>Review carefully.</b> On confirm, {payloads.length === 1 ? 'this visit is' : `these ${payloads.length} visits are`} created on the OpenHouse app and <b>cannot be edited or undone</b>. The buyer &amp; CP are notified immediately.
              </div>
              <div className="bv-note ok">Booking as <b>{me.name || me.slug}</b> · CP <b>{cpObj.name}</b> ({cpObj.cp_code}) · {d.shared.date} · {d.shared.time}</div>
              {payloads.map((p, i) => (
                <div className="bv-revcard" key={p.unit.home_id}>
                  <div className="bv-rev-h"><span className="bv-ix">{i + 1}</span> {p.unit.society} · {p.unit.unit}</div>
                  <div className="bv-rev-grid">
                    <div><span className="bv-rev-k">Unit</span>{p.unit.unit} · {p.unit.cfg} · {p.unit.sqft} sqft</div>
                    <div><span className="bv-rev-k">Home ID</span>{p.unit.home_id}</div>
                    <div><span className="bv-rev-k">City / Region</span>{p.unit.city} · {p.unit.mm}</div>
                    <div><span className="bv-rev-k">Ask price</span>{p.unit.price}</div>
                    <div><span className="bv-rev-k">Channel Partner</span>{p.cp.name} ({p.cp.cp_code}{p.cp.tier ? ' · ' + p.cp.tier : ''})</div>
                    <div><span className="bv-rev-k">CP city</span>{p.cp.city || '—'}</div>
                    <div><span className="bv-rev-k">Buyer</span>{p.buyer}</div>
                    <div><span className="bv-rev-k">Buyer mobile</span>{p.mobile} <span className="bv-mut">(last digits)</span></div>
                    <div><span className="bv-rev-k">Date</span>{p.date}</div>
                    <div><span className="bv-rev-k">Time</span>{p.time}</div>
                  </div>
                </div>
              ))}
              {!BOOKING_LIVE && <div className="bv-note preview">ℹ Preview mode — the booking API is not connected yet, so confirming will <b>not</b> create anything. This screen is exactly what super-admins will confirm once it goes live.</div>}
            </>
          )}

          {d.step === 3 && (() => {
            const booked = d.results.filter((r) => r.ok).length;
            const failed = d.results.length - booked;
            const preview = d.results.some((r) => r.preview);
            return (
              <>
                <div className="bv-doneh">{preview ? '👀 Preview — nothing created.' : `${booked > 0 ? '🎉' : '⚠'} Booked ${booked} of ${d.results.length}${failed ? ` · ${failed} failed` : ''}.`}</div>
                {d.results.map((r) => (
                  <div className="bv-result" key={r.unit.home_id}>
                    <div className="bv-res-ic" style={(r.ok || r.preview) ? undefined : { background: '#FEE2E2', color: '#B91C1C' }}>{r.preview ? '👁' : (r.ok ? '✓' : '✕')}</div>
                    <div>
                      <div className="bv-res-nm">{r.unit.society} · {r.unit.unit}</div>
                      <div className="bv-mut">{r.preview ? 'Would be scheduled (preview)' : (r.ok ? (r.visit?.id ? `Visit #${r.visit.id} scheduled` : 'Visit scheduled') : errLabel(r))}</div>
                    </div>
                  </div>
                ))}
                {failed > 0 && !preview && <div className="bv-note preview">Failed rows were not created. Fix and rebook just those.</div>}
              </>
            );
          })()}
        </div>

        <div className="bv-dfoot">
          {d.step === 1 && (
            <>
              <span className="bv-foot-sp">{d.units.length} visit{d.units.length > 1 ? 's' : ''} · source: Channel Partner</span>
              <button type="button" className="bv-btn primary" disabled={!detailsValid} onClick={() => setDraft((c) => ({ ...c, step: 2 }))}>Review {d.units.length} →</button>
            </>
          )}
          {d.step === 2 && (
            <>
              <button type="button" className="bv-btn" disabled={submitting} onClick={() => setDraft((c) => ({ ...c, step: 1 }))}>← Back</button>
              <button type="button" className={'bv-btn ' + (BOOKING_LIVE ? 'danger' : 'primary')} disabled={submitting || !canBook} onClick={confirm}>
                {submitting ? 'Booking…' : (!canBook ? 'Not set up to book' : (BOOKING_LIVE ? `Confirm & book ${payloads.length}` : 'Confirm (preview)'))}
              </button>
            </>
          )}
          {d.step === 3 && <button type="button" className="bv-btn primary" style={{ marginLeft: 'auto' }} onClick={onDone}>Done</button>}
        </div>
      </aside>
    </>
  );
}

function BuyerInputs({ r, onName, onMobile }) {
  return (
    <div className="bv-u2">
      <div><label className="bv-lbl">Buyer name <span className="bv-req">*</span></label>
        <input className="bv-inp" placeholder="Full name" value={r.buyer} onChange={(e) => onName(e.target.value)} /></div>
      <div><label className="bv-lbl">Mobile (last 5–10 digits) <span className="bv-req">*</span></label>
        <input className="bv-inp" placeholder="e.g. 98765" inputMode="numeric" value={r.mobile} onChange={(e) => onMobile(e.target.value.replace(/\D/g, '').slice(0, 10))} /></div>
    </div>
  );
}

/* ============================ scoped styles (bv- prefix only) ============================ */
function BvStyles() {
  return (
    <style>{`
.bv-root{--bv-brand:#F4541C;--bv-brand-press:#DA440D;--bv-tint:#FEEEE7;--bv-mut:#6E6E73;--bv-faint:#9A9AA0;--bv-line:#ECEAE6;--bv-line2:#E2DFD9;--bv-panel:#fff;--bv-bg:#F6F4F0;--bv-ink2:#3C3C3C;position:relative}
.bv-root .bv-mut{color:var(--bv-mut)}
.bv-beta{display:flex;align-items:center;gap:12px;background:linear-gradient(135deg,#FFF4EE,#FFE7DB);border:1px solid #FAD2BF;border-radius:14px;padding:12px 15px;margin-bottom:14px}
.bv-beta-ic{width:40px;height:40px;border-radius:11px;background:linear-gradient(135deg,#FB6A2E,var(--bv-brand));display:grid;place-items:center;font-size:19px;flex:0 0 auto}
.bv-beta-tx{flex:1;min-width:0}
.bv-kick{font-size:10px;font-weight:800;letter-spacing:.09em;color:var(--bv-brand);text-transform:uppercase}
.bv-beta-h{font-size:17px;font-weight:800;letter-spacing:-.02em;margin:1px 0}
.bv-beta-d{font-size:12.5px;color:#8a6f5f}
.bv-pill-preview{background:#1A1A1A;color:#fff;font-size:11px;font-weight:700;padding:5px 11px;border-radius:999px;white-space:nowrap}
.bv-filters{display:flex;flex-wrap:wrap;gap:9px;align-items:center;background:var(--bv-panel);border:1px solid var(--bv-line2);border-radius:13px;padding:12px 13px;margin-bottom:12px}
.bv-flbl{font-size:11px;font-weight:800;letter-spacing:.06em;color:var(--bv-faint);text-transform:uppercase}
.bv-ms{position:relative}
.bv-ms-btn{display:inline-flex;align-items:center;gap:7px;background:#fff;border:1px solid var(--bv-line2);border-radius:10px;padding:9px 12px;font-size:13px;font-weight:600;color:var(--bv-ink2);cursor:pointer}
.bv-ms-btn.has{border-color:var(--bv-brand);color:var(--bv-brand);background:var(--bv-tint)}
.bv-ms-count{background:var(--bv-brand);color:#fff;border-radius:6px;font-size:11px;padding:0 6px;font-weight:700}
.bv-ms-caret{color:var(--bv-faint);font-size:11px}
.bv-ms-pop,.bv-cppop{position:absolute;z-index:40;top:calc(100% + 6px);left:0;width:262px;background:#fff;border:1px solid var(--bv-line2);border-radius:12px;box-shadow:0 18px 40px -16px rgba(0,0,0,.28);padding:9px}
.bv-ms-search{width:100%;border:1px solid var(--bv-line);border-radius:8px;padding:8px 10px;font-size:13px;outline:none;margin-bottom:7px}
.bv-ms-actions{display:flex;align-items:center;gap:8px;font-size:12px;margin-bottom:6px}
.bv-ms-actions button{background:none;border:none;color:var(--bv-brand);font-weight:700;font-size:12px;padding:0;cursor:pointer}
.bv-ms-n{color:var(--bv-faint);margin-left:auto}
.bv-ms-list{max-height:230px;overflow:auto}
.bv-ms-opt{display:flex;align-items:center;gap:8px;padding:6px 4px;font-size:13px;border-radius:7px;cursor:pointer}
.bv-ms-opt:hover{background:var(--bv-bg)}
.bv-ms-more{font-size:12px;color:var(--bv-faint);padding:8px 4px}
.bv-price{display:inline-flex;align-items:center;gap:6px;background:#fff;border:1px solid var(--bv-line2);border-radius:10px;padding:7px 11px}
.bv-price input{width:52px;border:none;outline:none;font-size:13px;font-weight:600;text-align:center}
.bv-searchbox{flex:1;min-width:150px;display:flex;align-items:center;gap:8px;background:#fff;border:1px solid var(--bv-line2);border-radius:10px;padding:9px 12px;color:var(--bv-mut)}
.bv-searchbox input{border:none;outline:none;flex:1;font-size:13px;background:none}
.bv-chip-clear{background:#fff;border:1px solid var(--bv-line2);border-radius:999px;padding:8px 13px;font-size:12.5px;font-weight:600;color:var(--bv-ink2);cursor:pointer}
.bv-countrow{padding:2px 4px 10px;font-size:13px}
.bv-countrow b{color:#1A1A1A}
.bv-selnote{color:var(--bv-brand);font-weight:800}
.bv-tablecard{background:var(--bv-panel);border:1px solid var(--bv-line);border-radius:13px;overflow-x:auto;-webkit-overflow-scrolling:touch}
.bv-tbl{width:100%;min-width:760px;border-collapse:collapse}
.bv-tbl thead th{font-size:11px;font-weight:800;letter-spacing:.04em;text-transform:uppercase;color:var(--bv-faint);text-align:left;padding:11px 12px;background:#FBFAF8;border-bottom:1px solid var(--bv-line)}
.bv-tbl th.bv-right,.bv-tbl td.bv-right{text-align:right}
.bv-tbl th.bv-cb,.bv-tbl td.bv-cb{width:38px;text-align:center}
.bv-tbl tbody td{padding:10px 12px;border-bottom:1px solid var(--bv-line);font-size:13px;vertical-align:middle}
.bv-tbl tbody tr:hover{background:#FBFAF8}
.bv-tbl tbody tr.bv-sel{background:var(--bv-tint)}
.bv-soc{font-weight:700}
.bv-new{display:inline-block;background:#1FA251;color:#fff;font-size:9px;font-weight:800;padding:2px 5px;border-radius:5px;margin-right:6px;vertical-align:middle}
.bv-status{display:inline-block;font-size:11px;font-weight:700;padding:3px 9px;border-radius:7px}
.bv-status.r{background:#E7F6EC;color:#147A3D}.bv-status.cs{background:#FBF0DA;color:#B45309}.bv-status.bk{background:#E7E5E4;color:#57534E}
.bv-ask{font-weight:800;white-space:nowrap}
.bv-book{background:#fff;border:1px solid var(--bv-brand);color:var(--bv-brand);font-weight:700;font-size:12px;padding:6px 13px;border-radius:8px;white-space:nowrap;cursor:pointer}
.bv-book:hover{background:var(--bv-brand);color:#fff}
.bv-grp td{background:#F3F1EC;font-size:11px;font-weight:800;letter-spacing:.05em;text-transform:uppercase;color:var(--bv-brand);padding:7px 12px}
.bv-tbl input[type=checkbox]{width:16px;height:16px;accent-color:var(--bv-brand);cursor:pointer}
.bv-tbl input[type=checkbox]:disabled{cursor:not-allowed;opacity:.4}
.bv-empty{text-align:center;padding:44px 20px;color:var(--bv-mut)}
/* Mobile card list (≤900px; rendered instead of the table) */
.bv-cards{display:flex;flex-direction:column;gap:9px}
.bv-cgrp{font-size:11px;font-weight:800;letter-spacing:.05em;text-transform:uppercase;color:var(--bv-brand);padding:8px 2px 1px}
.bv-card{display:flex;gap:11px;background:var(--bv-panel);border:1px solid var(--bv-line);border-radius:13px;padding:13px 14px}
.bv-card.on{background:var(--bv-tint);border-color:var(--bv-brand)}
.bv-card-cb{width:18px;height:18px;accent-color:var(--bv-brand);margin-top:3px;flex:0 0 auto;cursor:pointer}
.bv-card-cb:disabled{opacity:.4}
.bv-card-b{flex:1;min-width:0}
.bv-card-soc{font-weight:800;font-size:15px;line-height:1.3}
.bv-card-m{font-size:12.5px;color:var(--bv-mut);margin-top:4px;display:flex;align-items:center;gap:7px;flex-wrap:wrap}
.bv-card-f{display:flex;align-items:center;justify-content:space-between;margin-top:11px;gap:10px}
.bv-card-f .bv-ask{font-weight:800;font-size:15.5px;color:var(--bv-ink2)}
.bv-card-f .bv-book{background:var(--bv-brand);color:#fff;border-color:var(--bv-brand);padding:9px 18px;font-size:13px;border-radius:9px}
.bv-bulkbar{position:fixed;left:50%;transform:translateX(-50%);bottom:74px;z-index:50;display:flex;align-items:center;gap:13px;background:#1A1A1A;color:#fff;border-radius:13px;padding:11px 15px;box-shadow:0 22px 48px -16px rgba(0,0,0,.5)}
.bv-bb-n{font-size:13.5px;font-weight:700}.bv-bb-n b{color:#FB6A2E}
.bv-clr{color:#bbb;font-size:12.5px;font-weight:600;background:none;border:none;cursor:pointer}
.bv-btn{background:#fff;border:1px solid var(--bv-line2);border-radius:10px;padding:9px 15px;font-size:13.5px;font-weight:700;color:var(--bv-ink2);cursor:pointer}
.bv-btn.primary{background:var(--bv-brand);border-color:var(--bv-brand);color:#fff}
.bv-btn.primary:hover{background:var(--bv-brand-press)}
.bv-btn.danger{background:#B91C1C;border-color:#B91C1C;color:#fff}
.bv-btn:disabled{opacity:.5;cursor:not-allowed}
.bv-scrim{position:fixed;inset:0;background:rgba(20,12,4,.42);z-index:100}
.bv-drawer{position:fixed;top:0;right:0;height:100%;width:560px;max-width:96vw;background:var(--bv-bg);z-index:101;display:flex;flex-direction:column;box-shadow:-22px 0 50px -20px rgba(0,0,0,.4)}
.bv-dhead{display:flex;align-items:flex-start;gap:12px;padding:17px 19px 13px;background:#fff;border-bottom:1px solid var(--bv-line)}
.bv-dh-title{font-size:18px;font-weight:800;letter-spacing:-.02em}
.bv-dh-sub{font-size:12.5px;color:var(--bv-mut);margin-top:3px}
.bv-xbtn{width:34px;height:34px;border-radius:50%;border:1px solid var(--bv-line);background:#fff;font-size:15px;color:var(--bv-mut);cursor:pointer}
.bv-dbody{flex:1;overflow-y:auto;padding:15px 19px}
.bv-dfoot{padding:13px 19px;background:#fff;border-top:1px solid var(--bv-line);display:flex;align-items:center;gap:10px}
.bv-foot-sp{flex:1;font-size:12px;color:var(--bv-mut)}
.bv-steps{display:flex;gap:7px;margin-bottom:14px}
.bv-steps .s{flex:1;height:4px;border-radius:3px;background:var(--bv-line2)}.bv-steps .s.on{background:var(--bv-brand)}
.bv-sect{background:#fff;border:1px solid var(--bv-line);border-radius:12px;padding:13px;margin-bottom:13px}
.bv-sect-t{font-size:11px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;color:var(--bv-faint);margin-bottom:10px}
.bv-req{color:var(--bv-brand)}
.bv-lbl{font-size:12px;font-weight:700;color:var(--bv-ink2);margin:0 0 6px;display:block}
.bv-inp{width:100%;border:1px solid var(--bv-line2);border-radius:9px;padding:10px 12px;font-size:13.5px;outline:none;background:#fff;font-family:inherit}
.bv-inp:focus{border-color:var(--bv-brand)}
.bv-cpbtn{display:flex;align-items:center;gap:8px;text-align:left;cursor:pointer}
.bv-field+.bv-field{margin-top:11px}
.bv-chips{display:flex;gap:8px;overflow-x:auto;padding-bottom:2px}
.bv-datechip{flex:0 0 auto;border:1px solid var(--bv-line2);background:#fff;border-radius:11px;padding:8px 12px;text-align:center;min-width:62px;cursor:pointer}
.bv-datechip .dow{font-size:11px;color:var(--bv-mut);font-weight:600}.bv-datechip .dd{font-size:13px;font-weight:800;margin-top:1px}
.bv-datechip.on{background:var(--bv-brand);border-color:var(--bv-brand)}.bv-datechip.on .dow,.bv-datechip.on .dd{color:#fff}
.bv-slots{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}
.bv-slot{border:1px solid var(--bv-line2);background:#fff;border-radius:10px;padding:10px 6px;font-size:13px;font-weight:700;color:var(--bv-ink2);text-align:center;cursor:pointer}
.bv-slot.on{background:var(--bv-brand);border-color:var(--bv-brand);color:#fff}
.bv-slot.dis{opacity:.4;text-decoration:line-through;cursor:not-allowed}
.bv-cpsel{position:relative}
.bv-cppop{width:100%;max-height:280px;overflow:auto}
.bv-cpopt{display:flex;align-items:center;gap:9px;padding:8px;border-radius:8px;cursor:pointer}
.bv-cpopt:hover{background:var(--bv-bg)}
.bv-av{width:30px;height:30px;border-radius:50%;background:var(--bv-tint);color:var(--bv-brand);font-weight:800;font-size:12px;display:grid;place-items:center;flex:0 0 auto}
.bv-tier{font-size:10px;font-weight:800;padding:2px 6px;border-radius:5px;margin-left:auto}
.bv-tier.T1{background:#E7F0FF;color:#1D4ED8}.bv-tier.T2{background:#EDE9FE;color:#6D28D9}.bv-tier.T3{background:#F1F5F9;color:#475569}.bv-tier.T4{background:#F1F5F9;color:#94A3B8}
.bv-toggle{display:inline-flex;align-items:center;gap:9px;font-size:13px;font-weight:600;color:var(--bv-ink2);margin:0 2px 12px;cursor:pointer}
.bv-sw{width:40px;height:23px;border-radius:999px;background:var(--bv-line2);position:relative;transition:.2s;flex:0 0 auto}
.bv-sw::after{content:'';position:absolute;top:2px;left:2px;width:19px;height:19px;border-radius:50%;background:#fff;transition:.2s;box-shadow:0 1px 3px rgba(0,0,0,.25)}
.bv-sw.on{background:var(--bv-brand)}.bv-sw.on::after{left:19px}
.bv-u2{display:grid;grid-template-columns:1fr 1fr;gap:9px}
.bv-urow{border:1px solid var(--bv-line);border-radius:11px;padding:11px;margin-bottom:9px;background:#fff}
.bv-urow-top{display:flex;align-items:center;gap:10px;margin-bottom:9px}
.bv-urow-soc{font-weight:800;font-size:13.5px}.bv-urow-un{font-size:12px;color:var(--bv-mut)}
.bv-rm{margin-left:auto;color:var(--bv-faint);font-size:18px;background:none;border:none;line-height:1;cursor:pointer}
.bv-warn{background:#FFF1E9;border:1px solid #F6C7AE;color:#9A3412;font-size:12.5px;border-radius:11px;padding:11px 13px;margin-bottom:12px;line-height:1.5}
.bv-note{font-size:12px;border-radius:10px;padding:9px 11px;margin-bottom:10px}
.bv-note.ok{background:#E7F6EC;color:#147A3D}
.bv-note.preview{background:#F1F5F9;color:#475569;margin-top:6px}
.bv-revcard{background:#fff;border:1px solid var(--bv-line);border-radius:11px;padding:12px;margin-bottom:9px}
.bv-rev-h{font-weight:800;font-size:13.5px;display:flex;align-items:center;gap:8px;margin-bottom:9px}
.bv-ix{background:var(--bv-brand);color:#fff;width:20px;height:20px;border-radius:6px;display:grid;place-items:center;font-size:11px}
.bv-rev-grid{display:grid;grid-template-columns:1fr 1fr;gap:7px 14px;font-size:12.5px}
.bv-rev-k{display:block;font-size:10px;font-weight:800;letter-spacing:.04em;text-transform:uppercase;color:var(--bv-faint);margin-bottom:1px}
.bv-doneh{font-size:14px;font-weight:700;margin-bottom:12px}
.bv-result{display:flex;align-items:center;gap:10px;padding:10px;border-radius:10px;margin-bottom:8px;background:#fff;border:1px solid var(--bv-line)}
.bv-res-ic{width:30px;height:30px;border-radius:8px;display:grid;place-items:center;background:#E7F6EC;color:#147A3D;font-size:15px;flex:0 0 auto}
.bv-res-nm{font-weight:700;font-size:13px}
@media(max-width:560px){.bv-rev-grid{grid-template-columns:1fr}.bv-u2{grid-template-columns:1fr}}
/* Mobile/tablet: the fixed bottom tab bar (z-index 90) used to paint over the drawer's
   footer — the Review/Confirm CTA. The drawer now sits above it (z-index 101); use the
   dynamic viewport + safe-area so that footer always clears the iOS toolbar & home bar. */
@media(max-width:900px){.bv-drawer{height:100dvh;max-height:100dvh}.bv-dfoot{padding-bottom:calc(13px + env(safe-area-inset-bottom,0))}}
`}</style>
  );
}
