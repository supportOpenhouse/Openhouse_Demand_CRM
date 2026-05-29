#!/usr/bin/env python3
"""Pull the four sheets the CRM depends on and write tab summaries + sample rows.

Reads service-account creds from $GOOGLE_APPLICATION_CREDENTIALS.
Output: ./sheet_snapshots/<sheet-name>/<tab>.{schema.md, head.csv}
"""

import os, json, csv, sys
from pathlib import Path
import gspread
from google.oauth2.service_account import Credentials

SHEETS = {
    "visitors":      "17eEX021t97pGnJasMJ6v7ERE0jezKEC0S8teKepJRWQ",
    "brokers":       "1bUkpfbceA7lLpMhRh2aoB-oGCwnzUiyD4sIclm25Z1k",
    "live_inventory":"1-kxlCnXUv7absl4rpWeMoYIxSAHpWykyjpd9v_5df-o",
    "team":          "18XoHGVorN5cMOIJSvfqS2cS6teGi-iq98xwdCp3ZBjk",
}

OUT = Path(__file__).parent / "sheet_snapshots"
OUT.mkdir(exist_ok=True)

# load env for the path
sa_path = os.environ.get(
    "GOOGLE_APPLICATION_CREDENTIALS",
    os.path.expanduser("~/.openhouse/credentials/service-account.json"),
)
if not os.path.exists(sa_path):
    raise SystemExit(
        f"Service account JSON not found at {sa_path}. "
        "Set GOOGLE_APPLICATION_CREDENTIALS or place the file at "
        "~/.openhouse/credentials/service-account.json"
    )
creds = Credentials.from_service_account_file(sa_path, scopes=[
    "https://www.googleapis.com/auth/spreadsheets.readonly",
    "https://www.googleapis.com/auth/drive.readonly",
])
gc = gspread.authorize(creds)

summary = {}
for nick, sid in SHEETS.items():
    print(f"\n=== {nick} ({sid}) ===", flush=True)
    out_dir = OUT / nick
    out_dir.mkdir(exist_ok=True)
    try:
        sh = gc.open_by_key(sid)
    except Exception as e:
        print(f"  ! ERROR opening sheet: {e}", flush=True)
        summary[nick] = {"error": str(e)}
        continue
    summary[nick] = {"title": sh.title, "tabs": []}
    print(f"  title: {sh.title}", flush=True)
    for ws in sh.worksheets():
        print(f"  - tab: {ws.title}  ({ws.row_count}x{ws.col_count})", flush=True)
        try:
            vals = ws.get_all_values()
        except Exception as e:
            print(f"      ! couldn't read: {e}", flush=True)
            continue
        if not vals:
            continue
        # auto-detect header row: first non-empty row near top
        header_idx = 0
        for i, row in enumerate(vals[:5]):
            if any((c or "").strip() for c in row):
                header_idx = i
                break
        header = vals[header_idx]
        data_rows = vals[header_idx + 1:]
        # write head csv (header + up to 20 sample rows)
        head_path = out_dir / f"{ws.title.replace('/', '_')}.head.csv"
        with head_path.open("w", newline="") as fp:
            w = csv.writer(fp)
            w.writerow(header)
            for row in data_rows[:20]:
                w.writerow(row)
        # write schema md with column index + name + 3 sample non-empty values
        schema_path = out_dir / f"{ws.title.replace('/', '_')}.schema.md"
        with schema_path.open("w") as fp:
            fp.write(f"# {nick} / {ws.title}\n\n")
            fp.write(f"- sheet id: `{sid}`\n")
            fp.write(f"- tab dims: {ws.row_count} x {ws.col_count}\n")
            fp.write(f"- header row at index {header_idx} (1-based: row {header_idx+1})\n")
            fp.write(f"- data rows: {len(data_rows)}\n\n")
            fp.write("| # | Column | Example values |\n|---|---|---|\n")
            for i, col in enumerate(header):
                samples = []
                for r in data_rows[:60]:
                    if i < len(r) and (r[i] or "").strip():
                        v = r[i].strip()
                        if v and v not in samples:
                            samples.append(v)
                        if len(samples) >= 3:
                            break
                fp.write(f"| {i} | `{col}` | {' • '.join(s.replace('|','/') for s in samples) or '_(empty)_'} |\n")
        summary[nick]["tabs"].append({
            "name": ws.title,
            "rows": len(data_rows),
            "cols": len(header),
            "header": header,
        })

with (OUT / "SUMMARY.json").open("w") as fp:
    json.dump(summary, fp, indent=2)
print("\nDone. Snapshots in:", OUT)
