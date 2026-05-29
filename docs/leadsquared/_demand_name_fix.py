"""
Fix demand-deal (12001) opportunity names where the address-1 portion encoded
in mx_Custom_1 differs from the mx_Custom_42 (unit_address_line1) column.

Source of truth: mx_Custom_42 is correct.
Field to rewrite:  mx_Custom_1 (Opportunity Name) → "<buyer> <addr1>"

API:
  POST /v2/OpportunityManagement.svc/Update
  Body: { "ProspectOpportunityId": "<id>", "Fields": [{...}] }
Verification: refetch via /v2/ProspectActivity.svc/RetrieveRecentlyModified
              and match on `Id`.

Safety guards:
  1. Refetch ALL 5,352 demand opps fresh at apply-time (no stale snapshot).
  2. Skip if mx_Custom_4 (buyer) blank.
  3. Skip if mx_Custom_42 (addr1) blank.
  4. Skip if proposed name == current name (idempotent).
  5. Skip if proposed name > 200 chars (LSQ field max).
  6. Backup full {opp_id, lead_id, old_name, addr1, buyer, modified_on} BEFORE writes.
  7. Stop on 5 consecutive write failures.
  8. Rate-limit + exponential backoff on 429.
  9. Per-record audit row in CSV/JSON.
 10. Final batch verification: refetch and confirm each of the 553 names changed.
 11. APPLY=False by default → preview only, zero LSQ mutations.

Usage:
  python3 _demand_name_fix.py                  # dry-run (preview CSV only)
  python3 _demand_name_fix.py --apply --limit 1  # one-record live test
  python3 _demand_name_fix.py --apply           # full run
  python3 _demand_name_fix.py --apply --hyphen  # use "<buyer>- <addr1>" form
"""
import urllib.parse, urllib.request, json, time, re, sys, csv, argparse
from collections import Counter

sys.stdout.reconfigure(line_buffering=True)
TS = lambda: time.strftime('%H:%M:%S')

env = dict(l.strip().split('=', 1) for l in open('.env') if '=' in l)
HOST = env['LSQ_API_HOST']
AUTH = {'accessKey': env['LSQ_ACCESS_KEY'], 'secretKey': env['LSQ_SECRET_KEY']}

ap = argparse.ArgumentParser()
ap.add_argument('--apply', action='store_true', help='Write changes to LSQ')
ap.add_argument('--hyphen', action='store_true', help='Use "<buyer>- <addr1>" canonical form')
ap.add_argument('--limit', type=int, default=0, help='Limit to first N (0 = all)')
args = ap.parse_args()

SEP  = '- ' if args.hyphen else ' '
MODE = 'APPLY' if args.apply else 'DRY-RUN'
print(f'[{TS()}] Mode: {MODE}   Separator: "<buyer>{SEP}<addr1>"')


def call(path, body=None, method='POST', extra_qs=None, retries=3):
    qs_d = dict(AUTH)
    if extra_qs: qs_d.update(extra_qs)
    qs = urllib.parse.urlencode(qs_d)
    url = f'{HOST}{path}?{qs}'
    last_err = None
    for attempt in range(retries + 1):
        try:
            req = urllib.request.Request(url, method=method,
                data=(json.dumps(body).encode() if body is not None else None),
                headers={'Content-Type': 'application/json'})
            with urllib.request.urlopen(req, timeout=60) as r:
                return json.loads(r.read()), None
        except urllib.error.HTTPError as e:
            err_body = ''
            try: err_body = e.read().decode()[:300]
            except Exception: pass
            last_err = f'HTTP {e.code}: {err_body}'
            if e.code == 429 and attempt < retries:
                time.sleep(2 ** attempt); continue
            return None, last_err
        except Exception as e:
            last_err = f'{type(e).__name__}: {e}'
            if attempt < retries:
                time.sleep(1 + attempt); continue
            return None, last_err
    return None, last_err or 'exhausted'


def norm(s):
    return re.sub(r'\s+', ' ', (s or '')).strip()


def fetch_all_demand_opps():
    out = []
    for page in range(1, 50):
        body = {
            'Parameter': {
                'FromDate': '2020-01-01 00:00:00',
                'ToDate':   time.strftime('%Y-%m-%d %H:%M:%S'),
                'ActivityEvent': 12001,
                'IncludeCustomFields': 1,
            },
            'Paging': {'PageIndex': page, 'PageSize': 1000},
            'Sorting': {'ColumnName': 'CreatedOn', 'Direction': '1'},
        }
        d, err = call('/v2/ProspectActivity.svc/RetrieveRecentlyModified', body=body)
        if err:
            print(f'  ABORT: page {page} fetch failed: {err}'); sys.exit(1)
        acts = d.get('ProspectActivities') or []
        out.extend(acts)
        if len(acts) < 1000: break
        time.sleep(0.25)
    return out


# === STEP 1: Refetch + identify mismatch set ===
print(f'[{TS()}] Step 1: refetching all demand (12001) opportunities...')
all_opps = fetch_all_demand_opps()
print(f'[{TS()}] Total fetched: {len(all_opps)}')

print(f'\n[{TS()}] Step 2: identifying mismatch set + building proposed names...')
to_fix = []
skip_reasons = Counter()
for a in all_opps:
    fields = {f.get('Key'): f.get('Value') for f in (a.get('Fields') or [])}
    name  = norm(fields.get('mx_Custom_1'))
    buyer = norm(fields.get('mx_Custom_4'))
    addr1 = norm(fields.get('mx_Custom_42'))
    if not name:  skip_reasons['name_blank']  += 1; continue
    if not addr1: skip_reasons['addr1_blank'] += 1; continue
    if name.lower().endswith(addr1.lower()):
        continue  # already aligned
    if not buyer:
        skip_reasons['buyer_blank'] += 1; continue
    proposed = f'{buyer}{SEP}{addr1}'
    if len(proposed) > 200:
        skip_reasons['proposed_too_long'] += 1; continue
    if proposed == name:
        skip_reasons['already_correct'] += 1; continue

    to_fix.append({
        'opp_id':      a.get('Id'),
        'lead_id':     a.get('RelatedProspectId'),
        'buyer':       buyer,
        'addr1':       addr1,
        'old_name':    name,
        'new_name':    proposed,
        'modified_on': a.get('ModifiedOn'),
        'created_on':  a.get('CreatedOn'),
    })
print(f'  candidates to fix:  {len(to_fix)}')
for k, v in skip_reasons.most_common():
    print(f'  skipped ({k}): {v}')

# Backup BEFORE any write
preview_csv = 'snapshots/demand_opp_name_fix_preview.csv'
backup_json = 'snapshots/demand_opp_name_fix_backup.json'
with open(preview_csv, 'w', newline='') as f:
    w = csv.writer(f)
    w.writerow(['opp_id','lead_id','buyer','addr1_column','OLD_name','NEW_name','created_on','modified_on'])
    for r in to_fix:
        w.writerow([r['opp_id'], r['lead_id'], r['buyer'], r['addr1'],
                    r['old_name'], r['new_name'], r['created_on'], r['modified_on']])
with open(backup_json, 'w') as f:
    json.dump({'generated_at': time.strftime('%Y-%m-%d %H:%M:%S'),
               'separator': repr(SEP),
               'count': len(to_fix),
               'records': to_fix}, f, indent=2, default=str)
print(f'\n  preview CSV: {preview_csv}')
print(f'  backup JSON: {backup_json}')

print(f'\n=== Sample of proposed renames (first 12) ===')
for r in to_fix[:12]:
    print(f"  {r['opp_id'][:8]}.. | OLD: {r['old_name'][:55]:55s} | NEW: {r['new_name'][:55]}")

if not args.apply:
    print(f'\n[{TS()}] === DRY-RUN COMPLETE — no LSQ writes ===')
    sys.exit(0)

# === STEP 3: Apply ===
target = to_fix[:args.limit] if args.limit else to_fix
print(f'\n[{TS()}] Step 3: applying {len(target)} updates...')
results = []
written = errors = consecutive_failures = 0

for i, r in enumerate(target, 1):
    body = {
        'ProspectOpportunityId': r['opp_id'],
        'Fields': [{'SchemaName': 'mx_Custom_1', 'Value': r['new_name']}],
    }
    res, err = call('/v2/OpportunityManagement.svc/Update', body=body, method='POST')
    if err or (res and res.get('Status') != 'Success'):
        errors += 1; consecutive_failures += 1
        results.append({**r, 'status':'write_failed', 'error': err or json.dumps(res)})
        if consecutive_failures >= 5:
            print(f'\n[{TS()}] ABORT — 5 consecutive write failures.')
            break
        time.sleep(0.5)
        continue
    written += 1; consecutive_failures = 0
    results.append({**r, 'status':'written', 'response': res})
    if i % 25 == 0 or i == len(target):
        print(f'  [{TS()}] {i}/{len(target)}  written={written}  errors={errors}')
        with open('snapshots/demand_opp_name_fix_results.json', 'w') as f:
            json.dump({'in_progress':True, 'processed':i, 'written':written,
                       'errors':errors, 'results':results}, f, indent=2, default=str)
    time.sleep(0.3)

print(f'\n[{TS()}] writes done: {written} OK / {errors} errors')

# === STEP 4: Batch verification ===
print(f'\n[{TS()}] Step 4: refetching all demand opps for verification...')
verify_opps = fetch_all_demand_opps()
verify_idx = {a.get('Id'): a for a in verify_opps}
verified = name_unchanged = missing = 0
for r in results:
    if r.get('status') != 'written': continue
    a = verify_idx.get(r['opp_id'])
    if not a:
        r['verify_status'] = 'missing'; missing += 1; continue
    fields = {f.get('Key'): f.get('Value') for f in (a.get('Fields') or [])}
    cur_name = norm(fields.get('mx_Custom_1'))
    if cur_name == r['new_name']:
        r['verify_status'] = 'ok'; verified += 1
    else:
        r['verify_status'] = 'name_unchanged'; r['cur_name_after'] = cur_name
        name_unchanged += 1

with open('snapshots/demand_opp_name_fix_results.json', 'w') as f:
    json.dump({'in_progress':False, 'processed':len(results),
               'written':written, 'errors':errors,
               'verified':verified, 'name_unchanged':name_unchanged, 'missing':missing,
               'results':results}, f, indent=2, default=str)
with open('snapshots/demand_opp_name_fix_results.csv', 'w', newline='') as f:
    w = csv.writer(f)
    w.writerow(['opp_id','lead_id','status','verify_status','old_name','new_name','cur_name_after','error'])
    for x in results:
        w.writerow([x.get('opp_id'), x.get('lead_id'), x.get('status'),
                    x.get('verify_status',''), x.get('old_name'), x.get('new_name'),
                    x.get('cur_name_after',''), x.get('error','')])

print(f'\n[{TS()}] === FINAL ===')
print(f'  attempted:        {len(results)}')
print(f'  written OK:       {written}')
print(f'  write errors:     {errors}')
print(f'  verified:         {verified}')
print(f'  name unchanged:   {name_unchanged}')
print(f'  not found:        {missing}')
print(f'  results:          snapshots/demand_opp_name_fix_results.csv / .json')
