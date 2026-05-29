"""Write the demand-analysis report into 'LSQ Demand Analysis' (5 tabs), city-subgrouped."""
import json, time, sys
from google.oauth2.service_account import Credentials
from googleapiclient.discovery import build
sys.stdout.reconfigure(line_buffering=True)
KEY='/Users/akshit.chaudhary/Documents/Claude Code/Property level report/credentials/service_account.json'
SID='1JJt4rGX_qFcS0UYnUm1a2LCxrCIs58IDWseimGQ9fo4'
creds=Credentials.from_service_account_file(KEY,scopes=['https://www.googleapis.com/auth/spreadsheets'])
svc=build('sheets','v4',credentials=creds)
R=json.load(open('/tmp/dm_results.json'))
M=R['MONTHS']; CPOM=R['CPO_MONTHS']
CITY_ORDER=['Gurgaon','Noida','Ghaziabad','Delhi','Multicity','Unknown']

def ensure_tabs(names):
    meta=svc.spreadsheets().get(spreadsheetId=SID).execute()
    have={s['properties']['title']:s['properties']['sheetId'] for s in meta['sheets']}
    reqs=[]
    for n in names:
        if n not in have: reqs.append({'addSheet':{'properties':{'title':n}}})
    if reqs: svc.spreadsheets().batchUpdate(spreadsheetId=SID,body={'requests':reqs}).execute()
    meta=svc.spreadsheets().get(spreadsheetId=SID).execute()
    ids={s['properties']['title']:s['properties']['sheetId'] for s in meta['sheets']}
    # delete default Sheet1 if empty and not used
    if 'Sheet1' in ids and 'Sheet1' not in names:
        try: svc.spreadsheets().batchUpdate(spreadsheetId=SID,body={'requests':[{'deleteSheet':{'sheetId':ids['Sheet1']}}]}).execute()
        except: pass
        meta=svc.spreadsheets().get(spreadsheetId=SID).execute()
        ids={s['properties']['title']:s['properties']['sheetId'] for s in meta['sheets']}
    return ids

def city_of(r):
    c=r.get('City','Unknown'); return c if c in CITY_ORDER else 'Unknown'

def grouped(rows, cols, numcols):
    """Return 2D grid: per city -> subtotal row + member rows."""
    grid=[]
    bycity={}
    for r in rows: bycity.setdefault(city_of(r),[]).append(r)
    for c in CITY_ORDER:
        if c not in bycity: continue
        mem=bycity[c]
        sub=[f'▌ {c}'] + ['']*(len(cols)-1-len(numcols))
        # build subtotal aligned to columns
        strow=[]
        for i,col in enumerate(cols):
            if i==0: strow.append(f'▌ {c}  (n={len(mem)})')
            elif col in numcols:
                tot=sum((x.get(col) or 0) for x in mem if isinstance(x.get(col),(int,float)))
                strow.append(round(tot,1) if tot else 0)
            else: strow.append('')
        grid.append(('SUB',strow))
        for x in mem:
            grid.append(('ROW',[x.get(col,'') for col in cols]))
    return grid

def write_tab(tab, blocks):
    """blocks = list of (title, cols, grid-or-rows). Writes sequentially."""
    values=[]
    for b in blocks:
        kind=b[0]
        if kind=='H':       values.append([b[1]]); values.append([])
        elif kind=='SUBTTL':values.append([b[1]])
        elif kind=='TABLE':
            _,title,cols,grid=b
            values.append([title]); values.append(cols)
            for typ,row in grid: values.append(row)
            values.append([])
    svc.spreadsheets().values().update(spreadsheetId=SID,range=f"{tab}!A1",
        valueInputOption='RAW',body={'values':values}).execute()
    return values

def fmt(tab_id, header_rows):
    reqs=[{'updateSheetProperties':{'properties':{'sheetId':tab_id,'gridProperties':{'frozenRowCount':1}},'fields':'gridProperties.frozenRowCount'}}]
    svc.spreadsheets().batchUpdate(spreadsheetId=SID,body={'requests':reqs}).execute()

ids=ensure_tabs(['Summary & Recommendations','Broker-Level','Cohorts','CP-Owner','Founder-Metrics'])

# ---------- Broker-Level ----------
def bcols(extra): return ['Broker','Company','CP Code','CP Owner','Onboarding','City']+extra+['Total']
mcols=M
g1=grouped(R['T1'], bcols(mcols), mcols+['Total'])
g2=grouped(R['T2'], bcols(mcols), mcols+['Total'])
L3=M[-3:]
t4cols=['Broker','Company','CP Code','CP Owner','City']+[f'{x} {m}' for m in L3 for x in('Visits','Revisits','Nego')]+['Visits L3']
g4=grouped(R['T4'], t4cols, [c for c in t4cols if c not in('Broker','Company','CP Code','CP Owner','City')])
def stoptbl(key):
    cols=['Broker','Company','CP Code','CP Owner','City','Onboarding','Last active','Lifetime visits']
    return ('TABLE',f'Table 5 — Brokers who STOPPED giving visits ({key} zero-window)  [{len(R["T5"][key])}]',
            cols, grouped(R['T5'][key],cols,['Lifetime visits']))
bl=[('H','BROKER-LEVEL VIEW  (visits = completed; spine = Visitors sheet; LSQ mirror)'),
 ('TABLE','Table 1 — MoM Visits by Broker (Aug-25 → May-25*)',bcols(mcols),g1),
 ('TABLE','Table 2 — MoM Revisits by Broker (2nd+ visit, same buyer)',bcols(mcols),g2),
 ('TABLE','Table 3 — MoM Negotiation meetings by Broker',['Note'],
   [('ROW',['LSQ has only 29 Demand-Negotiation (event 215) records all-time and none carry a CP code — negotiation logging is effectively not happening in LSQ. Per-broker MoM negotiation cannot be produced. See Summary > Findings.'])]),
 ('TABLE','Table 4 — Last-3-month combined trend (Visits / Revisits / Nego)',t4cols,g4),
 stoptbl('1m'),stoptbl('2m'),stoptbl('3m')]
write_tab('Broker-Level',bl); fmt(ids['Broker-Level'],1)
print('Broker-Level written')

# ---------- Cohorts ----------
ccols=['Cohort','Brokers onboarded','Metric']+M
cg=[('ROW',[r.get(c,'') for c in ccols]) for r in R['cohort']]
write_tab('Cohorts',[('H','COHORT VIEW — brokers grouped by ONBOARDING month (Aug-25 → May-26*)'),
  ('TABLE','Per onboarding cohort: Visits / Unique active brokers / Active %  (columns = activity month)',ccols,cg)])
fmt(ids['Cohorts'],1); print('Cohorts written')

# ---------- CP-Owner ----------
co_cols=['CP Owner','City']+[f'{x} {m}' for m in CPOM for x in ('Onboarded','Active CPs','Visits')]+['Total visits']
co_g=grouped(R['cp_owner_tbl'],co_cols,[c for c in co_cols if c not in('CP Owner','City')])
it_cols=['CP Owner','City','AVFU done','AVFU created','AVFU completion %','Revisit task done','Revisit created',
 'Nego task done','Nego created','RegInteraction done (3w)','RegInteraction created (3w)']
it_g=grouped(R['intent_tbl'],it_cols,[c for c in it_cols if c not in('CP Owner','City')])
write_tab('CP-Owner',[('H','CP-OWNER VIEW  (CP owner = LSQ Lead Owner; onboarding credited to added_by; Jan-26 → now)'),
 ('TABLE','MoM Onboarded CPs / Active CPs / Total CP visits — by CP owner',co_cols,co_g),
 ('TABLE','Task-intent: completed vs created since LSQ (2026-03-20); Reg-Interaction = last 3 wks; excludes Prashant Singh',it_cols,it_g)])
fmt(ids['CP-Owner'],1); print('CP-Owner written')

# ---------- Founder-Metrics ----------
def simple(title,cols,rows):
    return ('TABLE',title,cols,[('ROW',[r.get(c,'') for c in cols]) for r in rows])
fm=[('H','FOUNDER METRICS  (since Aug-25; *May-26 partial to 18th)'),
 simple('MAU — active brokers, total visits, visits/active broker',
   ['Month','MAU (active brokers)','Total visits','Visits / active broker'],R['fm_mau']),
 simple('DAU — avg distinct brokers per active visit-day',
   ['Month','Avg DAU (brokers/active day)','Active days'],R['fm_dau']),
 simple('Stickiness — MoM active→active carryover',
   ['From','To','Active prev','Retained','Stickiness %'],R['fm_stick']),
 ('TABLE','Cohort retention triangle — % of onboarding cohort active each month',
   ['Cohort','Size']+M,[('ROW',[r.get(c,'') for c in (['Cohort','Size']+M)]) for r in R['fm_cohort_ret']]),
 simple('Visits per LIVE property (historic, from Property Master live window)',
   ['Month','Total visits','Live properties','Visits / live property'],R['fm_perprop'])]
write_tab('Founder-Metrics',fm); fmt(ids['Founder-Metrics'],1); print('Founder-Metrics written')
print('ALL TABS WRITTEN')
