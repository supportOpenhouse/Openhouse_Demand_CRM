import { useState, useEffect, useCallback } from 'react';
import { listRecordings, matchRecording, dismissRecording } from '../api.js';
import RecordingDetail from '../components/RecordingDetail.jsx';

// Admin: every recording, with Match / Pin / Dismiss on the unmatched ones.
// Mapped RM (non-admin): a read-only list of the recordings they conducted.
const TABS = [
  { k: 'unmatched', label: 'Unmatched' },
  { k: 'matched', label: 'Auto-matched' },
  { k: 'manual', label: 'Manually matched' },
  { k: 'dismissed', label: 'Dismissed' },
];

export default function MeetingRecordingsView({ seed }) {
  const me = seed.current_user || {};
  const isAdmin = me.team === 'Admin';
  const [tab, setTab] = useState('unmatched');
  const [data, setData] = useState({ items: [], counts: {} });
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');

  const load = useCallback(async (status) => {
    setLoading(true); setErr('');
    try { setData(await listRecordings(status)); }
    catch (e) { setData({ items: [], counts: {} }); setErr(e.message || 'Failed to load'); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { load(tab); }, [tab, load]);

  const doMatch = async (rec) => {
    const cp = window.prompt('Match to CP code (broker). Leave blank to skip:', rec.broker_cp_code || rec.cp_code || '');
    if (cp === null) return;
    const vc = window.prompt('Pin to visit code (optional). Leave blank to skip:', rec.visit_code || '');
    if (vc === null) return;
    if (!cp.trim() && !vc.trim()) { window.alert('Provide a CP code and/or a visit code.'); return; }
    setBusy(rec.id);
    try { await matchRecording(rec.id, { broker_cp_code: cp.trim() || null, visit_code: vc.trim() || null }); await load(tab); }
    catch (e) { window.alert('Match failed: ' + e.message); }
    finally { setBusy(''); }
  };
  const doDismiss = async (rec) => {
    if (!window.confirm('Mark this recording as reviewed & not-matchable?')) return;
    setBusy(rec.id);
    try { await dismissRecording(rec.id); await load(tab); }
    catch (e) { window.alert('Dismiss failed: ' + e.message); }
    finally { setBusy(''); }
  };

  return (
    <div className="rx-fade rec-view">
      <div className="rec-head">
        <div className="rec-h">🎙 Meeting Recordings</div>
        <div className="rec-d">
          {isAdmin
            ? 'Read-only notes from the Meetings app, mapped to CPs and visits. Match or dismiss the unmatched ones.'
            : 'Recordings you conducted, mapped to the CP / visit.'}
        </div>
      </div>

      <div className="rec-tabs">
        {TABS.map((t) => (
          <button key={t.k} type="button" className={'rec-tabbtn' + (tab === t.k ? ' on' : '')} onClick={() => setTab(t.k)}>
            {t.label}{data.counts[t.k] != null ? ` (${data.counts[t.k]})` : ''}
          </button>
        ))}
      </div>

      {err && <div className="rec-mut" style={{ color: 'var(--bad)' }}>{err}</div>}
      {loading ? <div className="rec-mut">Loading…</div> : (
        <div className="rec-list">
          {data.items.length === 0 && <div className="rec-mut">No recordings here.</div>}
          {data.items.map((r) => (
            <div key={r.id} className="rec-card">
              <div className="rec-card-top">
                <span className={'rec-type ' + r.type}>{r.type === 'visit' ? 'Site visit' : 'Engagement'}</span>
                <span className="rec-date">{(r.date || '').slice(0, 16)}</span>
                {r.rm && <span className="rec-rm">{r.rm}</span>}
                <span className="rec-cp">{r.cp_name || r.cp_code || '—'}{r.cp_mobile ? ' · ' + r.cp_mobile : ''}</span>
                {r.broker_cp_code && <span className="rec-anchor">CP {r.broker_cp_code}</span>}
                {r.visit_code && <span className="rec-anchor">VST{String(r.visit_code).padStart(4, '0')}</span>}
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
