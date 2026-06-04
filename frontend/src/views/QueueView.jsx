import { useMemo, useState } from 'react';
import { bulkAssign } from '../api.js';
import { fmtDay } from '../lib/format.js';
import { toast } from '../lib/toast.js';
import useIsMobile from '../lib/useIsMobile.js';

const CITY_TABS = [
  { k: 'all', label: 'All' },
  { k: 'Gurgaon', label: 'Gurgaon' },
  { k: 'Noida', label: 'Noida' },
  { k: 'Ghaziabad', label: 'Ghaziabad' },
];

// Bulk-modal tier options (legacy openBulk ctx==='queue', line 3968-3974)
const TIER_OPTS = [
  { v: 'T3', label: 'Tier 3 (default for new brokers)' },
  { v: 'T2', label: 'Tier 2 (Silver) — promote' },
  { v: 'T1', label: 'Tier 1 (Gold) — promote' },
  { v: 'T4', label: 'Tier 4 (inactive)' },
];

export default function QueueView({ seed, reloadSeed }) {
  const isMobile = useIsMobile();
  const me = seed.current_user || {};
  const canReassign = me.team === 'Admin' || me.team === 'TL';

  // Data source: seed.to_assign_cps mapped to brokers keyed by cp_code, insertion order.
  const brokersByCode = useMemo(() => {
    const m = {};
    (seed.brokers || []).forEach((b) => { m[b.cp_code] = b; });
    return m;
  }, [seed]);
  const list = useMemo(
    () => (seed.to_assign_cps || []).map((cp) => brokersByCode[cp]).filter(Boolean),
    [seed, brokersByCode],
  );

  // ownerOptions(): KAM (Calling Team) + Ground (Ground Team) optgroups, value=slug.
  const owners = useMemo(() => {
    const users = seed.users || [];
    return {
      kam: users.filter((u) => u.team === 'KAM'),
      ground: users.filter((u) => u.team === 'Ground'),
    };
  }, [seed]);

  const [cityFilter, setCityFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState(() => new Set());
  const [selectMode, setSelectMode] = useState(false);

  // Bulk modal state
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bOwner, setBOwner] = useState('');
  const [bTier, setBTier] = useState('T3');
  const [bNote, setBNote] = useState('');
  const [busy, setBusy] = useState(false);

  const out = useMemo(() => {
    let o = list;
    if (cityFilter !== 'all') o = o.filter((b) => b.city === cityFilter);
    const q = search.trim().toLowerCase();
    if (q) {
      o = o.filter((b) => (b.name || '').toLowerCase().includes(q)
        || (b.cp_code || '').toLowerCase().includes(q)
        || (b.phone_number || '').includes(q));
    }
    return o;
  }, [list, cityFilter, search]);

  const allSelected = out.length > 0 && out.every((b) => selected.has(b.cp_code));

  function toggleCp(cp) {
    setSelected((prev) => {
      const n = new Set(prev);
      if (n.has(cp)) n.delete(cp); else n.add(cp);
      return n;
    });
  }
  function toggleSelectAll() {
    setSelected((prev) => {
      if (out.every((b) => prev.has(b.cp_code)) && out.length) {
        const n = new Set(prev);
        out.forEach((b) => n.delete(b.cp_code));
        return n;
      }
      const n = new Set(prev);
      out.forEach((b) => n.add(b.cp_code));
      return n;
    });
  }

  function openBulk() {
    if (!canReassign) { toast('Only Admin or Team Leads can bulk-reassign', 'bad'); return; }
    setBOwner(''); setBTier('T3'); setBNote('');
    setBulkOpen(true);
  }
  // Per-row "Assign…": clear selection, select just this cp, open bulk.
  function assignOne(cp) {
    if (!canReassign) { toast('Only Admin or Team Leads can bulk-reassign', 'bad'); return; }
    setSelected(new Set([cp]));
    setBOwner(''); setBTier('T3'); setBNote('');
    setBulkOpen(true);
  }

  async function applyBulk() {
    if (!bOwner) { toast('Pick a KAM or Ground member', 'bad'); return; }
    const cps = [...selected];
    if (!cps.length) { toast('No brokers selected', 'bad'); return; }
    setBusy(true);
    try {
      await bulkAssign({ cp_codes: cps, owner_slug: bOwner, tier: bTier || 'T3', note: bNote || '' });
      const ownerObj = (seed.users || []).find((u) => u.slug === bOwner);
      toast(`Assigned ${cps.length} broker${cps.length === 1 ? '' : 's'} to ${ownerObj ? ownerObj.name : bOwner}`, 'good');
      setSelected(new Set());
      setBulkOpen(false);
      await reloadSeed();
    } catch (e) {
      toast('Assign failed: ' + String(e.message || e).slice(0, 80), 'bad');
    } finally {
      setBusy(false);
    }
  }

  function onRowClick(e, cp) {
    if (e.target.closest('input,button')) return;
    if (selectMode) toggleCp(cp);
  }

  function clearSelection() {
    if (selected.size === 0) setSelectMode(false);
    setSelected(new Set());
  }

  const countLabel = isMobile
    ? `${out.length} awaiting assignment`
    : `${out.length} brokers awaiting assignment · admin assigns them to KAM (T1/T2) or Ground (T3/T4)`;

  return (
    <div className="view" id="view-queue">
      {/* City tabs (mirrors the global #cityTabs that scope the queue) */}
      <div className="city-tabs-wrap">
        <div className="city-tabs" id="cityTabs">
          {CITY_TABS.map((c) => (
            <button
              key={c.k}
              className={cityFilter === c.k ? 'on' : ''}
              onClick={() => setCityFilter(c.k)}
            >
              {c.label}
            </button>
          ))}
        </div>
        <div style={{ flex: 1 }} />
        <button className="btn" id="btnSelect" onClick={() => { setSelectMode((m) => { const nv = !m; if (!nv) setSelected(new Set()); return nv; }); }}>
          {selectMode ? 'Done' : 'Select'}
        </button>
      </div>

      <div className="search" style={{ margin: '10px 0' }}>
        <span className="ico">🔍</span>
        <input
          type="search"
          placeholder="Search visit, society, CP, buyer, phone…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      <div className="list-head">
        <span id="queueCountLabel">{countLabel}</span>
      </div>

      {isMobile ? (
        <div className="tbl-wrap">
          <QueueCards
            out={out}
            selected={selected}
            selectMode={selectMode}
            onToggle={toggleCp}
            onAssign={assignOne}
          />
        </div>
      ) : (
        <div className="tbl-wrap">
          <table className="t" style={{ minWidth: 1000 }}>
            <thead>
              <tr>
                <th className="col-check">
                  <input
                    type="checkbox"
                    id="queueSelAll"
                    checked={allSelected}
                    onChange={toggleSelectAll}
                  />
                </th>
                <th>Broker</th>
                <th>CP Code</th>
                <th>Phone</th>
                <th>City</th>
                <th>Added by</th>
                <th>Onboarded</th>
                <th>Activity</th>
                <th>Visits</th>
                <th />
              </tr>
            </thead>
            <tbody id="queueBody">
              {out.length === 0 ? (
                <tr>
                  <td colSpan={10}>
                    <div className="empty">
                      <div className="emoji">✅</div>
                      <div className="t">Queue clear</div>
                      <div className="s">No unassigned brokers in this view</div>
                    </div>
                  </td>
                </tr>
              ) : out.map((b) => {
                const sel = selected.has(b.cp_code);
                return (
                  <tr
                    key={b.cp_code}
                    data-cp={b.cp_code}
                    className={sel ? 'selected' : undefined}
                    onClick={(e) => onRowClick(e, b.cp_code)}
                  >
                    <td className="col-check">
                      <input
                        type="checkbox"
                        data-cb={b.cp_code}
                        checked={sel}
                        onChange={() => toggleCp(b.cp_code)}
                      />
                    </td>
                    <td>
                      <b>{b.name}</b>
                      <div style={{ fontSize: '10.5px', color: 'var(--mut)', marginTop: 1 }}>{b.company_name || ''}</div>
                    </td>
                    <td><span className="id-pill">{b.cp_code}</span></td>
                    <td style={{ fontFamily: "'SF Mono',monospace", fontSize: '11.5px' }}>{b.phone_number}</td>
                    <td><span className="city-pill">{b.city || ''}</span></td>
                    <td>{b.added_by || '—'}</td>
                    <td style={{ fontSize: '11.5px' }}>{fmtDay(b.created_at)}</td>
                    <td>
                      <span style={{ fontSize: '10.5px', color: 'var(--mut)', background: 'var(--panel2)', padding: '2px 7px', borderRadius: 4 }}>
                        {b.activity_category || '—'}
                      </span>
                    </td>
                    <td style={{ textAlign: 'center', fontWeight: 600 }}>{b.all_time_visits || 0}</td>
                    <td>
                      <button
                        className="btn xs"
                        data-assign={b.cp_code}
                        onClick={() => assignOne(b.cp_code)}
                      >
                        Assign…
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Floating selection bar (renderSelectionBar, queue context) */}
      {(selectMode || selected.size > 0) && (
        <div id="selBar" className="sel-bar">
          <span className="n">{selected.size}</span>
          <span>{`broker${selected.size === 1 ? '' : 's'} selected`}</span>
          <button className="a" id="selClear" onClick={clearSelection}>
            {selected.size ? 'Clear' : 'Exit select mode'}
          </button>
          {canReassign && selected.size > 0 && (
            <button className="a primary" id="selBulk" onClick={openBulk}>Assign brokers…</button>
          )}
        </div>
      )}

      {/* Bulk modal — openBulk('queue') */}
      {bulkOpen && (
        <div className="modal-bg" id="modal-bulk" onClick={(e) => { if (e.target.classList.contains('modal-bg')) setBulkOpen(false); }}>
          <div className="modal">
            <div className="modal-head">
              <h2 id="bulkTitle">Assign brokers to owner</h2>
              <button className="x-btn" data-close="modal-bulk" onClick={() => setBulkOpen(false)}>✕</button>
            </div>
            <div className="modal-body" id="bulkBody">
              <div className="bulk-info">
                <b>{selected.size}</b> broker{selected.size === 1 ? '' : 's'} selected to assign
              </div>
              <div className="f-row">
                <label>Assign to (any KAM or Ground team member)</label>
                <select
                  id="bAssignTo"
                  value={bOwner}
                  onChange={(e) => setBOwner(e.target.value)}
                  style={{ padding: '8px 11px', border: '1px solid var(--line)', borderRadius: 7, background: 'var(--panel)', width: '100%' }}
                >
                  <option value="">— Select —</option>
                  <optgroup label="Calling Team (KAM — Tier 1+2)">
                    {owners.kam.map((u) => (
                      <option key={u.slug} value={u.slug}>{u.name} ({(u.cities || []).join(', ')})</option>
                    ))}
                  </optgroup>
                  <optgroup label="Ground Team (Tier 3+4 + Properties)">
                    {owners.ground.map((u) => (
                      <option key={u.slug} value={u.slug}>{u.name} ({(u.cities || []).join(', ')})</option>
                    ))}
                  </optgroup>
                </select>
              </div>
              <div className="f-row" style={{ marginTop: 12 }}>
                <label>Set tier</label>
                <select
                  id="bTier"
                  value={bTier}
                  onChange={(e) => setBTier(e.target.value)}
                  style={{ padding: '8px 11px', border: '1px solid var(--line)', borderRadius: 7, background: 'var(--panel)', width: '100%' }}
                >
                  {TIER_OPTS.map((t) => (
                    <option key={t.v} value={t.v}>{t.label}</option>
                  ))}
                </select>
              </div>
              <div className="f-row" style={{ marginTop: 12 }}>
                <label>Note (optional)</label>
                <input
                  type="text"
                  id="bNote"
                  placeholder="e.g. KAM has capacity / fresh-broker bucket"
                  value={bNote}
                  onChange={(e) => setBNote(e.target.value)}
                  style={{ padding: '8px 11px', border: '1px solid var(--line)', borderRadius: 7, background: 'var(--panel)' }}
                />
              </div>
            </div>
            <div className="modal-foot">
              <span id="bulkSummary" className="muted" style={{ fontSize: 12 }} />
              <div>
                <button className="btn" data-close="modal-bulk" onClick={() => setBulkOpen(false)}>Cancel</button>
                <button className="btn primary" id="bulkApply" disabled={busy} onClick={applyBulk}>
                  {busy ? 'Applying…' : 'Apply'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// Mobile cards — renderQueueViewMobile (legacy line 2716)
function QueueCards({ out, selected, selectMode, onToggle, onAssign }) {
  if (!out.length) {
    return (
      <div className="m-card-list">
        <div className="empty">
          <div className="emoji">✅</div>
          <div className="t">Queue clear</div>
        </div>
      </div>
    );
  }
  return (
    <div className="m-card-list">
      {out.map((b) => {
        const sel = selected.has(b.cp_code);
        return (
          <div
            key={b.cp_code}
            className={`m-card ${sel ? 'selected' : ''}`}
            data-cp={b.cp_code}
            onClick={(e) => {
              if (e.target.closest('[data-assign]')) return;
              if (selectMode) onToggle(b.cp_code);
            }}
          >
            {selectMode && <div className="mc-check">{sel ? '✓' : ''}</div>}
            <div className="mc-top">
              <div className="mc-title">
                {b.name}
                <span className="sub">{b.company_name || ''} · {b.phone_number || ''}</span>
              </div>
              <div className="mc-right">
                <span className="city-pill">{b.city || ''}</span>
              </div>
            </div>
            <div className="mc-meta">
              <span>Added by <b>{b.added_by || '—'}</b></span>
              <span style={{ color: 'var(--mut)' }}>· {fmtDay(b.created_at)}</span>
            </div>
            <div className="mc-foot">
              <span>
                <b>{b.all_time_visits || 0}</b> all-time visits · <span style={{ color: 'var(--mut)' }}>{b.activity_category || ''}</span>
              </span>
              <button
                className="btn primary sm"
                data-assign={b.cp_code}
                onClick={(e) => { e.stopPropagation(); onAssign(b.cp_code); }}
              >
                Assign…
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
