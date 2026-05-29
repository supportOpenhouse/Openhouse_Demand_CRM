"""
Demand-analysis extraction — LSQ side. Caches raw to /tmp/dm_*.json.
Pulls: event-12001 visits (all-time), event-215 negotiation, event-221 AVFU,
users, and demand tasks (Re-Visit / Negotiations / After Visit / Regular Interaction Call -CP)
completed+created across all users.
"""
import urllib.parse, urllib.request, json, time, sys, os
from collections import defaultdict
sys.stdout.reconfigure(line_buffering=True)
TS=lambda: time.strftime('%H:%M:%S')
env=dict(l.strip().split('=',1) for l in open('.env') if '=' in l) if os.path.exists('.env') else dict(LSQ_API_HOST=os.environ['LSQ_API_HOST'],LSQ_ACCESS_KEY=os.environ['LSQ_ACCESS_KEY'],LSQ_SECRET_KEY=os.environ['LSQ_SECRET_KEY'])
HOST=env['LSQ_API_HOST']; AUTH={'accessKey':env['LSQ_ACCESS_KEY'],'secretKey':env['LSQ_SECRET_KEY']}
qs=urllib.parse.urlencode(AUTH)

def call(path, body=None, method='POST', retries=4):
    for a in range(retries+1):
        try:
            rq=urllib.request.Request(f'{HOST}{path}?{qs}',method=method,
               data=(json.dumps(body).encode() if body is not None else None),
               headers={'Content-Type':'application/json'})
            with urllib.request.urlopen(rq,timeout=90) as r: return json.loads(r.read()),None
        except urllib.error.HTTPError as e:
            if e.code==429 and a<retries: time.sleep(2**a); continue
            try: msg=e.read().decode()[:150]
            except: msg=''
            if a<retries: time.sleep(1+a); continue
            return None,f'HTTP {e.code} {msg}'
        except Exception as e:
            if a<retries: time.sleep(1+a); continue
            return None,f'{type(e).__name__}'
    return None,'exhausted'

def pull_event(ev, label, start='2025-06-01'):
    out=[];
    now=time.time(); cur=time.mktime(time.strptime(start,'%Y-%m-%d')); chunk=14*86400
    while cur<now:
        ce=min(cur+chunk,now)
        body={'Parameter':{'FromDate':time.strftime('%Y-%m-%d %H:%M:%S',time.localtime(cur)),
               'ToDate':time.strftime('%Y-%m-%d %H:%M:%S',time.localtime(ce)),
               'ActivityEvent':ev,'IncludeCustomFields':1},
              'Paging':{'PageIndex':1,'PageSize':1000},'Sorting':{'ColumnName':'CreatedOn','Direction':'0'}}
        p=1
        while p<=30:
            body['Paging']['PageIndex']=p
            d,err=call('/v2/ProspectActivity.svc/RetrieveRecentlyModified',body=body)
            if err: print(f'  {label} chunk err {err}'); break
            acts=d.get('ProspectActivities') or []
            out.extend(acts)
            if len(acts)<1000: break
            p+=1; time.sleep(0.25)
        print(f'[{TS()}] {label} {time.strftime("%Y-%m-%d",time.localtime(cur))} -> total {len(out)}')
        cur=ce+1
    # dedup by Id
    seen={};
    for a in out: seen[a.get('Id')]=a
    return list(seen.values())

print(f'[{TS()}] === LSQ extraction start ===')

print(f'[{TS()}] event 12001 (visits)...')
visits=pull_event(12001,'visits')
json.dump(visits,open('/tmp/dm_visits.json','w'),default=str)
print(f'[{TS()}] visits cached: {len(visits)}')

print(f'[{TS()}] event 215 (Demand-Negotiation)...')
nego=pull_event(215,'nego')
json.dump(nego,open('/tmp/dm_nego.json','w'),default=str)
print(f'[{TS()}] nego cached: {len(nego)}')

print(f'[{TS()}] event 221 (Demand-After Visit Follow Up)...')
avfu=pull_event(221,'avfu')
json.dump(avfu,open('/tmp/dm_avfu.json','w'),default=str)
print(f'[{TS()}] avfu cached: {len(avfu)}')

# Users: local snapshot (local runs) -> live LSQ API -> baked seed.
# The LSQ Users.Get endpoint intermittently 500s (MySqlException) server-side; the
# roster is ~stable internal staff, so a baked seed keeps the daily run from dying.
# Live is still tried first on Cloud Run, so it self-heals when LSQ recovers.
if os.path.exists('snapshots/raw/users.json'):
    u=json.load(open('snapshots/raw/users.json'))
else:
    u,uerr=call('/v2/UserManagement.svc/Users.Get',method='GET')
    if uerr or u is None:
        seed=os.path.join(os.path.dirname(os.path.abspath(__file__)),'automation','users_seed.json')
        print(f'[{TS()}] users live fetch failed ({uerr}); using baked seed')
        u=json.load(open(seed))
uitems=u if isinstance(u,list) else u.get('Users',u)
json.dump(uitems,open('/tmp/dm_users.json','w'),default=str)
print(f'[{TS()}] users cached: {len(uitems)}')

# Tasks: per-user, both status, both relevant types. Cache CreatedOn/CompletedOn/Type/Owner.
TYPES={'Buyer- Re-Visit Follow Up','Buyer- Negotiations','Buyer- After Visit Follow Up',
       'Regular Interaction Call -CP','Buyer- Phone Call','Buyer- Follow Up Call'}
emails=[x.get('EmailAddress') for x in uitems if x.get('EmailAddress')]
tasks=[]
CUT=time.time()-200*86400  # ~ since Oct 2025
for i,em in enumerate(emails,1):
    for sc in (0,1):
        pg=1
        while pg<=40:
            body={'Parameter':{'LookupName':'OwnerEmailAddress','LookupValue':em,'StatusCode':sc},
                  'Paging':{'PageIndex':pg,'PageSize':1000},
                  'Sorting':{'ColumnName':'CreatedOn','Direction':'1'}}
            d,err=call('/v2/Task.svc/Retrieve',body=body)
            if err: break
            ts_=d.get('List') or d.get('Tasks') or d.get('Records') or [] if d else []
            if not ts_: break
            stop=False
            for t in ts_:
                tt=(t.get('TaskType') or {}).get('Name','')
                if tt in TYPES:
                    tasks.append({'id':t.get('UserTaskId'),'type':tt,'sc':sc,
                        'created':t.get('CreatedOn'),'completed':t.get('CompletedOn'),
                        'due':t.get('DueDate'),'owner':t.get('OwnerName'),
                        'owner_email':t.get('OwnerEmailAddress'),'lead':t.get('RelatedEntityId'),
                        'completer':t.get('ModifiedByName')})
                cs=(t.get('CreatedOn') or '')[:10]
                if cs and cs<'2025-09-15': stop=True
            if stop or len(ts_)<1000: break
            pg+=1; time.sleep(0.2)
        time.sleep(0.1)
    if i%10==0: print(f'[{TS()}] tasks: {i}/{len(emails)} users, {len(tasks)} rows')
# dedup tasks by id
seen={}
for t in tasks: seen[t['id']]=t
tasks=list(seen.values())
json.dump(tasks,open('/tmp/dm_tasks.json','w'),default=str)
print(f'[{TS()}] tasks cached: {len(tasks)} unique')
print(f'[{TS()}] === LSQ extraction DONE ===')
