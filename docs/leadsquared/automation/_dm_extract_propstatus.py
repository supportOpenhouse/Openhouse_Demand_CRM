"""Extract property-ageing 'Property Status' tab -> /tmp/dm_propstatus.json"""
import json,os
from googleapiclient.discovery import build
SCOPES=['https://www.googleapis.com/auth/spreadsheets']
try:
    import google.auth
    cr,_=google.auth.default(scopes=SCOPES)
except Exception:
    from google.oauth2.service_account import Credentials
    j=os.environ.get('GS_SA_JSON')
    SA='/Users/akshit.chaudhary/Documents/Claude Code/Property level report/credentials/service_account.json'
    cr=Credentials.from_service_account_info(json.loads(j),scopes=SCOPES) if j else Credentials.from_service_account_file(SA,scopes=SCOPES)
svc=build('sheets','v4',credentials=cr)
v=svc.spreadsheets().values().get(spreadsheetId='127SOgmUuTVoeoU0uHWm0LjzHNSyZWAttWlFn93ybLAs',range='Property Status',valueRenderOption='UNFORMATTED_VALUE',dateTimeRenderOption='FORMATTED_STRING').execute().get('values',[])
hdr=[str(c).replace(chr(10),' ').strip() for c in v[0]]
rows=[dict(zip(hdr,[('' if c is None else c) for c in (list(r)+['']*(len(hdr)-len(r)))])) for r in v[1:] if any(str(x).strip() for x in r)]
json.dump({'headers':hdr,'rows':rows},open('/tmp/dm_propstatus.json','w'),default=str)
print('propstatus rows:',len(rows))
