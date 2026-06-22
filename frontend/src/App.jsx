import { useEffect, useState, useRef } from 'react';
import { loadSeed } from './api.js';
import Toast from './components/Toast.jsx';
import AppSkeleton from './components/AppSkeleton.jsx';
import Logo from './components/Logo.jsx';
import HomeView from './views/HomeView.jsx';
import VisitsView from './views/VisitsView.jsx';
import NegotiationsView from './views/NegotiationsView.jsx';
import CpView from './views/CpView.jsx';
import PropertiesView from './views/PropertiesView.jsx';
import NotificationsView from './views/NotificationsView.jsx';
import SnapshotView from './views/SnapshotView.jsx';
import TeamView from './views/TeamView.jsx';
import AnalyticsView from './views/AnalyticsView.jsx';
import PropertyPerformanceView from './views/PropertyPerformanceView.jsx';
import BookVisitsView from './views/BookVisitsView.jsx';
import HiringView from './views/HiringView.jsx';
import ReportShareView from './views/ReportShareView.jsx';
import AiSuggestionsView from './views/AiSuggestionsView.jsx';
import TeamPerformanceView from './views/TeamPerformanceView.jsx';
import BrokerModal from './components/BrokerModal.jsx';
import ErrorBoundary from './components/ErrorBoundary.jsx';
import FiltersModal, { activeFilterCount } from './components/FiltersModal.jsx';
import BottomTabBar from './components/BottomTabBar.jsx';
import { TEAM_PILL } from './lib/legacy.js';

const SEARCH_VIEWS = new Set(['visits', 'negotiations', 'cps', 'properties']);

// Book Visits (beta) is restricted to these super-admins BY SLUG until the app
// booking API is connected. Deliberately NOT gated by team/role — several other users
// are also Admin/admin, and this must stay limited to exactly this set.
const SUPER_ADMINS = new Set(['akshit', 'saransh', 'tazim', 'ankit']);

const NAV = [
  { k: 'home',          icon: '🏠', label: 'Home' },
  { k: 'ai',            icon: '✨', label: 'AI Suggestions' },
  { k: 'visits',        icon: '📋', label: 'Visits' },
  { k: 'negotiations',  icon: '💬', label: 'Negotiations' },
  { k: 'cps',           icon: '🤝', label: 'Channel Partners' },
  { k: 'properties',    icon: '🏠', label: 'Properties' },
  { k: 'analytics',     icon: '📊', label: 'Analytics' },
  { k: 'propertyperf',  icon: '🏢', label: 'Property Performance' },
  { k: 'snapshot',      icon: '📤', label: 'Inventory Snapshot' },
  { k: 'team',          icon: '👤', label: 'My Day' },
  { k: 'notifications', icon: '🔔', label: 'Notifications' },
  { k: 'book',          icon: '📅', label: 'Book Visits' },
  { k: 'hiring',        icon: '🧮', label: 'Hiring', adminOnly: true },
  { k: 'reports',       icon: '📧', label: 'Report Share', adminOnly: true },
  { k: 'teamperf',      icon: '📈', label: 'Team Performance', adminOnly: true },
];

function initials(name = '') {
  return name.trim().split(/\s+/).slice(0, 2).map((w) => w[0] || '').join('').toUpperCase() || '?';
}

export default function App() {
  const [seed, setSeed] = useState(null);
  const [error, setError] = useState(null);
  const [view, setView] = useState('home');
  const [openCp, setOpenCp] = useState(null);   // broker popup, openable from any view
  const [busy, setBusy] = useState(false);       // re-fetch in flight → top progress bar
  const [navCollapsed, setNavCollapsed] = useState(() => {
    try { return localStorage.getItem('rx-nav-collapsed') === '1'; } catch { return false; }
  });
  useEffect(() => { try { localStorage.setItem('rx-nav-collapsed', navCollapsed ? '1' : '0'); } catch { /* ignore */ } }, [navCollapsed]);
  const [search, setSearch] = useState('');          // global topbar search (like crm.html)
  const [filters, setFilters] = useState({});         // advanced Visits filters
  const [filtersOpen, setFiltersOpen] = useState(false);
  // Visits chip-bar + sort selections, lifted here so they survive the view
  // unmounting on a tab switch (per-tab, in-session). null = use VisitsView defaults.
  const [visitsUi, setVisitsUi] = useState(null);
  const [impersonate, setImpersonate] = useState(null); // admin: view as another user (slug)
  const [switcherOpen, setSwitcherOpen] = useState(false);
  // clear search when switching views — UNLESS a deep-link (AI Suggestions) set a
  // pending search to apply on arrival (e.g. jump to Visits filtered to a buyer).
  const pendingSearch = useRef(null);
  useEffect(() => {
    if (pendingSearch.current != null) { setSearch(pendingSearch.current); pendingSearch.current = null; }
    else setSearch('');
  }, [view]);
  const navigateWithSearch = (targetView, term) => {
    if (term != null) pendingSearch.current = term;
    setView(targetView);
  };

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

  const realMe = seed.current_user || {};   // real signed-in user — no hardcoded default (#2)
  const canImpersonate = realMe.team === 'Admin' || realMe.role === 'admin';
  // effective user: admins can "view as" anyone — the admin seed has the full dataset,
  // so swapping current_user re-scopes every view exactly like that user would see it.
  const me = (impersonate && canImpersonate)
    ? ((seed.users || []).find((u) => u.slug === impersonate) || realMe)
    : realMe;
  const vseed = me === realMe ? seed : { ...seed, current_user: me, current_user_slug: me.slug };
  const isAdmTL = me.team === 'Admin' || me.team === 'TL' || me.role === 'admin' || (me.role || '').includes('tl');
  // Gate Book Visits on the REAL signed-in user (never the impersonated `me`), by exact slug.
  const isSuperAdmin = SUPER_ADMINS.has(realMe.slug);
  // Hiring (beta) is for all team=Admin users (incl. the super-admins). Gated on the
  // effective user, like the other admin tabs.
  const isAdmin = me.team === 'Admin';
  // Report-only viewers (e.g. supply team) get EXACTLY one tab: Report Share. They
  // have no other CRM access — the backend scopes their seed to properties-only and
  // 403s every admin route — so we surface no other view to them.
  const isReportViewer = me.team === 'Report';
  const nav = isReportViewer
    ? NAV.filter((n) => n.k === 'reports')
    : NAV.filter((n) => (!n.adm || isAdmTL) && (!n.superAdmin || isSuperAdmin) && (!n.adminOnly || isAdmin))
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
          <div className="rx-topbar-right">
            {SEARCH_VIEWS.has(view) && (
              <div className="rx-search">
                <span className="rx-search-ic">🔍</span>
                <input value={search} onChange={(e) => setSearch(e.target.value)}
                       placeholder="Search visit, society, CP, buyer, phone…" />
              </div>
            )}
            {(view === 'visits' || view === 'negotiations') && (
              <button className="rx-filters-btn" type="button" onClick={() => setFiltersOpen(true)}>
                Filters{activeFilterCount(filters) > 0 && <span className="rx-filters-badge">{activeFilterCount(filters)}</span>}
              </button>
            )}
            <div className="rx-who-wrap">
              <button type="button" className={'rx-who' + (canImpersonate ? ' clickable' : '') + (impersonate ? ' impersonating' : '')}
                      onClick={() => canImpersonate && setSwitcherOpen((o) => !o)}
                      title={canImpersonate ? 'View as another user' : undefined}>
                <span>{me.name || me.slug || 'Signed in'}{me.team ? ` · ${me.team}` : ''}</span>
                <span className="rx-avatar">{initials(me.name || me.slug)}</span>
                {canImpersonate && <span className="rx-who-caret">▾</span>}
              </button>
              {switcherOpen && (
                <>
                  <div className="rx-switch-backdrop" onClick={() => setSwitcherOpen(false)} />
                  <div className="rx-switch-menu">
                    {impersonate && (
                      <button type="button" className="rx-switch-item exit"
                              onClick={() => { setImpersonate(null); setSwitcherOpen(false); setView('visits'); }}>
                        ⤺ Back to myself ({realMe.name})
                      </button>
                    )}
                    <div className="rx-switch-label">View as</div>
                    {(seed.users || []).slice()
                      .sort((a, b) => (a.team || '').localeCompare(b.team || '') || (a.name || '').localeCompare(b.name || ''))
                      .map((u) => (
                        <button key={u.slug} type="button" className={'rx-switch-item' + (me.slug === u.slug ? ' on' : '')}
                                onClick={() => { setImpersonate(u.slug === realMe.slug ? null : u.slug); setSwitcherOpen(false); setView('visits'); }}>
                          <span className="rx-avatar sm">{initials(u.name)}</span>
                          <span className="nm">{u.name}{u.slug === realMe.slug ? ' (you)' : ''}</span>
                          <span className={'role-pill ' + (TEAM_PILL[u.team] || '')}>{u.team}</span>
                        </button>
                      ))}
                  </div>
                </>
              )}
            </div>
          </div>
        </header>
        {impersonate && (
          <div className="rx-impersonate-bar">
            <span>👁 Viewing as <b>{me.name}</b> · {me.team} — exactly what they see.</span>
            <button type="button" onClick={() => { setImpersonate(null); setView('visits'); }}>Exit</button>
          </div>
        )}

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
              {isReportViewer ? (
                <ReportShareView seed={vseed} />
              ) : view === 'home' ? (
                <HomeView seed={vseed} onOpenBroker={setOpenCp} />
              ) : view === 'ai' ? (
                <AiSuggestionsView seed={vseed} onOpenBroker={setOpenCp} onNavigate={navigateWithSearch} />
              ) : view === 'visits' ? (
                <VisitsView seed={vseed} onOpenBroker={setOpenCp} search={search} filters={filters} visitsUi={visitsUi} onVisitsUiChange={setVisitsUi} />
              ) : view === 'negotiations' ? (
                <NegotiationsView seed={vseed} onOpenBroker={setOpenCp} reloadSeed={reloadSeed} search={search} filters={filters} />
              ) : view === 'cps' ? (
                <CpView seed={vseed} onOpenBroker={setOpenCp} search={search} />
              ) : view === 'properties' ? (
                <PropertiesView seed={vseed} onOpenBroker={setOpenCp} search={search} />
              ) : view === 'analytics' ? (
                <AnalyticsView seed={vseed} />
              ) : view === 'propertyperf' ? (
                <PropertyPerformanceView seed={vseed} />
              ) : view === 'notifications' ? (
                <NotificationsView seed={vseed} onOpenBroker={setOpenCp} />
              ) : view === 'snapshot' ? (
                <SnapshotView seed={vseed} />
              ) : view === 'book' ? (
                <BookVisitsView seed={seed} />
              ) : view === 'hiring' ? (
                isAdmin ? <HiringView /> : <div className="empty"><div className="emoji">🚧</div><div className="t">Coming soon</div></div>
              ) : view === 'reports' ? (
                isAdmin ? <ReportShareView seed={seed} /> : <div className="empty"><div className="emoji">🚧</div><div className="t">Coming soon</div></div>
              ) : view === 'teamperf' ? (
                isAdmin ? <TeamPerformanceView seed={seed} /> : <div className="empty"><div className="emoji">🚧</div><div className="t">Coming soon</div></div>
              ) : view === 'team' ? (
                <TeamView seed={vseed} onOpenBroker={setOpenCp} reloadSeed={reloadSeed} />
              ) : (
                <div className="empty"><div className="emoji">🚧</div><div className="t">Coming soon</div></div>
              )}
              </ErrorBoundary>
            </div>
          </main>
        </div>
        <BottomTabBar nav={nav} view={view} setView={setView} unread={unread} />
      </div>
      {openCp && <BrokerModal cpCode={openCp} seed={vseed} reloadSeed={reloadSeed} onClose={() => setOpenCp(null)} />}
      {filtersOpen && (
        <FiltersModal seed={vseed} value={filters}
          onApply={(f) => { setFilters(f); setFiltersOpen(false); }}
          onClose={() => setFiltersOpen(false)} />
      )}
    </>
  );
}
