import { useState } from 'react';

// Mobile-only bottom tab bar (rendered for every viewport but hidden by CSS >900px).
// Shows the first 4 nav items as primary tabs + a "More" bottom-sheet for the rest.
// Pure presentation over the existing nav/view state — no data or business logic.
const SHORT = {
  home: 'Home', visits: 'Visits', cps: 'Partners', properties: 'Property',
  analytics: 'Analytics', snapshot: 'Inventory', team: 'My Day', notifications: 'Alerts',
  book: 'Book Visit',
};

// Mobile bottom-bar primary tabs, in order. Book Visits is promoted into the bar (in
// place of AI Suggestions, which moves into the "More" sheet) — every other view, incl.
// AI, stays reachable via More. Keys absent from `nav` are skipped; anything not listed
// here drops to More in its original nav order. Desktop is unaffected: the sidebar
// (App.jsx) renders `nav` directly and this whole bar is CSS-hidden above 900px.
const PRIMARY_KEYS = ['home', 'book', 'visits', 'cps'];

export default function BottomTabBar({ nav, view, setView, unread = 0 }) {
  const [moreOpen, setMoreOpen] = useState(false);
  const items = Array.isArray(nav) ? nav : [];
  const byKey = Object.fromEntries(items.map((n) => [n.k, n]));
  const primary = PRIMARY_KEYS.map((k) => byKey[k]).filter(Boolean);
  const primaryK = new Set(primary.map((n) => n.k));
  const more = items.filter((n) => !primaryK.has(n.k));
  const moreActive = more.some((n) => n.k === view);
  const moreBadge = more.some((n) => n.k === 'notifications') && unread > 0;
  const go = (k) => { setMoreOpen(false); setView(k); };
  const label = (n) => SHORT[n.k] || (n.label || '').split(' ')[0];

  return (
    <>
      {moreOpen && (
        <>
          <div className="rx-tab-sheet-backdrop" onClick={() => setMoreOpen(false)} />
          <nav className="rx-tab-sheet" aria-label="More views">
            <div className="rx-tab-sheet-grip" />
            {more.map((n) => (
              <button key={n.k} type="button"
                      className={'rx-tab-sheet-item' + (view === n.k ? ' on' : '')}
                      onClick={() => go(n.k)}>
                <span className="rx-tab-ic">{n.icon}</span>
                <span className="rx-tab-sheet-lbl">{n.label}</span>
                {n.k === 'notifications' && unread > 0 && <span className="rx-badge">{unread}</span>}
              </button>
            ))}
          </nav>
        </>
      )}
      <nav className="rx-tabbar" aria-label="Primary navigation">
        {primary.map((n) => (
          <button key={n.k} type="button"
                  className={'rx-tab' + (view === n.k ? ' on' : '')}
                  aria-current={view === n.k ? 'page' : undefined}
                  onClick={() => go(n.k)}>
            <span className="rx-tab-ic">{n.icon}{n.k === 'notifications' && unread > 0 && <span className="rx-tab-dot" />}</span>
            <span className="rx-tab-lbl">{label(n)}</span>
          </button>
        ))}
        {more.length > 0 && (
          <button type="button"
                  className={'rx-tab' + (moreActive ? ' on' : '')}
                  aria-haspopup="menu" aria-expanded={moreOpen}
                  onClick={() => setMoreOpen((o) => !o)}>
            <span className="rx-tab-ic">⋯{moreBadge && <span className="rx-tab-dot" />}</span>
            <span className="rx-tab-lbl">More</span>
          </button>
        )}
      </nav>
    </>
  );
}
