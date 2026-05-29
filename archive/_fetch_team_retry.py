#!/usr/bin/env python3
import os, csv, time, gspread
from pathlib import Path
from google.oauth2.service_account import Credentials

OUT = Path(__file__).parent / "sheet_snapshots/team"
sa = os.environ.get(
    "GOOGLE_APPLICATION_CREDENTIALS",
    os.path.expanduser("~/.openhouse/credentials/service-account.json"),
)
if not os.path.exists(sa):
    raise SystemExit(
        f"Service account JSON not found at {sa}. "
        "Set GOOGLE_APPLICATION_CREDENTIALS."
    )
creds = Credentials.from_service_account_file(sa, scopes=["https://www.googleapis.com/auth/spreadsheets.readonly"])
gc = gspread.authorize(creds)
sh = gc.open_by_key("18XoHGVorN5cMOIJSvfqS2cS6teGi-iq98xwdCp3ZBjk")

TARGETS = [
    "22 99acres Brokers — Noida",
    "23 99acres Brokers — Ghaziabad",
    "24 Top 99acres Brokers by City",
    "25 Brokers per Live Property",
    "26 Tier 1+2 CP Engagement Plan",
    "27 Team-Wise Action Plan",
    "28 Team Plan v2 (Detailed)",
]

# wait for quota reset
time.sleep(65)

for name in TARGETS:
    for attempt in range(3):
        try:
            ws = sh.worksheet(name)
            vals = ws.get_all_values()
            break
        except gspread.exceptions.APIError as e:
            if "429" in str(e):
                print(f"  rate-limited, sleep 35s ({name})")
                time.sleep(35)
                continue
            print(f"  ! {name}: {e}"); vals = None; break
        except Exception as e:
            print(f"  ! {name}: {e}"); vals = None; break
    if not vals:
        continue
    header = vals[0]; data = vals[1:]
    with (OUT / f"{name}.head.csv").open("w", newline="") as fp:
        w = csv.writer(fp); w.writerow(header)
        for r in data[:20]: w.writerow(r)
    with (OUT / f"{name}.schema.md").open("w") as fp:
        fp.write(f"# team / {name}\n\n- data rows: {len(data)}\n\n| # | Column | Examples |\n|---|---|---|\n")
        for i,c in enumerate(header):
            samp=[]
            for r in data[:80]:
                if i<len(r) and (r[i] or "").strip():
                    v=r[i].strip().replace("|","/")
                    if v not in samp: samp.append(v)
                    if len(samp)>=3: break
            fp.write(f"| {i} | `{c}` | {' • '.join(samp) or '_(empty)_'} |\n")
    print(f"ok {name}: {len(data)} rows")
    time.sleep(8)

print("done")
