import { useState, useEffect, useCallback, useRef } from 'react';
import { loadActivity, loadActivityMeta } from '../api.js';
import useIsMobile from '../lib/useIsMobile.js';

// Admin only: every change, export and sign-in in the CRM, newest first (backend: GET /api/activity).
// Lines can only be added — never edited or removed — so this is the full history.

const ACTION_LABELS = {
  'auth.login': 'Signed in', 'auth.login_refused': 'Sign-in refused', 'auth.logout': 'Signed out',
  'auth.dev_login': 'Dev sign-in',
  'visit.followup': 'Follow-up added', 'visit.manager_remark': 'Manager remark',
  'visit.booked': 'Visit booked', 'visit.book_failed': 'Booking not made',
  'visit.completed': 'Visit completed', 'visit.cancelled': 'Visit cancelled',
  'visit.revisit_booked': 'Revisit booked', 'visit.rescheduled': 'Visit rescheduled',
  'visit.nudge': 'Nudge sent', 'visit.rm_reassigned': 'Visit RM reassigned',
  'property.kh_override': 'KH date override', 'property.review': 'Offer / demand remark',
  'property.snapshot_remark': 'Snapshot remark', 'property.sales_manager': 'Property sales manager',
  'property.pm_assigned': 'PM assignment', 'property.status_reconciled': 'Sold / Archived stamped',
  'property.duplicate_hidden': 'Duplicate unit hidden', 'property.duplicate_unhidden': 'Duplicate unit un-hidden',
  'lead.auto_archived': 'Lead auto-archived', 'lead.unarchived': 'Lead back in working list',
  'cp.registered': 'CP registered', 'cp.engagement': 'CP engagement', 'cp.tier': 'CP tier', 'cp.owner': 'CP owner',
  'cp.pinned': 'CP pinned to day', 'cp.unpinned': 'CP unpinned',
  'core_sm.created': 'Sales manager created in app',
  'user.created': 'Member added', 'user.updated': 'Member edited', 'user.deactivated': 'Member deactivated',
  'user.reactivated': 'Member reactivated', 'user.core_sm_linked': 'App sales-manager id linked',
  'team_perf.manual_cell': 'Team Performance cell', 'top_broker.phone': 'Top-broker phone',
  'society.hiring_mm': 'Hiring micro-market', 'report.preview': 'Seller report previewed',
  'report.gmail_draft': 'Seller report drafted in Gmail', 'ai_brief.refreshed': 'AI brief refreshed',
  'meeting.matched': 'Recording matched', 'meeting.dismissed': 'Recording dismissed',
  'dsr.target': 'DSR target', 'dsr.area_manager': 'DSR area manager', 'dsr.pm_manager': 'DSR PM manager',
  'export.visits_csv': 'Visits CSV downloaded', 'export.analytics_csv': 'Analytics CSV downloaded',
  'export.property_status_csv': 'Property Status CSV downloaded', 'export.dsr_xlsx': 'DSR Excel downloaded',
  'snapshot.text_copy': 'Snapshot text copied', 'snapshot.text_whatsapp': 'Snapshot sent to WhatsApp',
  'snapshot.image_download': 'Snapshot image downloaded', 'snapshot.image_copy': 'Snapshot image copied',
  'snapshot.image_whatsapp': 'Snapshot image to WhatsApp',
  'view_as.start': 'Started "View as"', 'view_as.stop': 'Stopped "View as"',
};
const SOURCES = [
  { k: '', label: 'All' }, { k: 'app', label: 'Team' }, { k: 'sync', label: 'System (sync)' },
  { k: 'backfill', label: 'Backfilled history' }, { k: 'script', label: 'Scripts' },
];
const actionLabel = (a) => ACTION_LABELS[a] || a;
const fieldLabel = (k) => String(k).replace(/_/g, ' ');

function fmtWhen(iso) {
  const d = new Date(iso);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', ...(sameYear ? {} : { year: 'numeric' }),
    hour: 'numeric', minute: '2-digit',
  });
}
function show(v) {
  if (v === null || v === undefined || v === '' || (Array.isArray(v) && !v.length)) return '—';
  if (Array.isArray(v)) return v.join(', ');
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

function Changes({ changes }) {
  const keys = Object.keys(changes || {});
  if (!keys.length) return null;
  return (
    <div className="al-changes">
      {keys.map((k) => (
        <div key={k} className="al-change">
          <span className="al-field">{fieldLabel(k)}</span>
          <span className="al-old">{show(changes[k]?.old)}</span>
          <span className="al-arrow">→</span>
          <span className="al-new">{show(changes[k]?.new)}</span>
        </div>
      ))}
    </div>
  );
}

function Details({ row }) {
  const d = row.details || {};
  const keys = Object.keys(d);
  const ctx = [row.ip && `IP ${row.ip}`, row.http_path].filter(Boolean).join(' · ');
  if (!keys.length && !ctx) return null;
  return (
    <div className="al-details">
      {keys.map((k) => (
        <div key={k} className="al-drow"><span className="al-dk">{fieldLabel(k)}</span><span className="al-dv">{show(d[k])}</span></div>
      ))}
      {ctx && <div className="al-drow"><span className="al-dk">request</span><span className="al-dv al-mut">{ctx}</span></div>}
      {row.user_agent && <div className="al-drow"><span className="al-dk">browser</span><span className="al-dv al-mut">{row.user_agent}</span></div>}
    </div>
  );
}

function Who({ row }) {
  if (row.actor_slug) {
    return (
      <span className="al-who">
        <b>{row.actor_name || row.actor_slug}</b>
        {row.actor_team && <span className="al-team">{row.actor_team}</span>}
        {row.details?.viewing_as && <span className="al-viewas">viewing as {row.details.viewing_as}</span>}
      </span>
    );
  }
  if (row.source === 'sync') return <span className="al-who al-sys">System · sheet sync</span>;
  if (row.action === 'auth.login_refused') return <span className="al-who al-sys">{row.details?.email || 'Unknown'}</span>;
  return <span className="al-who al-sys">{row.source || 'System'}</span>;
}

function What({ row }) {
  return (
    <span className="al-what">
      {row.object_label || row.object_id || '—'}
      {row.object_id && row.object_label && <span className="al-id">{row.object_type} {row.object_id}</span>}
    </span>
  );
}

export default function ActivityLogView() {
  const isMobile = useIsMobile();
  const [meta, setMeta] = useState({ actions: [], actors: [], sources: [] });
  const [f, setF] = useState({ actor: '', action: '', source: '', q: '', since: '', until: '' });
  const [items, setItems] = useState([]);
  const [total, setTotal] = useState(0);
  const [nextBefore, setNextBefore] = useState(null);
  const [loading, setLoading] = useState(true);
  const [more, setMore] = useState(false);
  const [err, setErr] = useState('');
  const [open, setOpen] = useState(() => new Set());
  const reqSeq = useRef(0);   // only the latest request may update the list (typing fires several)

  useEffect(() => { loadActivityMeta().then(setMeta).catch(() => {}); }, []);

  const load = useCallback(async (filters) => {
    const my = ++reqSeq.current;
    setLoading(true); setErr('');
    try {
      const d = await loadActivity({ ...filters, limit: 100 });
      if (my !== reqSeq.current) return;
      setItems(d.items); setTotal(d.total); setNextBefore(d.next_before);
    } catch (e) {
      if (my !== reqSeq.current) return;
      setItems([]); setTotal(0); setNextBefore(null); setErr(e.message || 'Failed to load');
    } finally { if (my === reqSeq.current) setLoading(false); }
  }, []);

  // debounced reload on any filter change (absorbs typing in the search box)
  useEffect(() => {
    const t = setTimeout(() => load(f), 300);
    return () => clearTimeout(t);
  }, [f, load]);

  const loadMore = async () => {
    if (!nextBefore) return;
    setMore(true);
    const my = reqSeq.current;
    try {
      const d = await loadActivity({ ...f, before: nextBefore, limit: 100 });
      if (my !== reqSeq.current) return;     // filters changed meanwhile — drop this page
      setItems((xs) => [...xs, ...d.items]); setNextBefore(d.next_before);
    } catch (e) { setErr(e.message || 'Failed to load'); }
    finally { setMore(false); }
  };
  const set = (k) => (e) => setF((p) => ({ ...p, [k]: e.target.value }));
  const toggle = (id) => setOpen((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const filtered = Object.values(f).some((v) => v);

  return (
    <div className="rx-fade al-view">
      <div className="al-sub">Every change, export and sign-in in the CRM, by the team and by the system — newest first. Entries can't be edited or deleted.</div>

      <div className="al-filters">
        <select value={f.actor} onChange={set('actor')} className="al-in">
          <option value="">Everyone</option>
          {meta.actors.map((a) => <option key={a.actor_slug} value={a.actor_slug}>{a.name || a.actor_slug} ({a.n})</option>)}
        </select>
        <select value={f.action} onChange={set('action')} className="al-in">
          <option value="">All actions</option>
          {meta.actions.map((a) => <option key={a.action} value={a.action}>{actionLabel(a.action)} ({a.n})</option>)}
        </select>
        <select value={f.source} onChange={set('source')} className="al-in">
          {SOURCES.map((s) => <option key={s.k || 'all'} value={s.k}>{s.label}</option>)}
        </select>
        <label className="al-date">From <input type="date" value={f.since} onChange={set('since')} className="al-in" /></label>
        <label className="al-date">To <input type="date" value={f.until} onChange={set('until')} className="al-in" /></label>
        <input className="al-in al-q" placeholder="Search lead, unit, CP, note, person…" value={f.q} onChange={set('q')} />
        {filtered && <button type="button" className="al-clear" onClick={() => setF({ actor: '', action: '', source: '', q: '', since: '', until: '' })}>↺ Clear</button>}
        <span className="al-total">{loading ? '…' : `${total.toLocaleString('en-IN')} entr${total === 1 ? 'y' : 'ies'}`}</span>
      </div>

      {err && <div className="al-mut" style={{ color: 'var(--bad)' }}>{err}</div>}
      {loading ? <div className="al-mut">Loading…</div> : items.length === 0 ? (
        <div className="al-mut">Nothing logged for these filters.</div>
      ) : isMobile ? (
        <div className="al-cards">
          {items.map((r) => (
            <div key={r.id} className="al-card" onClick={() => toggle(r.id)}>
              <div className="al-card-top"><span className="al-when">{fmtWhen(r.at)}</span><span className={'al-act src-' + r.source}>{actionLabel(r.action)}</span></div>
              <Who row={r} />
              <What row={r} />
              <Changes changes={r.changes} />
              {open.has(r.id) ? <Details row={r} /> : <div className="al-more-hint">Tap for details</div>}
            </div>
          ))}
        </div>
      ) : (
        <div className="al-table-wrap">
          <table className="al-table">
            <thead><tr><th>When (IST)</th><th>Who</th><th>Action</th><th>On</th><th>Change</th><th /></tr></thead>
            <tbody>
              {items.map((r) => (
                <tr key={r.id} className={open.has(r.id) ? 'on' : ''}>
                  <td className="al-when">{fmtWhen(r.at)}</td>
                  <td><Who row={r} /></td>
                  <td><span className={'al-act src-' + r.source}>{actionLabel(r.action)}</span></td>
                  <td><What row={r} /></td>
                  <td>
                    <Changes changes={r.changes} />
                    {open.has(r.id) && <Details row={r} />}
                  </td>
                  <td><button type="button" className="al-toggle" onClick={() => toggle(r.id)}>{open.has(r.id) ? 'Hide' : 'Details'}</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {!loading && nextBefore && (
        <div className="al-loadmore"><button type="button" className="btn" disabled={more} onClick={loadMore}>{more ? 'Loading…' : 'Load older entries'}</button></div>
      )}
    </div>
  );
}
