import { useState, useEffect, useCallback } from 'react';
import { listRecordings, matchRecording, dismissRecording } from '../api.js';
import RecordingDetail from '../components/RecordingDetail.jsx';

// Admin: every recording, with Match / Pin / Dismiss on the unmatched ones.
// Mapped RM (non-admin): a read-only list of the recordings they conducted.
const TABS = [
  { k: '', label: 'All' },
  { k: 'unmatched', label: 'Unmatched' },
  { k: 'matched', label: 'Auto-matched' },
  { k: 'manual', label: 'Manually matched' },
  { k: 'dismissed', label: 'Dismissed' },
];
const TYPES = [
  { k: '', label: 'All types' },
  { k: 'engagement', label: 'Engagement' },
  { k: 'visit', label: 'Site visit' },
];

export default function MeetingRecordingsView({ seed }) {
  const me = seed.current_user || {};
  const isAdmin = me.team === 'Admin';
  const [status, setStatus] = useState('');     // '' = All (default — shows every recording)
  const [mtype, setMtype] = useState('');
  const [cp, setCp] = useState('');
  const [rm, setRm] = useState('');
  const [data, setData] = useState({ items: [], counts: {}, total: 0, limit: 500 });
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');

  const load = useCallback(async (params) => {
    setLoading(true); setErr('');
    try { setData(await listRecordings(params)); }
    catch (e) { setData({ items: [], counts: {}, total: 0, limit: 500 }); setErr(e.message || 'Failed to load'); }
    finally { setLoading(false); }
  }, []);

  // Debounced reload on any filter change (250ms absorbs CP/RM typing).
  useEffect(() => {
    const t = setTimeout(() => load({ status, mtype, cp, rm }), 250);
    return () => clearTimeout(t);
  }, [status, mtype, cp, rm, load]);

  const allCount = Object.values(data.counts || {}).reduce((a, b) => a + b, 0);
  const tabCount = (k) => (k === '' ? allCount : (data.counts?.[k] ?? 0));
  const capped = data.total > (data.items?.length || 0);

  const reload = () => load({ status, mtype, cp, rm });
  const doMatch = async (rec) => {
    const cpv = window.prompt('Match to CP code (broker). Leave blank to skip:', rec.broker_cp_code || rec.cp_code || '');
    if (cpv === null) return;
    const vc = window.prompt('Pin to visit code (optional). Leave blank to skip:', rec.visit_code || '');
    if (vc === null) return;
    if (!cpv.trim() && !vc.trim()) { window.alert('Provide a CP code and/or a visit code.'); return; }
    setBusy(rec.id);
    try { await matchRecording(rec.id, { broker_cp_code: cpv.trim() || null, visit_code: vc.trim() || null }); await reload(); }
    catch (e) { window.alert('Match failed: ' + e.message); }
    finally { setBusy(''); }
  };
  const doDismiss = async (rec) => {
    if (!window.confirm('Mark this recording as reviewed & not-matchable?')) return;
    setBusy(rec.id);
    try { await dismissRecording(rec.id); await reload(); }
    catch (e) { window.alert('Dismiss failed: ' + e.message); }
    finally { setBusy(''); }
  };
  const resetFilters = () => { setStatus(''); setMtype(''); setCp(''); setRm(''); };
  const filtered = status || mtype || cp.trim() || rm.trim();

  return (
    <div className="rx-fade rec-view">
      <div className="rec-head">
        <div className="rec-h">🎙 Meeting Recordings</div>
        <div className="rec-d">
          {isAdmin
            ? 'Read-only notes from the Meetings app, mapped to CPs and visits. Filter, then match or dismiss the unmatched ones.'
            : 'Recordings you conducted, mapped to the CP / visit.'}
        </div>
      </div>

      {/* status tabs (with live counts) */}
      <div className="rec-tabs">
        {TABS.map((t) => (
          <button key={t.k || 'all'} type="button" className={'rec-tabbtn' + (status === t.k ? ' on' : '')} onClick={() => setStatus(t.k)}>
            {t.label} ({tabCount(t.k)})
          </button>
        ))}
      </div>

      {/* type + CP + RM filters */}
      <div className="rec-filters">
        <div className="rec-typechips">
          {TYPES.map((t) => (
            <button key={t.k || 'allt'} type="button" className={'rec-chipbtn' + (mtype === t.k ? ' on' : '')} onClick={() => setMtype(t.k)}>{t.label}</button>
          ))}
        </div>
        <input className="rec-in" placeholder="CP code or name…" value={cp} onChange={(e) => setCp(e.target.value)} />
        <input className="rec-in" placeholder="RM name…" value={rm} onChange={(e) => setRm(e.target.value)} />
        {filtered ? <button type="button" className="rec-clear" onClick={resetFilters}>↺ Clear</button> : null}
        <span className="rec-total">{loading ? '…' : `${data.total} recording${data.total === 1 ? '' : 's'}`}{capped ? ` · showing first ${data.items.length}` : ''}</span>
      </div>

      {err && <div className="rec-mut" style={{ color: 'var(--bad)' }}>{err}</div>}
      {loading ? <div className="rec-mut">Loading…</div> : (
        <div className="rec-list">
          {data.items.length === 0 && <div className="rec-mut">No recordings match these filters.</div>}
          {data.items.map((r) => (
            <div key={r.id} className="rec-card">
              <div className="rec-card-top">
                <span className={'rec-type ' + r.type}>{r.type === 'visit' ? 'Site visit' : 'Engagement'}</span>
                <span className="rec-date">{(r.date || '').slice(0, 16)}</span>
                {r.rm && <span className="rec-rm">{r.rm}</span>}
                <span className="rec-cp">{r.cp_name || r.cp_code || '—'}{r.cp_mobile ? ' · ' + r.cp_mobile : ''}</span>
                {r.broker_cp_code && <span className="rec-anchor">CP {r.broker_cp_code}</span>}
                {r.visit_code && <span className="rec-anchor">VST{String(r.visit_code).padStart(4, '0')}</span>}
                <span className={'rec-status ' + r.match_status}>{r.match_status}</span>
                {r.match_method && <span className="rec-method">{r.match_method}</span>}
                {isAdmin && (
                  <span className="rec-actions">
                    <button type="button" disabled={busy === r.id} onClick={() => doMatch(r)}>Match / Pin</button>
                    {r.match_status !== 'dismissed' && (
                      <button type="button" disabled={busy === r.id} onClick={() => doDismiss(r)}>Dismiss</button>
                    )}
                  </span>
                )}
              </div>
              <RecordingDetail rec={r} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
