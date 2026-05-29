"""Demand-analysis extraction — Google Sheets via service account. Caches to /tmp/dm_sheet_*.json"""
import json, time, sys
from google.oauth2.service_account import Credentials
from googleapiclient.discovery import build
sys.stdout.reconfigure(line_buffering=True)
KEY='/Users/akshit.chaudhary/Documents/Claude Code/Property level report/credentials/service_account.json'
creds=Credentials.from_service_account_file(KEY, scopes=['https://www.googleapis.com/auth/spreadsheets'])
svc=build('sheets','v4',credentials=creds)

def grab(sid,tab,rng=None):
    r=f'{tab}!{rng}' if rng else tab
    v=svc.spreadsheets().values().get(spreadsheetId=sid,range=r,
        valueRenderOption='UNFORMATTED_VALUE',dateTimeRenderOption='FORMATTED_STRING').execute().get('values',[])
    if not v: return []
    hdr=[str(c).strip() for c in v[0]]
    rows=[]
    for row in v[1:]:
        row=list(row)+['']*(len(hdr)-len(row))
        rows.append(dict(zip(hdr,row)))
    return rows

jobs=[
 ('visitors_data','17eEX021t97pGnJasMJ6v7ERE0jezKEC0S8teKepJRWQ','Sheet1',None),
 ('broker_master','1bUkpfbceA7lLpMhRh2aoB-oGCwnzUiyD4sIclm25Z1k','Sheet1',None),
 ('visit_form','1Gclly9_BeHy8KysQrj6M6DCkK_VqSbpDov17H185l4s','Responses',None),
 ('prop_master','16VriaamcwNIVTFYFWx4cWz0L1d826sPcsB-ukIkBc28','Property Master',None),
 ('live_inv','1w8N63xMJJQwgz0mtNWbtpoOfU_PkYF_t5_jM9nMnCuQ','Total count of Properties',None),
]
for name,sid,tab,rng in jobs:
    t=time.strftime('%H:%M:%S')
    try:
        rows=grab(sid,tab,rng)
        json.dump(rows,open(f'/tmp/dm_sheet_{name}.json','w'),default=str)
        cols=list(rows[0].keys()) if rows else []
        print(f'[{t}] {name}: {len(rows)} rows | cols={cols[:12]}{"..." if len(cols)>12 else ""}')
    except Exception as e:
        print(f'[{t}] {name} ERR {type(e).__name__}: {str(e)[:140]}')
print('DONE sheets')
