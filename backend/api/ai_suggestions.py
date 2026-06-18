"""AI Suggestions — a short, role-aware morning brief for each team member.

For every active user we:
  1. scope the snapshot to exactly what they're allowed to see (reusing
     seed_snapshot.scope_for_user — the SAME who-sees-what the app uses), then
  2. compute deterministic SIGNALS from their scoped visits (leads near closing,
     follow-ups due/overdue, channel-partners with pending follow-ups, leads
     awaiting a status update), then
  3. ask Claude (Sonnet) to PRIORITISE and PHRASE those facts into a friendly,
     actionable brief. Claude only ever sees the computed signals, so it can't
     invent leads/brokers.

Nothing here writes to CRM data. Persistence (the ai_suggestions cache table) and
the cron/endpoint live in main.py. Degrades gracefully: no ANTHROPIC_API_KEY or no
signals → a deterministic fallback brief is returned (never raises).

The stage / follow-up helpers below are a faithful Python port of the frontend
lib/visits.js (visitStage / visitStatus / isClosedLead / nextFuFor) so "what they
should be updating" matches what the user sees in the Visits tab exactly.
"""
from __future__ import annotations

import datetime as dt
import logging
from typing import Optional

from . import config

log = logging.getLogger("api.ai_suggestions")

_MODEL = "claude-sonnet-4-6"

# stages that are CLOSED for follow-up purposes (mirror lib/visits.js TERMINAL_STAGES)
_TERMINAL_STAGES = {"future_prospect", "not_interested"}
# advanced pipeline stages = "near closing" (need a push / status update)
_NEAR_CLOSING = {"revisit_scheduled", "after_revisit_fu", "negotiation",
                 "after_negotiation_fu", "booking", "ats", "need_more"}
_STAGE_LABEL = {
    "revisit_scheduled": "Revisit scheduled", "after_revisit_fu": "After-revisit follow-up",
    "negotiation": "In negotiation", "after_negotiation_fu": "After-negotiation follow-up",
    "booking": "Booking", "ats": "ATS", "need_more": "Needs more options",
}


def _today() -> dt.date:
    return dt.date.today()


def _date(s) -> Optional[dt.date]:
    if not s:
        return None
    try:
        return dt.date.fromisoformat(str(s)[:10])
    except ValueError:
        return None


def _ymd(d: dt.date) -> str:
    return d.isoformat()


# ---- ports of lib/visits.js -------------------------------------------------

def visit_stage(v: dict, today: dt.date) -> str:
    ts = _ymd(today)
    st = v.get("_stage")
    if st:
        rev = v.get("_revisit_date")
        neg = v.get("_negotiation_date")
        if st == "revisit_scheduled" and rev and rev[:10] < ts:
            return "after_revisit_fu"
        if st == "revisit":
            return "after_revisit_fu" if (rev and rev[:10] < ts) else "revisit_scheduled"
        if st == "negotiation" and neg and neg[:10] < ts:
            return "after_negotiation_fu"
        return st
    s = (v.get("status") or "").lower()
    if s == "upcoming":
        return "upcoming"
    if s == "cancelled":
        return "cancelled"
    ls = (v.get("lead_status") or "").lower()
    if ls == "future_prospect":
        return "future_prospect"
    if ls == "dead":
        note = (v.get("latest_followup_note") or "").lower()
        if "more propert" in note:
            return "need_more"
        return "not_interested"
    return "avfu"


def visit_status(v: dict) -> str:
    ls = (v.get("lead_status") or "").lower()
    return ls if ls in ("hot", "warm", "cold", "dead", "future_prospect") else "unc"


def is_closed_lead(v: dict, today: dt.date) -> bool:
    stage = visit_stage(v, today)
    if stage in _TERMINAL_STAGES:
        return True
    if visit_status(v) == "dead" and stage != "need_more":
        return True
    return False


def is_completed(v: dict, today: dt.date) -> bool:
    return visit_stage(v, today) not in ("upcoming", "cancelled")


def next_fu(v: dict, today: dt.date) -> Optional[str]:
    """Scheduled next follow-up date (None for closed leads), mirroring nextFuFor."""
    if is_closed_lead(v, today):
        return None
    return v.get("_next_followup_date")


# ---- signals ----------------------------------------------------------------

def _first_name(name: str) -> str:
    return (name or "").strip().split(" ")[0] if name else ""


def compute_signals(scoped: dict, user: dict) -> dict:
    """Deterministic facts from the user's SCOPED visits. No Claude, no I/O."""
    today = _today()
    visits = scoped.get("visits", [])
    # current-inventory liveness per unit (Ready/Coming Soon = True); see seed_snapshot.build
    live_by_home_id = scoped.get("live_by_home_id") or {}

    near_closing: list[dict] = []
    overdue: list[dict] = []          # follow-up date in the past
    due_today: list[dict] = []
    awaiting_update = 0
    broker_pending: dict[str, int] = {}
    broker_name: dict[str, str] = {}
    broker_buyers: dict[str, list] = {}
    hot = warm = active = 0

    for v in visits:
        if v.get("is_old_lead"):
            continue                  # dead inventory — not actionable
        # hide dead / dropped leads (status Dead, or stage not-interested / future-prospect)
        if is_closed_lead(v, today):
            continue
        # show only leads whose unit is still in LIVE inventory; skip only when we
        # positively know it's off-market (Sold / Booked / Archived). Unknown unit → keep.
        hid = v.get("home_id")
        if hid and live_by_home_id.get(hid) is False:
            continue
        stage = visit_stage(v, today)
        status = visit_status(v)
        completed = stage not in ("upcoming", "cancelled")
        closed = is_closed_lead(v, today)

        if status == "hot":
            hot += 1
        elif status == "warm":
            warm += 1
        if completed and not closed:
            active += 1

        # leads near closing — advanced stage, still open
        if stage in _NEAR_CLOSING and not closed:
            nf = next_fu(v, today)
            od = (today - _date(nf)).days if _date(nf) else None
            near_closing.append({
                "buyer": v.get("buyer_name") or "Buyer",
                "society": v.get("society_name") or "",
                "stage": _STAGE_LABEL.get(stage, stage),
                "broker": v.get("broker_name") or "",
                "cp_code": v.get("cp_code") or "",
                "next_followup": nf or "",
                "overdue_days": od if (od is not None and od > 0) else 0,
                "note": (v.get("latest_followup_note") or "")[:140],
            })

        # follow-ups due / overdue (open, completed visits with a scheduled next-FU)
        nf = next_fu(v, today)
        if completed and not closed and nf:
            d = _date(nf)
            if d:
                od = (today - d).days
                row = {
                    "buyer": v.get("buyer_name") or "Buyer",
                    "society": v.get("society_name") or "",
                    "broker": v.get("broker_name") or "",
                    "cp_code": v.get("cp_code") or "",
                    "due": nf, "overdue_days": od,
                }
                if od > 0:
                    overdue.append(row)
                elif od == 0:
                    due_today.append(row)
                if od >= 0 and v.get("cp_code"):
                    cp = v["cp_code"]
                    broker_pending[cp] = broker_pending.get(cp, 0) + 1
                    broker_name[cp] = v.get("broker_name") or cp
                    bn = v.get("buyer_name") or "Buyer"
                    broker_buyers.setdefault(cp, [])
                    if bn not in broker_buyers[cp]:
                        broker_buyers[cp].append(bn)

        # completed, open, but lead status never set → needs a status update
        if completed and not closed and (v.get("lead_status") or "select_status") == "select_status":
            awaiting_update += 1

    overdue.sort(key=lambda r: -r["overdue_days"])
    near_closing.sort(key=lambda r: -r["overdue_days"])
    broker_calls = sorted(
        ({"cp_code": cp, "broker": broker_name.get(cp, cp), "pending_followups": n,
          "buyers": broker_buyers.get(cp, [])[:6]}
         for cp, n in broker_pending.items()),
        key=lambda r: -r["pending_followups"],
    )

    return {
        "counts": {
            "active_leads": active, "hot": hot, "warm": warm,
            "overdue_followups": len(overdue), "due_today": len(due_today),
            "near_closing": len(near_closing), "awaiting_update": awaiting_update,
        },
        # generous caps — the user wants comprehensive, not truncated, lists
        "near_closing": near_closing[:40],
        "overdue": overdue[:40],
        "due_today": due_today[:40],
        "broker_calls": broker_calls[:25],
    }


def _role_context(user: dict) -> str:
    team = user.get("team")
    if team == "Admin":
        return ("This person is an ADMIN — give an org-wide overview across all teams and cities, "
                "highlighting where the most pipeline value and the most overdue work sit.")
    if team == "TL" or (user.get("role") or "").endswith("tl"):
        return ("This person is a TEAM LEAD — frame it as a view of THEIR MARKET/TEAM: where to focus the "
                "team today, which areas have the most near-closing leads and the most overdue follow-ups.")
    if team == "KAM":
        return ("This person is a KAM (key-account manager) — their book is their CHANNEL PARTNERS. Focus on "
                "which partners to call and which of their buyers are near closing.")
    if team == "Ground":
        return ("This person is a PROPERTY MANAGER — their book is the buyers/leads at THEIR PROPERTIES. Focus on "
                "leads near closing at their societies and follow-ups they owe.")
    return "Give a concise, actionable view of this person's open leads and pending follow-ups."


def _has_anything(signals: dict) -> bool:
    c = signals["counts"]
    return any(c[k] for k in ("active_leads", "overdue_followups", "due_today", "near_closing", "awaiting_update"))


def _fallback_brief(user: dict, signals: dict) -> dict:
    """Deterministic, still-clickable brief when Claude is unavailable. Builds the
    same {text, link_kind, link_ref} priority shape straight from the signals,
    priority-ordered (overdue → near-closing → due-today → status updates)."""
    c = signals["counts"]
    fn = _first_name(user.get("name") or user.get("slug") or "there")
    pr: list[dict] = []
    for r in signals["overdue"]:
        d = r["overdue_days"]
        pr.append({"text": f"Overdue {d}d: {r['buyer']} at {r['society']}"
                           + (f" — call {r['broker']}" if r.get("broker") else ""),
                   "link_kind": "lead", "link_ref": r["buyer"]})
    for r in signals["near_closing"]:
        if r.get("overdue_days"):
            continue  # already covered above
        pr.append({"text": f"{r['stage']}: {r['buyer']} at {r['society']}",
                   "link_kind": "lead", "link_ref": r["buyer"]})
    for r in signals["due_today"]:
        pr.append({"text": f"Follow-up due today: {r['buyer']} at {r['society']}",
                   "link_kind": "lead", "link_ref": r["buyer"]})
    if c["awaiting_update"]:
        pr.append({"text": f"Update the lead status on {c['awaiting_update']} completed visit(s).",
                   "link_kind": "visits", "link_ref": ""})
    if not pr:
        pr.append({"text": "No pending follow-ups or near-closing leads right now — a good place to be.",
                   "link_kind": "none", "link_ref": ""})
    return {
        "greeting": f"Good morning, {fn}.",
        "headline": pr[0]["text"],
        "priorities": pr[:30],
        "_fallback": True,
    }


_SCHEMA = {
    "type": "object",
    "properties": {
        "greeting": {"type": "string", "description": "One warm line, e.g. 'Good morning, <first name>.'"},
        "headline": {"type": "string", "description": "The single most important focus for today, one sentence."},
        "priorities": {
            "type": "array",
            "maxItems": 30,
            "description": "EVERY meaningful action item for today, ordered by priority (most urgent first: "
                           "overdue follow-ups, then near-closing leads, then today's follow-ups, then status "
                           "updates). Do NOT cap at a small number — if there are 12 things to do, return 12; if 25, "
                           "return up to 25. Group only when several items are genuinely the same single action.",
            "items": {
                "type": "object",
                "properties": {
                    "text": {"type": "string", "description": "The action to take — specific, concise, with the buyer/society/broker named."},
                    "link_kind": {"type": "string", "enum": ["broker", "lead", "visits", "none"],
                                  "description": "What clicking this point should open: 'broker' = the channel partner's profile; "
                                                 "'lead' = the buyer's visit; 'visits' = the visits list; 'none' = not linkable."},
                    "link_ref": {"type": "string",
                                 "description": "For link_kind 'broker': the partner's EXACT cp_code copied from the data (e.g. 'CP01543'). "
                                                "For 'lead': the buyer's EXACT name copied from the data. Otherwise an empty string."},
                },
                "required": ["text", "link_kind", "link_ref"],
            },
        },
    },
    "required": ["greeting", "headline", "priorities"],
}


def _trim_for_prompt(signals: dict) -> dict:
    """Give Claude the TOP items of each list (not all 40) so it can prioritise
    without trying to emit a point per item and blowing the output-token budget.
    The frontend still renders the full lists from the cached signals."""
    return {
        "counts": signals["counts"],
        "overdue": signals["overdue"][:15],
        "near_closing": signals["near_closing"][:15],
        "due_today": signals["due_today"][:12],
        "broker_calls": signals["broker_calls"][:12],
    }


def _prompt(user: dict, signals: dict) -> str:
    import json
    fn = _first_name(user.get("name") or user.get("slug") or "")
    return (
        "You are an assistant writing a short, motivating MORNING BRIEF for a real-estate sales team member, "
        "to help them plan their day. Be concise, specific and action-oriented.\n\n"
        f"TEAM MEMBER: {user.get('name') or user.get('slug')} (first name: {fn})\n"
        f"ROLE CONTEXT: {_role_context(user)}\n\n"
        "Here are the FACTS — the TOP open items for the leads this person is responsible for (the full counts are in "
        "'counts'). Use ONLY these — do not invent buyers, brokers or numbers; every name and cp_code below is exact:\n"
        f"{json.dumps(_trim_for_prompt(signals), indent=1, default=str)}\n\n"
        "Write the brief as: a warm greeting; a one-line headline of today's top focus; and a PRIORITISED list of "
        "action items. Don't cap it at a handful — include one point for each important item listed above (typically "
        "10-25 points), ordered strictly by urgency: overdue follow-ups first (most-overdue first), then near-closing "
        "leads to push, then today's follow-ups, then a point about the leads awaiting a status update. Name the buyer "
        "/ society / channel-partner in each point. Make each point CLICKABLE: set link_kind='broker' with "
        "link_ref=<exact cp_code> when the action is to call a partner; link_kind='lead' with link_ref=<exact buyer "
        "name> when it's about a specific buyer's visit; link_kind='visits' for a general 'review your visits' action; "
        "link_kind='none' if nothing to open. Copy cp_codes and names EXACTLY from the data above. If there's very "
        "little to do, say so positively. Return via the tool."
    )


def generate(user: dict, signals: dict) -> dict:
    """Claude-prioritised brief from the signals. Never raises — falls back to a
    deterministic brief on any error / missing key / empty signals."""
    if not config.ANTHROPIC_API_KEY or not _has_anything(signals):
        return _fallback_brief(user, signals)
    try:
        import anthropic
    except ImportError:
        log.warning("anthropic SDK not installed — using fallback brief")
        return _fallback_brief(user, signals)
    try:
        client = anthropic.Anthropic(api_key=config.ANTHROPIC_API_KEY)
        msg = client.messages.create(
            model=_MODEL,
            max_tokens=3500,
            tools=[{"name": "morning_brief", "description": "Return the structured morning brief.",
                    "input_schema": _SCHEMA}],
            tool_choice={"type": "tool", "name": "morning_brief"},
            messages=[{"role": "user", "content": _prompt(user, signals)}],
        )
        for block in msg.content:
            if getattr(block, "type", None) == "tool_use":
                out = dict(block.input)
                out["_fallback"] = False
                return out
        log.warning("ai brief: no tool_use block")
        return _fallback_brief(user, signals)
    except Exception as e:  # noqa: BLE001
        log.warning("ai brief failed (%s) — fallback", e)
        return _fallback_brief(user, signals)


def build_for_user(snap: dict, user: dict, scope_for_user) -> dict:
    """Scope a (shallow-copied) snapshot to the user, compute signals, generate the
    brief. `scope_for_user` is injected to avoid a circular import. Returns the full
    payload {counts, signals, brief} to cache + serve."""
    scoped = scope_for_user(dict(snap), user)
    signals = compute_signals(scoped, user)
    brief = generate(user, signals)
    return {"counts": signals["counts"], "signals": signals, "brief": brief,
            "for_date": _today().isoformat(), "team": user.get("team")}
