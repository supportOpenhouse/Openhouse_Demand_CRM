import { useState } from 'react';
import { fetchMeetingSummary } from '../api.js';
import { digestRows, recLabel } from '../lib/recordings.js';

// One recording rendered as an expandable 🎙 chip. The structured summary is
// lazy-fetched on first expand (kept out of the seed to keep it light). Purely
// read-only; never mutates anything.
export default function RecordingDetail({ rec, anchorNote }) {
  const [open, setOpen] = useState(false);
  const [st, setSt] = useState({ loading: false, rows: null, err: null });

  const toggle = async () => {
    const next = !open;
    setOpen(next);
    if (next && st.rows == null && !st.loading) {
      setSt({ loading: true, rows: null, err: null });
      try {
        const r = await fetchMeetingSummary(rec.id);
        setSt({ loading: false, rows: digestRows(r.digest), err: null });
      } catch {
        setSt({ loading: false, rows: null, err: 'Could not load summary' });
      }
    }
  };

  return (
    <div className="rec-item">
      <button type="button" className="rec-chip" onClick={toggle} aria-expanded={open}>
        <span className="rec-mic">🎙</span> {recLabel(rec)}
        {anchorNote ? <span className="rec-anchornote"> · {anchorNote}</span> : null}
        <span className="rec-exp">{open ? '▴' : '▾'}</span>
      </button>
      {open && (
        <div className="rec-body">
          {st.loading && <div className="rec-mut">Loading summary…</div>}
          {st.err && <div className="rec-mut">{st.err}</div>}
          {st.rows && st.rows.length === 0 && <div className="rec-mut">No structured summary captured.</div>}
          {st.rows && st.rows.map(([k, v], i) => (
            <div key={i} className="rec-row">
              <span className="rec-k">{k}</span>
              <span className="rec-v">{v}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
