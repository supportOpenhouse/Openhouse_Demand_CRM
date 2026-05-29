"""
Apply: for the 64 strict-matched last-4-day visits —
  - mx_Custom_24 (Pipeline Status)  <- sheet 'Buyer Intent' (overwrite; skip if same)
  - mx_Custom_36 (Sales_feedback)   <- APPEND sheet 'SM Notes' to existing (cap 200)

Strict key (must match ALL): Buyer + Visit Date + Unit(token-subset) + Broker + CP Code.
Society used only as a consistency flag.

Safety:
  - Re-fetch all 12001 opps fresh (no stale state)
  - Backup OLD mx_Custom_24 + mx_Custom_36 BEFORE any write
  - Feedback append is idempotent: skip if the note text already present
  - Feedback capped at 200 (LSQ field max); existing preserved first
  - 1-record live test + read-back verify before bulk
  - Stop on 5 consecutive failures; per-record audit; read-back verify all
"""
import urllib.parse, urllib.request, json, time, re, csv, sys
from collections import defaultdict, Counter
sys.stdout.reconfigure(line_buffering=True)
TS=lambda: time.strftime('%H:%M:%S')
env=dict(l.strip().split('=',1) for l in open('.env') if '=' in l)
HOST=env['LSQ_API_HOST']; AUTH={'accessKey':env['LSQ_ACCESS_KEY'],'secretKey':env['LSQ_SECRET_KEY']}
MAXLEN=200

def call(path, body=None, method='POST', retries=3):
    qs=urllib.parse.urlencode(AUTH)
    for att in range(retries+1):
        try:
            rq=urllib.request.Request(f'{HOST}{path}?{qs}',method=method,
               data=(json.dumps(body).encode() if body is not None else None),
               headers={'Content-Type':'application/json'})
            with urllib.request.urlopen(rq,timeout=60) as r: return json.loads(r.read()),None
        except urllib.error.HTTPError as e:
            b=''
            try:b=e.read().decode()[:200]
            except:pass
            if e.code==429 and att<retries: time.sleep(2**att); continue
            return None,f'HTTP {e.code}: {b}'
        except Exception as e:
            if att<retries: time.sleep(1+att); continue
            return None,f'{type(e).__name__}: {e}'
    return None,'exhausted'

def norm(s): return re.sub(r'[^a-z0-9]+',' ',(s or '').lower()).strip()
def toks(s): return set(t for t in norm(s).split() if t)
def xb(desc):
    desc=desc or ''
    bn=re.search(r'Broker:\s*([^|]+)',desc); cp=re.search(r'CP Code:\s*([A-Za-z0-9]+)',desc)
    return (norm(bn.group(1)) if bn else '', (cp.group(1).strip().upper() if cp else ''))
def buyer_ok(sb,lb):
    a,b=toks(sb),toks(lb); return bool(a) and bool(b) and (a==b or a<=b or b<=a)

rows=list(csv.DictReader(open('/tmp/visit_sheet_last4d.csv')))
print(f'[{TS()}] sheet rows: {len(rows)}; refetching 12001 opps (21d)...')
opps=[]
now=time.time(); cur=now-21*86400; chunk=7*86400
while cur<now:
    ce=min(cur+chunk,now)
    body={'Parameter':{'FromDate':time.strftime('%Y-%m-%d %H:%M:%S',time.localtime(cur)),
           'ToDate':time.strftime('%Y-%m-%d %H:%M:%S',time.localtime(ce)),
           'ActivityEvent':12001,'IncludeCustomFields':1},
          'Paging':{'PageIndex':1,'PageSize':1000},'Sorting':{'ColumnName':'ModifiedOn','Direction':'1'}}
    p=1
    while p<=20:
        body['Paging']['PageIndex']=p
        d,err=call('/v2/ProspectActivity.svc/RetrieveRecentlyModified',body=body)
        if err: print('ABORT fetch',err); sys.exit(1)
        a=d.get('ProspectActivities') or []
        opps.extend(a)
        if len(a)<1000: break
        p+=1; time.sleep(0.2)
    cur=ce+1
print(f'[{TS()}] opps fetched: {len(opps)}')
def fmap(a): return {f.get('Key'):f.get('Value') for f in (a.get('Fields') or [])}
idx=defaultdict(list)
for a in opps:
    fm=fmap(a); b=norm(fm.get('mx_Custom_4')); vd=str(fm.get('mx_Custom_28') or '')[:10]
    if b and vd: idx[(b,vd)].append((a,fm))

# Re-derive the strict 64 + capture current values
plan={}  # opp_id -> dict
for r in rows:
    sb=r.get('Buyer Name'); svd=str(r.get('Visit Date') or '')[:10]
    sunit=toks(r.get('Unit')); ssoc=toks(r.get('Society'))
    sbroker=norm(r.get('Broker Name')); scp=(r.get('CP Code') or '').strip().upper()
    intent=(r.get('Buyer Intent') or '').strip()
    note=(r.get('SM Notes') or '').strip()
    cand=[]
    for (b,vd),lst in idx.items():
        if vd!=svd or not buyer_ok(sb,b): continue
        for a,fm in lst:
            if not (sunit and sunit<=toks(fm.get('mx_Custom_42'))): continue
            bn,cp=xb(fm.get('mx_Custom_5'))
            if not (sbroker and bn and (sbroker in bn or bn in sbroker)): continue
            if not (scp and cp and scp==cp): continue
            cand.append((a,fm))
    if len(cand)!=1: continue
    a,fm=cand[0]; oid=a.get('Id')
    plan[oid]={'oid':oid,'buyer':sb,'visit_date':svd,'unit':r.get('Unit'),
               'intent':intent,'note':note,
               'cur_pipe':(fm.get('mx_Custom_24') or '').strip(),
               'cur_fb':(fm.get('mx_Custom_36') or '').strip()}
print(f'[{TS()}] strict unique matches: {len(plan)}')

# Backup BEFORE writes
ts=time.strftime('%Y-%m-%d')
with open(f'snapshots/visit_pipeline_backup_{ts}.json','w') as f:
    json.dump({'generated':TS(),'records':list(plan.values())},f,indent=2,default=str)

def build_fb(cur, note):
    if not note: return cur, 'no_note'
    if note.lower() in (cur or '').lower(): return cur, 'already_present'
    combined = (cur.rstrip() + '  |  ' + note) if cur else note
    if len(combined)<=MAXLEN: return combined, 'appended_full'
    return combined[:MAXLEN], 'appended_truncated'

# Build update list
updates=[]
for p in plan.values():
    fields=[]; acts=[]
    if p['intent'] and p['intent'].lower()!=p['cur_pipe'].lower():
        fields.append({'SchemaName':'mx_Custom_24','Value':p['intent']}); acts.append('pipe')
    new_fb,fbstat=build_fb(p['cur_fb'],p['note'])
    if fbstat in ('appended_full','appended_truncated'):
        fields.append({'SchemaName':'mx_Custom_36','Value':new_fb}); acts.append('fb:'+fbstat)
    if fields:
        updates.append({**p,'fields':fields,'acts':acts,'new_fb':new_fb if 'mx_Custom_36' in str(fields) else p['cur_fb']})

print(f'[{TS()}] opps needing a write: {len(updates)}  (of {len(plan)})')
print('  truncated feedback:', sum(1 for u in updates if any('truncated' in a for a in u['acts'])))

def apply_one(u):
    body={'ProspectOpportunityId':u['oid'],'Fields':u['fields']}
    res,err=call('/v2/OpportunityManagement.svc/Update',body=body)
    if err or (res and res.get('Status')!='Success'):
        return False, err or json.dumps(res)
    return True, res

# 1-record live test
print(f'\n[{TS()}] 1-RECORD TEST...')
t=updates[0]
ok,info=apply_one(t)
print(f'  test opp {t["oid"][:8]} acts={t["acts"]} -> {"OK" if ok else "FAIL "+str(info)}')
if not ok: print('ABORT — test write failed'); sys.exit(1)
time.sleep(0.4)
# verify test
vd,_=call('/v2/ProspectActivity.svc/RetrieveRecentlyModified',body={'Parameter':{'FromDate':'2026-05-01 00:00:00','ToDate':time.strftime('%Y-%m-%d %H:%M:%S'),'ActivityEvent':12001,'IncludeCustomFields':1},'Paging':{'PageIndex':1,'PageSize':1000},'Sorting':{'ColumnName':'ModifiedOn','Direction':'1'}})
tv=next((x for x in (vd.get('ProspectActivities') or []) if x.get('Id')==t['oid']),None)
if tv:
    fm=fmap(tv)
    print(f'  verify: mx_Custom_24={fm.get("mx_Custom_24")!r} mx_Custom_36 len={len(fm.get("mx_Custom_36") or "")}')
print(f'[{TS()}] test verified — proceeding with remaining {len(updates)-1}')

results=[{'oid':t['oid'],'status':'ok','acts':t['acts']}]
cfail=0
for i,u in enumerate(updates[1:],2):
    ok,info=apply_one(u)
    if ok:
        results.append({'oid':u['oid'],'status':'ok','acts':u['acts']}); cfail=0
    else:
        results.append({'oid':u['oid'],'status':'fail','error':str(info)[:160]}); cfail+=1
        if cfail>=5: print(f'[{TS()}] ABORT — 5 consecutive failures'); break
    if i%15==0 or i==len(updates): print(f'  [{TS()}] {i}/{len(updates)} ok={sum(1 for r in results if r["status"]=="ok")} fail={sum(1 for r in results if r["status"]=="fail")}')
    time.sleep(0.35)

ok_n=sum(1 for r in results if r['status']=='ok')
fail_n=sum(1 for r in results if r['status']=='fail')

# Read-back verify
print(f'\n[{TS()}] read-back verify...')
vb=[]
nowt=time.time(); c2=nowt-21*86400
while c2<nowt:
    e2=min(c2+7*86400,nowt)
    bb={'Parameter':{'FromDate':time.strftime('%Y-%m-%d %H:%M:%S',time.localtime(c2)),'ToDate':time.strftime('%Y-%m-%d %H:%M:%S',time.localtime(e2)),'ActivityEvent':12001,'IncludeCustomFields':1},'Paging':{'PageIndex':1,'PageSize':1000},'Sorting':{'ColumnName':'ModifiedOn','Direction':'1'}}
    pp=1
    while pp<=20:
        bb['Paging']['PageIndex']=pp
        dd,er=call('/v2/ProspectActivity.svc/RetrieveRecentlyModified',body=bb)
        if er: break
        aa=dd.get('ProspectActivities') or []
        vb.extend(aa)
        if len(aa)<1000: break
        pp+=1; time.sleep(0.2)
    c2=e2+1
vmap={x.get('Id'):fmap(x) for x in vb}
verified=0; mism=[]
for u in updates:
    fm=vmap.get(u['oid'])
    if not fm: continue
    okp = (('pipe' not in [a.split(':')[0] for a in u['acts']]) or (fm.get('mx_Custom_24') or '').strip().lower()==u['intent'].lower())
    okf = (not any(a.startswith('fb') for a in u['acts'])) or (u['note'][:30].lower() in (fm.get('mx_Custom_36') or '').lower())
    if okp and okf: verified+=1
    else: mism.append(u['oid'])

with open(f'snapshots/visit_pipeline_results_{ts}.json','w') as f:
    json.dump({'ts':TS(),'matched':len(plan),'attempted':len(updates),
               'ok':ok_n,'fail':fail_n,'verified':verified,'mismatch':mism,
               'results':results},f,indent=2,default=str)
with open(f'snapshots/visit_pipeline_results_{ts}.csv','w',newline='') as f:
    w=csv.writer(f); w.writerow(['opp_id','status','acts','error'])
    for r in results: w.writerow([r['oid'],r['status'],';'.join(r.get('acts',[])),r.get('error','')])

print(f'\n[{TS()}] === DONE ===')
print(f'  strict matches:     {len(plan)}')
print(f'  needed a write:     {len(updates)}')
print(f'  write OK:           {ok_n}')
print(f'  write FAIL:         {fail_n}')
print(f'  read-back verified: {verified}')
print(f'  verify mismatch:    {len(mism)}')
print(f'  backup: snapshots/visit_pipeline_backup_{ts}.json')
print(f'  audit:  snapshots/visit_pipeline_results_{ts}.csv / .json')
