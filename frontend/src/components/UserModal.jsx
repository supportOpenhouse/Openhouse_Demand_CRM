import { useEffect, useMemo, useRef, useState } from 'react';
import { createUser, updateUser } from '../api.js';
import { toast } from '../lib/toast.js';

const TEAMS = ['Admin', 'TL', 'KAM', 'Ground'];

// FastAPI errors come back as {"detail":"…"} text — pull the message out.
function errMsg(e) {
  const raw = String(e?.message || e || 'Something went wrong');
  try { const j = JSON.parse(raw); if (j?.detail) return String(j.detail); } catch { /* not json */ }
  return raw.slice(0, 160);
}

// slug preview mirrors the backend's _slugify so the admin sees what they'll get.
const slugify = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'user';

export default function UserModal({ mode, user, seed, onClose, onSaved }) {
  const editing = mode === 'edit';
  const [name, setName] = useState(user?.name || '');
  const [email, setEmail] = useState(user?.email || '');
  const [team, setTeam] = useState(user?.team || 'KAM');
  const [role, setRole] = useState(user?.role || '');
  const [phone, setPhone] = useState(user?.phone || '');
  const [slug, setSlug] = useState('');                       // create-only, optional override
  const [cities, setCities] = useState(user?.cities || []);
  const [cityDraft, setCityDraft] = useState('');
  const [mms, setMms] = useState(user?.micro_markets || []);
  const [mmDraft, setMmDraft] = useState('');
  const [active, setActive] = useState(user?.active !== false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');
  const firstRef = useRef(null);

  useEffect(() => { firstRef.current?.focus(); }, []);
  // Close on Escape — standard modal affordance.
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape' && !saving) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [saving, onClose]);

  // Suggestions pulled from the existing roster so the admin stays consistent.
  const allUsers = seed?.users || [];
  const roleSuggest = useMemo(() => [...new Set(allUsers.map((u) => u.role).filter(Boolean))].sort(), [allUsers]);
  const citySuggest = useMemo(
    () => [...new Set(allUsers.flatMap((u) => u.cities || []).filter(Boolean))].sort(),
    [allUsers],
  );
  const mmSuggest = useMemo(
    () => [...new Set([
      ...allUsers.flatMap((u) => u.micro_markets || []),
      ...(seed?.properties || []).map((p) => p.micro_market),
    ].filter(Boolean))].sort(),
    [allUsers, seed],
  );

  const addCity = (c) => {
    const v = (c || '').trim();
    if (v && !cities.some((x) => x.toLowerCase() === v.toLowerCase())) setCities([...cities, v]);
    setCityDraft('');
  };
  const removeCity = (c) => setCities(cities.filter((x) => x !== c));
  const onCityKey = (e) => {
    if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); addCity(cityDraft); }
    else if (e.key === 'Backspace' && !cityDraft && cities.length) removeCity(cities[cities.length - 1]);
  };
  const addMm = (c) => {
    const v = (c || '').trim();
    if (v && !mms.some((x) => x.toLowerCase() === v.toLowerCase())) setMms([...mms, v]);
    setMmDraft('');
  };
  const removeMm = (c) => setMms(mms.filter((x) => x !== c));
  const onMmKey = (e) => {
    if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); addMm(mmDraft); }
    else if (e.key === 'Backspace' && !mmDraft && mms.length) removeMm(mms[mms.length - 1]);
  };

  const submit = async () => {
    setErr('');
    const nm = name.trim();
    const em = email.trim().toLowerCase();
    if (!nm) return setErr('Name is required.');
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(em)) return setErr('Enter a valid email address.');
    if (!role.trim()) return setErr('Role is required.');
    const digits = (phone || '').replace(/\D/g, '');
    if (digits && digits.length !== 10) return setErr('Phone must be exactly 10 digits (or left blank).');

    setSaving(true);
    try {
      if (editing) {
        await updateUser(user.slug, { name: nm, email: em, team, role: role.trim(), phone: digits, cities, micro_markets: mms, active });
        toast('Member updated', 'good');
      } else {
        const r = await createUser({ name: nm, email: em, team, role: role.trim(), phone: digits, cities, micro_markets: mms, slug: slug.trim() || undefined });
        toast(`${r.name || nm} added to the team`, 'good');
      }
      await onSaved?.();
      onClose();
    } catch (e) {
      setErr(errMsg(e));
      setSaving(false);
    }
  };

  const slugPreview = editing ? user.slug : (slug.trim() || slugify(name));

  return (
    <div className="rx-modal-bg" style={{ zIndex: 220 }} onMouseDown={(e) => { if (e.target === e.currentTarget && !saving) onClose(); }}>
      <div className="rx-modal" style={{ width: 'min(560px, 95vw)' }} role="dialog" aria-modal="true">
        <div className="rx-modal-head">
          <div>
            <h2>{editing ? 'Edit member' : 'Add team member'}</h2>
            <div className="rx-sub" style={{ marginTop: 3 }}>
              {editing ? <>Identity <span className="id-pill">{user.slug}</span> can’t change.</>
                       : <>They’ll sign in with their <b>@openhouse.in</b> Google account.</>}
            </div>
          </div>
          <button className="rx-x" onClick={onClose} disabled={saving} aria-label="Close">✕</button>
        </div>

        <div className="rx-modal-body">
          <div className="rx-fuform" style={{ marginTop: 0, paddingTop: 0, borderTop: 'none' }}>
            <div className="full">
              <label>Full name</label>
              <input ref={firstRef} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Priya Sharma" />
            </div>
            <div className="full">
              <label>Email</label>
              <input value={email} type="email" onChange={(e) => setEmail(e.target.value)} placeholder="priya@openhouse.in" />
            </div>
            <div>
              <label>Team</label>
              <select value={team} onChange={(e) => setTeam(e.target.value)}>
                {TEAMS.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
            <div>
              <label>Role</label>
              <input value={role} onChange={(e) => setRole(e.target.value)} list="rx-role-list" placeholder="e.g. kam, tl_closer, caller" />
              <datalist id="rx-role-list">{roleSuggest.map((r) => <option key={r} value={r} />)}</datalist>
            </div>
            <div>
              <label>Phone <span style={{ textTransform: 'none', fontWeight: 400 }}>(optional)</span></label>
              <input value={phone} inputMode="numeric" maxLength={10}
                     onChange={(e) => setPhone(e.target.value.replace(/\D/g, '').slice(0, 10))} placeholder="10 digits" />
            </div>
            {!editing && (
              <div>
                <label>Login slug <span style={{ textTransform: 'none', fontWeight: 400 }}>(auto)</span></label>
                <input value={slug} onChange={(e) => setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))} placeholder={slugify(name)} />
              </div>
            )}

            <div className="full">
              <label>Cities</label>
              <div className="rx-citybox">
                {cities.map((c) => (
                  <span key={c} className="rx-citychip">{c}<button type="button" onClick={() => removeCity(c)} aria-label={`Remove ${c}`}>✕</button></span>
                ))}
                <input className="rx-cityinput" value={cityDraft} onChange={(e) => setCityDraft(e.target.value)}
                       onKeyDown={onCityKey} onBlur={() => addCity(cityDraft)}
                       placeholder={cities.length ? 'Add another…' : 'Type a city, press Enter'} />
              </div>
              {citySuggest.filter((c) => !cities.includes(c)).length > 0 && (
                <div className="rx-citysuggest">
                  {citySuggest.filter((c) => !cities.includes(c)).map((c) => (
                    <button type="button" key={c} className="btn xs ghost" onClick={() => addCity(c)}>+ {c}</button>
                  ))}
                </div>
              )}
            </div>

            <div className="full">
              <label>Micro-market manager <span style={{ textTransform: 'none', fontWeight: 400 }}>(optional — scopes them to these micro-markets, overriding city)</span></label>
              <div className="rx-citybox">
                {mms.map((c) => (
                  <span key={c} className="rx-citychip">{c}<button type="button" onClick={() => removeMm(c)} aria-label={`Remove ${c}`}>✕</button></span>
                ))}
                <input className="rx-cityinput" value={mmDraft} onChange={(e) => setMmDraft(e.target.value)}
                       onKeyDown={onMmKey} onBlur={() => addMm(mmDraft)}
                       placeholder={mms.length ? 'Add another…' : 'e.g. Dwarka Expressway'} />
              </div>
              {mmSuggest.filter((c) => !mms.includes(c)).length > 0 && (
                <div className="rx-citysuggest">
                  {mmSuggest.filter((c) => !mms.includes(c)).map((c) => (
                    <button type="button" key={c} className="btn xs ghost" onClick={() => addMm(c)}>+ {c}</button>
                  ))}
                </div>
              )}
            </div>

            {editing && (
              <div className="full">
                <label>Status</label>
                <label className="rx-switch">
                  <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
                  <span>{active ? 'Active — appears in the roster and can sign in' : 'Deactivated — hidden from the roster (history kept)'}</span>
                </label>
              </div>
            )}
          </div>

          <div className="rx-sub" style={{ marginTop: 12 }}>
            Signs in as <span className="id-pill">{slugPreview}</span>
          </div>
          {err && <div className="rx-form-err">{err}</div>}
        </div>

        <div className="rx-modal-foot">
          <button className="btn ghost" onClick={onClose} disabled={saving}>Cancel</button>
          <button className="btn primary" onClick={submit} disabled={saving}>
            {saving ? 'Saving…' : editing ? 'Save changes' : 'Add member'}
          </button>
        </div>
      </div>
    </div>
  );
}
