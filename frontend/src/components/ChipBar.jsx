// The legacy chip-bar filter (colored, clickable, live counts). Uses the verbatim
// .chip-bar / .chip / .ct / .dot classes from theme.css so it matches crm.html.
// `options` is the full list (include an {k:'all'} entry yourself where wanted).
export default function ChipBar({ label, options, counts = {}, value, onChange, showDots = true }) {
  return (
    <div className="chip-bar">
      {label && <div className="chip-bar-label">{label}</div>}
      <div className="chip-row">
        {options.map((o) => (
          <button
            key={o.k}
            className={'chip ' + (o.cls || '') + (value === o.k ? ' on' : '')}
            onClick={() => onChange(o.k)}
            type="button"
          >
            {showDots && o.k !== 'all' && <span className="dot" />}
            {o.label}
            <span className="ct">{counts[o.k] || 0}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
