// Add CP — registers a NEW channel partner in Open House Core via our server proxy
// (/api/cp-register → Core CP-Meetings create-broker). ADMIN ONLY. The API key +
// the admin's Core sales_manager_id + the allocated cp_code are all handled
// server-side; this form only collects partner details. The new CP appears in the
// CRM at the next sheet sync (nothing is written to the CRM DB here). Mirrors the
// Meetings app's Supply → "Register a partner" screen.
import { useEffect, useState } from 'react';
import { cpRegisterCities, cpRegisterMicroMarkets, cpRegister } from '../api.js';
import { toast } from '../lib/toast.js';

const IN = { width: '100%', padding: '9px 11px', border: '1px solid var(--line)', borderRadius: 8, fontSize: 14, background: '#fff' };
const LBL = { display: 'block', fontSize: 12.5, fontWeight: 600, color: 'var(--mut)', marginBottom: 5 };
const CARD = { border: '1px solid var(--line)', borderRadius: 12, padding: 16, background: '#fff', marginBottom: 14 };

export default function RegisterCpView() {
  const [configured, setConfigured] = useState(true);
  const [cities, setCities] = useState([]);
  const [citiesLoading, setCitiesLoading] = useState(true);
  const [fullName, setFullName] = useState('');
  const [phone, setPhone] = useState('');
  const [city, setCity] = useState('');
  const [company, setCompany] = useState('Individual');
  const [email, setEmail] = useState('');
  const [markets, setMarkets] = useState([]);
  const [marketsLoading, setMarketsLoading] = useState(false);
  const [selected, setSelected] = useState([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(null);

  useEffect(() => {
    let off = false;
    (async () => {
      try {
        const data = await cpRegisterCities();
        if (off) return;
        setConfigured(data?.configured !== false);
        setCities(data?.cities ?? []);
      } catch { if (!off) setCities([]); }
      finally { if (!off) setCitiesLoading(false); }
    })();
    return () => { off = true; };
  }, []);

  useEffect(() => {
    if (!city) { setMarkets([]); setSelected([]); return undefined; }
    let off = false;
    setMarketsLoading(true); setSelected([]);
    (async () => {
      try { const data = await cpRegisterMicroMarkets(city); if (!off) setMarkets(data?.microMarkets ?? []); }
      catch { if (!off) setMarkets([]); }
      finally { if (!off) setMarketsLoading(false); }
    })();
    return () => { off = true; };
  }, [city]);

  const toggle = (id) => setSelected((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));

  async function submit(e) {
    e.preventDefault();
    setError('');
    if (!fullName.trim()) return setError('Partner name is required.');
    const digits = phone.replace(/\D/g, '');
    if (digits.length !== 10) return setError('Enter a valid 10-digit phone number.');
    if (!city) return setError('Select a city.');
    if (!selected.length) return setError('Select at least one micro market.');
    setSaving(true);
    try {
      const data = await cpRegister({
        full_name: fullName.trim(), phone_number: digits, city,
        company_name: company.trim() || 'Individual',
        email: email.trim() || undefined, micro_markets: selected,
      });
      setDone({ cp_code: data?.cp_code, name: fullName.trim() });
      toast('Partner registered', 'good');
    } catch (err) { setError(err?.message || 'Could not register partner.'); }
    finally { setSaving(false); }
  }

  function reset() {
    setDone(null); setFullName(''); setPhone(''); setCity(''); setCompany('Individual');
    setEmail(''); setSelected([]); setMarkets([]); setError('');
  }

  if (!configured) {
    return (
      <div className="empty" style={{ marginTop: 24 }}>
        <div className="emoji">🔧</div>
        <div className="t">Add CP isn’t set up yet</div>
        <div className="s" style={{ maxWidth: 460, margin: '6px auto 0' }}>
          The partner-registration key (<code>CP_MEETINGS_API_KEY</code>) isn’t configured on the
          server yet. Once it’s added, this form goes live — no further changes needed.
        </div>
      </div>
    );
  }

  if (done) {
    return (
      <div className="empty" style={{ marginTop: 24 }}>
        <div className="emoji">✅</div>
        <div className="t">Partner registered</div>
        <div className="s" style={{ maxWidth: 480, margin: '6px auto 0' }}>
          <b>{done.name}</b> is now in Open House{done.cp_code ? <> as <b>{done.cp_code}</b></> : ''}.
          They’ll appear in the CRM’s Channel Partners list at the next sync (~15 min).
        </div>
        <button type="button" className="btn primary" style={{ marginTop: 14 }} onClick={reset}>
          ＋ Register another
        </button>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 640 }}>
      <p style={{ color: 'var(--mut)', margin: '0 0 16px', fontSize: 13.5 }}>
        Add a new channel partner to Open House. Registered under your account and synced to the CRM.
      </p>
      <form onSubmit={submit}>
        {error && (
          <div style={{ background: 'var(--badBg, #FEE2E2)', color: 'var(--bad, #B91C1C)', padding: '10px 13px', borderRadius: 10, fontSize: 13, marginBottom: 14, fontWeight: 500 }}>
            {error}
          </div>
        )}
        <div style={CARD}>
          <div style={{ marginBottom: 12 }}>
            <label style={LBL}>Partner name *</label>
            <input style={IN} value={fullName} onChange={(e) => setFullName(e.target.value)} placeholder="e.g. Rahul Sharma" autoFocus />
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
            <div>
              <label style={LBL}>Phone number *</label>
              <input style={IN} type="tel" inputMode="numeric" maxLength={10} value={phone}
                     onChange={(e) => setPhone(e.target.value.replace(/\D/g, ''))} placeholder="10-digit mobile" />
            </div>
            <div>
              <label style={LBL}>Email</label>
              <input style={IN} type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="optional" />
            </div>
          </div>
          <div>
            <label style={LBL}>Company</label>
            <input style={IN} value={company} onChange={(e) => setCompany(e.target.value)} placeholder="Individual" />
          </div>
        </div>

        <div style={CARD}>
          <div style={{ marginBottom: 12 }}>
            <label style={LBL}>City *</label>
            <select style={IN} value={city} onChange={(e) => setCity(e.target.value)} disabled={citiesLoading}>
              <option value="">{citiesLoading ? 'Loading…' : 'Select a city'}</option>
              {cities.map((c) => <option key={c.id} value={c.name}>{c.name}</option>)}
            </select>
          </div>
          {city && (
            <div>
              <label style={LBL}>Micro markets *{selected.length > 0 ? ` · ${selected.length} selected` : ''}</label>
              {marketsLoading ? (
                <div style={{ fontSize: 13, color: 'var(--mut)' }}>Loading micro markets…</div>
              ) : markets.length === 0 ? (
                <div style={{ fontSize: 13, color: 'var(--mut)' }}>No micro markets found for {city}.</div>
              ) : (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                  {markets.map((m) => {
                    const on = selected.includes(m.id);
                    return (
                      <button type="button" key={m.id} onClick={() => toggle(m.id)}
                        style={{ padding: '7px 12px', borderRadius: 100, cursor: 'pointer', fontSize: 13, fontWeight: on ? 600 : 500,
                          border: '1px solid ' + (on ? 'var(--acc, #2563EB)' : 'var(--line)'),
                          background: on ? 'var(--accBg, #EFF6FF)' : '#fff', color: on ? 'var(--acc, #2563EB)' : 'var(--ink)' }}>
                        📍 {m.name}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>

        <button type="submit" className="btn primary" disabled={saving} style={{ width: '100%', padding: 13, justifyContent: 'center' }}>
          {saving ? 'Registering…' : '＋ Register partner'}
        </button>
      </form>
    </div>
  );
}
