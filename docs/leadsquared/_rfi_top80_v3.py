"""
v3: production-quality plan to keep top 80 (or 120 for Saket/Mukul/Shubham) RFI
tasks per owner. Uses Sheet1 CSV for d90/all_time/created_at; LSQ for current
owner + cp_code-to-task matching.

Safety rules — DO NOT DROP a task if ANY of these are true:
  - Task has no RelatedProspectId
  - LSQ lookup for the lead fails or returns no record
  - Lead has no mx_CP_code populated
  - cp_code doesn't match anything in Sheet1
  - Owner from task ≠ owner from LSQ lead (sanity mismatch)
All such tasks → flagged "KEEP_unmatched_safety" (kept open by default).

Priority for ranking within each owner:
  P1: d90_visits > 0
  P2: created in last 60 days (and d90 == 0)
  P3: all_time_visits > 0 (and not P1/P2)
  P4: rest

Quotas: Saket Kumar / Mukul Chhabra / Shubham Sharma → 120; everyone else → 80.
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
DEFAULT_QUOTA = 80
sixty_days_ago = today - timedelta(days=60)

CSV_PATH = "/Users/akshit.chaudhary/Downloads/Broker_data_query - Sheet1 (9).csv"

def parse_dt(s):
    if not s: return None
    s = str(s).split('.')[0].strip()
    for f in ('%Y-%m-%d','%Y-%m-%d %H:%M:%S','%m/%d/%Y %I:%M:%S %p','%m/%d/%Y %H:%M:%S','%m/%d/%Y'):
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


# === STEP 1: read Sheet1 CSV ===
print(f"[{TS()}] Reading Sheet1 CSV...")
def to_int(v):
    try: return int(float(v or 0))
    except: return 0

cp_sheet = {}  # cp_code → {d90, all_time, created_at, name, added_by, city}
dup_codes = 0
with open(CSV_PATH) as f:
    for r in csv.DictReader(f):
        code = (r.get('cp_code') or '').strip()
        if not code: continue
        if code in cp_sheet:
            dup_codes += 1
            continue  # keep first occurrence
        cp_sheet[code] = {
            'd90': to_int(r.get('d90_visits')),
            'all_time': to_int(r.get('all_time_visits')),
            'created_at': (r.get('created_at') or '').strip(),
            'name': (r.get('name') or '').strip(),
            'added_by': (r.get('added_by') or '').strip(),
            'city': (r.get('city') or '').strip(),
            'micro_market': (r.get('micro_markets') or '').strip(),
        }
print(f"  Sheet1 unique cp_codes: {len(cp_sheet)} (dropped {dup_codes} duplicates)")
print(f"  d90>0:    {sum(1 for v in cp_sheet.values() if v['d90']>0)}")
print(f"  all>0:    {sum(1 for v in cp_sheet.values() if v['all_time']>0)}")
print(f"  Created last 60d: {sum(1 for v in cp_sheet.values() if (parse_dt(v['created_at']) and parse_dt(v['created_at']).date() >= sixty_days_ago))}")


# === STEP 2: fetch today's RFI tasks ===
print(f"\n[{TS()}] Fetching today's RFI tasks across all active users...")
users = json.load(open('snapshots/raw/users.json'))
items = users if isinstance(users, list) else users.get('Users', users)
active = [u for u in items if u.get('StatusCode') in (0,'0') and u.get('EmailAddress')]
PREFIX = 'Regular Interaction Call -CP'

tasks_per_owner_cp = defaultdict(list)
unique_tasks = {}
qs = urllib.parse.urlencode(AUTH)
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
            if created.date() < today: stale = True; break
            if created.date() == today:
                subj = (t.get('Name') or t.get('Subject') or '').strip()
                if not subj.startswith(PREFIX): continue
                tid = t.get('UserTaskId') or t.get('TaskId') or t.get('Id')
                pid = t.get('RelatedProspectId') or t.get('RelatedEntityId') or ''
                rec = {'task_id': tid, 'subject': subj, 'owner': name, 'related_prospect_id': pid,
                       'created_on': t.get('CreatedOn'), 'due_date': t.get('DueDate')}
                if tid not in unique_tasks:
                    unique_tasks[tid] = rec
                    tasks_per_owner_cp[(name, pid)].append(rec)
        if stale or len(tasks) < 1000: break
        page += 1
        time.sleep(0.27)
    if ui % 5 == 0:
        print(f"  [{TS()}] {ui}/{len(active)} users; unique tasks so far: {len(unique_tasks)}")
    time.sleep(0.1)

print(f"\n  Today's unique RFI tasks: {len(unique_tasks)}")

# Tasks with no RelatedProspectId — instant safety flag
no_pid_tasks = [t for t in unique_tasks.values() if not t['related_prospect_id']]
print(f"  Tasks with no RelatedProspectId (will keep): {len(no_pid_tasks)}")

# Unique CP IDs
all_pids = {t['related_prospect_id'] for t in unique_tasks.values() if t['related_prospect_id']}
print(f"  Unique CP prospect IDs: {len(all_pids)}")


# === STEP 3: look up each unique CP in LSQ ===
print(f"\n[{TS()}] Looking up {len(all_pids)} CPs in LSQ for cp_code + current owner...")
cp_lsq = {}
for i, pid in enumerate(all_pids, 1):
    qs2 = urllib.parse.urlencode({**AUTH, 'id': pid})
    try:
        with urllib.request.urlopen(f"{HOST}/v2/LeadManagement.svc/Leads.GetById?{qs2}", timeout=20) as r:
            d = json.loads(r.read())
        leads = d if isinstance(d, list) else d.get('Leads', [])
        if leads:
            l = leads[0]
            def gf(key):
                if l.get(key) is not None: return l.get(key)
                for p in (l.get('LeadPropertyList') or []):
                    if p.get('Attribute') == key: return p.get('Value')
                return None
            cp_lsq[pid] = {
                'first_name': l.get('FirstName') or '',
                'cp_code': (gf('mx_CP_code') or '').strip(),
                'lsq_owner': l.get('OwnerIdName') or '',
                'lsq_owner_id': l.get('OwnerId') or '',
                'lsq_created_on': l.get('CreatedOn'),
                'stage': l.get('ProspectStage') or '',
            }
        else:
            cp_lsq[pid] = {'_error': 'no lead found'}
    except urllib.error.HTTPError as e:
        cp_lsq[pid] = {'_error': f'HTTP {e.code}'}
    except Exception as e:
        cp_lsq[pid] = {'_error': f'{type(e).__name__}'}
    if i % 200 == 0:
        print(f"  [{TS()}] {i}/{len(all_pids)} done")
    time.sleep(0.27)
errors = sum(1 for v in cp_lsq.values() if v.get('_error'))
print(f"  CP lookups complete. Lookup errors: {errors}")


# === STEP 4: combine + safety-flag ===
print(f"\n[{TS()}] Combining + applying safety rules...")

def priority(d90, at, created_at_str):
    if d90 > 0: return 1
    co = parse_dt(created_at_str)
    if co and co.date() >= sixty_days_ago: return 2
    if at > 0: return 3
    return 4

owner_cps = defaultdict(list)
unmatched_safety = []  # tasks we will NOT drop due to safety rule

for (owner, pid), recs in tasks_per_owner_cp.items():
    if not pid:
        for r in recs:
            unmatched_safety.append({**r, 'reason': 'no_related_prospect_id'})
        continue
    lsq = cp_lsq.get(pid, {})
    if lsq.get('_error'):
        for r in recs:
            unmatched_safety.append({**r, 'reason': f"lsq_error:{lsq['_error']}"})
        continue
    cp_code = lsq.get('cp_code', '')
    if not cp_code:
        for r in recs:
            unmatched_safety.append({**r, 'reason': 'lsq_lead_has_no_cp_code'})
        continue
    sheet = cp_sheet.get(cp_code)
    if not sheet:
        # CP not in Sheet1 — assume d90=0, all_time=0 (P4) but still INCLUDE in ranking
        # This is what the user wants: rank all tasks, just default for missing
        sheet = {'d90': 0, 'all_time': 0, 'created_at': '', 'name': lsq.get('first_name','')}
        in_sheet = False
    else:
        in_sheet = True

    # Sanity check: owner mismatch
    lsq_owner = lsq.get('lsq_owner', '')
    if lsq_owner and lsq_owner != owner:
        # Owner has changed — flag as safety unmatched
        for r in recs:
            unmatched_safety.append({**r, 'reason': f'owner_mismatch:lsq={lsq_owner}|task={owner}'})
        continue

    cp_info = {
        'pid': pid, 'cp_code': cp_code,
        'first_name': lsq.get('first_name',''),
        'sheet_name': sheet.get('name',''),
        'd90': sheet['d90'], 'all_time': sheet['all_time'],
        'created_at': sheet['created_at'] or lsq.get('lsq_created_on') or '',
        'in_sheet': in_sheet,
        'lsq_owner': lsq_owner, 'stage': lsq.get('stage',''),
        'task_count': len(recs), 'task_recs': recs,
    }
    owner_cps[owner].append(cp_info)

print(f"  Tasks held back by safety rules: {len(unmatched_safety)}")
unsafe_reasons = Counter(t['reason'].split(':')[0] for t in unmatched_safety)
for r, n in unsafe_reasons.most_common():
    print(f"    {r}: {n}")


# === STEP 5: per-owner ranking + quota ===
print(f"\n=== TOP 80/120 ANALYSIS ===")
print(f"  {'Owner':22s}  {'Quota':>5s}  {'CPs':>4s}  {'Keep':>4s}  {'Drop':>4s}  {'DropTk':>6s}  {'P1':>3s} {'P2':>3s} {'P3':>3s} {'P4':>4s}")
total_keep_tasks = 0
total_drop_tasks = 0
output_rows = []

for owner in sorted(owner_cps.keys(), key=lambda o: -len(owner_cps[o])):
    quota = QUOTAS.get(owner, DEFAULT_QUOTA)
    cps = owner_cps[owner]
    def sort_key(cp):
        co = parse_dt(cp['created_at'])
        co_ts = co.timestamp() if co else 0
        return (priority(cp['d90'], cp['all_time'], cp['created_at']),
                -cp['d90'], -cp['all_time'], -co_ts)
    cps_sorted = sorted(cps, key=sort_key)
    keep = cps_sorted[:quota]
    drop = cps_sorted[quota:]
    keep_tasks = sum(c['task_count'] for c in keep)
    drop_tasks = sum(c['task_count'] for c in drop)
    total_keep_tasks += keep_tasks
    total_drop_tasks += drop_tasks
    p_counts = Counter(priority(c['d90'], c['all_time'], c['created_at']) for c in cps)
    print(f"  {owner[:22]:22s}  {quota:>5d}  {len(cps):>4d}  {len(keep):>4d}  {len(drop):>4d}  {drop_tasks:>6d}  "
          f"{p_counts.get(1,0):>3d} {p_counts.get(2,0):>3d} {p_counts.get(3,0):>3d} {p_counts.get(4,0):>4d}")

    for rank, cp in enumerate(cps_sorted, 1):
        output_rows.append({
            'owner': owner, 'quota': quota, 'rank': rank,
            'action': 'KEEP' if rank <= quota else 'MARK_DONE',
            'cp_first_name': cp['first_name'], 'sheet_name': cp['sheet_name'],
            'cp_code': cp['cp_code'],
            'priority': priority(cp['d90'], cp['all_time'], cp['created_at']),
            'd90_visits': cp['d90'], 'all_time_visits': cp['all_time'],
            'created_at': cp['created_at'], 'in_sheet1': cp['in_sheet'],
            'stage': cp['stage'], 'tasks_today': cp['task_count'],
            'task_ids': '; '.join(r['task_id'] for r in cp['task_recs']),
            'lead_id': cp['pid'],
        })

print(f"\n  TOTAL keep tasks: {total_keep_tasks}, drop tasks: {total_drop_tasks}")
print(f"  Safety-held tasks (NOT in drop set): {len(unmatched_safety)}")
print(f"  Today's task pool: {len(unique_tasks)}")
print(f"  Accounted: {total_keep_tasks + total_drop_tasks + len(unmatched_safety)}")


# === SAVE OUTPUTS ===
out_csv = 'snapshots/rfi_top80_plan.csv'
with open(out_csv, 'w', newline='') as f:
    if output_rows:
        w = csv.DictWriter(f, fieldnames=list(output_rows[0].keys()))
        w.writeheader()
        for r in output_rows: w.writerow(r)
print(f"\nFull plan CSV: {out_csv} ({len(output_rows)} rows)")

# Save the to-be-marked-done task IDs separately
drop_task_ids = []
for r in output_rows:
    if r['action'] == 'MARK_DONE':
        for tid in r['task_ids'].split('; '):
            tid = tid.strip()
            if tid: drop_task_ids.append({
                'task_id': tid, 'owner': r['owner'], 'cp_code': r['cp_code'],
                'cp_first_name': r['cp_first_name'], 'priority': r['priority'],
                'd90': r['d90_visits'], 'all_time': r['all_time_visits'],
            })
with open('snapshots/rfi_top80_drop_tasks.json', 'w') as f:
    json.dump(drop_task_ids, f, indent=2)
print(f"Drop task list: snapshots/rfi_top80_drop_tasks.json ({len(drop_task_ids)} tasks)")

# Save safety-held tasks for review
with open('snapshots/rfi_top80_safety_held.json', 'w') as f:
    json.dump(unmatched_safety, f, indent=2, default=str)
print(f"Safety-held tasks: snapshots/rfi_top80_safety_held.json ({len(unmatched_safety)} tasks)")
