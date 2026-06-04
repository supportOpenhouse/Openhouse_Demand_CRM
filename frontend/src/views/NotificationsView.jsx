import { useMemo, useState } from 'react';
import { fmtDay } from '../lib/format.js';
import { usersBySlug } from '../lib/brokers.js';
import { markNotifRead, markAllNotifsRead } from '../api.js';
import { toast } from '../lib/toast.js';

const TYPE_ICON = { nudge: '🔔', assign: '📥', visit: '🏠', followup: '📝', tl_ask: '📌' };

export default function NotificationsView({ seed, onOpenBroker }) {
  const me = seed.current_user || {};
  const ubs = useMemo(() => usersBySlug(seed), [seed]);
  const visitById = useMemo(() => {
    const m = {}; (seed.visits || []).forEach((v) => { if (v.id) m[v.id] = v; });
    return m;
  }, [seed]);
  const [list, setList] = useState(() => (seed.notifications || [])
    .filter((n) => n.to === me.slug || n.to === me.id)
    .slice().sort((a, b) => (b.ts || '').localeCompare(a.ts || '')));

  const unread = list.filter((n) => !n.read).length;

  // resolve a notification's target CP (visit → its CP, or a direct cp/broker ref) → open popup
  function go(n) {
    const cp = n.refType === 'visit' ? visitById[n.refId]?.cp_code
      : (n.refType === 'cp' || n.refType === 'broker') ? n.refId : null;
    if (cp) onOpenBroker?.(cp);
  }

  async function readOne(n) {
    go(n);
    if (n.read) return;
    setList((L) => L.map((x) => (x.id === n.id ? { ...x, read: true } : x)));
    await markNotifRead(n.id);
  }
  async function readAll() {
    setList((L) => L.map((x) => ({ ...x, read: true })));
    await markAllNotifsRead();
    toast('All notifications marked read', 'good');
  }

  return (
    <div className="rx-fade">
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
        <div className="muted" style={{ fontSize: 12 }}>{list.length} notification{list.length === 1 ? '' : 's'}{unread ? ` · ${unread} unread` : ''}</div>
        {unread > 0 && <button className="btn sm" onClick={readAll}>Mark all read</button>}
      </div>
      {list.length ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {list.map((n) => {
            const from = ubs[n.from]?.name || n.from || 'System';
            return (
              <button key={n.id} onClick={() => readOne(n)}
                      style={{
                        textAlign: 'left', cursor: 'pointer', display: 'flex', gap: 12, alignItems: 'flex-start',
                        padding: '11px 14px', borderRadius: 10, border: '1px solid var(--line)',
                        background: n.read ? 'var(--panel)' : 'var(--accBg)',
                      }}>
                <span style={{ fontSize: 17 }}>{TYPE_ICON[n.type] || '•'}</span>
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ fontSize: 13, color: 'var(--txt)' }}>{n.text}</span>
                  <span className="rx-sub" style={{ display: 'block', marginTop: 2 }}>from {from} · {fmtDay(n.ts)}{n.refType ? ` · ${n.refType} ${n.refId || ''}` : ''}</span>
                </span>
                {!n.read && <span style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--acc)', marginTop: 5 }} />}
              </button>
            );
          })}
        </div>
      ) : (
        <div className="empty"><div className="emoji">🔔</div><div className="t">No notifications</div><div className="s">You're all caught up.</div></div>
      )}
    </div>
  );
}
