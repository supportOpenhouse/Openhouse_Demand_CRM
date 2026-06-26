import { useEffect, useMemo, useRef, useState } from 'react';
import { initials } from '../lib/format.js';
import { usersBySlug } from '../lib/brokers.js';
import { TEAM_PILL, TEAM_LABEL } from '../lib/legacy.js';
import { toast } from '../lib/toast.js';
import { apiFetch } from '../api.js';
import useIsMobile from '../lib/useIsMobile.js';
import UserModal from '../components/UserModal.jsx';

const TEAM_ORDER = ['Admin', 'TL', 'KAM', 'Ground', 'Report'];

function notifIcon(type) {
  return { nudge: '🔔', nudge_resolved: '✅', message: '📣', task: '📌', assign: '📥' }[type] || '💬';
}
function timeAgo(ts) {
  const d = new Date(ts);
  if (isNaN(d)) return ts;
  const diffMin = Math.round((Date.now() - d) / 60000);
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return diffMin + 'm';
  if (diffMin < 60 * 24) return Math.round(diffMin / 60) + 'h';
  return Math.round(diffMin / (60 * 24)) + 'd';
}

// Searchable dropdown matching the legacy makeSearchSelect (.ss-* classes).
function SearchSelect({ placeholder, options, value, onChange }) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);

  useEffect(() => {
    const onDoc = (e) => { if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  const ql = q.toLowerCase();
  const filtered = options
    .filter((o) => !ql || (o.label || '').toLowerCase().includes(ql) || (o.sub || '').toLowerCase().includes(ql))
    .slice(0, 100);

  const hilite = (text) => {
    if (!q || !text) return text;
    const i = text.toLowerCase().indexOf(ql);
    if (i < 0) return text;
    return (<>{text.slice(0, i)}<mark>{text.slice(i, i + q.length)}</mark>{text.slice(i + q.length)}</>);
  };

  const pick = (o) => { onChange(o.value); setQ(o.label); setOpen(false); };

  return (
    <div className={`ss-wrap ${open ? 'open' : ''}`} ref={wrapRef}>
      <input
        className={`ss-input ${q ? 'has-val' : ''}`}
        placeholder={placeholder}
        value={q}
        onFocus={(e) => { e.target.select(); setOpen(true); }}
        onChange={(e) => { setQ(e.target.value); setOpen(true); if (!e.target.value) onChange(''); }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && filtered.length) { e.preventDefault(); pick(filtered[0]); }
          else if (e.key === 'Escape') setOpen(false);
        }}
      />
      {q && <span className="ss-clear" onClick={() => { setQ(''); onChange(''); }}>✕</span>}
      <span className="ss-caret">▼</span>
      <div className="ss-list">
        {filtered.length ? filtered.map((o) => (
          <div
            key={o.value}
            className={`ss-opt ${o.value === value ? 'active' : ''}`}
            onMouseDown={(e) => { e.preventDefault(); pick(o); }}
          >
            {hilite(o.label)}
            {o.sub && <div className="meta">{o.sub}</div>}
          </div>
        )) : <div className="ss-empty">No matches</div>}
      </div>
    </div>
  );
}

export default function TeamView({ seed, onOpenBroker, reloadSeed }) {
  const me = seed.current_user || {};
  const isAdm = me.team === 'Admin' || me.role === 'admin';
  const isTL = me.team === 'TL';
  const canEdit = isAdm || isTL;
  const isMobile = useIsMobile();

  const users = seed.users || [];
  const ubs = useMemo(() => usersBySlug(seed), [seed]);
  const cpOwner = seed.cp_owner || {};
  const brokers = seed.brokers || [];
  const brokersByCode = useMemo(() => {
    const m = {}; brokers.forEach((b) => { m[b.cp_code] = b; }); return m;
  }, [brokers]);

  // Local optimistic copy of team tasks so pin/unpin/message edits reflect instantly.
  const [tasks, setTasks] = useState(() => structuredClone(seed.team_tasks || {}));
  useEffect(() => { setTasks(structuredClone(seed.team_tasks || {})); }, [seed]);

  const [selectedId, setSelectedId] = useState(me.slug);
  const [modal, setModal] = useState(null);          // { mode:'create'|'edit', user? }
  const [pickCp, setPickCp] = useState('');          // daily CP picker value
  const [msgText, setMsgText] = useState('');
  const [msgPriority, setMsgPriority] = useState('normal');

  const notifsFor = (slug) => (seed.notifications || []).filter((n) => n.to === slug);
  const brokersForOwner = (slug) => brokers.filter((b) => cpOwner[b.cp_code] === slug);

  // ---------------- My Day (non-admin / non-TL): the CPs you own ----------------
  if (!canEdit) {
    const m = ubs[me.slug] || me;
    const tt = tasks[me.slug] || {};
    const dailyCps = (tt.daily_calls || []).map((cp) => brokersByCode[cp]).filter(Boolean);
    const myCps = brokersForOwner(me.slug);
    const firstName = (m.name || '').split(' ')[0];
    return (
      <div className="rx-fade">
        <div className="list-head">
          <span>My Day</span>
        </div>
        <div className="team-detail">
          <div className="td-head">
            <div className="avatar lg">{initials(m.name)}</div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="name">{m.name}</div>
              <div className="sub">{m.email} · {(m.cities || []).join(', ')}</div>
              <div style={{ marginTop: 6 }}>
                <span className={`role-pill ${TEAM_PILL[m.team] || ''}`}>{m.team}</span>
                <span style={{ fontSize: 11, color: 'var(--mut)', marginLeft: 6 }}>{m.role}</span>
              </div>
            </div>
          </div>

          <div className="team-section">
            <h4 style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              Daily call list
              <span style={{ fontWeight: 500, color: 'var(--mut)', textTransform: 'none', letterSpacing: 0 }}>CPs {firstName} should contact today</span>
            </h4>
            {dailyCps.length ? (
              <div className="daily-list">
                {dailyCps.map((b) => (
                  <div className="daily-item" key={b.cp_code} style={{ cursor: 'pointer' }} onClick={() => onOpenBroker?.(b.cp_code)}>
                    <div className="avatar sm">{initials(b.name)}</div>
                    <div className="di-meta">
                      <div className="di-name">{b.name} <span className={`tier-badge ${b.tier || 'T4'}`} style={{ fontSize: '9.5px', marginLeft: 4 }}>{b.tier || 'T4'}</span></div>
                      <div className="di-sub">{b.company_name || ''} · {b.phone_number}</div>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="muted" style={{ fontSize: '12.5px', fontStyle: 'italic', padding: '6px 0' }}>No daily list set. Following standard flow.</div>
            )}
          </div>

          <div className="team-section">
            <h4>Your channel partners <span style={{ fontWeight: 500, color: 'var(--mut)', textTransform: 'none', letterSpacing: 0 }}>{myCps.length} owned</span></h4>
            {myCps.length ? (
              <div className="daily-list">
                {myCps.map((b) => (
                  <div className="daily-item" key={b.cp_code} style={{ cursor: 'pointer' }} onClick={() => onOpenBroker?.(b.cp_code)}>
                    <div className="avatar sm">{initials(b.name)}</div>
                    <div className="di-meta">
                      <div className="di-name">{b.name} <span className={`tier-badge ${b.tier || 'T4'}`} style={{ fontSize: '9.5px', marginLeft: 4 }}>{b.tier || 'T4'}</span></div>
                      <div className="di-sub">{b.company_name || ''} · {b.phone_number}</div>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="muted" style={{ fontSize: '12.5px', fontStyle: 'italic', padding: '6px 0' }}>No CPs assigned to you yet.</div>
            )}
          </div>

          <div className="team-section">
            <h4>Recent notifications received</h4>
            <div className="notif-list" style={{ maxHeight: 240, overflowY: 'auto' }}>
              {notifsFor(me.slug).slice(0, 8).map((n) => {
                const from = n.from ? ubs[n.from] : null;
                return (
                  <div className={`notif ${n.type} ${n.read ? '' : 'unread'}`} key={n.id}>
                    <div className="notif-ic">{notifIcon(n.type)}</div>
                    <div className="notif-body">
                      <div className="notif-head"><span className="notif-from">{from ? from.name : 'System'}</span><span className="notif-ts">{timeAgo(n.ts)}</span></div>
                      <div className="notif-text">{n.text || ''}</div>
                    </div>
                  </div>
                );
              })}
              {!notifsFor(me.slug).length && <div className="muted" style={{ fontSize: 12 }}>No notifications</div>}
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ---------------- Team & Assignments (Admin / TL): roster + detail ----------------
  const sections = TEAM_ORDER
    .map((sec) => ({ sec, members: users.filter((u) => u.team === sec) }))
    .filter((g) => g.members.length);

  const selected = ubs[selectedId] || ubs[me.slug];

  // ---- daily list operations (optimistic local, fire-and-forget server) ----
  function removeDailyCp(slug, cp) {
    setTasks((T) => {
      const next = structuredClone(T);
      const tt = next[slug] || { daily_calls: [], messages: [] };
      tt.daily_calls = (tt.daily_calls || []).filter((c) => c !== cp);
      next[slug] = tt;
      return next;
    });
    apiFetch('/api/daily_tasks/unpin', { method: 'POST', body: JSON.stringify({ user_slug: slug, cp_code: cp }) }).catch(() => {});
  }

  async function addDailyCp(slug) {
    const cp = pickCp;
    if (!cp) { toast('Pick a CP first', 'bad'); return; }
    try {
      const r = await apiFetch('/api/daily_tasks/pin', { method: 'POST', body: JSON.stringify({ user_slug: slug, cp_code: cp }) });
      if (!r.ok) { const t = await r.text(); toast(`Pin failed: ${t.slice(0, 120)}`, 'bad'); return; }
      setTasks((T) => {
        const next = structuredClone(T);
        const tt = next[slug] || { daily_calls: [], messages: [] };
        if (!(tt.daily_calls || []).includes(cp)) tt.daily_calls = [...(tt.daily_calls || []), cp];
        next[slug] = tt;
        return next;
      });
      setPickCp('');
      toast('Added to daily list', 'good');
    } catch (e) {
      toast(`Network error: ${e.message}`, 'bad');
    }
  }

  function sendMessage(slug) {
    const text = msgText.trim();
    if (!text) { toast('Type a message first', 'bad'); return; }
    setTasks((T) => {
      const next = structuredClone(T);
      const tt = next[slug] || { daily_calls: [], messages: [] };
      tt.messages = [{ id: 'TM' + Date.now(), from: me.slug, text, ts: new Date().toISOString(), priority: msgPriority }, ...(tt.messages || [])];
      next[slug] = tt;
      return next;
    });
    setMsgText('');
    toast(`Message sent to ${(selected.name || '').split(' ')[0]}`, 'good');
  }

  function broadcast() {
    const text = msgText.trim();
    if (!text) { toast('Type a message first', 'bad'); return; }
    const recipients = users.filter((u) => u.team === 'KAM' || u.team === 'Ground' || u.team === 'TL');
    setTasks((T) => {
      const next = structuredClone(T);
      recipients.forEach((u) => {
        const tt = next[u.slug] || { daily_calls: [], messages: [] };
        tt.messages = [{ id: 'TM' + Date.now() + u.slug, from: me.slug, text, ts: new Date().toISOString(), priority: msgPriority }, ...(tt.messages || [])];
        next[u.slug] = tt;
      });
      return next;
    });
    setMsgText('');
    toast('Broadcast sent', 'good');
  }

  // ---- detail panel for the selected member ----
  function renderDetail() {
    const m = selected;
    if (!m) return <div className="muted">Pick a team member</div>;
    const tt = tasks[m.slug] || {};
    const dailyCps = (tt.daily_calls || []).map((cp) => brokersByCode[cp]).filter(Boolean);
    const messages = tt.messages || [];
    const firstName = (m.name || '').split(' ')[0];
    const myCps = brokersForOwner(m.slug);
    const pickerOptions = myCps
      .filter((b) => !(tt.daily_calls || []).includes(b.cp_code))
      .map((b) => ({ value: b.cp_code, label: b.name, sub: `${b.cp_code} · ${b.tier || 'T4'} · ${b.company_name || ''}` }));

    return (
      <>
        {/* (A) header */}
        <div className="td-head">
          <div className="avatar lg">{initials(m.name)}</div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="name">{m.name}</div>
            <div className="sub">{m.email} · {(m.cities || []).join(', ')}</div>
            <div style={{ marginTop: 6 }}>
              <span className={`role-pill ${TEAM_PILL[m.team] || ''}`}>{m.team}</span>
              <span style={{ fontSize: 11, color: 'var(--mut)', marginLeft: 6 }}>{m.role}</span>
            </div>
          </div>
          {isAdm && <button className="btn sm" onClick={() => setModal({ mode: 'edit', user: m })}>Edit role / cities</button>}
        </div>

        {/* (B) daily call list */}
        <div className="team-section">
          <h4 style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            Daily call list
            <span style={{ fontWeight: 500, color: 'var(--mut)', textTransform: 'none', letterSpacing: 0 }}>CPs {firstName} should contact today</span>
          </h4>
          {dailyCps.length ? (
            <div className="daily-list">
              {dailyCps.map((b) => (
                <div className="daily-item" key={b.cp_code}>
                  <div className="avatar sm">{initials(b.name)}</div>
                  <div className="di-meta" style={{ cursor: 'pointer' }} onClick={() => onOpenBroker?.(b.cp_code)}>
                    <div className="di-name">{b.name} <span className={`tier-badge ${b.tier || 'T4'}`} style={{ fontSize: '9.5px', marginLeft: 4 }}>{b.tier || 'T4'}</span></div>
                    <div className="di-sub">{b.company_name || ''} · {b.phone_number}</div>
                  </div>
                  {canEdit && <button className="di-rem" title="Remove" onClick={() => removeDailyCp(m.slug, b.cp_code)}>✕</button>}
                </div>
              ))}
            </div>
          ) : (
            <div className="muted" style={{ fontSize: '12.5px', fontStyle: 'italic', padding: '6px 0' }}>
              No daily list set. {canEdit ? "Add CPs below to define today’s priorities." : 'Following standard flow.'}
            </div>
          )}
          {canEdit && (
            <div style={{ marginTop: 10, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <div style={{ flex: 1, minWidth: 200 }}>
                <SearchSelect placeholder="Find CP to assign…" options={pickerOptions} value={pickCp} onChange={setPickCp} />
              </div>
              <button className="btn primary sm" onClick={() => addDailyCp(m.slug)}>+ Add to list</button>
            </div>
          )}
        </div>

        {/* (C) messages & goals */}
        <div className="team-section">
          <h4 style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            Messages & goals
            <span style={{ fontWeight: 500, color: 'var(--mut)', textTransform: 'none', letterSpacing: 0 }}>{messages.length} active</span>
          </h4>
          {messages.length ? messages.map((msg) => (
            <div className={`msg-item ${msg.priority === 'high' ? 'priority' : ''}`} key={msg.id}>
              <div className="mi-head"><span className="mi-from">{(ubs[msg.from] || {}).name || 'System'}</span><span>{timeAgo(msg.ts)}</span></div>
              <div className="mi-text">{msg.text || ''}</div>
            </div>
          )) : (
            <div className="muted" style={{ fontSize: '12.5px', fontStyle: 'italic', padding: '6px 0' }}>No specific messages — {firstName} follows standard flow.</div>
          )}
          {canEdit && (
            <div style={{ marginTop: 10, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <input
                type="text"
                placeholder={`Send a goal or message to ${firstName}…`}
                value={msgText}
                onChange={(e) => setMsgText(e.target.value)}
                style={{ flex: 1, minWidth: 200, padding: '8px 11px', border: '1px solid var(--line)', borderRadius: 7, fontSize: 13, background: 'var(--panel)', outline: 'none' }}
              />
              <select
                value={msgPriority}
                onChange={(e) => setMsgPriority(e.target.value)}
                style={{ padding: '8px 11px', border: '1px solid var(--line)', borderRadius: 7, background: 'var(--panel)', fontSize: '12.5px' }}
              >
                <option value="normal">Normal</option>
                <option value="high">High priority</option>
              </select>
              <button className="btn primary sm" onClick={() => sendMessage(m.slug)}>Send</button>
              {isAdm && <button className="btn sm" onClick={broadcast}>Broadcast to all</button>}
            </div>
          )}
        </div>

        {/* (D) recent notifications received */}
        <div className="team-section">
          <h4>Recent notifications received</h4>
          <div className="notif-list" style={{ maxHeight: 240, overflowY: 'auto' }}>
            {notifsFor(m.slug).slice(0, 8).map((n) => {
              const from = n.from ? ubs[n.from] : null;
              return (
                <div className={`notif ${n.type} ${n.read ? '' : 'unread'}`} key={n.id}>
                  <div className="notif-ic">{notifIcon(n.type)}</div>
                  <div className="notif-body">
                    <div className="notif-head"><span className="notif-from">{from ? from.name : 'System'}</span><span className="notif-ts">{timeAgo(n.ts)}</span></div>
                    <div className="notif-text">{n.text || ''}</div>
                  </div>
                </div>
              );
            })}
            {!notifsFor(m.slug).length && <div className="muted" style={{ fontSize: 12 }}>No notifications</div>}
          </div>
        </div>
      </>
    );
  }

  return (
    <div className="rx-fade">
      <div className="list-head">
        <span>{`${users.length} team members`}</span>
        <div className="pager">
          {isAdm && <button className="btn sm primary" onClick={() => setModal({ mode: 'create' })}>＋ Add member</button>}
        </div>
      </div>

      <div className="team-layout" style={isMobile ? { gridTemplateColumns: '1fr', gap: 10 } : undefined}>
        <div className="team-sidebar" style={isMobile ? { maxHeight: 'none' } : undefined}>
          {sections.map((g) => (
            <div className="team-sec" key={g.sec}>
              <h4>{TEAM_LABEL[g.sec]} <span className="ct">{g.members.length}</span></h4>
              {g.members.map((mm) => {
                const tasksCount = (tasks[mm.slug]?.daily_calls || []).length;
                return (
                  <div
                    key={mm.slug}
                    className={`team-row ${selectedId === mm.slug ? 'on' : ''}`}
                    onClick={() => { setSelectedId(mm.slug); setPickCp(''); }}
                  >
                    <div className="avatar md">{initials(mm.name)}</div>
                    <div className="tr-meta">
                      <div className="tr-name">{mm.name}</div>
                      <div className="tr-sub">{(mm.cities || []).join(', ')}</div>
                    </div>
                    {tasksCount > 0 && <span className="tr-bdg">{tasksCount}</span>}
                  </div>
                );
              })}
            </div>
          ))}
        </div>

        <div className="team-detail" id="teamDetail">{renderDetail()}</div>
      </div>

      {modal && (
        <UserModal
          mode={modal.mode}
          user={modal.user}
          seed={seed}
          onClose={() => setModal(null)}
          onSaved={reloadSeed}
        />
      )}
    </div>
  );
}
