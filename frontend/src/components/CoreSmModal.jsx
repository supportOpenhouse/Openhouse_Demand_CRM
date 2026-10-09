// Create a Sales Manager in the OpenHouse app (Core/Django).
//
// This is NOT the CRM roster — "＋ Add member" beside it does that. This creates the
// record in the app so the person can own homes and be attributed visits. The two are
// linked by `users.core_sales_manager_id`, which the 15-min sheet sync fills from the
// inventory "Sales managers" tab; the new id is shown on success so an admin can map
// it right away rather than waiting.
//
// ⚠️ ONE-WAY. Core exposes no delete or deactivate for a sales manager (verified:
// DELETE/PATCH both 404), so a typo is permanent. Hence the explicit confirm step —
// this is the same reason Book Visits confirms before creating.
import { useEffect, useState } from 'react';
import { loadCoreCities, createCoreSalesManager } from '../api.js';
import { toast } from '../lib/toast.js';

const last10 = (s) => (String(s || '').match(/\d/g) || []).join('').slice(-10);

export default function CoreSmModal({ onClose, onCreated }) {
  const [cities, setCities] = useState([]);
  // Teams come from the backend (single source of truth with core_visits.SM_TEAMS).
  // Default to Demand: this is the Demand CRM, so it's right nearly every time —
  // and Core treats `team` as optional, which is exactly the manual backfill the
  // field exists to prevent. Still a real choice; just a sensible pre-selection.
  const [teams, setTeams] = useState([]);
  const [team, setTeam] = useState('demand');
  const [loadErr, setLoadErr] = useState('');
  const [loading, setLoading] = useState(true);

  const [name, setName] = useState('');
  const [mobile, setMobile] = useState('');
  const [cityId, setCityId] = useState('');

  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [done, setDone] = useState(null);      // the created SM

  useEffect(() => {
    let alive = true;
    loadCoreCities()
      .then((d) => {
        if (!alive) return;
        setCities(d.cities || []);
        setTeams(d.teams || []);
      })
      .catch((e) => { if (alive) setLoadErr(e.message || 'Could not load cities from the app'); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, []);

  const digits = last10(mobile);
  const cityName = cities.find((c) => String(c.id) === String(cityId))?.name || '';
  const teamLabel = teams.find((t) => t.value === team)?.label
    || (team ? team.charAt(0).toUpperCase() + team.slice(1) : '—');
  const valid = name.trim().length > 1 && digits.length === 10 && !!cityId && !!team;

  async function submit() {
    setBusy(true); setErr('');
    try {
      const res = await createCoreSalesManager({
        name: name.trim(), mobile: digits, city_id: Number(cityId), team,
      });
      setDone(res.sales_manager || null);
      toast(`Sales manager created in the app${res.sales_manager?.id ? ` (id ${res.sales_manager.id})` : ''}`);
      onCreated?.(res.sales_manager);
    } catch (e) {
      // 409 → already exists; name who it clashed with so they can stop guessing.
      setErr(e.status === 409 && e.salesManagerId
        ? `${e.message}. Use that existing record instead of creating a duplicate.`
        : (e.message || 'Could not create the sales manager'));
      setConfirming(false);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="vc-backdrop" onClick={(e) => { if (e.target === e.currentTarget && !busy) onClose?.(); }}>
      <div className="vc-modal" role="dialog" aria-modal="true" aria-label="New sales manager in the app">
        <div className="vc-head">
          <div>
            <div className="vc-title">New sales manager · OpenHouse app</div>
            <div className="vc-sub">
              Creates the record in the app so they can own homes and take visits.
              This is separate from the CRM roster.
            </div>
          </div>
          <button className="vc-x" type="button" onClick={onClose} disabled={busy} aria-label="Close">×</button>
        </div>

        {done ? (
          <div className="vc-body">
            <div className="vc-current">
              <span>Created in the app</span>
              <b>{done.name} · id {done.id}</b>
            </div>
            <ul className="vc-recap" style={{ marginTop: 10 }}>
              <li><span>Mobile</span><b>{done.mobile}</b></li>
              <li><span>City</span><b>{done.city_name || cityName}</b></li>
              <li><span>Team</span><b>{
                done.team
                  ? (teams.find((t) => t.value === done.team)?.label
                     || done.team.charAt(0).toUpperCase() + done.team.slice(1))
                  : teamLabel
              }</b></li>
              <li><span>Active</span><b>{done.is_active === false ? 'No' : 'Yes'}</b></li>
            </ul>
            <div className="vc-note sm" style={{ marginTop: 10 }}>
              To let a CRM user book visits as this person, their CRM profile must map to
              sales-manager id <b>{done.id}</b>. That mapping comes from the inventory
              “Sales managers” sheet on the next 15-minute sync.
            </div>
          </div>
        ) : confirming ? (
          <div className="vc-body">
            <div className="vc-confirm-t">Confirm new sales manager</div>
            <ul className="vc-recap">
              <li><span>Name</span><b>{name.trim()}</b></li>
              <li><span>Mobile</span><b>{digits}</b></li>
              <li><span>City</span><b>{cityName}</b></li>
              <li><span>Team</span><b>{teamLabel}</b></li>
            </ul>
            <div className="vc-warn">
              This creates a record in the <b>OpenHouse app</b>. The app has no delete for
              sales managers, so <b>this can’t be undone</b> — check the spelling and number.
            </div>
            {err ? <div className="vc-err">{err}</div> : null}
          </div>
        ) : (
          <div className="vc-body">
            {loading ? <div className="vc-note">Loading cities from the app…</div> : null}
            {loadErr ? <div className="vc-err">{loadErr}</div> : null}

            <label className="vc-label" htmlFor="sm-name">Full name</label>
            <input id="sm-name" className="vc-select" type="text" value={name} disabled={busy}
                   placeholder="e.g. Rahul Sharma" onChange={(e) => setName(e.target.value)} />

            <label className="vc-label" htmlFor="sm-mob">Mobile</label>
            <input id="sm-mob" className="vc-select" type="tel" inputMode="numeric" value={mobile}
                   disabled={busy} placeholder="10-digit number"
                   onChange={(e) => setMobile(e.target.value)} />
            {mobile && digits.length !== 10
              ? <div className="vc-note sm">Needs 10 digits — currently {digits.length}.</div>
              : null}

            <label className="vc-label" htmlFor="sm-city">City</label>
            <select id="sm-city" className="vc-select" value={cityId} disabled={busy || loading}
                    onChange={(e) => setCityId(e.target.value)}>
              <option value="">— select a city —</option>
              {cities.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>

            <label className="vc-label" htmlFor="sm-team">Team</label>
            <select id="sm-team" className="vc-select" value={team} disabled={busy || loading}
                    onChange={(e) => setTeam(e.target.value)}>
              {teams.length === 0 ? <option value="demand">Demand</option> : null}
              {teams.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
            </select>

            {err ? <div className="vc-err">{err}</div> : null}
          </div>
        )}

        <div className="vc-foot">
          {done ? (
            <button className="vc-btn primary" type="button" onClick={onClose}>Done</button>
          ) : confirming ? (
            <>
              <button className="vc-btn" type="button" disabled={busy}
                      onClick={() => setConfirming(false)}>← Back</button>
              <button className="vc-btn primary" type="button" disabled={busy} onClick={submit}>
                {busy ? 'Creating…' : 'Create in the app'}
              </button>
            </>
          ) : (
            <>
              <button className="vc-btn" type="button" onClick={onClose} disabled={busy}>Cancel</button>
              <button className="vc-btn primary" type="button" disabled={!valid || busy}
                      onClick={() => { setErr(''); setConfirming(true); }}>Review →</button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
