import { useMemo, useState } from 'react';
import { usersBySlug } from '../lib/brokers.js';
import { TEAM_PILL } from '../lib/legacy.js';
import { markNotifRead, markAllNotifsRead } from '../api.js';
import { toast } from '../lib/toast.js';

// emoji per notification type (legacy notifIcon)
function notifIcon(type) {
  return { nudge: '🔔', nudge_resolved: '✅', message: '📣', task: '📌', assign: '📥' }[type] || '💬';
}

// relative time string (legacy timeAgo): just now / Nm / Nh / Nd
function timeAgo(ts) {
  const d = new Date(ts);
  if (isNaN(d)) return ts;
  const diffMin = Math.round((Date.now() - d) / 60000);
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return diffMin + 'm';
  if (diffMin < 60 * 24) return Math.round(diffMin / 60) + 'h';
  return Math.round(diffMin / (60 * 24)) + 'd';
}

export default function NotificationsView({ seed, onOpenBroker }) {
  const me = seed.current_user || {};
  const ubs = useMemo(() => usersBySlug(seed), [seed]);
  // notifications addressed to the current user, newest-first (seed already orders by created_at DESC)
  const visitById = useMemo(() => {
    const m = {};
    (seed.visits || []).forEach((v) => { if (v.id != null) m[String(v.id)] = v; if (v.visit_code) m[String(v.visit_code)] = v; });
    return m;
  }, [seed]);

  const initial = useMemo(() => (seed.notifications || [])
    .filter((n) => n.to === me.slug), [seed, me.slug]);
  const [list, setList] = useState(initial);

  const unread = list.filter((n) => !n.read).length;

  // routing on click: open the linked visit's broker drawer (deep-link), else no-op for team route here
  function route(n) {
    if (n.action === 'open_visit' && n.refType === 'visit') {
      const v = visitById[String(n.refId)];
      if (v) onOpenBroker?.(v.cp_code, v.id);
    }
    // legacy 'open_team' routes to the Team view via setView — no analog in this isolated view.
  }

  async function readOne(n) {
    // mark read locally (drops .unread + dot) then route, fire-and-forget POST
    if (!n.read) {
      setList((L) => L.map((x) => (x.id === n.id ? { ...x, read: true } : x)));
      markNotifRead(n.id);
    }
    route(n);
  }

  async function readAll() {
    setList((L) => L.map((x) => ({ ...x, read: true })));
    await markAllNotifsRead();
    toast('All marked as read', 'good');
  }

  return (
    <div className="rx-fade">
      <div className="list-head">
        <span>{`${list.length} notifications${unread ? ` · ${unread} unread` : ''}`}</span>
        <div className="pager"><button className="btn sm" onClick={readAll}>Mark all read</button></div>
      </div>

      {list.length ? (
        <div className="notif-list">
          {list.map((n) => {
            const from = n.from ? ubs[n.from] : null;
            return (
              <div
                key={n.id}
                className={`notif ${n.type} ${n.read ? '' : 'unread'}`}
                onClick={() => readOne(n)}
              >
                <div className="notif-ic">{notifIcon(n.type)}</div>
                <div className="notif-body">
                  <div className="notif-head">
                    <span className="notif-from">
                      {from ? from.name : 'System'}
                      {from && (
                        <span className={`role-pill ${TEAM_PILL[from.team] || ''}`} style={{ marginLeft: 4 }}>{from.team || ''}</span>
                      )}
                    </span>
                    <span className="notif-ts">
                      {timeAgo(n.ts)}
                      {!n.read && <span className="notif-dot" />}
                    </span>
                  </div>
                  <div className="notif-text">{n.text || ''}</div>
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="empty"><div className="emoji">🔔</div><div className="t">No notifications</div></div>
      )}
    </div>
  );
}
