// Searchable sales-manager picker for the Sales Managers grid.
//
// Why not a native <select>: the roster has namesakes (two "Ankit Kumar"s, two Nitins…)
// and a bare name list let TLs assign units to the wrong person. Every entry here shows
// NAME · CITY · PHONE, the list is type-to-filter on any of those, and people based in
// the unit's own city are listed first. The cross-city warning lives in the parent,
// which owns the save.
//
// The list renders in a portal with fixed positioning: the grid's cells clip overflow,
// so an in-cell dropdown would be cut off.
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

const last10 = (v) => { const d = String(v || '').replace(/\D/g, ''); return d.length >= 10 ? d.slice(-10) : ''; };
export const smCityLabel = (a) => ((a?.cities || []).length ? a.cities.join('/') : '—');
export const smLabel = (a) => `${a.name} · ${smCityLabel(a)} · ${last10(a.phone) || 'no phone'}`;

export default function SmPicker({ options = [], value = '', unitCity = '', appOnlyLabel = '',
  loading = false, disabled = false, onPick }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const [pos, setPos] = useState(null);
  const btnRef = useRef(null);
  const listRef = useRef(null);
  const inputRef = useRef(null);

  const current = options.find((a) => String(a.sales_manager_id) === String(value)) || null;
  const closedLabel = loading ? 'loading…'
    : current ? smLabel(current)
      : value === '__app__' && appOnlyLabel ? `${appOnlyLabel} · in app, not linked in CRM`
        : '— not mapped —';

  // filter on name / city / team / phone digits; this unit's city first, then the rest
  const items = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const digits = needle.replace(/\D/g, '');
    const hit = (a) => !needle
      || (a.name || '').toLowerCase().includes(needle)
      || smCityLabel(a).toLowerCase().includes(needle)
      || (a.team || '').toLowerCase().includes(needle)
      || (digits.length >= 3 && last10(a.phone).includes(digits));
    const pool = options.filter(hit);
    const local = pool.filter((a) => unitCity && (a.cities || []).includes(unitCity));
    const other = pool.filter((a) => !(unitCity && (a.cities || []).includes(unitCity)));
    const out = [];
    if (!needle || 'unassign nobody'.includes(needle)) out.push({ kind: 'none' });
    if (local.length) out.push({ kind: 'head', label: `${unitCity} — this unit's city` }, ...local.map((a) => ({ kind: 'sm', a })));
    if (other.length) out.push({ kind: 'head', label: unitCity ? 'Other cities' : 'All people' }, ...other.map((a) => ({ kind: 'sm', a })));
    return out;
  }, [options, q, unitCity]);
  const pickable = items.map((it, i) => (it.kind === 'head' ? -1 : i)).filter((i) => i >= 0);

  const place = () => {
    const r = btnRef.current?.getBoundingClientRect();
    if (!r) return;
    const w = Math.min(Math.max(r.width, 360), window.innerWidth - 16);   // never wider than a phone
    const left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8));
    const below = window.innerHeight - r.bottom;
    setPos(below > 260 ? { left, top: r.bottom + 2, width: w } : { left, bottom: window.innerHeight - r.top + 2, width: w });
  };
  const openList = () => { if (disabled || loading) return; place(); setQ(''); setActive(pickable[0] ?? 0); setOpen(true); };
  const close = () => setOpen(false);

  useEffect(() => {
    if (!open) return undefined;
    inputRef.current?.focus();
    const onDoc = (e) => {
      if (btnRef.current?.contains(e.target) || listRef.current?.contains(e.target)) return;
      close();
    };
    // The list is fixed-position, so it FOLLOWS the button when the page scrolls (closing on
    // every scroll made a trailing scroll event close it the instant it opened). It closes
    // only once the button has left the viewport.
    const onMove = (e) => {
      // scrolling the list itself (a resize's target is `window`, which is not a Node)
      if (e && e.target instanceof Node && listRef.current?.contains(e.target)) return;
      const r = btnRef.current?.getBoundingClientRect();
      if (!r || r.bottom < 0 || r.top > window.innerHeight) { close(); return; }
      place();
    };
    document.addEventListener('mousedown', onDoc);
    window.addEventListener('scroll', onMove, true);
    window.addEventListener('resize', onMove);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      window.removeEventListener('scroll', onMove, true);
      window.removeEventListener('resize', onMove);
    };
  }, [open]);

  useEffect(() => { if (open) setActive(pickable[0] ?? 0); }, [q]);  // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    listRef.current?.querySelector(`[data-i="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const choose = (it) => {
    if (!it || it.kind === 'head') return;
    close();
    onPick?.(it.kind === 'none' ? '__none__' : it.a);
  };
  const onKey = (e) => {
    const at = pickable.indexOf(active);
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive(pickable[Math.min(at + 1, pickable.length - 1)] ?? active); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(pickable[Math.max(at - 1, 0)] ?? active); }
    else if (e.key === 'Enter') { e.preventDefault(); choose(items[active]); }
    else if (e.key === 'Escape') { e.preventDefault(); close(); btnRef.current?.focus(); }
  };

  return (
    <>
      <button type="button" ref={btnRef} className="sm-select sm-picker-btn" disabled={disabled}
              onClick={() => (open ? close() : openList())} title={closedLabel}
              style={{ width: '100%', maxWidth: '100%', textAlign: 'left', overflow: 'hidden',
                       textOverflow: 'ellipsis', whiteSpace: 'nowrap', cursor: disabled ? 'default' : 'pointer',
                       color: current ? undefined : 'var(--mut)' }}>
        {closedLabel} <span style={{ float: 'right', opacity: 0.5 }}>▾</span>
      </button>
      {open && pos ? createPortal(
        <div ref={listRef} className="sm-picker-pop" role="dialog"
             style={{ position: 'fixed', zIndex: 1000, ...pos, background: 'var(--card,#fff)',
                      border: '1px solid var(--line,#e6e9ee)', borderRadius: 8,
                      boxShadow: '0 8px 24px rgba(0,0,0,.14)', padding: 6 }}>
          <input ref={inputRef} value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={onKey}
                 placeholder="Search name, city or phone…" aria-label="Search sales managers"
                 style={{ width: '100%', boxSizing: 'border-box', padding: '6px 8px', fontSize: 12.5,
                          border: '1px solid var(--line,#e6e9ee)', borderRadius: 6, marginBottom: 4 }} />
          <div role="listbox" style={{ maxHeight: 300, overflowY: 'auto' }}>
            {items.length === 0 ? (
              <div style={{ padding: '8px 6px', fontSize: 12, color: 'var(--mut)' }}>No one matches "{q}"</div>
            ) : items.map((it, i) => {
              if (it.kind === 'head') {
                return <div key={`h${i}`} style={{ padding: '6px 6px 2px', fontSize: 10.5, fontWeight: 700,
                  letterSpacing: '.03em', textTransform: 'uppercase', color: 'var(--mut)' }}>{it.label}</div>;
              }
              const isCur = it.kind === 'sm' && current && it.a.sales_manager_id === current.sales_manager_id;
              return (
                <div key={it.kind === 'none' ? 'none' : it.a.slug} data-i={i} role="option" aria-selected={i === active}
                     onMouseEnter={() => setActive(i)} onMouseDown={(e) => { e.preventDefault(); choose(it); }}
                     style={{ padding: '5px 6px', borderRadius: 5, cursor: 'pointer', fontSize: 12.5,
                              background: i === active ? 'var(--hover,#eef2ff)' : 'transparent',
                              display: 'flex', gap: 6, alignItems: 'baseline' }}>
                  {it.kind === 'none' ? <i style={{ color: 'var(--mut)' }}>Unassign (nobody)</i> : (
                    <>
                      <b style={{ whiteSpace: 'nowrap' }}>{it.a.name}</b>
                      <span style={{ color: 'var(--mut)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {smCityLabel(it.a)} · {last10(it.a.phone) || 'no phone'} · {it.a.team}
                      </span>
                      {isCur ? <span style={{ marginLeft: 'auto', color: 'var(--good,#16A34A)' }}>✓</span> : null}
                    </>
                  )}
                </div>
              );
            })}
          </div>
        </div>,
        document.body,
      ) : null}
    </>
  );
}
