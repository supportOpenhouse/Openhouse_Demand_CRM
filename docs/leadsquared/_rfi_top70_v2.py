"""
v2: use broker sheet for d90/all_time/created_at (sheet is up to date, LSQ is not)
    use LSQ for current owner and cp_code-from-prospect-id matching.

Priority (per user):
  P1: d90_visits > 0
  P2: created in last 60 days (and d90 == 0)
  P3: all_time_visits > 0 (and not P1/P2)
  P4: rest

Quotas: Saket Kumar / Mukul Chhabra / Shubham Sharma → 120; everyone else → 70.
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
    for f in ('%Y-%m-%d','%Y-%m-%d %H:%M:%S','%m/%d/%Y %I:%M:%S %p','%m/%d/%Y %H:%M:%S'):
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


# === STEP A: parse broker sheet → cp_code → {d90, all_time, created_at} ===
print(f"[{TS()}] Parsing broker sheet for d90/all_time data...")
SHEET_FILE = "/Users/akshit.chaudhary/.claude/projects/-Users-akshit-chaudhary-Documents-Claude-Code/7fe8a9da-14b0-4f8f-9d99-90ea39177427/tool-results/mcp-7ddd1d31-4de7-4fba-8138-5d7150d26d01-read_file_content-1778819033926.txt"
sheet = json.load(open(SHEET_FILE))['fileContent']
lines = sheet.split('\n')

# Header lines for sections WITH d90 data: 0, 116, 3760
def parse_section(start, end):
    raw_header = lines[start].strip().strip('|').split('|')
    header = [c.strip().replace('\\','') for c in raw_header]
    rows = []
    for ln in lines[start+2:end]:
        s = ln.strip()
        if not s.startswith('|'): continue
        cells = [c.strip().replace('\\','') for c in s.strip('|').split('|')]
        if len(cells) != len(header): continue
        rows.append(dict(zip(header, cells)))
    return rows

# Use ONLY Sheet1 (section 0 → ends at line 116 where Sheet2 begins)
sheet1 = parse_section(0, 116)
print(f"  Sheet1 rows: {len(sheet1)}")
sections_with_d90 = sheet1

# Build cp_code → {d90, all_time, created_at}
cp_sheet_data = {}
for r in sections_with_d90:
    cp_code = (r.get('cp_code') or '').strip()
    if not cp_code: continue
    try: d90 = int(float(r.get('d90_visits') or 0))
    except: d90 = 0
    try: at = int(float(r.get('all_time_visits') or 0))
    except: at = 0
    created_at = (r.get('created_at') or r.get('create_at') or '').strip()
    # Newer entries override older ones (sections appear in chrono order; later sections preferred)
    cp_sheet_data[cp_code] = {
        'd90': d90, 'all_time': at, 'created_at': created_at,
        'name': r.get('name','').strip(), 'added_by': r.get('added_by','').strip(),
        'city': r.get('city','').strip(),
    }
print(f"  Unique CP codes with d90 data: {len(cp_sheet_data)}")

print(f"  CPs in Sheet1 with d90>0:    {sum(1 for v in cp_sheet_data.values() if v['d90']>0)}")
print(f"  CPs in Sheet1 with all_time>0: {sum(1 for v in cp_sheet_data.values() if v['all_time']>0)}")
# CPs not in Sheet1 → assumed d90=0, all_time=0 (no visit history)


# === STEP B: fetch today's RFI tasks with RelatedProspectId ===
print(f"\n[{TS()}] Fetching today's RFI tasks...")
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
                pid = t.get('RelatedProspectId') or t.get('RelatedEntityId')
                rec = {'task_id': tid, 'subject': subj, 'owner': name, 'related_prospect_id': pid}
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

# Unique CPs (RelatedProspectId)
all_pids = set()
for (owner, pid), recs in tasks_per_owner_cp.items():
    if pid: all_pids.add(pid)
print(f"  Unique CP prospect IDs: {len(all_pids)}")


# === STEP C: look up each unique CP in LSQ to get cp_code + ProspectStage + CreatedOn ===
print(f"\n[{TS()}] Looking up {len(all_pids)} CPs in LSQ for cp_code + onboarding date...")
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
                'cp_code': gf('mx_CP_code') or '',
                'lsq_owner': l.get('OwnerIdName') or '',
                'lsq_created_on': l.get('CreatedOn'),
                'stage': l.get('ProspectStage') or '',
            }
    except Exception as e:
        cp_lsq[pid] = {'_error': str(e)}
    if i % 200 == 0:
        print(f"  [{TS()}] {i}/{len(all_pids)} done")
    time.sleep(0.27)
errors = sum(1 for v in cp_lsq.values() if v.get('_error'))
print(f"  CP lookups complete. Errors: {errors}")


# === STEP D: combine sheet + LSQ data, rank, apply quotas ===
print(f"\n[{TS()}] Combining data and applying quotas...")

def priority(d90, at, created_at_str):
    if d90 > 0: return 1
    co = parse_dt(created_at_str)
    if co and co.date() >= sixty_days_ago: return 2
    if at > 0: return 3
    return 4

owner_cps = defaultdict(list)
for (owner, pid), recs in tasks_per_owner_cp.items():
    if not pid: continue
    lsq = cp_lsq.get(pid, {})
    if lsq.get('_error'): continue
    cp_code = lsq.get('cp_code', '')
    sheet = cp_sheet_data.get(cp_code, {})
    d90 = sheet.get('d90', 0)
    at  = sheet.get('all_time', 0)
    # For created_at, prefer sheet (since user trusts sheet); fall back to LSQ
    created = sheet.get('created_at') or lsq.get('lsq_created_on') or ''
    cp_info = {
        'pid': pid, 'cp_code': cp_code,
        'first_name': lsq.get('first_name',''),
        'd90': d90, 'all_time': at, 'created_at': created,
        'lsq_owner': lsq.get('lsq_owner',''),
        'stage': lsq.get('stage',''),
        'in_sheet': cp_code in cp_sheet_data,
        'task_count': len(recs),
        'task_recs': recs,
    }
    owner_cps[owner].append(cp_info)

print(f"\n=== TOP 70/120 ANALYSIS ===")
print(f"  {'Owner':25s}  {'Quota':>5s}  {'Total CPs':>10s}  {'Keep':>5s}  {'Drop':>5s}  {'Drop tasks':>10s}  {'P1':>3s} {'P2':>3s} {'P3':>3s} {'P4':>4s}")
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
    print(f"  {owner[:25]:25s}  {quota:>5d}  {len(cps):>10d}  {len(keep):>5d}  {len(drop):>5d}  {drop_tasks:>10d}  "
          f"{p_counts.get(1,0):>3d} {p_counts.get(2,0):>3d} {p_counts.get(3,0):>3d} {p_counts.get(4,0):>4d}")

    for rank, cp in enumerate(cps_sorted, 1):
        output_rows.append({
            'owner': owner, 'quota': quota, 'rank': rank,
            'action': 'KEEP' if rank <= quota else 'MARK_DONE',
            'cp_first_name': cp['first_name'], 'cp_code': cp['cp_code'],
            'priority': priority(cp['d90'], cp['all_time'], cp['created_at']),
            'd90_visits': cp['d90'], 'all_time_visits': cp['all_time'],
            'created_at': cp['created_at'], 'in_sheet': cp['in_sheet'],
            'lsq_owner': cp['lsq_owner'], 'stage': cp['stage'],
            'tasks_today': cp['task_count'],
            'task_ids': '; '.join(r['task_id'] for r in cp['task_recs']),
            'lead_id': cp['pid'],
        })

print(f"\n  TOTAL  keep tasks: {total_keep_tasks}, drop tasks: {total_drop_tasks}")
print(f"  Today's task pool:  {len(unique_tasks)} ({total_keep_tasks + total_drop_tasks} accounted)")

# Save CSV
with open('snapshots/rfi_top70_plan_v2.csv', 'w', newline='') as f:
    if output_rows:
        w = csv.DictWriter(f, fieldnames=list(output_rows[0].keys()))
        w.writeheader()
        for r in output_rows: w.writerow(r)
print(f"\nFull plan CSV: snapshots/rfi_top70_plan_v2.csv ({len(output_rows)} rows)")

# Save JSON for next step (mark complete)
with open('/tmp/rfi_top70_plan_v2.json', 'w') as f:
    json.dump({
        'output_rows': output_rows,
        'total_keep_tasks': total_keep_tasks,
        'total_drop_tasks': total_drop_tasks,
    }, f, indent=2, default=str)
