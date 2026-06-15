"""Property Report mailer.

A seller expects a periodic update on how their unit is performing. This module
builds that report from data the CRM already has, and drops it as a DRAFT into the
triggering admin's own Gmail (they add the recipient and hit send).

Three concerns, deliberately separated so each can fail independently without
breaking the others:

  1. build_report_data(conn, home_id)  — pure read from `visits`/`properties`,
     keyed on home_id. The counts here reconcile EXACTLY with the Analytics
     "Property Status" tab, which also matches visits to a unit by home_id
     (see frontend/src/lib/propertyStatus.js: visitsForProperty).
  2. summarize_feedback(...)           — optional Claude (Sonnet) pass that turns
     free-text visit remarks into a structured, seller-appropriate summary.
     Degrades gracefully: no API key or no feedback → returns None and the report
     simply omits the AI section.
  3. render_report_html(...) + create_gmail_draft(...) — a branded, inline-styled
     HTML email and the Gmail draft. The ONLY side effect in this module is
     creating a draft in the user's own mailbox (gmail.compose, never send).

Nothing here mutates CRM data.
"""
from __future__ import annotations

import base64
import datetime as dt
import html
import json
import logging
from email.mime.text import MIMEText
from typing import Optional

from . import config

log = logging.getLogger("api.reports")

# Sonnet for the summary — the user asked for the sonnet model specifically. Exact
# model id, no date suffix (per the Anthropic SDK guidance).
_SUMMARY_MODEL = "claude-sonnet-4-6"
_GMAIL_SCOPES = ["https://www.googleapis.com/auth/gmail.compose"]

# Brand palette (kept here, inline into the email — email clients strip <style>).
# Accent is the OpenHouse brand orange; header stays slate for a premium, report look.
_INK = "#0f172a"
_MUTED = "#64748b"
_LINE = "#e7e3dd"
_ACCENT = "#F4541C"
_BG = "#f6f4f0"


class DelegationNotConfigured(RuntimeError):
    """Raised when the Gmail draft can't be created because the service account
    isn't yet authorised for domain-wide delegation (gmail.compose). Surfaced to
    the admin as an actionable message rather than a 500."""


# ============================================================================
# 1. Metrics — read-only, keyed on home_id (matches the Analytics tab exactly)
# ============================================================================

# lead_status values that count as an "active" pipeline lead, mirroring
# visitStatus() in the frontend (which is just lead_status lower-cased).
_STATUS_ORDER = ["hot", "warm", "cold", "dead", "future_prospect"]
_FEEDBACK_FIELDS = ("sales_feedback", "buyer_feedback", "all_feedback", "latest_followup_note")
_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]


def _buyer_key(r) -> str:
    """Stable identity for unique-buyer counts: phone if present, else name."""
    return (r["buyer_contact"] or "").strip() or (r["buyer_name"] or "").strip().lower()


async def build_report_data(conn, home_id: str) -> Optional[dict]:
    """Returns {property, metrics, feedback_items} for a unit, or None if the
    home_id maps to no live property. All counts come from `visits` joined on
    home_id only — identical to how the app's Analytics tab counts them."""
    home_id = (home_id or "").strip()
    if not home_id:
        return None

    prop = await conn.fetchrow(
        """
        SELECT property_name, society_name, city, micro_market, configuration,
               listing_status, listing_price, sales_manager, home_id
          FROM properties
         WHERE home_id = $1 AND deleted_at IS NULL
         ORDER BY updated_at DESC NULLS LAST
         LIMIT 1
        """,
        home_id,
    )
    if not prop:
        return None

    rows = await conn.fetch(
        """
        SELECT COALESCE(visit_date, selected_date) AS vd,
               lead_status, current_stage, buyer_name, buyer_contact,
               sales_feedback, buyer_feedback, all_feedback, latest_followup_note
          FROM visits
         WHERE home_id = $1
        """,
        home_id,
    )

    today = dt.date.today()
    last7_from = today - dt.timedelta(days=7)

    till_date = len(rows)
    last_7d = 0
    by_status: dict[str, int] = {}
    monthly: dict[str, dict] = {}          # "YYYY-MM" → {visits, buyers:set}
    unique_buyers: set[str] = set()

    for r in rows:
        vd = r["vd"]
        bk = _buyer_key(r)
        if bk:
            unique_buyers.add(bk)
        ls = (r["lead_status"] or "").strip().lower()
        by_status[ls] = by_status.get(ls, 0) + 1
        if vd:
            if last7_from < vd <= today:
                last_7d += 1
            mk = f"{vd.year:04d}-{vd.month:02d}"
            m = monthly.setdefault(mk, {"visits": 0, "buyers": set()})
            m["visits"] += 1
            if bk:
                m["buyers"].add(bk)

    hot = by_status.get("hot", 0)
    warm = by_status.get("warm", 0)
    cold = by_status.get("cold", 0)
    dead = by_status.get("dead", 0)
    future = by_status.get("future_prospect", 0)
    # everything not in the explicit set (select_status, blank, null …) = "not updated"
    not_updated = till_date - (hot + warm + cold + dead + future)

    monthly_rows = [
        {
            "label": f"{_MONTHS[int(k[5:7]) - 1]} {k[0:4]}",
            "key": k,
            "visits": v["visits"],
            "buyers": len(v["buyers"]),
        }
        for k, v in sorted(monthly.items())
    ]

    # Feedback bundle for the summariser: most-recent first, only rows with text.
    fb_sorted = sorted(rows, key=lambda r: (r["vd"] or dt.date.min), reverse=True)
    feedback_items: list[dict] = []
    for r in fb_sorted:
        parts = [(r[f] or "").strip() for f in _FEEDBACK_FIELDS]
        text = " · ".join(p for p in parts if p)
        if not text:
            continue
        feedback_items.append(
            {
                "name": (r["buyer_name"] or "A buyer").strip() or "A buyer",
                "status": (r["lead_status"] or "").strip().lower() or "not_updated",
                "stage": (r["current_stage"] or "").strip(),
                "text": text,
            }
        )

    return {
        "property": {
            "property_name": prop["property_name"] or "",
            "society_name": prop["society_name"] or "",
            "city": prop["city"] or "",
            "micro_market": prop["micro_market"] or "",
            "configuration": prop["configuration"] or "",
            "listing_status": prop["listing_status"] or "",
            "listing_price": prop["listing_price"] or "",
            "sales_manager": prop["sales_manager"] or "",
            "home_id": prop["home_id"] or "",
        },
        "metrics": {
            "till_date": till_date,
            "last_7d": last_7d,
            "unique_buyers": len(unique_buyers),
            "hot": hot,
            "warm": warm,
            "cold": cold,
            "dead": dead,
            "future_prospect": future,
            "not_updated": not_updated,
            "pipeline": hot + warm,        # the "Hot + Warm pipeline" the seller cares about
            "monthly": monthly_rows,
            "report_date": today.isoformat(),
        },
        "feedback_items": feedback_items,
    }


# ============================================================================
# 2. Claude summary — structured, seller-appropriate, grounded in the notes
# ============================================================================

_SUMMARY_SCHEMA = {
    "type": "object",
    "properties": {
        "headline": {
            "type": "string",
            "description": "One concise sentence summarising overall buyer response to the unit.",
        },
        "positives": {
            "type": "array",
            "maxItems": 5,
            "items": {"type": "string"},
            "description": "Up to 5 positive observations buyers made (layout, location, light, value...).",
        },
        "objections": {
            "type": "array",
            "maxItems": 5,
            "items": {"type": "string"},
            "description": "Up to 5 common reasons buyers hesitated or did not proceed, framed constructively.",
        },
        "notable_leads": {
            "type": "array",
            "maxItems": 5,
            "items": {
                "type": "object",
                "properties": {
                    "name": {"type": "string", "description": "Buyer's first name."},
                    "detail": {"type": "string", "description": "One specific line about why they're promising."},
                },
                "required": ["name", "detail"],
            },
            "description": "Up to 5 genuinely high-potential (hot/warm) buyers. Empty if none stand out.",
        },
        "assessment": {
            "type": "string",
            "description": "2-3 sentences on where the unit currently stands.",
        },
        "recommendations": {
            "type": "array",
            "maxItems": 4,
            "items": {"type": "string"},
            "description": "2-4 concrete next steps the team will take to drive a closure.",
        },
    },
    "required": ["headline", "positives", "objections", "notable_leads", "assessment", "recommendations"],
}


def _summary_prompt(label: str, metrics: dict, feedback_items: list[dict]) -> str:
    lines = []
    for it in feedback_items[:80]:
        stage = f"/{it['stage']}" if it["stage"] else ""
        lines.append(f"- [{it['status']}{stage}] {it['name']}: {it['text']}")
    notes = "\n".join(lines)
    return (
        "You are preparing a professional property-performance summary for a real-estate "
        "SELLER (the owner of the unit below). The notes are buyer-visit remarks recorded by "
        "our sales team during tours of this specific unit.\n\n"
        f"PROPERTY: {label}\n"
        f"ACTIVITY: {metrics['till_date']} visits to date; "
        f"{metrics['hot']} hot + {metrics['warm']} warm active leads.\n\n"
        f"VISIT NOTES (status/stage | buyer | remark):\n{notes}\n\n"
        "Write the summary using ONLY the information in these notes. Do not invent facts. "
        "Use a professional, warm, seller-facing tone — no internal codes, broker names, or slang.\n"
        "TONE: the seller should come away feeling our team is actively and capably working to sell "
        "their property. Keep the entire report positive, reassuring and effort-forward. Never imply "
        "the property is hard to sell or speak negatively about it; present every point of hesitation "
        "as a normal, addressable market dynamic the team is already acting on.\n"
        "PRICING: you MAY note in general terms that some buyers perceived the price as on the higher "
        "side (or on the lower side), but keep it measured, brief and never extreme. Do NOT quote any "
        "specific price figure, amount, budget, offer or numeric range ANYWHERE in the summary "
        "(no '₹.. Cr', no numbers, no ranges).\n"
        "notable_leads: use the buyer's first name and a short QUALITATIVE detail (e.g. 'actively "
        "engaged and keen to revisit', 'seriously evaluating the unit') — never a price or offer amount.\n"
        "objections (points of hesitation): include ONLY neutral, addressable MARKET factors — a general "
        "price/value perception, configuration or size, floor / layout / view preference, location or "
        "connectivity, possession timeline, financing, or a comparison with other options. Do NOT mention "
        "the property's cleanliness, housekeeping, upkeep, condition, furnishing wear, smell, or "
        "presentation, and do NOT reference any shortcoming or delay on our own (the sales team's / "
        "OpenHouse's) side. If a remark is only about such things, leave it out. Keep every point "
        "constructive, measured, and never embarrassing to the owner or to OpenHouse.\n"
        "Return your answer by calling the provided tool."
    )


def summarize_feedback(label: str, metrics: dict, feedback_items: list[dict]) -> Optional[dict]:
    """Claude (Sonnet) summary of the visit feedback. Returns the structured dict,
    or None when there's nothing to summarise or the API key/SDK is unavailable.
    Never raises — the report must still generate if this step fails."""
    if not config.ANTHROPIC_API_KEY or not feedback_items:
        return None
    try:
        import anthropic
    except ImportError:
        log.warning("anthropic SDK not installed — skipping report summary")
        return None
    try:
        client = anthropic.Anthropic(api_key=config.ANTHROPIC_API_KEY)
        # Forced tool-use for structured output: the most version-robust path and a
        # response shape we can rely on (a single tool_use block whose .input is the dict).
        msg = client.messages.create(
            model=_SUMMARY_MODEL,
            max_tokens=2000,
            tools=[
                {
                    "name": "property_report_summary",
                    "description": "Return the structured seller-facing summary of the visit feedback.",
                    "input_schema": _SUMMARY_SCHEMA,
                }
            ],
            tool_choice={"type": "tool", "name": "property_report_summary"},
            messages=[{"role": "user", "content": _summary_prompt(label, metrics, feedback_items)}],
        )
        for block in msg.content:
            if getattr(block, "type", None) == "tool_use":
                return dict(block.input)
        log.warning("report summary: no tool_use block in response")
        return None
    except Exception as e:  # noqa: BLE001 — degrade gracefully on ANY API/SDK error
        log.warning("report summary failed: %s", e)
        return None


# ============================================================================
# 3. HTML render + Gmail draft
# ============================================================================

def default_subject(prop: dict) -> str:
    name = prop.get("property_name") or prop.get("society_name") or "Property"
    today = dt.date.today()
    return f"Property Update — {name} — {_MONTHS[today.month - 1]} {today.year}"


def _esc(s) -> str:
    return html.escape(str(s if s is not None else ""))


def _metric_card(label: str, value, accent: str = _ACCENT) -> str:
    return (
        f'<td style="padding:6px;" width="25%" valign="top">'
        f'<table role="presentation" width="100%" cellpadding="0" cellspacing="0" '
        f'style="border:1px solid {_LINE};border-radius:10px;background:#ffffff;">'
        f'<tr><td style="padding:14px 12px;text-align:center;">'
        f'<div style="font:700 26px/1 Arial,Helvetica,sans-serif;color:{accent};">{_esc(value)}</div>'
        f'<div style="font:600 11px/1.4 Arial,Helvetica,sans-serif;color:{_MUTED};'
        f'text-transform:uppercase;letter-spacing:.4px;margin-top:6px;">{_esc(label)}</div>'
        f"</td></tr></table></td>"
    )


def _section_title(text: str) -> str:
    return (
        f'<tr><td style="padding:26px 0 10px;">'
        f'<div style="font:700 16px/1.3 Arial,Helvetica,sans-serif;color:{_INK};'
        f'border-left:4px solid {_ACCENT};padding-left:10px;">{_esc(text)}</div>'
        f"</td></tr>"
    )


def _bullets(items: list[str]) -> str:
    if not items:
        return ""
    lis = "".join(
        f'<li style="margin:0 0 7px;">{_esc(i)}</li>' for i in items if str(i).strip()
    )
    return (
        f'<ul style="margin:4px 0 0;padding-left:20px;font:400 14px/1.6 Arial,Helvetica,sans-serif;'
        f'color:#334155;">{lis}</ul>'
    )


def render_report_html(prop: dict, metrics: dict, summary: Optional[dict],
                       prepared_by_name: str = "", prepared_by_email: str = "") -> str:
    """A branded, inline-styled HTML email. Email clients strip <style> blocks and
    ignore classes, so every rule is inline. Table-based layout for Outlook/Gmail."""
    pname = prop.get("property_name") or prop.get("society_name") or "Property"
    sub = " · ".join(
        x for x in [prop.get("configuration"), prop.get("micro_market"), prop.get("city")] if x
    )
    price = prop.get("listing_price") or ""
    report_dt = metrics.get("report_date") or dt.date.today().isoformat()
    try:
        d = dt.date.fromisoformat(report_dt)
        report_dt_h = f"{d.day} {_MONTHS[d.month - 1]} {d.year}"
    except ValueError:
        report_dt_h = report_dt

    # --- monthly trend rows ---
    monthly = metrics.get("monthly") or []
    if monthly:
        body_rows = "".join(
            f'<tr>'
            f'<td style="padding:8px 12px;border-top:1px solid {_LINE};font:400 13px Arial,Helvetica,sans-serif;color:#334155;">{_esc(m["label"])}</td>'
            f'<td style="padding:8px 12px;border-top:1px solid {_LINE};font:600 13px Arial,Helvetica,sans-serif;color:{_INK};text-align:center;">{_esc(m["visits"])}</td>'
            f'<td style="padding:8px 12px;border-top:1px solid {_LINE};font:400 13px Arial,Helvetica,sans-serif;color:#334155;text-align:center;">{_esc(m["buyers"])}</td>'
            f'</tr>'
            for m in monthly
        )
        monthly_table = (
            f'<table role="presentation" width="100%" cellpadding="0" cellspacing="0" '
            f'style="border:1px solid {_LINE};border-radius:10px;overflow:hidden;background:#fff;">'
            f'<tr style="background:{_BG};">'
            f'<td style="padding:9px 12px;font:700 11px Arial,Helvetica,sans-serif;color:{_MUTED};text-transform:uppercase;letter-spacing:.4px;">Month</td>'
            f'<td style="padding:9px 12px;font:700 11px Arial,Helvetica,sans-serif;color:{_MUTED};text-transform:uppercase;letter-spacing:.4px;text-align:center;">Visits</td>'
            f'<td style="padding:9px 12px;font:700 11px Arial,Helvetica,sans-serif;color:{_MUTED};text-transform:uppercase;letter-spacing:.4px;text-align:center;">Unique Buyers</td>'
            f'</tr>{body_rows}</table>'
        )
    else:
        monthly_table = ""

    # --- pipeline breakdown chips ---
    chips = [
        ("Hot", metrics.get("hot", 0), "#dc2626"),
        ("Warm", metrics.get("warm", 0), "#ea580c"),
        ("Cold", metrics.get("cold", 0), "#2563eb"),
        ("Not Interested", metrics.get("dead", 0), _MUTED),
        ("Awaiting Update", metrics.get("not_updated", 0), "#94a3b8"),
    ]
    pipeline_cells = "".join(
        f'<td style="padding:4px;" valign="top">'
        f'<table role="presentation" width="100%" cellpadding="0" cellspacing="0" '
        f'style="border:1px solid {_LINE};border-radius:8px;background:#fff;">'
        f'<tr><td style="padding:10px 8px;text-align:center;">'
        f'<div style="font:700 20px/1 Arial,Helvetica,sans-serif;color:{c};">{_esc(v)}</div>'
        f'<div style="font:600 10px/1.3 Arial,Helvetica,sans-serif;color:{_MUTED};margin-top:5px;text-transform:uppercase;letter-spacing:.3px;">{_esc(lbl)}</div>'
        f'</td></tr></table></td>'
        for lbl, v, c in chips
    )

    # --- AI summary sections ---
    summary_html = ""
    if summary:
        headline = summary.get("headline") or ""
        if headline:
            summary_html += (
                f'<tr><td style="padding:6px 0 2px;">'
                f'<div style="font:600 15px/1.5 Arial,Helvetica,sans-serif;color:{_INK};'
                f'background:{_BG};border-radius:10px;padding:14px 16px;">{_esc(headline)}</div></td></tr>'
            )
        if summary.get("positives"):
            summary_html += _section_title("What buyers are responding to")
            summary_html += f'<tr><td>{_bullets(summary["positives"])}</td></tr>'
        if summary.get("objections"):
            summary_html += _section_title("Common points of hesitation")
            summary_html += f'<tr><td>{_bullets(summary["objections"])}</td></tr>'
        notable = summary.get("notable_leads") or []
        notable = [n for n in notable if isinstance(n, dict) and (n.get("name") or n.get("detail"))]
        if notable:
            summary_html += _section_title("Notable high-potential buyers")
            cards = "".join(
                f'<tr><td style="padding:9px 14px;border:1px solid {_LINE};border-radius:8px;background:#fff;margin:0;">'
                f'<span style="font:700 14px Arial,Helvetica,sans-serif;color:{_INK};">{_esc(n.get("name") or "Buyer")}</span>'
                f'<span style="font:400 14px Arial,Helvetica,sans-serif;color:#334155;"> — {_esc(n.get("detail") or "")}</span>'
                f'</td></tr><tr><td style="height:8px;line-height:8px;">&nbsp;</td></tr>'
                for n in notable
            )
            summary_html += (
                f'<tr><td><table role="presentation" width="100%" cellpadding="0" cellspacing="0">{cards}</table></td></tr>'
            )
        if summary.get("assessment"):
            summary_html += _section_title("Where the unit stands")
            summary_html += (
                f'<tr><td style="font:400 14px/1.6 Arial,Helvetica,sans-serif;color:#334155;">{_esc(summary["assessment"])}</td></tr>'
            )
        if summary.get("recommendations"):
            summary_html += _section_title("Our plan of action")
            summary_html += f'<tr><td>{_bullets(summary["recommendations"])}</td></tr>'
    else:
        summary_html = (
            f'<tr><td style="padding:10px 0;font:400 13px/1.6 Arial,Helvetica,sans-serif;color:{_MUTED};">'
            f'A detailed feedback summary will accompany the next update.</td></tr>'
        )

    prepared = ""
    if prepared_by_name or prepared_by_email:
        who = _esc(prepared_by_name)
        mail = (
            f' · <a href="mailto:{_esc(prepared_by_email)}" style="color:{_ACCENT};text-decoration:none;">{_esc(prepared_by_email)}</a>'
            if prepared_by_email else ""
        )
        prepared = f'Prepared by {who}{mail}'

    price_h = (
        f'<span style="font:600 14px Arial,Helvetica,sans-serif;color:#fff;opacity:.92;">Asking&nbsp;{_esc(price)}</span>'
        if price else ""
    )

    return f"""\
<div style="margin:0;padding:0;background:{_BG};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:{_BG};padding:24px 0;">
<tr><td align="center">
<table role="presentation" width="640" cellpadding="0" cellspacing="0" style="width:640px;max-width:640px;background:#ffffff;border-radius:14px;overflow:hidden;border:1px solid {_LINE};">

  <!-- header -->
  <tr><td style="background:{_INK};padding:22px 28px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
      <td valign="middle">
        <div style="font:800 18px/1 Arial,Helvetica,sans-serif;color:#fff;letter-spacing:.3px;">OpenHouse</div>
        <div style="font:600 10px/1.4 Arial,Helvetica,sans-serif;color:#fdba8c;text-transform:uppercase;letter-spacing:2px;margin-top:4px;">Property Performance Report</div>
      </td>
      <td valign="middle" align="right" style="font:400 12px Arial,Helvetica,sans-serif;color:#cbd5e1;">{_esc(report_dt_h)}</td>
    </tr></table>
  </td></tr>

  <!-- property band -->
  <tr><td style="background:{_ACCENT};padding:18px 28px;">
    <div style="font:800 20px/1.3 Arial,Helvetica,sans-serif;color:#fff;">{_esc(pname)}</div>
    <div style="font:400 13px/1.5 Arial,Helvetica,sans-serif;color:#ffe7db;margin-top:3px;">{_esc(sub)}</div>
    <div style="margin-top:6px;">{price_h}</div>
  </td></tr>

  <!-- body -->
  <tr><td style="padding:8px 22px 28px;">

    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
      {_section_title("Visit activity")}
      <tr><td>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
          {_metric_card("Visits last 7 days", metrics.get("last_7d", 0), _INK)}
          {_metric_card("Visits to date", metrics.get("till_date", 0), _INK)}
          {_metric_card("Unique buyers", metrics.get("unique_buyers", 0), _INK)}
          {_metric_card("Hot + Warm pipeline", metrics.get("pipeline", 0), _ACCENT)}
        </tr></table>
      </td></tr>

      {('<tr><td style="padding:18px 0 0;">' + monthly_table + '</td></tr>') if monthly_table else ''}

      {_section_title("Lead pipeline")}
      <tr><td>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>{pipeline_cells}</tr></table>
      </td></tr>

      {_section_title("Buyer feedback & insights")}
      {summary_html}

    </table>
  </td></tr>

  <!-- footer -->
  <tr><td style="background:{_BG};padding:18px 28px;border-top:1px solid {_LINE};">
    <div style="font:400 12px/1.6 Arial,Helvetica,sans-serif;color:{_MUTED};">{prepared}</div>
    <div style="font:400 11px/1.6 Arial,Helvetica,sans-serif;color:#94a3b8;margin-top:6px;">
      This report is generated by the OpenHouse Demand team from live visit data. Figures reflect activity recorded as of {_esc(report_dt_h)}.
    </div>
  </td></tr>

</table>
</td></tr></table>
</div>"""


def _gmail_setup_error(status, reason: str, message: str, project_id: str) -> "DelegationNotConfigured":
    """Map a Gmail API failure to a friendly, actionable error (→ 503). Distinguishes
    the two one-time setup gaps that look alike (both 403): the Gmail API not being
    enabled in the service-account's Cloud project, vs domain-wide delegation not being
    authorised for the gmail.compose scope."""
    blob = f"{reason} {message}".lower()
    if ("accessnotconfigured" in blob or "service_disabled" in blob
            or "has not been used in project" in blob or ("gmail" in blob and "disabl" in blob)):
        link = (f"https://console.cloud.google.com/apis/library/gmail.googleapis.com?project={project_id}"
                if project_id else "https://console.cloud.google.com/apis/library/gmail.googleapis.com")
        where = project_id or "the service-account's Google Cloud project"
        return DelegationNotConfigured(
            f"The Gmail API isn't enabled in {where}. Enable it here: {link} — then wait a minute and "
            f"retry. (One-time setup.) [{status}] {message}"
        )
    if status == 401 or "unauthorized_client" in blob or "delegation" in blob or "not authorized" in blob:
        return DelegationNotConfigured(
            "Domain-wide delegation isn't authorised for the gmail.compose scope yet. In the Google "
            "Workspace Admin console → Security → Access and data control → API controls → Domain-wide "
            f"delegation, add the service account's client ID with scope {_GMAIL_SCOPES[0]}, then retry. "
            f"[{status}] {message}"
        )
    return DelegationNotConfigured(f"Gmail draft could not be created. [{status}] {(reason + ' ' + message).strip()}")


def create_gmail_draft(user_email: str, subject: str, html_body: str) -> dict:
    """Create a DRAFT (never send) in `user_email`'s mailbox via service-account
    domain-wide delegation. The recipient is intentionally left blank — the admin
    adds it in Gmail and sends. Two one-time prerequisites (see _gmail_setup_error):
    the Gmail API enabled in the SA's Cloud project, and the SA client_id authorised
    for the gmail.compose scope. Until both are done Google returns 403 and we raise
    DelegationNotConfigured with an actionable message."""
    if not (user_email or "").strip():
        raise RuntimeError("Cannot create a draft without the signed-in user's email.")

    # Lazy imports so the app boots even if these libs are ever absent.
    from google.oauth2.service_account import Credentials
    from googleapiclient.discovery import build
    from googleapiclient.errors import HttpError

    project_id = ""
    if config.GOOGLE_SERVICE_ACCOUNT_JSON:
        info = json.loads(config.GOOGLE_SERVICE_ACCOUNT_JSON)
        project_id = info.get("project_id", "")
        creds = Credentials.from_service_account_info(
            info, scopes=_GMAIL_SCOPES, subject=user_email
        )
    elif config.GOOGLE_APPLICATION_CREDENTIALS_PATH:
        creds = Credentials.from_service_account_file(
            config.GOOGLE_APPLICATION_CREDENTIALS_PATH, scopes=_GMAIL_SCOPES, subject=user_email
        )
    else:
        raise RuntimeError("No Google service-account credentials configured.")

    mime = MIMEText(html_body, "html", "utf-8")
    mime["subject"] = subject
    mime["from"] = user_email
    raw = base64.urlsafe_b64encode(mime.as_bytes()).decode()

    try:
        service = build("gmail", "v1", credentials=creds, cache_discovery=False)
        draft = (
            service.users()
            .drafts()
            .create(userId="me", body={"message": {"raw": raw}})
            .execute()
        )
    except HttpError as e:
        status = getattr(getattr(e, "resp", None), "status", None)
        message, reason = "", ""
        try:
            err = json.loads(e.content.decode()).get("error", {})
            message = err.get("message", "")
            errs = err.get("errors") or []
            reason = (errs[0].get("reason", "") if errs else "") or err.get("status", "")
        except Exception:  # noqa: BLE001
            message = str(e)
        raise _gmail_setup_error(status, reason, message, project_id) from e
    except Exception as e:  # refresh/credential errors (e.g. delegation not set) → friendly
        msg = str(e).lower()
        if "unauthorized_client" in msg or "delegation" in msg or "subject" in msg:
            raise _gmail_setup_error(401, "unauthorized_client", str(e), project_id) from e
        raise

    draft_id = draft.get("id", "")
    msg_id = (draft.get("message") or {}).get("id", "")
    return {
        "draft_id": draft_id,
        "message_id": msg_id,
        # Deep link to the draft in the user's Gmail (opens the compose window).
        "gmail_url": f"https://mail.google.com/mail/u/0/#drafts?compose={msg_id}" if msg_id else "https://mail.google.com/mail/u/0/#drafts",
    }
