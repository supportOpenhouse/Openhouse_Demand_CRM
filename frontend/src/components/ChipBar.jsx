// The legacy chip-bar filter (colored, clickable, live counts). Uses the verbatim
// .chip-bar / .chip / .ct / .dot classes from theme.css so it matches crm.html.
// `options` is the full list (include an {k:'all'} entry yourself where wanted).
export default function ChipBar({ label, options, counts = {}, value, onChange, showDots = true, multi = false }) {
  // multi: value is an array; clicking toggles membership; the 'all' chip clears it.
  const isOn = (k) => (multi ? (k === 'all' ? !value.length : value.includes(k)) : value === k);
  const handle = (k) => {
    if (!multi) return onChange(k);
    if (k === 'all') return onChange([]);
    return onChange(value.includes(k) ? value.filter((x) => x !== k) : [...value, k]);
  };
  return (
    <div className="chip-bar">
      {label && <div className="chip-bar-label">{label}</div>}
      <div className="chip-row">
        {options.map((o) => (
          <button
            key={o.k}
            className={'chip ' + (o.cls || '') + (isOn(o.k) ? ' on' : '')}
            onClick={() => handle(o.k)}
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
