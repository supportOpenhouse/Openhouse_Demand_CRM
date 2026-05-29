#!/usr/bin/env bash
# Full OH Demand Dashboard refresh — invoked daily by the Claude Code routine.
# Runs ALL extracts, regenerates bundle, rebuilds dm_site, then the routine prompt
# tells the remote agent to deploy via the Netlify MCP and verify.
set -euo pipefail
cd "$(dirname "$0")"                       # repo root

# 0) Python deps (remote agent's sandbox is minimal)
python3 -m pip install --quiet --user \
  google-api-python-client google-auth google-auth-httplib2 \
  google-cloud-storage psycopg2-binary >/dev/null 2>&1 || true

# 1) Credentials — both must exist in the repo for the routine to work.
export SA_FILE="$PWD/service_account.json"
export GOOGLE_APPLICATION_CREDENTIALS="$SA_FILE"
[ -f .env ] || { echo "FATAL: .env missing in repo"; exit 1; }
[ -f "$SA_FILE" ] || { echo "FATAL: service_account.json missing in repo"; exit 1; }

# Some scripts hardcode the Mac SA path — symlink so they still work.
MAC_SA="/Users/akshit.chaudhary/Documents/Claude Code/Property level report/credentials/service_account.json"
mkdir -p "$(dirname "$MAC_SA")" 2>/dev/null && ln -sf "$SA_FILE" "$MAC_SA" 2>/dev/null || true

# 2) Extracts — sheets + LSQ (events + slow task scan) + events 216/217/220 + propstatus
echo "[$(date -u +%H:%M:%SZ)] === EXTRACTS ==="
python3 _dm_extract_sheets.py
# cp_owner (LeadSquare tab) — not pulled by _dm_extract_sheets.py
python3 - <<'PY'
import json
from google.oauth2.service_account import Credentials
from googleapiclient.discovery import build
import os
cr=Credentials.from_service_account_file(os.environ['SA_FILE'],scopes=['https://www.googleapis.com/auth/spreadsheets'])
svc=build('sheets','v4',credentials=cr)
v=svc.spreadsheets().values().get(spreadsheetId='1bUkpfbceA7lLpMhRh2aoB-oGCwnzUiyD4sIclm25Z1k',range='LeadSquare',valueRenderOption='UNFORMATTED_VALUE',dateTimeRenderOption='FORMATTED_STRING').execute().get('values',[])
h=[str(c).strip() for c in v[0]]
rows=[dict(zip(h,[('' if c is None else c) for c in (list(r)+['']*(len(h)-len(r)))])) for r in v[1:]]
json.dump(rows,open('/tmp/dm_sheet_cp_owner.json','w'),default=str)
print('cp_owner rows:',len(rows))
PY
python3 automation/_dm_extract_events.py
python3 automation/_dm_extract_propstatus.py
python3 _dm_extract_lsq.py            # SLOW — events + ~30 min task scan

# 3) Engine → bundle
echo "[$(date -u +%H:%M:%SZ)] === ENGINE / BUNDLE ==="
python3 _dm_engine.py
python3 _dm_dashdata.py
python3 _dm_enrich.py

# 4) Build dm_site (uses SA_FILE env to find the SA, then deploy via Netlify MCP)
python3 _dm_build_authsite.py
echo "[$(date -u +%H:%M:%SZ)] === BUILD DONE — dm_site ready for deploy ==="
python3 - <<'PY'
import json
B=json.load(open('dm_site/netlify/functions/_data.json'))
v=B['visits']
print(f'BUNDLE READY: visits={len(v)} | max date={max(x[\"date\"] for x in v)} | brokers={len(B[\"brokers\"])} | propstatus={len(B[\"propstatus\"][\"rows\"])}')
PY
