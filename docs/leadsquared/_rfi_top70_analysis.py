"""
For each owner: rank their CPs by priority, identify which today's RFI tasks
to keep (top 70 or 120) and which to mark complete (the rest).

Priority order:
  P1: d90_visits > 0  (visited in last 90 days)
  P2: created in last 60 days  (newly onboarded; only if d90==0)
  P3: all_time_visits > 0  (only if not P1/P2)
  P4: rest

Quotas:
  Saket Kumar, Mukul Chhabra, Shubham Sharma → 120 each
  Everyone else → 70 each
"""
import urllib.parse, urllib.request, json, sys, time, csv
from datetime import datetime, date, timedelta
from collections import defaultdict, Counter

sys.stdout.reconfigure(line_buffering=True)
TS = lambda: time.strftime('%H:%M:%S')

env = dict(l.strip().split('=', 1) for l in open('.env') if '=' in l)
HOST = env['LSQ_API_HOST']
AUTH = {'accessKey': env['LSQ_ACCESS_KEY'], 'secretKey': env['LSQ_SECRET_KEY']}

today = date(2026, 5, 15)
QUOTAS = {'Saket Kumar': 120, 'Mukul Chhabra': 120, 'Shubham Sharma': 120}
DEFAULT_QUOTA = 70
sixty_days_ago = today - timedelta(days=60)

def parse_dt(s):
    if not s: return None
    s = str(s).split('.')[0].strip()
    for f in ('%Y-%m-%d %H:%M:%S','%m/%d/%Y %I:%M:%S %p','%m/%d/%Y %H:%M:%S'):
        try: return datetime.strptime(s, f)
        except: continue
    return None

def call(path, body=None, method='POST', retries=2):
    qs = urllib.parse.urlencode(AUTH)
    url = f"{HOST}{path}?{qs}"
    for a in range(retries+1):
        try:
            req = urllib.request.Request(url, method=method,
                data=(json.dumps(body).encode() if body else None),
                headers={'Content-Type': 'application/json'})
            with urllib.request.urlopen(req, timeout=60) as r:
                return json.loads(r.read()), None
        except urllib.error.HTTPError as e:
            if e.code == 429 and a < retries: time.sleep(2**a); continue
            return None, f"HTTP {e.code}"
        except Exception as e:
            return None, f"{type(e).__name__}"
    return None, "exhausted"

# === STEP 1: fetch today's RFI tasks with RelatedProspectId ===
print(f"[{TS()}] Fetching today's RFI tasks across users...")
users = json.load(open('snapshots/raw/users.json'))
items = users if isinstance(users, list) else users.get('Users', users)
active = [u for u in items if u.get('StatusCode') in (0,'0') and u.get('EmailAddress')]
print(f"  Active users: {len(active)}")

PREFIX = 'Regular Interaction Call -CP'
qs = urllib.parse.urlencode(AUTH)

# tasks_per_owner_cp[(owner, prospect_id)] = list of task records
tasks_per_owner_cp = defaultdict(list)
unique_tasks = {}  # task_id -> task record

for ui, u in enumerate(active, 1):
    email = u['EmailAddress']
    name = f"{u.get('FirstName','')} {u.get('LastName','') or ''}".strip()
    page = 1
    while page <= 30:
        body = {
            "Parameter": {"LookupName": "OwnerEmailAddress", "LookupValue": email, "StatusCode": 0},
            "Paging": {"PageIndex": page, "PageSize": 1000},
            "Sorting": {"ColumnName": "CreatedOn", "Direction": "1"},
        }
        r, err = call("/v2/Task.svc/Retrieve", body=body)
        if err: break
        tasks = r.get('List') or []
        if not tasks: break
        stale = False
        for t in tasks:
            created = parse_dt(t.get('CreatedOn'))
            if not created: continue
            if created.date() < today:
                stale = True; break
            if created.date() == today:
                subj = (t.get('Name') or t.get('Subject') or '').strip()
                if not subj.startswith(PREFIX): continue
                tid = t.get('UserTaskId') or t.get('TaskId') or t.get('Id')
                pid = t.get('RelatedProspectId') or t.get('RelatedEntityId')
                owner_uid = t.get('OwnerId') or ''
                key = (name, pid)
                rec = {
                    'task_id': tid, 'subject': subj, 'owner': name, 'owner_email': email,
                    'related_prospect_id': pid, 'created_on': t.get('CreatedOn'),
                }
                if tid not in unique_tasks:
                    unique_tasks[tid] = rec
                    tasks_per_owner_cp[key].append(rec)
        if stale or len(tasks) < 1000: break
        page += 1
        time.sleep(0.27)
    if ui % 5 == 0:
        print(f"  [{TS()}] {ui}/{len(active)} users; unique tasks so far: {len(unique_tasks)}")
    time.sleep(0.1)

print(f"\n[{TS()}] Today's RFI tasks (unique): {len(unique_tasks)}")

# Unique CPs per owner
cps_per_owner = defaultdict(set)
for (owner, pid), recs in tasks_per_owner_cp.items():
    if pid: cps_per_owner[owner].add(pid)
print(f"Unique CPs with tasks today (per owner):")
for o, s in sorted(cps_per_owner.items(), key=lambda kv: -len(kv[1])):
    print(f"  {o:25s}  {len(s)} unique CPs")

# Save tasks_per_owner_cp for reuse
all_unique_pids = set()
for s in cps_per_owner.values(): all_unique_pids |= s
print(f"\nTotal unique CP prospect IDs to look up: {len(all_unique_pids)}")

with open('/tmp/rfi_today_tasks.json', 'w') as f:
    json.dump({
        'tasks_per_owner_cp': {f"{k[0]}|{k[1]}": v for k, v in tasks_per_owner_cp.items()},
        'all_unique_pids': list(all_unique_pids),
    }, f, indent=2, default=str)


# === STEP 2: look up each unique CP lead ===
print(f"\n[{TS()}] Looking up {len(all_unique_pids)} CP leads (eta {int(len(all_unique_pids)*0.27/60)}m)...")

cp_data = {}  # pid -> {first_name, owner_name, d90, all_time, created_on}
for i, pid in enumerate(all_unique_pids, 1):
    qs2 = urllib.parse.urlencode({**AUTH, 'id': pid})
    try:
        with urllib.request.urlopen(f"{HOST}/v2/LeadManagement.svc/Leads.GetById?{qs2}", timeout=20) as r:
            d = json.loads(r.read())
        leads = d if isinstance(d, list) else d.get('Leads', [])
        if leads:
            l = leads[0]
            def gf(key):
                v = l.get(key)
                if v is not None: return v
                # check LeadPropertyList if present
                for p in (l.get('LeadPropertyList') or []):
                    if p.get('Attribute') == key: return p.get('Value')
                return None
            try: d90 = int(float(gf('mx_d90_visits') or 0))
            except: d90 = 0
            try: at = int(float(gf('mx_all_time_visits') or 0))
            except: at = 0
            cp_data[pid] = {
                'first_name': l.get('FirstName') or '',
                'owner_name': l.get('OwnerIdName') or '',
                'cp_code': gf('mx_CP_code') or '',
                'd90': d90,
                'all_time': at,
                'created_on': l.get('CreatedOn'),
                'stage': l.get('ProspectStage'),
            }
    except Exception as e:
        cp_data[pid] = {'_error': str(e)}
    if i % 200 == 0:
        print(f"  [{TS()}] {i}/{len(all_unique_pids)} fetched")
    time.sleep(0.27)

with open('/tmp/cp_data_today.json', 'w') as f:
    json.dump(cp_data, f, indent=2, default=str)
print(f"\n[{TS()}] CP lookups done. Errors: {sum(1 for v in cp_data.values() if v.get('_error'))}")


# === STEP 3: rank per owner, identify keep/drop ===
def priority(cp):
    """Lower is better."""
    d90 = cp.get('d90', 0)
    at = cp.get('all_time', 0)
    co = parse_dt(cp.get('created_on'))
    if d90 > 0: return 1
    if co and co.date() >= sixty_days_ago: return 2
    if at > 0: return 3
    return 4

# Group: owner -> list of (pid, cp_data, task_records)
owner_cps = defaultdict(list)
for (owner, pid), recs in tasks_per_owner_cp.items():
    cp = cp_data.get(pid, {})
    if '_error' in cp: continue
    owner_cps[owner].append((pid, cp, recs))

print(f"\n=== TOP 70/120 ANALYSIS ===")
print(f"  {'Owner':25s}  {'Quota':>5s}  {'Total CPs':>10s}  {'Keep':>5s}  {'Drop':>5s}  {'Drop tasks':>10s}")
total_keep_tasks = 0
total_drop_tasks = 0
output_rows = []

for owner in sorted(owner_cps.keys(), key=lambda o: -len(owner_cps[o])):
    quota = QUOTAS.get(owner, DEFAULT_QUOTA)
    cps = owner_cps[owner]
    # Sort by priority then by other tiebreakers (desc d90, desc all_time, desc created_on)
    def sort_key(item):
        _, cp, _ = item
        co = parse_dt(cp.get('created_on'))
        co_ts = co.timestamp() if co else 0
        return (priority(cp), -cp.get('d90',0), -cp.get('all_time',0), -co_ts)
    cps_sorted = sorted(cps, key=sort_key)
    keep = cps_sorted[:quota]
    drop = cps_sorted[quota:]
    keep_tasks = sum(len(recs) for _, _, recs in keep)
    drop_tasks = sum(len(recs) for _, _, recs in drop)
    total_keep_tasks += keep_tasks
    total_drop_tasks += drop_tasks
    print(f"  {owner[:25]:25s}  {quota:>5d}  {len(cps):>10d}  {len(keep):>5d}  {len(drop):>5d}  {drop_tasks:>10d}")

    # Save details
    for rank, (pid, cp, recs) in enumerate(cps_sorted, 1):
        output_rows.append({
            'owner': owner,
            'quota': quota,
            'rank': rank,
            'action': 'KEEP' if rank <= quota else 'MARK_DONE',
            'cp_first_name': cp.get('first_name',''),
            'cp_code': cp.get('cp_code',''),
            'priority': priority(cp),
            'd90_visits': cp.get('d90', 0),
            'all_time_visits': cp.get('all_time', 0),
            'created_on': cp.get('created_on',''),
            'stage': cp.get('stage',''),
            'task_count_today': len(recs),
            'task_ids': '; '.join(r['task_id'] for r in recs),
            'lead_id': pid,
        })

print(f"\n  TOTAL  keep tasks: {total_keep_tasks}, drop tasks: {total_drop_tasks}")

# Save CSV
with open('snapshots/rfi_top70_plan.csv', 'w', newline='') as f:
    w = csv.DictWriter(f, fieldnames=list(output_rows[0].keys()))
    w.writeheader()
    for r in output_rows:
        w.writerow(r)
print(f"\nFull plan CSV: snapshots/rfi_top70_plan.csv ({len(output_rows)} rows)")

# Priority breakdown
print(f"\n=== Priority breakdown across all CPs ===")
prio_count = Counter(priority(cp) for _, cp, _ in [item for cps_list in owner_cps.values() for item in cps_list])
labels = {1:'P1: d90>0', 2:'P2: onboarded last 60d', 3:'P3: all_time>0', 4:'P4: rest'}
for p in [1,2,3,4]:
    print(f"  {labels[p]:30s}  {prio_count.get(p, 0)} CPs")
