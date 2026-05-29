"""
Sync mx_d30/d60/d90/all_time_visits from Sheet1 CSV to LSQ for all 4,363 CPs.

Phase 1: Per-CP lookup of cp_code → ProspectID (~20 min)
Phase 2: Bulk update via /v2/LeadManagement.svc/Lead/Bulk/UpdateV2 in batches of 25
         using SearchByKey="ProspectID" (~1 min)

Resumable: Phase 1 cached to disk; Phase 2 tracks completed batches.
"""
import urllib.parse, urllib.request, json, sys, time, csv, os
from collections import Counter

sys.stdout.reconfigure(line_buffering=True)
TS = lambda: time.strftime('%H:%M:%S')

env = dict(l.strip().split('=', 1) for l in open('.env') if '=' in l)
HOST = env['LSQ_API_HOST']
AUTH = {'accessKey': env['LSQ_ACCESS_KEY'], 'secretKey': env['LSQ_SECRET_KEY']}

CSV_PATH = "/Users/akshit.chaudhary/Downloads/Broker_data_query - Sheet1 (9).csv"
PID_CACHE = '/tmp/cp_code_to_pid.json'
RESULTS = 'snapshots/sync_visits_results.json'

def to_int(v):
    try: return int(float(v or 0))
    except: return 0

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
            try: msg = e.read().decode()[:200]
            except: msg = ''
            return None, f"HTTP {e.code}: {msg}"
        except Exception as e:
            return None, f"{type(e).__name__}"
    return None, "exhausted"


# === Load CSV ===
print(f"[{TS()}] Loading Sheet1 CSV...")
csv_data = []
seen_codes = set()
with open(CSV_PATH) as f:
    for r in csv.DictReader(f):
        code = (r.get('cp_code') or '').strip()
        if not code or code in seen_codes: continue
        seen_codes.add(code)
        csv_data.append({
            'cp_code': code,
            'name': (r.get('name') or '').strip(),
            'd30': to_int(r.get('d30_visits')),
            'd60': to_int(r.get('d60_visits')),
            'd90': to_int(r.get('d90_visits')),
            'all_time': to_int(r.get('all_time_visits')),
        })
print(f"  Unique CPs: {len(csv_data)}")


# === PHASE 1: cp_code → ProspectID lookup (with cache) ===
pid_map = {}
if os.path.exists(PID_CACHE):
    pid_map = json.load(open(PID_CACHE))
    print(f"[{TS()}] Resume Phase 1: cached PIDs for {len(pid_map)} cp_codes")

remaining = [c for c in csv_data if c['cp_code'] not in pid_map]
print(f"[{TS()}] PHASE 1: looking up {len(remaining)} cp_codes → ProspectID...")

lookup_errors = 0
not_found = 0
start = time.time()
for i, c in enumerate(remaining, 1):
    code = c['cp_code']
    body = {
        "Parameter": {"LookupName": "mx_CP_code", "LookupValue": code, "SqlOperator": "="},
        "Columns": {"Include_CSV": "ProspectID"},
        "Paging": {"PageIndex": 1, "PageSize": 2},
    }
    r, err = call("/v2/LeadManagement.svc/Leads.Get", body=body)
    if err:
        pid_map[code] = {'_error': err}
        lookup_errors += 1
    else:
        leads = r if isinstance(r, list) else (r.get('Leads') or [])
        if not leads:
            pid_map[code] = {'_error': 'not_found'}
            not_found += 1
        elif len(leads) > 1:
            pid_map[code] = {'pid': leads[0].get('ProspectID'), 'warning': f'{len(leads)} leads'}
        else:
            pid_map[code] = {'pid': leads[0].get('ProspectID')}
    if i % 100 == 0:
        elapsed = time.time() - start
        eta = elapsed/i * (len(remaining)-i)
        # save cache
        with open(PID_CACHE, 'w') as f: json.dump(pid_map, f)
        print(f"  [{TS()}] {i}/{len(remaining)}  errors={lookup_errors}  not_found={not_found}  eta={int(eta)}s")
    time.sleep(0.27)

with open(PID_CACHE, 'w') as f: json.dump(pid_map, f)
print(f"\n[{TS()}] PHASE 1 done. Errors: {lookup_errors}, Not found: {not_found}")


# === PHASE 2: bulk update in batches of 25 ===
print(f"\n[{TS()}] PHASE 2: bulk-update in batches of 25...")
ready_targets = []
for c in csv_data:
    pid_info = pid_map.get(c['cp_code'], {})
    if isinstance(pid_info, dict) and pid_info.get('pid'):
        ready_targets.append({**c, 'pid': pid_info['pid']})
print(f"  Ready to update: {len(ready_targets)}")

batches = [ready_targets[i:i+25] for i in range(0, len(ready_targets), 25)]
print(f"  Batches of 25: {len(batches)}")

total_ok = 0
total_fail = 0
fail_details = []
start = time.time()
for bi, batch in enumerate(batches, 1):
    body = {
        "SearchByKey": "ProspectID",
        "Options": {"PushNonExistentLeadsToUnProcessedList": False},
        "LeadPropertiesList": [
            {"Fields": [
                {"Attribute": "ProspectID", "Value": t['pid']},
                {"Attribute": "mx_d30_visits", "Value": str(t['d30'])},
                {"Attribute": "mx_d60_visits", "Value": str(t['d60'])},
                {"Attribute": "mx_d90_visits", "Value": str(t['d90'])},
                {"Attribute": "mx_all_time_visits", "Value": str(t['all_time'])},
            ]}
            for t in batch
        ]
    }
    r, err = call("/v2/LeadManagement.svc/Lead/Bulk/UpdateV2", body=body)
    if err:
        # whole batch failed
        total_fail += len(batch)
        fail_details.append({'batch': bi, 'error': err, 'cp_codes': [t['cp_code'] for t in batch]})
    else:
        st = r.get('Status', {})
        ok = st.get('SuccessCount', 0)
        fail = st.get('FailureCount', 0) + st.get('UnProcessedCount', 0)
        total_ok += ok
        total_fail += fail
        if fail > 0:
            fail_details.append({'batch': bi, 'response': r})
    if bi % 10 == 0 or bi == len(batches):
        elapsed = time.time() - start
        rate = bi / max(1, elapsed)
        eta = (len(batches) - bi) / max(0.1, rate)
        print(f"  [{TS()}] batch {bi}/{len(batches)}  total ok={total_ok}  fail={total_fail}  eta={int(eta)}s")
    time.sleep(0.27)

print(f"\n[{TS()}] === SYNC COMPLETE ===")
print(f"  CSV CPs:        {len(csv_data)}")
print(f"  PID resolved:   {len(ready_targets)}")
print(f"  Updated OK:     {total_ok}")
print(f"  Update failed:  {total_fail}")
print(f"  Lookup errors:  {lookup_errors}")
print(f"  Not found in LSQ: {not_found}")

with open(RESULTS, 'w') as f:
    json.dump({
        'timestamp': time.strftime('%Y-%m-%d %H:%M:%S %Z'),
        'csv_cps': len(csv_data), 'pid_resolved': len(ready_targets),
        'updated_ok': total_ok, 'update_failed': total_fail,
        'lookup_errors': lookup_errors, 'not_found': not_found,
        'fail_details': fail_details[:50],
    }, f, indent=2)
print(f"  Audit log: {RESULTS}")
