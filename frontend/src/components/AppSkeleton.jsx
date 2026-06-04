import { Skel, SkeletonTable } from './Skeleton.jsx';

// Full-shell skeleton shown while /api/seed loads. Mirrors the real topbar +
// sidebar + content so the app feels like it's materializing, not blank-spinning.
export default function AppSkeleton() {
  return (
    <div className="rx-shell rx-skel-shell" aria-busy="true" aria-label="Loading">
      <header className="rx-topbar">
        <div className="rx-brand">
          <span className="rx-skel" style={{ width: 26, height: 26, borderRadius: 7 }} />
          <Skel w={120} h={14} />
        </div>
        <div className="rx-who">
          <Skel w={92} h={12} />
          <span className="rx-skel" style={{ width: 30, height: 30, borderRadius: '50%' }} />
        </div>
      </header>
      <div className="rx-body">
        <nav className="rx-sidebar">
          {Array.from({ length: 7 }).map((_, i) => (
            <span key={i} className="rx-skel" style={{ height: 34, borderRadius: 9, margin: '2px 0', '--i': i }} />
          ))}
        </nav>
        <main className="rx-main">
          <Skel w={170} h={22} style={{ marginBottom: 16 }} />
          <div className="rx-stats">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="rx-stat" style={{ cursor: 'default' }}>
                <Skel w="42%" h={22} />
                <Skel w="68%" h={11} style={{ marginTop: 9 }} />
              </div>
            ))}
          </div>
          <div style={{ height: 12 }} />
          <SkeletonTable rows={9} cols={6} />
        </main>
      </div>
    </div>
  );
}
