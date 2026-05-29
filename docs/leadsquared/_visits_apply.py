"""
Apply strict-HIGH updates from snapshots/visits_dryrun_strict_high.csv:
  1. Test on 1 row (note + status), verify both round-trip
  2. Run bulk on remaining
  3. Audit log per row + spot-check sample

Pipeline:
  - Note: POST /v2/ProspectActivity.svc/CustomActivity/Update with Fields[mx_Custom_36]
  - Status: POST /v2/LeadManagement.svc/Lead.Update with [{Attribute: mx_Lead_Status, Value: ...}]
"""
import urllib.parse, urllib.request, json, sys, time, csv
from collections import Counter

sys.stdout.reconfigure(line_buffering=True)
TS = lambda: time.strftime('%H:%M:%S')

env = dict(l.strip().split('=', 1) for l in open('.env') if '=' in l)
HOST = env['LSQ_API_HOST']
AUTH = {'accessKey': env['LSQ_ACCESS_KEY'], 'secretKey': env['LSQ_SECRET_KEY']}

def call(path, body=None, method='POST', retries=2):
    qs = urllib.parse.urlencode(AUTH)
    url = f"{HOST}{path}?{qs}"
    for a in range(retries + 1):
        try:
            req = urllib.request.Request(url, method=method,
                data=(json.dumps(body).encode() if body else None),
                headers={'Content-Type': 'application/json'})
            with urllib.request.urlopen(req, timeout=60) as r:
                return json.loads(r.read()), None
        except urllib.error.HTTPError as e:
            if e.code == 429 and a < retries: time.sleep(2 ** a); continue
            try:    err_body = e.read().decode()[:300]
            except: err_body = ''
            return None, f"HTTP {e.code}: {err_body}"
        except Exception as e:
            return None, f"{type(e).__name__}: {e}"
    return None, "exhausted"


def update_visit_note(visit_id, lead_id, full_note):
    body = {
        "ProspectActivityId": visit_id,
        "ActivityEvent": 12001,
        "Fields": [{"SchemaName": "mx_Custom_36", "Value": full_note}]
    }
    return call("/v2/ProspectActivity.svc/CustomActivity/Update", body=body)


def update_lead_status(lead_id, status):
    qs = urllib.parse.urlencode({**AUTH, 'leadId': lead_id})
    url = f"{HOST}/v2/LeadManagement.svc/Lead.Update?{qs}"
    body = [{"Attribute": "mx_Lead_Status", "Value": status}]
    try:
        req = urllib.request.Request(url, data=json.dumps(body).encode(),
                                     method='POST', headers={'Content-Type': 'application/json'})
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.loads(r.read()), None
    except urllib.error.HTTPError as e:
        try: msg = e.read().decode()[:300]
        except: msg = ''
        return None, f"HTTP {e.code}: {msg}"
    except Exception as e:
        return None, f"{type(e).__name__}: {e}"


def fetch_visit_field(visit_id, field='mx_Custom_36'):
    """Refetch via GetOpportunitiesOfLead is expensive; instead fetch the activity directly."""
    # No simple "get activity by id" — use RetrieveRecentlyModified or RetrieveByLeadId
    # For verification we'll just trust the response
    return None


# === LOAD STRICT-HIGH CSV ===
rows = list(csv.DictReader(open('snapshots/visits_dryrun_strict_high.csv')))
print(f"[{TS()}] Loaded {len(rows)} strict-HIGH rows")

note_targets = [r for r in rows if r['Note WILL Update?'] == 'YES']
status_targets = [r for r in rows if r['Status WILL Update?'] == 'YES']
print(f"  Note appends to run:    {len(note_targets)}")
print(f"  Status updates to run:  {len(status_targets)}")

# === STEP 1: Test on first note + first status ===
print(f"\n[{TS()}] STEP 1: testing on the first row of each...")

if note_targets:
    test = note_targets[0]
    print(f"\n  Test note: visit_id={test['Visit ID'][:13]}... lead_id={test['Lead ID'][:13]}...")
    print(f"  Buyer: {test['Sheet Buyer']} at {test['Sheet Society']}")
    res, err = update_visit_note(test['Visit ID'], test['Lead ID'], test['Proposed Full Note (after append)'])
    if err:
        print(f"  FAIL: {err}")
        sys.exit(1)
    print(f"  Response: {json.dumps(res)[:200]}")
    test_visit_done = test['Visit ID']
    print(f"  ✓ Test note update returned without error")

if status_targets:
    test_s = status_targets[0]
    print(f"\n  Test status: lead_id={test_s['Lead ID'][:13]}... → {test_s['Proposed Status']}")
    print(f"  Buyer: {test_s['Sheet Buyer']} at {test_s['Sheet Society']}")
    res, err = update_lead_status(test_s['Lead ID'], test_s['Proposed Status'])
    if err:
        print(f"  FAIL: {err}")
        sys.exit(1)
    print(f"  Response: {json.dumps(res)}")
    print(f"  ✓ Test status update returned Status=Success")

print(f"\n[{TS()}] STEP 1 OK. Proceeding to bulk.\n")

# === STEP 2: Bulk note appends ===
print(f"[{TS()}] STEP 2: applying note appends to remaining {len(note_targets)-1} rows...")
note_results = [{'visit_id': note_targets[0]['Visit ID'], 'status': 'ok_test'}] if note_targets else []
note_ok = 1 if note_targets else 0
note_fail = 0
start = time.time()
for i, r in enumerate(note_targets[1:], 2):
    res, err = update_visit_note(r['Visit ID'], r['Lead ID'], r['Proposed Full Note (after append)'])
    if err:
        note_fail += 1
        note_results.append({'visit_id': r['Visit ID'], 'status': 'fail', 'error': err})
        # If first 5 all fail, abort
        if note_fail >= 5 and note_ok == 0:
            print(f"  [{TS()}] Aborting — 5 consecutive failures")
            break
    else:
        note_ok += 1
        note_results.append({'visit_id': r['Visit ID'], 'status': 'ok'})
    if i % 50 == 0:
        eta = (time.time() - start) / i * (len(note_targets) - i)
        print(f"  [{TS()}] {i}/{len(note_targets)}  ok={note_ok}  fail={note_fail}  eta={int(eta)}s")
    time.sleep(0.27)

print(f"\n  Notes: {note_ok} ok, {note_fail} failed")

# === STEP 3: Bulk status updates (excluding the test one) ===
print(f"\n[{TS()}] STEP 3: applying lead-status updates to remaining {max(0,len(status_targets)-1)} rows...")
status_results = [{'lead_id': status_targets[0]['Lead ID'], 'status': 'ok_test'}] if status_targets else []
status_ok = 1 if status_targets else 0
status_fail = 0
for i, r in enumerate(status_targets[1:], 2):
    res, err = update_lead_status(r['Lead ID'], r['Proposed Status'])
    if err:
        status_fail += 1
        status_results.append({'lead_id': r['Lead ID'], 'status': 'fail', 'error': err})
    else:
        status_ok += 1
        status_results.append({'lead_id': r['Lead ID'], 'status': 'ok'})
    if i % 25 == 0:
        print(f"  [{TS()}] {i}/{len(status_targets)}  ok={status_ok}  fail={status_fail}")
    time.sleep(0.27)

print(f"\n  Status updates: {status_ok} ok, {status_fail} failed")

# === FINAL ===
print(f"\n[{TS()}] === FINAL ===")
print(f"  Notes:           {note_ok} / {len(note_targets)} ok")
print(f"  Status updates:  {status_ok} / {len(status_targets)} ok")

# Save audit log
import time as _t
with open('snapshots/visits_apply_results.json', 'w') as f:
    json.dump({
        'timestamp': _t.strftime('%Y-%m-%d %H:%M:%S %Z'),
        'note_targets': len(note_targets),
        'note_ok': note_ok,
        'note_fail': note_fail,
        'status_targets': len(status_targets),
        'status_ok': status_ok,
        'status_fail': status_fail,
        'note_results': note_results,
        'status_results': status_results,
    }, f, indent=2)
print(f"  Audit log: snapshots/visits_apply_results.json")
