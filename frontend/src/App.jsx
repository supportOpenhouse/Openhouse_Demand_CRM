import { useEffect, useState } from 'react';
import { loadSeed } from './api.js';
import Toast from './components/Toast.jsx';
import AppSkeleton from './components/AppSkeleton.jsx';
import Logo from './components/Logo.jsx';
import VisitsView from './views/VisitsView.jsx';
import CpView from './views/CpView.jsx';
import PropertiesView from './views/PropertiesView.jsx';
import NotificationsView from './views/NotificationsView.jsx';
import QueueView from './views/QueueView.jsx';
import SnapshotView from './views/SnapshotView.jsx';
import TeamView from './views/TeamView.jsx';
import BrokerModal from './components/BrokerModal.jsx';
import ErrorBoundary from './components/ErrorBoundary.jsx';

const NAV = [
  { k: 'visits',        icon: '📋', label: 'Visits' },
  { k: 'cps',           icon: '🤝', label: 'Channel Partners' },
  { k: 'properties',    icon: '🏠', label: 'Properties' },
  { k: 'queue',         icon: '📥', label: 'To Be Assigned', adm: true },
  { k: 'snapshot',      icon: '📤', label: 'Inventory Snapshot' },
  { k: 'team',          icon: '👤', label: 'My Day' },
  { k: 'notifications', icon: '🔔', label: 'Notifications' },
];

function initials(name = '') {
  return name.trim().split(/\s+/).slice(0, 2).map((w) => w[0] || '').join('').toUpperCase() || '?';
}

export default function App() {
  const [seed, setSeed] = useState(null);
  const [error, setError] = useState(null);
  const [view, setView] = useState('visits');
  const [openCp, setOpenCp] = useState(null);   // broker popup, openable from any view
  const [busy, setBusy] = useState(false);       // re-fetch in flight → top progress bar
  const [navCollapsed, setNavCollapsed] = useState(() => {
    try { return localStorage.getItem('rx-nav-collapsed') === '1'; } catch { return false; }
  });
  useEffect(() => { try { localStorage.setItem('rx-nav-collapsed', navCollapsed ? '1' : '0'); } catch { /* ignore */ } }, [navCollapsed]);

  useEffect(() => {
    let alive = true;
    loadSeed().then((d) => alive && setSeed(d)).catch((e) => alive && setError(e.message));
    return () => { alive = false; };
  }, []);

  // Re-fetch after a write so every view reflects the change (correct over optimistic drift).
  // A thin top bar shows the refresh is happening without blanking the screen.
  const reloadSeed = async () => {
    setBusy(true);
    try { setSeed(await loadSeed()); } catch { /* keep current */ }
    finally { setBusy(false); }
  };

  if (error && !seed) {
    return (
      <>
        <Toast />
        <div className="rx-loader">
          <div className="empty">
            <div className="emoji">⚠️</div>
            <div className="t">Couldn’t load the CRM</div>
            <div className="s">{error}</div>
          </div>
        </div>
      </>
    );
  }
  if (!seed) return (<><Toast /><AppSkeleton /></>);

  const me = seed.current_user || {};   // real signed-in user — no hardcoded default (#2)
  const isAdmTL = me.team === 'Admin' || me.team === 'TL' || me.role === 'admin' || (me.role || '').includes('tl');
  const nav = NAV.filter((n) => !n.adm || isAdmTL)
    .map((n) => (n.k === 'team' ? { ...n, label: isAdmTL ? 'Team & Assignments' : 'My Day' } : n));
  const unread = (seed.notifications || []).filter((n) => (n.to === me.slug || n.to === me.id) && !n.read).length;
  const counts = {
    visits: (seed.visits || []).length,
    cps: (seed.brokers || []).length,
    properties: (seed.properties || []).length,
  };
  const active = nav.find((n) => n.k === view) || nav[0];

  return (
    <>
      <Toast />
      <div className="rx-shell">
        {busy && <div className="rx-progress" aria-hidden="true" />}
        <header className="rx-topbar">
          <div className="rx-topbar-left">
            <button className="rx-navtoggle" onClick={() => setNavCollapsed((c) => !c)}
                    title={navCollapsed ? 'Expand sidebar' : 'Collapse sidebar'} aria-label="Toggle sidebar">☰</button>
            <div className="rx-brand">
              <Logo size={26} />
              <span><b>OpenHouse</b> <span className="rx-demand">DEMAND</span></span>
            </div>
          </div>
          <div className="rx-who">
            <span>{me.name || me.slug || 'Signed in'}{me.team ? ` · ${me.team}` : ''}</span>
            <span className="rx-avatar">{initials(me.name || me.slug)}</span>
          </div>
        </header>

        <div className="rx-body">
          <nav className={'rx-sidebar' + (navCollapsed ? ' collapsed' : '')}>
            {nav.map((n) => (
              <button key={n.k} className={'rx-nav-btn' + (view === n.k ? ' on' : '')} onClick={() => setView(n.k)}
                      title={navCollapsed ? n.label : undefined}>
                <span className="rx-ic">{n.icon}</span><span className="rx-nav-label">{n.label}</span>
                {n.k === 'notifications' && unread > 0 && <span className="rx-badge">{unread}</span>}
              </button>
            ))}
          </nav>

          <main className="rx-main">
            <div key={view} className="rx-view">
              <h2 style={{ margin: '2px 0 12px', letterSpacing: '-.3px' }}>{active?.label}</h2>
              <ErrorBoundary resetKey={view}>
              {view === 'visits' ? (
                <VisitsView seed={seed} onOpenBroker={setOpenCp} />
              ) : view === 'cps' ? (
                <CpView seed={seed} onOpenBroker={setOpenCp} />
              ) : view === 'properties' ? (
                <PropertiesView seed={seed} onOpenBroker={setOpenCp} />
              ) : view === 'queue' ? (
                <QueueView seed={seed} reloadSeed={reloadSeed} />
              ) : view === 'notifications' ? (
                <NotificationsView seed={seed} onOpenBroker={setOpenCp} />
              ) : view === 'snapshot' ? (
                <SnapshotView seed={seed} />
              ) : view === 'team' ? (
                <TeamView seed={seed} onOpenBroker={setOpenCp} reloadSeed={reloadSeed} />
              ) : (
                <div className="empty"><div className="emoji">🚧</div><div className="t">Coming soon</div></div>
              )}
              </ErrorBoundary>
            </div>
          </main>
        </div>
      </div>
      {openCp && <BrokerModal cpCode={openCp} seed={seed} reloadSeed={reloadSeed} onClose={() => setOpenCp(null)} />}
    </>
  );
}
