// Reusable shimmer placeholders. One `.rx-skel` shimmer (see app.css) sized by props.
export function Skel({ w = '100%', h = 14, r = 6, style }) {
  return <span className="rx-skel" style={{ display: 'block', width: w, height: h, borderRadius: r, ...style }} />;
}

// A placeholder table that matches the real `.t` tables (header + striped rows).
export function SkeletonTable({ rows = 8, cols = 5, minWidth = 700 }) {
  return (
    <div className="cp-tbl-wrap" style={{ borderRadius: 10 }}>
      <table className="t" style={{ minWidth }}>
        <thead>
          <tr>{Array.from({ length: cols }).map((_, i) => <th key={i}><Skel w="55%" h={11} /></th>)}</tr>
        </thead>
        <tbody>
          {Array.from({ length: rows }).map((_, r) => (
            <tr key={r} className="rx-skel-row" style={{ '--i': r }}>
              {Array.from({ length: cols }).map((_, c) => (
                <td key={c}><Skel w={c === 0 ? '72%' : `${35 + ((c * 13) % 30)}%`} /></td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
