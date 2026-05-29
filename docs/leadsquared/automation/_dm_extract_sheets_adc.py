"""ADC-aware Google Sheets extractor (Cloud Run uses the job's SA via ADC; no key file).
Mirrors root _dm_extract_sheets.py + cp_owner (Broker_data_query 'LeadSquare')."""
import json, time, sys, os
from googleapiclient.discovery import build
try:
    import google.auth
    creds,_=google.auth.default(scopes=['https://www.googleapis.com/auth/spreadsheets'])
except Exception:
    from google.oauth2.service_account import Credentials
    SA=os.environ.get('SA_PATH','/Users/akshit.chaudhary/Documents/Claude Code/Property level report/credentials/service_account.json')
    creds=Credentials.from_service_account_file(SA,scopes=['https://www.googleapis.com/auth/spreadsheets'])
svc=build('sheets','v4',credentials=creds)
def grab(sid,tab):
    v=svc.spreadsheets().values().get(spreadsheetId=sid,range=tab,
        valueRenderOption='UNFORMATTED_VALUE',dateTimeRenderOption='FORMATTED_STRING').execute().get('values',[])
    if not v: return []
    h=[str(c).strip() for c in v[0]]
    return [dict(zip(h,[('' if c is None else c) for c in (list(r)+['']*(len(h)-len(r)))])) for r in v[1:]]
JOBS=[('visitors_data','17eEX021t97pGnJasMJ6v7ERE0jezKEC0S8teKepJRWQ','Sheet1'),
 ('broker_master','1bUkpfbceA7lLpMhRh2aoB-oGCwnzUiyD4sIclm25Z1k','Sheet1'),
 ('visit_form','1Gclly9_BeHy8KysQrj6M6DCkK_VqSbpDov17H185l4s','Responses'),
 ('prop_master','16VriaamcwNIVTFYFWx4cWz0L1d826sPcsB-ukIkBc28','Property Master'),
 ('live_inv','1w8N63xMJJQwgz0mtNWbtpoOfU_PkYF_t5_jM9nMnCuQ','Total count of Properties')]
for name,sid,tab in JOBS:
    try:
        r=grab(sid,tab); json.dump(r,open(f'/tmp/dm_sheet_{name}.json','w'),default=str)
        print(name,len(r),flush=True)
    except Exception as e:
        print(name,'ERR',str(e)[:120],flush=True)
try:
    r=grab('1bUkpfbceA7lLpMhRh2aoB-oGCwnzUiyD4sIclm25Z1k','LeadSquare')
    json.dump(r,open('/tmp/dm_sheet_cp_owner.json','w'),default=str); print('cp_owner',len(r),flush=True)
except Exception as e:
    print('cp_owner ERR',str(e)[:120],flush=True)
