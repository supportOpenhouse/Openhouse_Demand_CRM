import { useEffect, useMemo, useState } from 'react';
import { fmtDate, fmtDay } from '../lib/format.js';
import { visitStage, visitStatus, STAGE_BY_KEY, STAGES } from '../lib/visits.js';
import { usersBySlug } from '../lib/brokers.js';
import { top99ForSociety } from '../lib/properties.js';
import { loadTopBrokers, setTopBrokerPhone } from '../api.js';
import { SkeletonTable } from './Skeleton.jsx';

const STATUS_COLOR = { hot: 'var(--bad,#B91C1C)', warm: '#B45309', cold: '#1E40AF', dead: 'var(--mut)' };

function tbMatchClass(t) {
  const s = (t || '').toLowerCase();
  if (!s || s.includes('no match')) return 'tb-m-none';
  if (s.startsWith('agency')) return 'tb-m-agency';
  if (s.startsWith('broker')) return 'tb-m-broker';
  return 'tb-m-other';
}

export default function PropertyModal({ property: p, seed, onClose, onOpenBroker }) {
  const ubs = useMemo(() => usersBySlug(seed), [seed]);
  const brokersByCode = useMemo(() => {
    const m = {}; (seed.brokers || []).forEach((b) => { m[b.cp_code] = b; }); return m;
  }, [seed]);
  const societyVisits = useMemo(
    () => (seed.visits || []).filter((v) => v.society_name === p.society_name),
    [seed, p],
  );

  const [tab, setTab] = useState('visits');
  const [stageTab, setStageTab] = useState('all');   // #7 — "All" default
  const [statusFilter, setStatusFilter] = useState('all'); // #8

  // 99acres lazy load
  const [tb99, setTb99] = useState(null);
  const [tb99Err, setTb99Err] = useState(null);
  useEffect(() => {
    if (tab !== 'top_99' || tb99 || tb99Err) return;
    loadTopBrokers().then((d) => setTb99(d.items || [])).catch((e) => setTb99Err(e.message));
  }, [tab, tb99, tb99Err]);

  // counts + groupings
  const counts = useMemo(() => {
    const c = { total: societyVisits.length, hot: 0, warm: 0, upcoming: 0, booking: 0 };
    societyVisits.forEach((v) => {
      const st = visitStatus(v); if (st === 'hot') c.hot++; if (st === 'warm') c.warm++;
      const sg = visitStage(v); if (sg === 'upcoming') c.upcoming++; if (sg === 'booking') c.booking++;
    });
    return c;
  }, [societyVisits]);

  const stagesPresent = useMemo(() => {
    const set = new Set(societyVisits.map(visitStage));
    return STAGES.filter((s) => set.has(s.k)).map((s) => s.k);
  }, [societyVisits]);

  const visitRows = useMemo(() => societyVisits.filter((v) => {
    if (stageTab !== 'all' && visitStage(v) !== stageTab) return false;
    if (statusFilter !== 'all' && visitStatus(v) !== statusFilter) return false;
    return true;
  }).sort((a, b) => (b.visit_date || '').localeCompare(a.visit_date || '')), [societyVisits, stageTab, statusFilter]);

  // Top Brokers · OpenHouse — CPs by visit count, with Last FU taken + by (#9)
  const cpStats = useMemo(() => {
    const m = {};
    societyVisits.forEach((v) => {
      const c = v.cp_code; if (!c) return;
      let e = m[c]; if (!e) e = m[c] = { cp_code: c, name: v.broker_name, company: v.company_name, visits: 0, fuDate: null, fuBy: '' };
      e.visits++;
      const d = v.latest_followup_date;
      if (d && (!e.fuDate || d > e.fuDate)) { e.fuDate = d; e.fuBy = (v.latest_followup_by && ubs[v.latest_followup_by]?.name) || v.sales_manager || ''; }
    });
    return Object.values(m).sort((a, b) => b.visits - a.visits);
  }, [societyVisits, ubs]);

  const tb99rows = useMemo(() => (tb99 ? top99ForSociety(tb99, p) : []), [tb99, p]);

  function statCard(label, value, color, onClick, active) {
    return (
      <button className={'rx-stat' + (active ? ' on' : '')} onClick={onClick} style={active ? { borderColor: color } : undefined}>
        <div className="rx-stat-v" style={{ color }}>{value}</div>
        <div className="rx-stat-l">{label}</div>
      </button>
    );
  }

  return (
    <div className="rx-modal-bg" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="rx-modal">
        <div className="rx-modal-head">
          <div style={{ flex: 1, minWidth: 0 }}>
            <h2>{p.property_name}</h2>
            <div className="muted" style={{ fontSize: 12, marginTop: 3 }}>{[p.society_name, p.micro_market, p.city_name].filter(Boolean).join(' · ')}</div>
          </div>
          <div style={{ textAlign: 'right', marginRight: 6 }}>
            <div style={{ fontSize: 17, fontWeight: 700, color: 'var(--accDark,var(--acc))' }}>{p.listing_price || '—'}</div>
            <div className="muted" style={{ fontSize: 11 }}>{p.configuration || ''}{p.super_sqft ? ` · ${p.super_sqft} sqft` : ''} · {p.listing_status}</div>
          </div>
          <button className="rx-x" onClick={onClose}>✕</button>
        </div>

        <div className="rx-modal-body">
          {/* #8 — clickable stat boxes */}
          <div className="rx-stats">
            {statCard('Total', counts.total, 'var(--txt)', () => { setStatusFilter('all'); setStageTab('all'); }, statusFilter === 'all' && stageTab === 'all')}
            {statCard('Hot', counts.hot, STATUS_COLOR.hot, () => setStatusFilter((s) => s === 'hot' ? 'all' : 'hot'), statusFilter === 'hot')}
            {statCard('Warm', counts.warm, STATUS_COLOR.warm, () => setStatusFilter((s) => s === 'warm' ? 'all' : 'warm'), statusFilter === 'warm')}
            {statCard('Upcoming', counts.upcoming, '#1E40AF', () => setStageTab((s) => s === 'upcoming' ? 'all' : 'upcoming'), stageTab === 'upcoming')}
            {statCard('Booking', counts.booking, 'var(--good,#15803D)', () => setStageTab((s) => s === 'booking' ? 'all' : 'booking'), stageTab === 'booking')}
          </div>

          <div className="rx-tabs">
            <button className={'rx-tab' + (tab === 'visits' ? ' on' : '')} onClick={() => setTab('visits')}>Visits <span className="ct">{societyVisits.length}</span></button>
            <button className={'rx-tab' + (tab === 'top_oh' ? ' on' : '')} onClick={() => setTab('top_oh')}>Top Brokers · OpenHouse <span className="ct">{cpStats.length}</span></button>
            <button className={'rx-tab' + (tab === 'top_99' ? ' on' : '')} onClick={() => setTab('top_99')}>Top Brokers · 99acres{tb99 ? <span className="ct">{tb99rows.length}</span> : null}</button>
          </div>

          {tab === 'visits' && (
            <div className="rx-fade">
              {/* #7 — All stage tab */}
              <div className="rx-stage-tabs">
                <button className={'rx-stage-tab' + (stageTab === 'all' ? ' on' : '')} onClick={() => setStageTab('all')}>All</button>
                {stagesPresent.map((k) => (
                  <button key={k} className={'rx-stage-tab' + (stageTab === k ? ' on' : '')} onClick={() => setStageTab(k)}>
                    {STAGE_BY_KEY[k]?.label || k} <span style={{ opacity: .6 }}>{societyVisits.filter((v) => visitStage(v) === k).length}</span>
                  </button>
                ))}
              </div>
              <div className="tbl-wrap">
                <table className="t" style={{ minWidth: 760 }}>
                  <thead><tr><th>Buyer</th><th>Channel Partner</th><th>RM</th><th>Status</th><th>Stage</th><th>Visit date</th><th>Last FU</th></tr></thead>
                  <tbody>
                    {visitRows.length ? visitRows.map((v, i) => {
                      const st = visitStatus(v); const sg = visitStage(v);
                      return (
                        <tr key={v.id || i} style={{ cursor: 'default' }}>
                          <td><b>{v.buyer_name || '—'}</b></td>
                          <td>{v.broker_name || '—'}<div className="rx-sub">{v.company_name || v.cp_code || ''}</div></td>
                          <td>{v.sales_manager || '—'}</td>
                          <td>{st === 'unc' ? <span className="muted">—</span> : <span className="rx-pill" style={{ background: 'var(--panel2)', color: STATUS_COLOR[st] || 'var(--txt)' }}>{st}</span>}</td>
                          <td><span className={'sgpill ' + sg}><span className="d" />{STAGE_BY_KEY[sg]?.label || sg}</span></td>
                          <td>{fmtDate(v.visit_date)}<div className="rx-sub">{fmtDay(v.visit_date)}</div></td>
                          <td>{v.latest_followup_date ? fmtDate(v.latest_followup_date) : <span className="muted">—</span>}</td>
                        </tr>
                      );
                    }) : <tr><td colSpan={7}><div className="empty"><div className="emoji">📭</div><div className="t">No visits in this filter</div></div></td></tr>}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {tab === 'top_oh' && (
            <div className="rx-fade">
              {cpStats.length ? cpStats.map((c, i) => {
                const b = brokersByCode[c.cp_code] || {};
                return (
                  <div key={c.cp_code} className="rx-ohrow" style={onOpenBroker ? { cursor: 'pointer' } : undefined} onClick={() => onOpenBroker?.(c.cp_code)}>
                    <div style={{ width: 26, fontWeight: 700, color: 'var(--mut)', textAlign: 'center', fontSize: 12 }}>#{i + 1}</div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 600, fontSize: 13 }}>{c.name || '—'}</div>
                      <div className="rx-sub">{[c.company || b.company_name, b.phone_number].filter(Boolean).join(' · ') || c.cp_code}</div>
                    </div>
                    <div style={{ minWidth: 90, textAlign: 'center', fontSize: 12 }}><b>{c.visits}</b><div className="rx-sub">visits</div></div>
                    {/* #9 — Last FU taken + by */}
                    <div style={{ minWidth: 150, textAlign: 'right' }}>
                      {c.fuDate
                        ? <><div style={{ fontSize: 12 }}>{fmtDate(c.fuDate)} <span className="muted">({fmtDay(c.fuDate)})</span></div><div className="rx-sub">{c.fuBy ? `by ${c.fuBy}` : ''}</div></>
                        : <span className="muted" style={{ fontSize: 11.5 }}>No FU taken</span>}
                    </div>
                  </div>
                );
              }) : <div className="empty"><div className="emoji">👥</div><div className="t">No brokers have brought visits here yet</div></div>}
            </div>
          )}

          {tab === 'top_99' && (
            <Top99 rows={tb99rows} loading={!tb99 && !tb99Err} err={tb99Err} society={p.society_name} total={tb99 ? tb99.length : 0} onPhone={(id, phone) => setTb99((prev) => prev.map((r) => r.id === id ? { ...r, phone } : r))} />
          )}
        </div>
      </div>
    </div>
  );
}

// 99acres tab body + inline phone editor (10-digit validation)
function Top99({ rows, loading, err, society, total, onPhone }) {
  const [editId, setEditId] = useState(null);
  const [val, setVal] = useState('');
  const [err2, setErr2] = useState('');
  const [saving, setSaving] = useState(false);

  if (loading) return (
    <div className="rx-fade">
      <div className="muted" style={{ fontSize: 11.5, marginBottom: 10 }}>Loading 99acres brokers…</div>
      <SkeletonTable rows={5} cols={7} minWidth={1180} />
    </div>
  );
  if (err) return <div className="empty"><div className="emoji">⚠️</div><div className="t">Couldn’t load 99acres brokers</div><div className="s">{err}</div></div>;
  if (!rows.length) return <div className="empty"><div className="emoji">🔗</div><div className="t">No 99acres top-broker data for {society}</div><div className="s">Not in the 99acres dataset ({total} brokers loaded across all societies).</div></div>;

  function start(r) { setEditId(r.id); setVal((r.phone || '').replace(/\D/g, '').slice(-10)); setErr2(''); }
  async function save(r) {
    const digits = (val || '').replace(/\D/g, '');
    if (digits.length !== 10) { setErr2('Enter a 10-digit number'); return; }
    setSaving(true);
    try {
      const d = await setTopBrokerPhone(r.id, digits);
      onPhone(r.id, d.phone || '');
      setEditId(null);
    } catch (e) { setErr2(String(e.message || e).slice(0, 80)); }
    finally { setSaving(false); }
  }

  return (
    <div className="rx-fade">
      <div className="muted" style={{ fontSize: 11.5, marginBottom: 10 }}>Top {rows.length} broker{rows.length > 1 ? 's' : ''} in <b style={{ color: 'var(--txt)' }}>{rows[0].society}</b> — sourced from 99acres.</div>
      <div className="tbl-wrap">
        <table className="t" style={{ minWidth: 1180 }}>
          <thead><tr>
            <th style={{ textAlign: 'center' }}>Rank</th><th>Broker</th><th>Agency</th>
            <th style={{ textAlign: 'center' }}>30d</th><th style={{ textAlign: 'center' }}>90d</th><th style={{ textAlign: 'center' }}>180d</th><th style={{ textAlign: 'center' }}>All</th>
            <th>Latest listing</th><th>Other NCR societies</th><th>OH match</th>
          </tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} style={{ cursor: 'default' }}>
                <td style={{ textAlign: 'center' }}><span className={'tb-rank' + ((r.rank || 99) <= 3 ? ' top' : '')}>{r.rank ?? '—'}</span></td>
                <td style={{ whiteSpace: 'normal', maxWidth: 170 }}>
                  <b>{r.broker_name || '—'}</b>
                  <div style={{ marginTop: 3 }}>
                    {editId === r.id ? (
                      <span style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>
                        <input autoFocus value={val} maxLength={10} inputMode="numeric"
                               onChange={(e) => { setVal(e.target.value.replace(/\D/g, '').slice(0, 10)); setErr2(''); }}
                               onKeyDown={(e) => { if (e.key === 'Enter') save(r); if (e.key === 'Escape') setEditId(null); }}
                               style={{ width: 96, padding: '2px 6px', border: '1px solid var(--line)', borderRadius: 6, fontSize: 11, fontFamily: "'SF Mono',Menlo,monospace" }} />
                        <button className="btn xs primary" disabled={saving} onClick={() => save(r)}>✓</button>
                        <button className="btn xs" onClick={() => setEditId(null)}>✕</button>
                        {err2 ? <span style={{ color: 'var(--bad)', fontSize: 9.5 }}>{err2}</span> : null}
                      </span>
                    ) : r.phone ? (
                      <button className="rx-phone-btn" onClick={() => start(r)} title="Edit phone">📞 {r.phone}</button>
                    ) : (
                      <button className="rx-phone-add" onClick={() => start(r)}>+ phone</button>
                    )}
                  </div>
                </td>
                <td style={{ whiteSpace: 'normal', maxWidth: 200 }}>{r.agency || '—'}{r.agency_address ? <div className="rx-sub">{r.agency_address}</div> : null}</td>
                <td style={{ textAlign: 'center' }}>{r.listings_30d || 0}</td>
                <td style={{ textAlign: 'center' }}>{r.listings_90d || 0}</td>
                <td style={{ textAlign: 'center' }}>{r.listings_180d || 0}</td>
                <td style={{ textAlign: 'center', fontWeight: 700 }}>{r.listings_all || 0}</td>
                <td style={{ fontSize: 11.5, whiteSpace: 'nowrap' }}>{r.latest_listing_date ? fmtDate(r.latest_listing_date) : '—'}{r.latest_listing_link ? <div><a href={r.latest_listing_link} target="_blank" rel="noopener" style={{ color: 'var(--acc)', fontSize: 11 }}>🔗 listing</a></div> : null}</td>
                <td style={{ whiteSpace: 'normal', maxWidth: 280 }}>{(r.other_ncr_societies || '').split(';').map((x) => x.trim()).filter(Boolean).map((x, i) => <span key={i} className="rx-chip">{x}</span>) || '—'}</td>
                <td style={{ whiteSpace: 'normal', maxWidth: 340 }}><span className={'tb-pill ' + tbMatchClass(r.oh_match_type)}>{r.oh_match_type || 'No match'}</span>{r.oh_match_details ? <div className="tb-details">{r.oh_match_details}</div> : null}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
