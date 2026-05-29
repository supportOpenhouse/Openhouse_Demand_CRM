"""
LeadSquared snapshot tool.

Pulls every customizable piece of the LeadSquared instance reachable via the
public API and writes:
  - snapshots/raw/<section>.json   — full API payload (source of truth)
  - snapshots/<section>.md         — human-readable summary Claude can read
  - snapshots/SUMMARY.md           — top-level index + counts + failure log

Re-run any time. Idempotent. Failures in one section don't stop the others.
"""
from __future__ import annotations

import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

ROOT = Path(__file__).parent
RAW = ROOT / "snapshots" / "raw"
OUT = ROOT / "snapshots"
RAW.mkdir(parents=True, exist_ok=True)


def load_env() -> dict[str, str]:
    env = {}
    for line in (ROOT / ".env").read_text().splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            env[k.strip()] = v.strip()
    return env


ENV = load_env()
HOST = ENV["LSQ_API_HOST"].rstrip("/")
AUTH = {"accessKey": ENV["LSQ_ACCESS_KEY"], "secretKey": ENV["LSQ_SECRET_KEY"]}

FAILURES: list[tuple[str, str]] = []
SECTIONS: list[tuple[str, str, int]] = []  # (name, file, count)


def call(path: str, params: dict | None = None, body: Any = None, method: str = "GET") -> Any:
    qs = urllib.parse.urlencode({**AUTH, **(params or {})})
    url = f"{HOST}{path}?{qs}"
    data = None
    headers = {"Accept": "application/json"}
    if body is not None:
        data = json.dumps(body).encode()
        headers["Content-Type"] = "application/json"
        method = "POST"
    req = urllib.request.Request(url, data=data, method=method, headers=headers)
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read())


def save_raw(name: str, data: Any) -> Path:
    p = RAW / f"{name}.json"
    p.write_text(json.dumps(data, indent=2, ensure_ascii=False))
    return p


def section(name: str):
    """Decorator: run the function, catch errors, log to FAILURES/SECTIONS."""
    def deco(fn):
        def wrapper():
            print(f"  → {name} ...", end=" ", flush=True)
            try:
                count = fn()
                print(f"OK ({count})")
                return count
            except urllib.error.HTTPError as e:
                msg = f"HTTP {e.code}: {e.read().decode()[:200]}"
                print(f"FAIL {msg}")
                FAILURES.append((name, msg))
            except Exception as e:
                print(f"FAIL {type(e).__name__}: {e}")
                FAILURES.append((name, f"{type(e).__name__}: {e}"))
        return wrapper
    return deco


# ---------- Sections ----------

@section("Lead fields")
def snap_lead_fields():
    data = call("/v2/LeadManagement.svc/LeadsMetaData.Get")
    save_raw("lead_fields", data)
    lines = ["# Lead Fields", "", f"Total: **{len(data)}**", ""]
    custom = [f for f in data if str(f.get("SchemaName", "")).startswith("mx_")]
    standard = [f for f in data if not str(f.get("SchemaName", "")).startswith("mx_")]
    lines.append(f"- Standard fields: {len(standard)}")
    lines.append(f"- Custom fields (mx_*): {len(custom)}")
    lines.append("")
    for label, fields in [("Custom Fields", custom), ("Standard Fields", standard)]:
        lines.append(f"## {label}")
        lines.append("")
        lines.append("| Schema Name | Display | Type | Mandatory | Options |")
        lines.append("|---|---|---|---|---|")
        for f in sorted(fields, key=lambda x: x.get("SchemaName", "")):
            opts = f.get("Options") or []
            opt_preview = ", ".join(o.get("Value", "") for o in opts[:6])
            if len(opts) > 6:
                opt_preview += f" … (+{len(opts) - 6})"
            lines.append(
                f"| `{f.get('SchemaName','')}` | {f.get('DisplayName','')} | "
                f"{f.get('DataType','')} | {'✓' if f.get('IsMandatory') else ''} | {opt_preview} |"
            )
        lines.append("")
    (OUT / "lead_fields.md").write_text("\n".join(lines))
    SECTIONS.append(("Lead fields", "lead_fields.md", len(data)))
    return len(data)


@section("Activity types")
def snap_activity_types():
    data = call("/v2/ProspectActivity.svc/ActivityTypes.Get")
    items = data if isinstance(data, list) else data.get("List", data)
    save_raw("activity_types", data)
    custom = [a for a in items if a.get("EventType") == 2]
    standard = [a for a in items if a.get("EventType") != 2]
    lines = ["# Activity Types", "",
             f"Total: **{len(items)}** ({len(custom)} custom, {len(standard)} standard)", "",
             "## Custom Activities (EventType=2)", "",
             "| Event Code | Name | Display | Score | Direction |",
             "|---|---|---|---|---|"]
    for a in sorted(custom, key=lambda x: x.get("ActivityEvent", 0)):
        lines.append(
            f"| {a.get('ActivityEvent','')} | {a.get('ActivityEventName','')} | "
            f"{a.get('DisplayName','')} | {a.get('Score','')} | {a.get('EventDirection','')} |"
        )
    lines += ["", "## Standard Activities", "",
              "| Event Code | Name | Display |", "|---|---|---|"]
    for a in sorted(standard, key=lambda x: x.get("ActivityEvent", 0)):
        lines.append(
            f"| {a.get('ActivityEvent','')} | {a.get('ActivityEventName','')} | "
            f"{a.get('DisplayName','')} |"
        )
    (OUT / "activity_types.md").write_text("\n".join(lines))
    SECTIONS.append(("Activity types", "activity_types.md", len(items)))
    return len(items)


@section("Activity type schemas")
def snap_activity_schemas():
    """For each CUSTOM activity type, pull its full setting (custom fields)."""
    types_path = RAW / "activity_types.json"
    if not types_path.exists():
        return 0
    data = json.loads(types_path.read_text())
    items = data if isinstance(data, list) else data.get("List", data)
    custom = [a for a in items if a.get("EventType") == 2]
    schemas = {}
    failures = []
    for a in custom:
        code = a.get("ActivityEvent")
        if code is None:
            continue
        try:
            schemas[str(code)] = call("/v2/ProspectActivity.svc/CustomActivity/GetActivitySetting",
                                      params={"code": code})
        except urllib.error.HTTPError as e:
            failures.append((code, e.code))
        time.sleep(0.05)
    save_raw("activity_schemas", schemas)
    lines = ["# Custom Activity Schemas", "",
             f"Captured **{len(schemas)}** custom activity schemas.", ""]
    if failures:
        lines.append(f"Failed: {failures}")
        lines.append("")
    for code, sch in schemas.items():
        name = next((a.get('ActivityEventName','') for a in items
                     if str(a.get('ActivityEvent')) == code), '')
        lines.append(f"## {name} (code {code})")
        fields = (sch.get("ActivityFields") or sch.get("Fields")
                  or sch.get("ActivityProperties") or [])
        if not fields:
            lines.append("_No custom fields_")
            lines.append("")
            continue
        lines.append("| Schema Name | Display | Type | Mandatory |")
        lines.append("|---|---|---|---|")
        for f in fields:
            lines.append(
                f"| `{f.get('SchemaName','')}` | {f.get('DisplayName','')} | "
                f"{f.get('DataType','')} | {'✓' if f.get('IsMandatory') else ''} |"
            )
        lines.append("")
    (OUT / "activity_schemas.md").write_text("\n".join(lines))
    SECTIONS.append(("Activity schemas", "activity_schemas.md", len(schemas)))
    return len(schemas)


@section("Users")
def snap_users():
    data = call("/v2/UserManagement.svc/Users.Get")
    items = data if isinstance(data, list) else data.get("Users", data)
    save_raw("users", data)
    lines = ["# Users", "", f"Total: **{len(items)}**", "",
             "| ID | Name | Email | Role | Active | Reports To |",
             "|---|---|---|---|---|---|"]
    for u in items:
        name = f"{u.get('FirstName','')} {u.get('LastName','')}".strip()
        lines.append(
            f"| {u.get('ID','')} | {name} | {u.get('EmailAddress','')} | "
            f"{u.get('Role','')} | {'✓' if u.get('IsActive') else ''} | "
            f"{u.get('AssociatedManagerEmail','') or ''} |"
        )
    (OUT / "users.md").write_text("\n".join(lines))
    SECTIONS.append(("Users", "users.md", len(items)))
    return len(items)


@section("Sales groups")
def snap_sales_groups():
    data = call("/v2/UserGroup.svc/Retrieve")
    items = data if isinstance(data, list) else data.get("List", data)
    save_raw("sales_groups", data)
    lines = ["# Sales Groups", "",
             f"Total: **{len(items) if hasattr(items, '__len__') else 'N/A'}**", ""]
    if isinstance(items, list) and items and isinstance(items[0], dict):
        lines += ["| ID | Name | Users | Description |", "|---|---|---|---|"]
        for g in items:
            lines.append(
                f"| {g.get('GroupId','')} | {g.get('Name','')} | "
                f"{g.get('UserCount','')} | {(g.get('Description') or '')[:80]} |"
            )
    else:
        lines += ["```json", json.dumps(items, indent=2)[:6000], "```"]
    (OUT / "sales_groups.md").write_text("\n".join(lines))
    n = len(items) if hasattr(items, '__len__') else 0
    SECTIONS.append(("Sales groups", "sales_groups.md", n))
    return n


@section("Task types")
def snap_task_types():
    data = call("/v2/Task.svc/RetrieveTaskType")
    items = data if isinstance(data, list) else data.get("List", data)
    save_raw("task_types", data)
    lines = ["# Task Types", "",
             f"Total: **{len(items) if hasattr(items, '__len__') else 'N/A'}**", ""]
    if isinstance(items, list) and items and isinstance(items[0], dict):
        lines += ["| ID | Name | Category |", "|---|---|---|"]
        for t in items:
            cat = t.get("Category", "")
            cat_label = {"0": "Appointment", "1": "To-do", 0: "Appointment", 1: "To-do"}.get(cat, cat)
            lines.append(
                f"| {t.get('TaskTypeId','')} | {t.get('TaskName','')} | {cat_label} |"
            )
    else:
        lines += ["```json", json.dumps(items, indent=2)[:6000], "```"]
    (OUT / "task_types.md").write_text("\n".join(lines))
    n = len(items) if hasattr(items, '__len__') else 0
    SECTIONS.append(("Task types", "task_types.md", n))
    return n


@section("Lead lists")
def snap_lead_lists():
    data = call("/v2/LeadManagement.svc/Lists.Get")
    items = data if isinstance(data, list) else data.get("List", data)
    save_raw("lead_lists", data)
    lines = ["# Lead Lists", "",
             f"Total: **{len(items) if hasattr(items, '__len__') else 'N/A'}**", ""]
    if isinstance(items, list) and items and isinstance(items[0], dict):
        lines += ["| ID | Name | Type | Members | Description |", "|---|---|---|---|---|"]
        for l in items:
            lines.append(
                f"| {l.get('ListId','')} | {l.get('ListName','')} | "
                f"{l.get('ListType','')} | {l.get('MemberCount','')} | "
                f"{(l.get('ListDescription') or '')[:80]} |"
            )
    else:
        lines += ["```json", json.dumps(items, indent=2)[:6000], "```"]
    (OUT / "lead_lists.md").write_text("\n".join(lines))
    n = len(items) if hasattr(items, '__len__') else 0
    SECTIONS.append(("Lead lists", "lead_lists.md", n))
    return n


@section("Webhooks")
def snap_webhooks():
    body = {
        "Parameter": {"Type": "Webhook"},
        "Sorting": {"ColumnName": "ModifiedOn", "Direction": "1"},
        "Paging": {"PageIndex": 1, "PageSize": 200},
    }
    data = call("/v2/Webhook.svc/Retrieve", body=body)
    save_raw("webhooks", data)
    items = data if isinstance(data, list) else (data.get("List") or data.get("Webhooks") or data)
    lines = ["# Webhooks", "",
             f"Total: **{len(items) if hasattr(items, '__len__') else 'N/A'}**", ""]
    if isinstance(items, list) and items and isinstance(items[0], dict):
        lines += ["| ID | Event | Method | URL | Status |", "|---|---|---|---|---|"]
        for w in items:
            lines.append(
                f"| {w.get('WebhookId','')} | {w.get('EventName','')} | "
                f"{w.get('Method','')} | `{(w.get('URL') or '')[:80]}` | {w.get('StatusCode','')} |"
            )
    else:
        lines += ["```json", json.dumps(data, indent=2)[:8000], "```"]
    (OUT / "webhooks.md").write_text("\n".join(lines))
    n = len(items) if hasattr(items, '__len__') else 0
    SECTIONS.append(("Webhooks", "webhooks.md", n))
    return n


# ---------- Main ----------

def main():
    print(f"Snapshotting {HOST} → {OUT.relative_to(ROOT)}/")
    snap_lead_fields()
    snap_activity_types()
    snap_activity_schemas()
    snap_users()
    snap_sales_groups()
    snap_task_types()
    snap_lead_lists()
    snap_webhooks()

    # Top-level summary
    summary = ["# LeadSquared Snapshot", "",
               f"Host: `{HOST}`",
               f"Generated: {time.strftime('%Y-%m-%d %H:%M:%S %Z')}", "",
               "## Captured", ""]
    for name, file, count in SECTIONS:
        summary.append(f"- [{name}]({file}) — {count}")
    if FAILURES:
        summary += ["", "## Not available via API",
                    "_These need manual export from the LeadSquared UI:_", ""]
        for name, msg in FAILURES:
            summary.append(f"- **{name}** — {msg}")
    summary += ["", "## Known UI-only items",
                "These have no public list-all API and require manual capture from the LeadSquared UI:",
                "",
                "- **Automations** (Workflow designer) — export each automation diagram as PNG/PDF;",
                "  the trigger + steps + conditions need to be transcribed to markdown",
                "- **Landing Pages and Web Forms** — export HTML / form definition from UI",
                "- **Smart Views / Lead Views** — screenshot the column + filter config",
                "- **Process Designer / Sales Process flows** — diagram export",
                "- **Opportunity Types** — no list endpoint (have to read codes from",
                "  Settings → Opportunities → Opportunity Types, then use",
                "  /v2/OpportunityManagement.svc/GetOpportunityTypeMetadata?code=<code>)",
                "- **Permission templates / roles**",
                "- **Email/SMS templates** (partial API exists)",
                "- **Lead distribution rules**"]
    (OUT / "SUMMARY.md").write_text("\n".join(summary))
    print(f"\nDone. See snapshots/SUMMARY.md")
    if FAILURES:
        print(f"({len(FAILURES)} sections failed — see SUMMARY.md)")


if __name__ == "__main__":
    main()
