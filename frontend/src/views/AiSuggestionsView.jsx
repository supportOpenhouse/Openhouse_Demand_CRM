// AI Suggestions — a per-user daily "morning brief" (ALL roles). Reads
// GET /api/ai-suggestions (today's cached brief, or generated on-demand). The
// brief is built from the user's SCOPED data on the backend (reusing the same
// who-sees-what as every other view), so it only ever reflects their own book.
// Every point is clickable → opens the relevant channel-partner (BrokerModal via
// onOpenBroker) or jumps to the Visits tab filtered to that buyer (onNavigate).
// Self-contained: styles scoped under `as-` so app.css is untouched.
import { useEffect, useState, useCallback, useMemo } from 'react';
import { loadAiSuggestions, refreshAiSuggestions } from '../api.js';
import { toast } from '../lib/toast.js';

const KIND_ICON = { broker: '☎', lead: '→', visits: '📋', none: '•' };

function fmtTime(iso) {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  } catch { return ''; }
}

export default function AiSuggestionsView({ seed, onOpenBroker, onNavigate, initialData = null }) {
  const me = seed?.current_user || {};
  const isAdmin = me.team === 'Admin';   // Refresh (an expensive regen) is admin-only — backend enforces it too
  const [data, setData] = useState(initialData);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    setErr(null);
    loadAiSuggestions().then((d) => alive && setData(d)).catch((e) => alive && setErr(e.message));
    return () => { alive = false; };
  }, []);

  const refresh = useCallback(async () => {
    setBusy(true); setErr(null);
    try { setData(await refreshAiSuggestions()); toast('Brief refreshed', 'good'); }
    catch (e) { setErr(e.message); toast('Refresh failed', 'bad'); }
    finally { setBusy(false); }
  }, []);

  // only treat a cp_code as a valid broker link if it exists in THIS user's brokers,
  // so a click can never open an empty modal (the brief's refs come from their own
  // scoped data, so they normally match — this is a safety net).
  const brokerCodes = useMemo(() => new Set((seed?.brokers || []).map((b) => b.cp_code)), [seed]);
  const isClickable = useCallback((p) =>
    (p.link_kind === 'broker' && brokerCodes.has(p.link_ref)) ||
    (p.link_kind === 'lead' && !!p.link_ref) ||
    p.link_kind === 'visits', [brokerCodes]);
  // resolve a click target from a {link_kind, link_ref}
  const go = useCallback((kind, ref) => {
    if (kind === 'broker' && brokerCodes.has(ref)) onOpenBroker?.(ref);
    else if (kind === 'lead' && ref) onNavigate?.('visits', ref);
    else if (kind === 'visits') onNavigate?.('visits', '');
  }, [onOpenBroker, onNavigate, brokerCodes]);

  const payload = data?.payload;
  const brief = payload?.brief;
  const sig = payload?.signals;
  const counts = payload?.counts || sig?.counts || {};

  return (
    <div className="as-root">
      <AsStyles />

      <div className="as-head">
        <div className="as-head-tx">
          <div className="as-kick">✨ AI Suggestions · your morning brief</div>
          {brief && <div className="as-greet">{brief.greeting}</div>}
          {brief && <div className="as-headline">{brief.headline}</div>}
        </div>
        <div className="as-head-meta">
          {data && <span className="as-when">{data.cached ? 'Updated' : 'Generated'} {fmtTime(data.generated_at)}</span>}
          {isAdmin && (
            <button type="button" className="as-refresh" onClick={refresh} disabled={busy}>
              {busy ? '…' : '↻'} Refresh
            </button>
          )}
        </div>
      </div>

      {!data && !err && <div className="as-loading"><span className="as-spin" /> Preparing your brief… the first load of the day can take up to a minute.</div>}
      {err && <div className="as-err">⚠️ Couldn’t load your brief — {err} <button className="as-link" onClick={refresh}>retry</button></div>}

      {data && (
        <>
          {/* stat chips */}
          <div className="as-stats">
            <Stat n={counts.active_leads} label="Active leads" />
            <Stat n={counts.overdue_followups} label="Overdue FUs" tone={counts.overdue_followups ? 'bad' : ''} />
            <Stat n={counts.due_today} label="Due today" tone={counts.due_today ? 'warn' : ''} />
            <Stat n={counts.near_closing} label="Near closing" tone={counts.near_closing ? 'good' : ''} />
            <Stat n={counts.no_next_fu} label="No next-FU" tone={counts.no_next_fu ? 'bad' : ''} />
            <Stat n={counts.going_cold} label="Going cold" tone={counts.going_cold ? 'bad' : ''} />
            <Stat n={counts.awaiting_update} label="Awaiting update" />
          </div>

          {/* priorities (the brief) */}
          <div className="as-card">
            <div className="as-card-h">Today’s priorities, in order</div>
            <ol className="as-prio">
              {(brief?.priorities || []).map((p, i) => {
                const clickable = isClickable(p);
                return (
                  <li key={i} className={'as-prio-item' + (clickable ? ' clickable' : '')}
                      onClick={clickable ? () => go(p.link_kind, p.link_ref) : undefined}>
                    <span className="as-prio-ic">{KIND_ICON[p.link_kind] || '•'}</span>
                    <span className="as-prio-tx">{p.text}</span>
                    {clickable && <span className="as-prio-go">{p.link_kind === 'broker' ? 'Open CP ↗' : 'Open ↗'}</span>}
                  </li>
                );
              })}
              {(!brief?.priorities || brief.priorities.length === 0) && (
                <li className="as-prio-item"><span className="as-prio-tx">Nothing pending right now — you’re on top of it. 🎉</span></li>
              )}
            </ol>
          </div>

          {/* Follow-up discipline — the no-next-step / overdue / going-cold panel.
              Personal lists for everyone; the per-RM team roll-up shows only when the
              user oversees more than one RM (TL/Admin). Rides the scoped signals. */}
          {(sig?.no_next_fu?.length > 0 || sig?.going_cold?.length > 0 || (sig?.team_discipline?.length || 0) > 1) && (
            <div className="as-card">
              <div className="as-card-h">
                🔔 Follow-up discipline
                <span className="as-count">{counts.no_next_fu || 0} no next-step · {counts.overdue_followups || 0} overdue · {counts.going_cold || 0} going cold</span>
              </div>

              {sig?.team_discipline?.length > 1 && (
                <div className="as-team">
                  <div className="as-team-row as-team-head">
                    <span>Team member</span><span>Active</span><span>No next-FU</span><span>Overdue</span><span>Going cold</span>
                  </div>
                  {sig.team_discipline.map((r) => (
                    <button type="button" key={r.rm} className="as-team-row" onClick={() => onNavigate?.('visits', r.rm)}>
                      <span className="as-team-rm">{r.rm}</span>
                      <span>{r.active}</span>
                      <span className={r.no_fu ? 'as-x bad' : 'as-x'}>{r.no_fu}</span>
                      <span className={r.overdue ? 'as-x warn' : 'as-x'}>{r.overdue}</span>
                      <span className={r.cold ? 'as-x bad' : 'as-x'}>{r.cold}</span>
                    </button>
                  ))}
                </div>
              )}

              {sig?.no_next_fu?.length > 0 && (
                <div className="as-disc">
                  <div className="as-disc-sub">Leads with no next step <span className="as-count">{sig.no_next_fu.length}</span></div>
                  {sig.no_next_fu.slice(0, 12).map((r, i) => (
                    <button type="button" key={i} className="as-lead" onClick={() => onNavigate?.('visits', r.buyer)}>
                      <span className="as-lead-l"><b>{r.buyer}</b><span className="as-lead-sub">{r.society || ''}{r.rm ? ' · ' + r.rm : ''}</span></span>
                      <span className={'as-pill ' + (r.status === 'hot' ? 'bad' : r.status === 'warm' ? 'warn' : '')}>{r.status}</span>
                    </button>
                  ))}
                  {sig.no_next_fu.length > 12 && (
                    <button type="button" className="as-more" onClick={() => onNavigate?.('visits', '')}>+{sig.no_next_fu.length - 12} more — set next steps in Visits ↗</button>
                  )}
                </div>
              )}

              {sig?.going_cold?.length > 0 && (
                <div className="as-disc">
                  <div className="as-disc-sub">🧊 Hot / Warm going cold <span className="as-count">{sig.going_cold.length}</span></div>
                  {sig.going_cold.slice(0, 8).map((r, i) => (
                    <button type="button" key={i} className="as-lead" onClick={() => onNavigate?.('visits', r.buyer)}>
                      <span className="as-lead-l"><b>{r.buyer}</b><span className="as-lead-sub">{r.society || ''}{r.rm ? ' · ' + r.rm : ''}</span></span>
                      <span className="as-pill bad">{r.days_since}d cold</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* CP reactivation — partners who were active 30–90 days ago but have had
              no visit in the last 30 (activity_category D60/D90_active). The viewer's
              OWN CPs (cp_owner) float to the top. Rides the scoped brokers; hidden
              when there are none. Read-only — opens the CP profile, changes nothing. */}
          {sig?.cp_slipping?.length > 0
            && (me.team === 'Admin' || me.team === 'TL' || me.team === 'KAM' || sig.cp_slipping.some((b) => b.owned)) && (
            <div className="as-card">
              <div className="as-card-h">
                🤝 CPs to reactivate
                <span className="as-count">{counts.cp_slipping || 0} slipping{counts.cp_dormant ? ` · ${counts.cp_dormant} dormant` : ''}</span>
              </div>
              <div className="as-disc-sub" style={{ margin: '2px 0 6px' }}>
                Active 30–90 days ago, then silent the last 30 — nudge them before they churn.
                {sig.cp_slipping.some((b) => b.owned) ? ` ${sig.cp_slipping.filter((b) => b.owned).length} are yours (★).` : ''}
              </div>
              {sig.cp_slipping.slice(0, 12).map((b) => (
                <button type="button" key={b.cp_code} className="as-broker" onClick={() => onOpenBroker?.(b.cp_code)}>
                  <span className="as-broker-l">
                    <b>{b.name}{b.owned ? <span style={{ color: '#B45309' }} title="Your CP"> ★</span> : null}</b>
                    <span className="as-broker-sub">{b.cp_code} · {b.all_time_visits} visit{b.all_time_visits === 1 ? '' : 's'} all-time{b.tier && b.tier !== 'T4' ? ' · ' + b.tier : ''}</span>
                  </span>
                  <span className={'as-pill ' + (b.activity === 'D90_active' ? 'bad' : 'warn')}>{b.window}</span>
                </button>
              ))}
              {sig.cp_slipping.length > 12 && (
                <button type="button" className="as-more" onClick={() => onNavigate?.('cps', '')}>+{sig.cp_slipping.length - 12} more — view in Channel Partners ↗</button>
              )}
            </div>
          )}

          <div className="as-cols">
            {/* brokers to call */}
            {sig?.broker_calls?.length > 0 && (
              <div className="as-card as-col">
                <div className="as-card-h">Channel partners to call <span className="as-count">{sig.broker_calls.length}</span></div>
                {sig.broker_calls.map((b) => (
                  <button type="button" key={b.cp_code} className="as-broker" onClick={() => onOpenBroker?.(b.cp_code)}>
                    <span className="as-broker-l">
                      <b>{b.broker}</b>
                      <span className="as-broker-sub">{b.cp_code}{b.buyers?.length ? ' · ' + b.buyers.slice(0, 3).join(', ') : ''}</span>
                    </span>
                    <span className="as-pill">{b.pending_followups} pending</span>
                  </button>
                ))}
              </div>
            )}

            {/* leads near closing */}
            {sig?.near_closing?.length > 0 && (
              <div className="as-card as-col">
                <div className="as-card-h">Leads near closing <span className="as-count">{sig.near_closing.length}</span></div>
                {sig.near_closing.slice(0, 15).map((r, i) => (
                  <button type="button" key={i} className="as-lead" onClick={() => onNavigate?.('visits', r.buyer)}>
                    <span className="as-lead-l">
                      <b>{r.buyer}</b>
                      <span className="as-lead-sub">{r.stage}{r.society ? ' · ' + r.society : ''}</span>
                    </span>
                    {r.overdue_days > 0 && <span className="as-pill bad">{r.overdue_days}d overdue</span>}
                  </button>
                ))}
                {sig.near_closing.length > 15 && (
                  <button type="button" className="as-more" onClick={() => onNavigate?.('visits', '')}>+{sig.near_closing.length - 15} more — view all in Visits ↗</button>
                )}
              </div>
            )}
          </div>

          <div className="as-foot">
            Generated from your own leads only. {brief?._fallback ? 'Showing a quick summary (AI brief unavailable right now).' : 'Prioritised by AI from live visit data.'} Tap any point to jump to it.
          </div>
        </>
      )}
    </div>
  );
}

function Stat({ n, label, tone = '' }) {
  return (
    <div className={'as-stat ' + tone}>
      <div className="as-stat-n">{n ?? 0}</div>
      <div className="as-stat-l">{label}</div>
    </div>
  );
}

function AsStyles() {
  return (
    <style>{`
.as-root{--as-brand:#F4541C;--as-mut:#6E6E73;--as-faint:#9A9AA0;--as-line:#ECEAE6;--as-line2:#E2DFD9;--as-bg:#F6F4F0;--as-ink2:#3C3C3C}
.as-head{display:flex;align-items:flex-start;gap:14px;background:linear-gradient(135deg,#FFF4EE,#FFE7DB);border:1px solid #FAD2BF;border-radius:14px;padding:15px 17px;margin-bottom:13px}
.as-head-tx{flex:1;min-width:0}
.as-kick{font-size:10px;font-weight:800;letter-spacing:.09em;color:var(--as-brand);text-transform:uppercase}
.as-greet{font-size:18px;font-weight:800;letter-spacing:-.02em;margin:3px 0 2px}
.as-headline{font-size:13.5px;color:#7a5e4d;line-height:1.5}
.as-head-meta{flex:0 0 auto;display:flex;flex-direction:column;align-items:flex-end;gap:7px}
.as-when{font-size:11px;color:var(--as-mut);white-space:nowrap}
.as-refresh{background:#fff;border:1px solid var(--as-line2);border-radius:9px;padding:7px 12px;font-size:12.5px;font-weight:700;color:var(--as-ink2);cursor:pointer;white-space:nowrap}
.as-refresh:disabled{opacity:.5;cursor:default}
.as-loading{display:flex;align-items:center;gap:10px;justify-content:center;padding:40px;color:var(--as-mut);font-size:14px}
.as-spin{width:16px;height:16px;border:2px solid var(--as-line2);border-top-color:var(--as-brand);border-radius:50%;animation:as-rot .7s linear infinite}
@keyframes as-rot{to{transform:rotate(360deg)}}
.as-err{background:#FFF1E9;border:1px solid #F6C7AE;color:#9A3412;border-radius:11px;padding:12px 14px;font-size:13px}
.as-link{background:none;border:none;color:var(--as-brand);font-weight:700;cursor:pointer}
.as-stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(88px,1fr));gap:9px;margin-bottom:13px}
.as-stat{background:#fff;border:1px solid var(--as-line);border-radius:11px;padding:11px 8px;text-align:center}
.as-stat-n{font-size:21px;font-weight:800;color:#1A1A1A;line-height:1}
.as-stat-l{font-size:10.5px;font-weight:700;color:var(--as-faint);text-transform:uppercase;letter-spacing:.03em;margin-top:5px}
.as-stat.bad .as-stat-n{color:#B91C1C}.as-stat.warn .as-stat-n{color:#B45309}.as-stat.good .as-stat-n{color:#147A3D}
.as-card{background:#fff;border:1px solid var(--as-line);border-radius:13px;padding:14px 15px;margin-bottom:13px}
.as-card-h{font-size:11px;font-weight:800;letter-spacing:.05em;text-transform:uppercase;color:var(--as-faint);margin-bottom:10px;display:flex;align-items:center;gap:8px}
.as-count{background:var(--as-bg);color:var(--as-ink2);border-radius:999px;padding:1px 8px;font-size:11px}
.as-prio{list-style:none;margin:0;padding:0;counter-reset:p}
.as-prio-item{display:flex;align-items:flex-start;gap:11px;padding:10px 8px;border-radius:9px;border-bottom:1px solid var(--as-line)}
.as-prio-item:last-child{border-bottom:none}
.as-prio-item.clickable{cursor:pointer}
.as-prio-item.clickable:hover{background:#FFF7F3}
.as-prio-ic{flex:0 0 auto;width:24px;height:24px;border-radius:7px;background:var(--as-bg);color:var(--as-brand);display:grid;place-items:center;font-size:13px;font-weight:800}
.as-prio-tx{flex:1;font-size:13.5px;line-height:1.5;color:#2A2A2A}
.as-prio-go{flex:0 0 auto;font-size:11px;font-weight:700;color:var(--as-brand);white-space:nowrap;align-self:center}
.as-cols{display:grid;grid-template-columns:1fr 1fr;gap:13px}
.as-col{margin-bottom:0}
.as-broker,.as-lead{width:100%;display:flex;align-items:center;gap:10px;justify-content:space-between;background:#fff;border:1px solid var(--as-line);border-radius:10px;padding:9px 11px;margin-bottom:8px;cursor:pointer;text-align:left;font-family:inherit}
.as-broker:hover,.as-lead:hover{border-color:var(--as-brand);background:#FFF7F3}
.as-broker-l,.as-lead-l{min-width:0;display:flex;flex-direction:column}
.as-broker-l b,.as-lead-l b{font-size:13.5px;color:#1A1A1A}
.as-broker-sub,.as-lead-sub{font-size:11.5px;color:var(--as-mut);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:230px}
.as-pill{flex:0 0 auto;background:#FEEEE7;color:var(--as-brand);font-size:11px;font-weight:800;padding:3px 9px;border-radius:7px;white-space:nowrap}
.as-pill.bad{background:#FCEBEB;color:#B91C1C}
.as-more{width:100%;background:none;border:1px dashed var(--as-line2);border-radius:9px;padding:8px;font-size:12px;font-weight:700;color:var(--as-brand);cursor:pointer;margin-top:2px}
.as-pill.warn{background:#FEF3E2;color:#B45309}
.as-team{border:1px solid var(--as-line);border-radius:9px;overflow:hidden;margin-bottom:11px}
.as-team-row{display:grid;grid-template-columns:1.6fr .7fr 1fr .8fr 1fr;align-items:center;gap:6px;width:100%;text-align:left;background:#fff;border:none;border-bottom:1px solid var(--as-line);padding:8px 11px;font-size:12.5px;color:#2A2A2A;cursor:pointer;font-family:inherit}
.as-team-row:last-child{border-bottom:none}
.as-team-row:hover{background:#FFF7F3}
.as-team-head{background:var(--as-bg);font-size:10px;font-weight:800;letter-spacing:.04em;text-transform:uppercase;color:var(--as-faint);cursor:default}
.as-team-head:hover{background:var(--as-bg)}
.as-team-rm{font-weight:700;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.as-team-row>span:not(.as-team-rm){text-align:center}
.as-x{font-weight:700;color:var(--as-ink2)}
.as-x.bad{color:#B91C1C}.as-x.warn{color:#B45309}
.as-disc{margin-top:4px}
.as-disc-sub{font-size:11px;font-weight:800;letter-spacing:.04em;text-transform:uppercase;color:var(--as-faint);margin:10px 0 6px;display:flex;align-items:center;gap:8px}
.as-foot{font-size:11.5px;color:var(--as-mut);text-align:center;padding:6px 0 2px;line-height:1.5}
@media(max-width:760px){.as-stats{grid-template-columns:repeat(3,1fr)}.as-cols{grid-template-columns:1fr}}
`}</style>
  );
}
