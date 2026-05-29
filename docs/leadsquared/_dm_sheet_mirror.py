"""Mirror dashboard changes into 'LSQ Demand Analysis':
   - Cohorts tab: retention triangle + 3 separate metric tables (Visits/Active/Active%)
   - New Segments tab: 9 behavioural segments, city-subgrouped, with CP + owner + visits."""
import json
from google.oauth2.service_account import Credentials
from googleapiclient.discovery import build
KEY='/Users/akshit.chaudhary/Documents/Claude Code/Property level report/credentials/service_account.json'
SID='1JJt4rGX_qFcS0UYnUm1a2LCxrCIs58IDWseimGQ9fo4'
creds=Credentials.from_service_account_file(KEY,scopes=['https://www.googleapis.com/auth/spreadsheets'])
svc=build('sheets','v4',credentials=creds)
R=json.load(open('/tmp/dm_results.json'))
B=json.load(open('/tmp/dm_dashboard_data.json'))
M=B['months']; brokers=B['brokers']

def ensure(name):
    m=svc.spreadsheets().get(spreadsheetId=SID).execute()
    ids={s['properties']['title']:s['properties']['sheetId'] for s in m['sheets']}
    if name not in ids:
        svc.spreadsheets().batchUpdate(spreadsheetId=SID,body={'requests':[{'addSheet':{'properties':{'title':name}}}]}).execute()
        m=svc.spreadsheets().get(spreadsheetId=SID).execute()
        ids={s['properties']['title']:s['properties']['sheetId'] for s in m['sheets']}
    return ids[name]
def put(tab,vals):
    svc.spreadsheets().values().clear(spreadsheetId=SID,range=tab).execute()
    svc.spreadsheets().values().update(spreadsheetId=SID,range=f"{tab}!A1",
        valueInputOption='RAW',body={'values':vals}).execute()
def freeze(tid,n=1):
    svc.spreadsheets().batchUpdate(spreadsheetId=SID,body={'requests':[
     {'updateSheetProperties':{'properties':{'sheetId':tid,'gridProperties':{'frozenRowCount':n}},'fields':'gridProperties.frozenRowCount'}}]}).execute()

CITY=['Gurgaon','Noida','Ghaziabad','Delhi','Multicity','Unknown']
def subgroup(rows,cols,numk):
    out=[];by={}
    for r in rows: by.setdefault(r.get('City') if r.get('City') in CITY else 'Unknown',[]).append(r)
    for c in CITY:
        if c not in by: continue
        mem=by[c]
        sr=[]
        for i,col in enumerate(cols):
            if i==0: sr.append(f'▌ {c}  (n={len(mem)})')
            elif col in numk: sr.append(sum(int(x.get(col) or 0) for x in mem))
            else: sr.append('')
        out.append(sr)
        for x in mem: out.append([x.get(col,'') for col in cols])
    return out

# ---------- Cohorts tab ----------
cid=ensure('Cohorts')
vals=[['COHORT VIEW — brokers grouped by ONBOARDING month (Aug-25 → May-26*)'],[]]
vals.append(['Cohort Retention Triangle (%) — green=healthy, red=decayed'])
crc=['Cohort','Size']+M
vals.append(crc)
for r in R['fm_cohort_ret']: vals.append([r.get(c,'') for c in crc])
vals.append([])
c2=['Cohort','Brokers onboarded']+M
for metric,title in [('Visits','TABLE — Cohort: Visits (by activity month)'),
                     ('Unique active brokers','TABLE — Cohort: Unique active brokers'),
                     ('Active %','TABLE — Cohort: Active %')]:
    vals.append([title]); vals.append(c2)
    for r in R['cohort']:
        if r.get('Metric')==metric: vals.append([r.get(c,'') for c in c2])
    vals.append([])
put('Cohorts',vals); freeze(cid,1)
print('Cohorts tab mirrored (triangle + 3 metric tables)')

# ---------- Segments tab ----------
sv=lambda b,k:int(b.get(k) or 0)
SEG=[('1. May visits',lambda b: sv(b,'2026-05')>0),
 ('2. Apr visits, no May',lambda b: sv(b,'2026-04')>0 and sv(b,'2026-05')==0),
 ('3. Mar visits, no Apr/May',lambda b: sv(b,'2026-03')>0 and sv(b,'2026-04')==0 and sv(b,'2026-05')==0),
 ('4. Feb visits, no Mar/Apr/May',lambda b: sv(b,'2026-02')>0 and sv(b,'2026-03')==0 and sv(b,'2026-04')==0 and sv(b,'2026-05')==0),
 ('5. Onboarded May, no May visits',lambda b: b.get('onb')=='2026-05' and sv(b,'2026-05')==0),
 ('6. Onboarded Apr, no Apr/May visits',lambda b: b.get('onb')=='2026-04' and sv(b,'2026-04')==0 and sv(b,'2026-05')==0),
 ('7. Onboarded Apr, Apr visit but no May',lambda b: b.get('onb')=='2026-04' and sv(b,'2026-04')>0 and sv(b,'2026-05')==0),
 ('8. Onboarded Mar, no visits till date',lambda b: b.get('onb')=='2026-03' and int(b.get('total') or 0)==0),
 ('9. Onboarded Mar, Mar/Apr visits but no May',lambda b: b.get('onb')=='2026-03' and (sv(b,'2026-03')>0 or sv(b,'2026-04')>0) and sv(b,'2026-05')==0)]
sid2=ensure('Segments')
cols=['CP Code','Broker','Company','CP Owner','City','Onboarded','Last active','Status']+M+['Visits total']
keymap={'CP Code':'cp','Broker':'name','Company':'company','CP Owner':'owner','City':'city',
        'Onboarded':'onb','Last active':'last_active','Status':'status','Visits total':'total'}
def rowmap(b):
    d={c:b.get(keymap.get(c,c),'') for c in cols}
    d['City']=b.get('city','Unknown')
    return d
vals=[['SEGMENTS — behavioural & onboarding cohorts (May=2026-05 partial to 18th). City-subgrouped.'],[]]
for label,test in SEG:
    mem=[rowmap(b) for b in brokers if test(b)]
    vals.append([f'{label}  —  {len(mem)} brokers'])
    vals.append(cols)
    vals+=subgroup(mem,cols,M+['Visits total'])
    vals.append([])
put('Segments',vals); freeze(sid2,1)
print(f'Segments tab created: 9 segments, {sum(1 for _ in brokers)} brokers scanned')
print('counts:',[(l,sum(1 for b in brokers if t(b))) for l,t in SEG])
