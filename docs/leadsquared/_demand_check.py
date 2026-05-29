"""
Demand-side discrepancy scan:
  1. Fetch all Demand Deal (event 12001) activities — these ARE the visits — last 60d
  2. Fetch all 'Buyer- After Visit Follow Up' tasks across all users, last 60d window
  3. Match visit RelatedProspectId against task RelatedProspectId
  4. Report visits with no AVFU task — by owner, stage, society
"""
import urllib.parse, urllib.request, json, sys, time
from collections import Counter, defaultdict

sys.stdout.reconfigure(line_buffering=True)
TS = lambda: time.strftime('%H:%M:%S')

env = dict(l.strip().split('=', 1) for l in open('.env') if '=' in l)
HOST = env['LSQ_API_HOST']
AUTH = {'accessKey': env['LSQ_ACCESS_KEY'], 'secretKey': env['LSQ_SECRET_KEY']}

WINDOW_DAYS = 60

def call(path, body=None, method='POST', retries=2):
    qs = urllib.parse.urlencode(AUTH)
    url = f"{HOST}{path}?{qs}"
    for attempt in range(retries + 1):
        try:
            req = urllib.request.Request(url, method=method,
                data=(json.dumps(body).encode() if body else None),
                headers={'Content-Type': 'application/json'})
            with urllib.request.urlopen(req, timeout=60) as r:
                return json.loads(r.read()), None
        except urllib.error.HTTPError as e:
            if e.code == 429 and attempt < retries:
                time.sleep(2 ** attempt); continue
            return None, f"HTTP {e.code}"
        except Exception as e:
            return None, f"{type(e).__name__}: {e}"
    return None, "exhausted"

# === STEP 1: fetch all Demand Deal (12001) activities last 60 days ===
print(f"[{TS()}] STEP 1: fetching event 12001 (Demand Deal) activities, last {WINDOW_DAYS}d...")

now = time.time()
from_t = now - WINDOW_DAYS * 86400
visits = {}  # prospect_id → {visit_data}; dedup by prospect (latest wins)
visit_count_total = 0  # raw count incl. duplicates per prospect

cursor = from_t
chunk_days = 7
while cursor < now:
    chunk_end = min(cursor + chunk_days * 86400, now)
    f_str = time.strftime('%Y-%m-%d %H:%M:%S', time.localtime(cursor))
    t_str = time.strftime('%Y-%m-%d %H:%M:%S', time.localtime(chunk_end))
    page = 1
    while page <= 50:
        body = {
            "Parameter": {"FromDate": f_str, "ToDate": t_str, "ActivityEvent": 12001, "IncludeCustomFields": 1},
            "Paging": {"PageIndex": page, "PageSize": 1000},
            "Sorting": {"ColumnName": "ModifiedOn", "Direction": "1"},
        }
        r, err = call("/v2/ProspectActivity.svc/RetrieveRecentlyModified", body=body)
        if err:
            print(f"  ERR chunk {f_str[:10]} p{page}: {err}"); break
        acts = r.get('ProspectActivities') or []
        if not acts: break
        for a in acts:
            pid = a.get('RelatedProspectId')
            if not pid: continue
            visit_count_total += 1
            # Extract owner / stage / society from custom fields
            fields = {f.get('Key'): f.get('Value') for f in (a.get('Fields') or [])}
            entry = {
                'prospect_id': pid,
                'activity_id': a.get('Id'),
                'modified_on': a.get('ModifiedOn'),
                'created_on': a.get('CreatedOn'),
                'sales_owner_text': fields.get('mx_Custom_11') or fields.get('mx_Custom_37') or '',
                'owner_uuid': fields.get('Owner') or '',
                'stage':       fields.get('mx_Custom_2') or '',
                'buyer_name':  fields.get('mx_Custom_4') or '',
                'cp_info':     fields.get('mx_Custom_5') or '',
                'unit':        fields.get('mx_Custom_42') or '',
                'visit_date':  fields.get('mx_Custom_28') or fields.get('mx_Custom_39') or '',
                'sales_feedback': fields.get('mx_Custom_36') or '',
                'lead_source': fields.get('mx_Custom_3') or '',
                'deal_title':  fields.get('mx_Custom_1') or '',
            }
            # Society (extracted from unit address if present)
            unit = entry['unit']
            society = ''
            if unit:
                parts = str(unit).strip().split()
                society = ' '.join(parts[2:]) if len(parts) >= 3 else unit
            entry['society'] = society
            visits[pid] = entry  # latest wins per prospect (we want current state)
        if len(acts) < 1000: break
        page += 1
        time.sleep(0.27)
    print(f"  [{TS()}] {f_str[:10]} → {t_str[:10]}  unique_visits={len(visits)}")
    cursor = chunk_end + 1

print(f"\n[{TS()}] Total raw 12001 activity rows scanned: {visit_count_total}")
print(f"[{TS()}] Unique buyer prospect IDs (visits): {len(visits)}")

with open('/tmp/demand_visits.json', 'w') as f:
    json.dump(visits, f, indent=2, default=str)

# === STEP 2: fetch all After-Visit Followup tasks (system-wide, last 60d) ===
print(f"\n[{TS()}] STEP 2: fetching AVFU tasks per user...")
users = json.load(open('snapshots/raw/users.json'))
items = users if isinstance(users, list) else users.get('Users', users)
active_users = [u for u in items if u.get('StatusCode') in (0, '0')]
print(f"  {len(active_users)} active users")

avfu_tasks_pids = set()  # prospect IDs with at least 1 AVFU task in window
total_avfu_tasks = 0
task_cutoff = time.time() - WINDOW_DAYS * 86400

for i, u in enumerate(active_users, 1):
    email = u.get('EmailAddress')
    if not email: continue
    name = f"{u.get('FirstName','')} {u.get('LastName','')}".strip()
    user_avfu_count = 0

    for status_code in [0, 1]:  # 0=open, 1=completed
        page = 1
        while page <= 30:
            body = {
                "Parameter": {"LookupName": "OwnerEmailAddress", "LookupValue": email, "StatusCode": status_code},
                "Paging": {"PageIndex": page, "PageSize": 1000},
                "Sorting": {"ColumnName": "CreatedOn", "Direction": "1"},  # newest first
            }
            r, err = call("/v2/Task.svc/Retrieve", body=body)
            if err:
                break
            tasks = []
            if r:
                tasks = r.get('List') or r.get('Tasks') or r.get('Records') or (r if isinstance(r, list) else [])
            if not tasks: break
            stale_break = False
            for t in tasks:
                created_str = t.get('CreatedOn') or ''
                # Parse the timestamp; LSQ format: "4/30/2026 10:12:46 AM"
                try:
                    parsed = time.mktime(time.strptime(created_str.split('.')[0], '%m/%d/%Y %I:%M:%S %p'))
                except Exception:
                    parsed = None
                if parsed is not None and parsed < task_cutoff:
                    stale_break = True; break
                subj = (t.get('Name') or t.get('Subject') or '').strip()
                if subj.startswith('Buyer- After Visit Follow Up'):
                    pid = t.get('RelatedProspectId')
                    if pid:
                        avfu_tasks_pids.add(pid)
                        user_avfu_count += 1
                        total_avfu_tasks += 1
            if stale_break or len(tasks) < 1000: break
            page += 1
            time.sleep(0.27)
        time.sleep(0.27)
    if user_avfu_count > 0 or i % 5 == 0:
        print(f"  [{TS()}] {i}/{len(active_users)}  {name[:25]:25s}  avfu={user_avfu_count}  total={total_avfu_tasks}  unique_pids={len(avfu_tasks_pids)}")

print(f"\n[{TS()}] Total AVFU tasks found: {total_avfu_tasks}")
print(f"[{TS()}] Unique prospect IDs with at least 1 AVFU task: {len(avfu_tasks_pids)}")

# === STEP 3: cross-reference ===
print(f"\n[{TS()}] STEP 3: cross-referencing visits vs AVFU tasks...")
with_task = []
without_task = []
for pid, v in visits.items():
    if pid in avfu_tasks_pids:
        with_task.append(v)
    else:
        without_task.append(v)

print(f"\n=== RESULT ===")
print(f"Total visits (unique prospects): {len(visits)}")
print(f"  with AVFU task:    {len(with_task)} ({len(with_task)*100//max(1,len(visits))}%)")
print(f"  without AVFU task: {len(without_task)} ({len(without_task)*100//max(1,len(visits))}%)")

# By sales owner
print("\n=== BY SALES OWNER (top 15) ===")
owner_total = Counter()
owner_no_task = Counter()
for v in visits.values():
    o = v['sales_owner_text'] or '(blank)'
    owner_total[o] += 1
for v in without_task:
    o = v['sales_owner_text'] or '(blank)'
    owner_no_task[o] += 1
print(f"  {'Owner':25s}  {'Total':>6s}  {'No AVFU':>8s}  {'%':>5s}")
for o, total in owner_total.most_common(15):
    nt = owner_no_task.get(o, 0)
    pct = nt * 100 // max(1, total)
    print(f"  {o[:25]:25s}  {total:>6d}  {nt:>8d}  {pct:>4d}%")

# By stage
print("\n=== BY VISIT STAGE ===")
stage_total = Counter()
stage_no_task = Counter()
for v in visits.values():
    stage_total[v['stage'] or '(blank)'] += 1
for v in without_task:
    stage_no_task[v['stage'] or '(blank)'] += 1
print(f"  {'Stage':35s}  {'Total':>6s}  {'No AVFU':>8s}")
for s, total in stage_total.most_common(20):
    nt = stage_no_task.get(s, 0)
    print(f"  {s[:35]:35s}  {total:>6d}  {nt:>8d}")

# Save outputs
import csv
with open('snapshots/demand_visits_no_avfu_task.csv', 'w', newline='') as f:
    w = csv.writer(f)
    w.writerow(['Prospect ID', 'Sales Owner', 'Stage', 'Buyer Name', 'Society/Unit',
                'Visit Date', 'Sales Feedback', 'Lead Source', 'Modified On'])
    for v in without_task:
        w.writerow([v['prospect_id'], v['sales_owner_text'], v['stage'], v['buyer_name'],
                    v['society'] or v['unit'], v['visit_date'], v['sales_feedback'][:80],
                    v['lead_source'], v['modified_on']])

with open('/tmp/demand_check_results.json', 'w') as f:
    json.dump({
        'window_days': WINDOW_DAYS,
        'total_visits': len(visits),
        'with_task': len(with_task),
        'without_task': len(without_task),
        'avfu_total': total_avfu_tasks,
        'avfu_unique_pids': len(avfu_tasks_pids),
        'by_owner': {o: {'total': owner_total[o], 'no_task': owner_no_task.get(o, 0)} for o in owner_total},
        'by_stage': {s: {'total': stage_total[s], 'no_task': stage_no_task.get(s, 0)} for s in stage_total},
    }, f, indent=2)

print(f"\n[{TS()}] CSV: snapshots/demand_visits_no_avfu_task.csv ({len(without_task)} rows)")
print(f"[{TS()}] === DEMAND CHECK COMPLETE ===")
