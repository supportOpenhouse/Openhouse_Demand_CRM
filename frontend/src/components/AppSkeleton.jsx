import { Skel, SkeletonTable } from './Skeleton.jsx';
import Logo from './Logo.jsx';

// Shown while /api/seed loads. The fixed chrome (logo, brand, nav rail) renders for
// real and stays stable; only the data area shimmers — so the app feels instant and
// the data fills in behind a skeleton instead of the whole screen flashing.
const NAV = [
  ['📋', 'Visits'], ['🤝', 'Channel Partners'], ['🏠', 'Properties'],
  ['📤', 'Inventory Snapshot'], ['👤', 'Team'], ['🔔', 'Notifications'],
];

export default function AppSkeleton() {
  return (
    <div className="rx-shell" aria-busy="true" aria-label="Loading">
      <header className="rx-topbar">
        <div className="rx-topbar-left">
          <button className="rx-navtoggle" tabIndex={-1} aria-hidden="true">☰</button>
          <div className="rx-brand">
            <Logo size={26} />
            <span><b>OpenHouse</b> <span className="rx-demand">DEMAND</span></span>
          </div>
        </div>
        <div className="rx-who">
          <Skel w={92} h={12} />
          <span className="rx-skel" style={{ width: 30, height: 30, borderRadius: '50%' }} />
        </div>
      </header>
      <div className="rx-body">
        <nav className="rx-sidebar">
          {NAV.map(([ic, label], i) => (
            <div key={i} className="rx-nav-btn" style={{ cursor: 'default', color: 'var(--mut)' }}>
              <span className="rx-ic">{ic}</span><span className="rx-nav-label">{label}</span>
            </div>
          ))}
        </nav>
        <main className="rx-main">
          <Skel w={150} h={22} style={{ marginBottom: 16 }} />
          <div className="rx-stats">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="rx-stat" style={{ cursor: 'default' }}>
                <Skel w="42%" h={22} />
                <Skel w="68%" h={11} style={{ marginTop: 9 }} />
              </div>
            ))}
          </div>
          <div style={{ height: 12 }} />
          <SkeletonTable rows={10} cols={7} />
        </main>
      </div>
    </div>
  );
}
