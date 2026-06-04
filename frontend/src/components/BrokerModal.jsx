import { useMemo, useState } from 'react';
import { fmtDate, fmtDay } from '../lib/format.js';
import { visitStage, visitStatus, STAGES, STAGE_BY_KEY } from '../lib/visits.js';
import { usersBySlug } from '../lib/brokers.js';
import { saveFollowup, setBrokerTier, setBrokerOwner, saveEngagement, addNudge } from '../api.js';
import { toast } from '../lib/toast.js';

const TIERS = ['T1', 'T2', 'T3', 'T4'];
const STATUS_COLOR = { hot: 'var(--bad,#B91C1C)', warm: '#B45309', cold: '#1E40AF', dead: 'var(--mut)' };
const BUYER_STATUSES = [
  ['hot', 'Hot'], ['warm', 'Warm'], ['cold', 'Cold'], ['dead', 'Dead'],
  ['future_prospect', 'Future Prospect'], ['unc', 'Unconfirmed'],
];

export default function BrokerModal({ cpCode, seed, reloadSeed, onClose }) {
  const me = seed.current_user || {};
  const isAdmin = me.team === 'Admin' || me.role === 'admin';
  const broker = useMemo(() => (seed.brokers || []).find((b) => b.cp_code === cpCode) || { cp_code: cpCode }, [seed, cpCode]);
  const ubs = useMemo(() => usersBySlug(seed), [seed]);
  const ownerOptions = useMemo(() => (seed.users || []).slice().sort((a, b) => (a.name || '').localeCompare(b.name || '')), [seed]);
  const cpOwner = seed.cp_owner || {};
  const nudgesByVisit = seed.nudges_by_visit || {};
  const visits = useMemo(
    () => (seed.visits || []).filter((v) => v.cp_code === cpCode).sort((a, b) => (b.visit_date || '').localeCompare(a.visit_date || '')),
    [seed, cpCode],
  );
  const [tab, setTab] = useState('visits');
  const [logVisit, setLogVisit] = useState(null);
  const [nudgeVisit, setNudgeVisit] = useState(null);
  const [busy, setBusy] = useState(false);

  async function changeTier(tier) {
    setBusy(true);
    try { await setBrokerTier(cpCode, tier); toast('Tier updated', 'good'); await reloadSeed(); }
    catch (e) { toast('Tier change failed: ' + String(e.message || e).slice(0, 80), 'bad'); }
    finally { setBusy(false); }
  }
  async function changeOwner(slug) {
    setBusy(true);
    try { await setBrokerOwner(cpCode, slug === '__none__' ? '' : slug); toast('CP owner updated', 'good'); await reloadSeed(); }
    catch (e) { toast('Owner change failed: ' + String(e.message || e).slice(0, 80), 'bad'); }
    finally { setBusy(false); }
  }

  const ownerSlug = cpOwner[cpCode] || '';

  function openWa() {
    const digits = (broker.phone_number || '').replace(/\D/g, '');
    if (!digits) { toast('No phone number for this CP', 'bad'); return; }
    const full = digits.length === 10 ? '91' + digits : digits;
    const text = encodeURIComponent(`Hi ${broker.name || ''}, this is ${me.name || 'OpenHouse'} from OpenHouse.`);
    window.open(`https://wa.me/${full}?text=${text}`, '_blank', 'noopener');
  }

  return (
    <div className="rx-modal-bg" style={{ zIndex: 210 }} onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="rx-modal" style={{ width: 'min(840px,95vw)' }}>
        <div className="rx-modal-head">
          <div style={{ flex: 1, minWidth: 0 }}>
            <h2>{broker.name || cpCode}</h2>
            <div className="rx-kv">
              <span>{broker.company_name || '—'}</span>
              {broker.phone_number ? <span><b>{broker.phone_number}</b></span> : null}
              <span>{broker.city || ''}</span>
              <span><b>{broker.cp_code}</b></span>
              {broker.tier ? <span>{broker.tier}</span> : null}
            </div>
          </div>
          {broker.phone_number ? <button className="btn sm" style={{ marginRight: 8 }} onClick={openWa}>💬 WhatsApp</button> : null}
          <button className="rx-x" onClick={onClose}>✕</button>
        </div>

        <div className="rx-modal-body">
          {isAdmin && (
            <div className="rx-filters" style={{ marginBottom: 12 }}>
              <div><label className="rx-stat-l" style={{ marginBottom: 2 }}>Tier</label>
                <select className="rx-sel" value={broker.tier || 'T4'} disabled={busy} onChange={(e) => changeTier(e.target.value)}>{TIERS.map((t) => <option key={t} value={t}>{t}</option>)}</select>
              </div>
              <div><label className="rx-stat-l" style={{ marginBottom: 2 }}>CP Owner</label>
                <select className="rx-sel" value={ownerSlug || '__none__'} disabled={busy} onChange={(e) => changeOwner(e.target.value)}>
                  <option value="__none__">Unassigned</option>{ownerOptions.map((u) => <option key={u.slug} value={u.slug}>{u.name}</option>)}
                </select>
              </div>
            </div>
          )}

          <div className="rx-tabs">
            <button className={'rx-tab' + (tab === 'visits' ? ' on' : '')} onClick={() => setTab('visits')}>Visits <span className="ct">{visits.length}</span></button>
            <button className={'rx-tab' + (tab === 'engagement' ? ' on' : '')} onClick={() => setTab('engagement')}>Log engagement</button>
          </div>

          {tab === 'engagement' && <EngagementForm cpCode={cpCode} seed={seed} reloadSeed={reloadSeed} ubs={ubs} />}

          {tab === 'visits' && (visits.length ? visits.map((v, i) => {
            const st = visitStatus(v); const sg = visitStage(v);
            const vid = v.id || String(i);
            const nudges = (nudgesByVisit[v.id] || []);
            const showLog = logVisit === vid;
            const showNudge = nudgeVisit === vid;
            return (
              <div key={vid} className="rx-vrow">
                <div className="rx-vrow-top">
                  <b>{v.buyer_name || 'Buyer'}</b>
                  <span className="muted" style={{ fontSize: 12 }}>{v.society_name || ''}</span>
                  {st !== 'unc' ? <span className="rx-pill" style={{ background: 'var(--panel2)', color: STATUS_COLOR[st] || 'var(--txt)' }}>{st}</span> : null}
                  <span className={'sgpill ' + sg}><span className="d" />{STAGE_BY_KEY[sg]?.label || sg}</span>
                  <span className="muted" style={{ fontSize: 11.5 }}>{fmtDay(v.visit_date)}</span>
                  <span className="rx-sub" style={{ marginLeft: 'auto' }}>{v.latest_followup_date ? `Last FU ${fmtDate(v.latest_followup_date)}` : 'No FU yet'}</span>
                  <button className="btn xs" onClick={() => { setNudgeVisit(showNudge ? null : vid); setLogVisit(null); }}>{showNudge ? 'Cancel' : '🔔 Nudge'}</button>
                  <button className="btn xs primary" onClick={() => { setLogVisit(showLog ? null : vid); setNudgeVisit(null); }}>{showLog ? 'Cancel' : 'Log follow-up'}</button>
                </div>
                {nudges.length > 0 && (
                  <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 5 }}>
                    {nudges.map((n) => (
                      <div key={n.id} style={{ fontSize: 11.5, color: 'var(--mut)', background: 'var(--panel2)', borderRadius: 7, padding: '5px 9px' }}>
                        🔔 <b style={{ color: 'var(--txt)' }}>{ubs[n.from]?.name || n.from}</b> → {ubs[n.to]?.name || n.to}: {n.message} <span style={{ opacity: .7 }}>· {fmtDay(n.ts)}{n.resolved ? ' · resolved' : ''}</span>
                      </div>
                    ))}
                  </div>
                )}
                {showLog && <FollowupForm visit={v} onDone={async () => { setLogVisit(null); await reloadSeed(); }} />}
                {showNudge && <NudgeForm visit={v} onDone={async () => { setNudgeVisit(null); await reloadSeed(); }} />}
              </div>
            );
          }) : <div className="empty"><div className="emoji">📭</div><div className="t">No visits for this CP</div></div>)}
        </div>
      </div>
    </div>
  );
}

function FollowupForm({ visit, onDone }) {
  const [buyerStatus, setBuyerStatus] = useState(visitStatus(visit) === 'unc' ? 'warm' : visitStatus(visit));
  const [stage, setStage] = useState(visitStage(visit));
  const [nextDate, setNextDate] = useState('');
  const [revisitDate, setRevisitDate] = useState('');
  const [note, setNote] = useState('');
  const [err, setErr] = useState('');
  const [saving, setSaving] = useState(false);

  async function save() {
    if (!note.trim()) { setErr('Note is required'); return; }
    if (stage === 'revisit_scheduled' && !revisitDate) { setErr('Revisit Scheduled needs a revisit date'); return; }
    setErr(''); setSaving(true);
    try {
      await saveFollowup({ visit_code: String(visit.id), buyer_status: buyerStatus, stage, note: note.trim(), next_followup_date: nextDate || null, revisit_date: revisitDate || null });
      toast('Follow-up logged', 'good');
      await onDone();
    } catch (e) { setErr(String(e.message || e).slice(0, 140)); toast('Follow-up failed', 'bad'); }
    finally { setSaving(false); }
  }

  return (
    <div className="rx-fuform">
      <div><label>Buyer status</label><select value={buyerStatus} onChange={(e) => setBuyerStatus(e.target.value)}>{BUYER_STATUSES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></div>
      <div><label>Stage / next step</label><select value={stage} onChange={(e) => setStage(e.target.value)}>{STAGES.map((s) => <option key={s.k} value={s.k}>{s.label}</option>)}</select></div>
      <div><label>Next follow-up date</label><input type="date" value={nextDate} onChange={(e) => setNextDate(e.target.value)} /></div>
      {stage === 'revisit_scheduled' && <div><label>Revisit date</label><input type="date" value={revisitDate} onChange={(e) => setRevisitDate(e.target.value)} /></div>}
      <div className="full"><label>Note (required)</label><textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="What happened / next action…" /></div>
      {err ? <div className="full" style={{ color: 'var(--bad)', fontSize: 11.5 }}>{err}</div> : null}
      <div className="full"><button className="btn sm primary" disabled={saving} onClick={save}>{saving ? 'Saving…' : 'Save follow-up'}</button></div>
    </div>
  );
}

function NudgeForm({ visit, onDone }) {
  const [message, setMessage] = useState('');
  const [priority, setPriority] = useState('normal');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');
  async function send() {
    if (!message.trim()) { setErr('Message is required'); return; }
    setErr(''); setSaving(true);
    try {
      await addNudge({ visit_code: String(visit.id), message: message.trim(), priority });
      toast('Nudge sent to CP owner', 'good');
      await onDone();
    } catch (e) { setErr(String(e.message || e).slice(0, 140)); toast('Nudge failed', 'bad'); }
    finally { setSaving(false); }
  }
  return (
    <div className="rx-fuform">
      <div><label>Priority</label><select value={priority} onChange={(e) => setPriority(e.target.value)}><option value="low">Low</option><option value="normal">Normal</option><option value="high">High</option></select></div>
      <div className="full"><label>Message to CP owner (required)</label><textarea rows={2} value={message} onChange={(e) => setMessage(e.target.value)} placeholder="e.g. Buyer seems serious, please push for a revisit." /></div>
      {err ? <div className="full" style={{ color: 'var(--bad)', fontSize: 11.5 }}>{err}</div> : null}
      <div className="full"><button className="btn sm primary" disabled={saving} onClick={send}>{saving ? 'Sending…' : 'Send nudge'}</button></div>
    </div>
  );
}

function EngagementForm({ cpCode, seed, reloadSeed, ubs }) {
  const [f, setF] = useState({ notes: '', inventory_shared: false, recording_done: false, listing_done: false, listing_link: '', listing_followup_date: '', support_asked: false, support_details: '', remarks: '' });
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');
  const set = (k, v) => setF((p) => ({ ...p, [k]: v }));
  const past = ((seed?.engagements || {})[cpCode] || []);   // server history, newest first
  const chk = (k, label) => (
    <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5, color: 'var(--txt)', fontWeight: 500, textTransform: 'none', letterSpacing: 0 }}>
      <input type="checkbox" checked={f[k]} onChange={(e) => set(k, e.target.checked)} /> {label}
    </label>
  );
  async function save() {
    if (!f.notes.trim()) { setErr('Notes are required'); return; }
    setErr(''); setSaving(true);
    try {
      await saveEngagement({
        cp_code: cpCode, notes: f.notes.trim(),
        inventory_shared: f.inventory_shared, recording_done: f.recording_done, listing_done: f.listing_done,
        listing_link: f.listing_link || null, listing_followup_date: f.listing_followup_date || null,
        support_asked: f.support_asked, support_details: f.support_details || null, remarks: f.remarks || null,
      });
      toast('Engagement logged', 'good');
      setF({ notes: '', inventory_shared: false, recording_done: false, listing_done: false, listing_link: '', listing_followup_date: '', support_asked: false, support_details: '', remarks: '' });
      await reloadSeed?.();   // pull the saved entry so it shows in Past engagements (and for teammates/admin)
    } catch (e) { setErr(String(e.message || e).slice(0, 140)); toast('Engagement failed', 'bad'); }
    finally { setSaving(false); }
  }
  return (
    <div>
      <div className="rx-fuform" style={{ borderTop: 'none', marginTop: 0 }}>
        <div className="full"><label>Notes (required)</label><textarea rows={2} value={f.notes} onChange={(e) => set('notes', e.target.value)} placeholder="What was discussed with the CP…" /></div>
        <div className="full" style={{ display: 'flex', gap: 18, flexWrap: 'wrap' }}>{chk('inventory_shared', 'Inventory shared')}{chk('recording_done', 'Recording done')}{chk('listing_done', 'Listing done')}{chk('support_asked', 'Support asked')}</div>
        <div><label>Listing link</label><input type="text" value={f.listing_link} onChange={(e) => set('listing_link', e.target.value)} placeholder="https://…" /></div>
        <div><label>Listing follow-up date</label><input type="date" value={f.listing_followup_date} onChange={(e) => set('listing_followup_date', e.target.value)} /></div>
        {f.support_asked && <div className="full"><label>Support details</label><input type="text" value={f.support_details} onChange={(e) => set('support_details', e.target.value)} /></div>}
        <div className="full"><label>Remarks</label><input type="text" value={f.remarks} onChange={(e) => set('remarks', e.target.value)} /></div>
        {err ? <div className="full" style={{ color: 'var(--bad)', fontSize: 11.5 }}>{err}</div> : null}
        <div className="full"><button className="btn sm primary" disabled={saving} onClick={save}>{saving ? 'Saving…' : 'Save engagement'}</button></div>
      </div>

      <h4 className="rx-eng-h">Past engagements ({past.length})</h4>
      {past.length ? past.map((e) => <PastEngagement key={e.id} e={e} ubs={ubs} />)
        : <div className="muted" style={{ fontSize: 12.5, padding: '4px 0' }}>No past engagements logged yet.</div>}
    </div>
  );
}

const YN = (v) => (v === 'yes' || v === true ? 'Yes' : 'No');
function PastEngagement({ e, ubs }) {
  const by = ubs?.[e.by];
  return (
    <div className="rx-eng-card">
      <div className="rx-eng-top">
        <b>{by ? by.name : 'Team'}{by?.team ? <span className="rx-chip" style={{ marginLeft: 6 }}>{by.team}</span> : null}</b>
        <span className="rx-sub">{e.ts ? fmtDay(e.ts.slice(0, 10)) : ''}</span>
      </div>
      <div className="rx-eng-flags">
        <span>Inventory: <b>{YN(e.inventoryShared)}</b></span>
        <span>Recording: <b>{YN(e.recordingDone)}</b></span>
        <span>Listing: <b>{YN(e.listingDone)}</b>{e.listingLink ? <> · <a href={e.listingLink} target="_blank" rel="noreferrer">link↗</a></> : null}{e.listingFollowupDate ? ` · FU ${fmtDate(e.listingFollowupDate)}` : ''}</span>
        <span>Support: <b>{YN(e.supportAsked)}</b></span>
      </div>
      {e.supportDetails ? <div className="rx-eng-line"><b>Support:</b> {e.supportDetails}</div> : null}
      {e.remarks ? <div className="rx-eng-line" style={{ fontStyle: 'italic', color: 'var(--mut)' }}>Remarks: {e.remarks}</div> : null}
      {e.notes ? <div className="rx-eng-notes"><b>Notes:</b> {e.notes}</div> : null}
    </div>
  );
}
