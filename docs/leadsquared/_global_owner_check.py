"""
Global ownership-mismatch scan.

Universe = unique leads that fired event 12000 (Supply Deal) or 12001 (Demand
Deal) in the last 365 days. For each, call GetOpportunitiesOfLead (any type)
and compare each opp's `Owner` field against the parent lead's owner
(`P_OwnerIdName` / `P_ProspectID` in the response — the API returns both).

Output:
  - count of opps with opp.Owner != lead.OwnerId
  - breakdown by (opp_owner, lead_owner) pair
  - CSV of every mismatch with seller name + opp + lead owner names
"""
import urllib.parse, urllib.request, json, sys, time, csv
from collections import Counter, defaultdict

sys.stdout.reconfigure(line_buffering=True)
TS = lambda: time.strftime('%H:%M:%S')

env = dict(l.strip().split('=', 1) for l in open('.env') if '=' in l)
HOST = env['LSQ_API_HOST']
AUTH = {'accessKey': env['LSQ_ACCESS_KEY'], 'secretKey': env['LSQ_SECRET_KEY']}

# Build name→UUID map from users.json (the API returns lead-owner NAME, not UUID, so we resolve it)
_users_data = json.load(open('snapshots/raw/users.json'))
_users_items = _users_data if isinstance(_users_data, list) else _users_data.get('Users', _users_data)
NAME_TO_UUID = {}
for u in _users_items:
    full = f"{u.get('FirstName','')} {u.get('LastName','') or ''}".strip()
    if full and u.get('ID'):
        NAME_TO_UUID[full] = u['ID']
print(f"Loaded {len(NAME_TO_UUID)} user name→UUID mappings")

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
            return None, f"HTTP {e.code}"
        except Exception as e:
            return None, f"{type(e).__name__}"
    return None, "exhausted"


# === STEP 1: build universe (cached if recent) ===
import os
CACHE_PATH = '/tmp/global_universe.json'

def build_universe():
    u = set()
    now_t = time.time()
    for code in [12000, 12001]:
        cursor = now_t - 365 * 86400
        while cursor < now_t:
            chunk_end = min(cursor + 14 * 86400, now_t)
            f_str = time.strftime('%Y-%m-%d %H:%M:%S', time.localtime(cursor))
            t_str = time.strftime('%Y-%m-%d %H:%M:%S', time.localtime(chunk_end))
            page = 1
            while page <= 50:
                body = {"Parameter": {"FromDate": f_str, "ToDate": t_str,
                                       "ActivityEvent": code, "IncludeCustomFields": 0},
                        "Paging": {"PageIndex": page, "PageSize": 1000},
                        "Sorting": {"ColumnName": "ModifiedOn", "Direction": "1"}}
                r, err = call("/v2/ProspectActivity.svc/RetrieveRecentlyModified", body=body)
                if err: break
                acts = r.get('ProspectActivities') or []
                if not acts: break
                for a in acts:
                    pid = a.get('RelatedProspectId')
                    if pid: u.add(pid)
                if len(acts) < 1000: break
                page += 1
                time.sleep(0.27)
            cursor = chunk_end + 1
        print(f"  [{TS()}] event {code} done. universe={len(u)}")
    return u

if os.path.exists(CACHE_PATH) and (time.time() - os.path.getmtime(CACHE_PATH)) < 3 * 3600:
    print(f"[{TS()}] STEP 1: Loading cached universe...")
    universe = set(json.load(open(CACHE_PATH)))
    print(f"  Cached universe: {len(universe)} leads")
else:
    print(f"[{TS()}] STEP 1: Building universe of leads with opp activity (365d)...")
    universe = build_universe()
    json.dump(list(universe), open(CACHE_PATH, 'w'))
    print(f"  Cached to {CACHE_PATH}")

print(f"\n[{TS()}] Universe: {len(universe)} unique leads with opp activity (365d)")
universe_list = list(universe)

# === STEP 2: per-lead opp check ===
print(f"\n[{TS()}] STEP 2: Per-lead check ({len(universe_list)} leads, ~{int(len(universe_list)*0.27/60)} min expected)...")

mismatches = []
total_opps = 0
matched = 0
mismatched = 0
errors = 0
no_opp = 0
pair_counts = Counter()  # (opp_owner_name, lead_owner_name) -> count
opp_owner_totals = Counter()  # how many mismatched opps each opp_owner has
start = time.time()

for i, lid in enumerate(universe_list, 1):
    qs = urllib.parse.urlencode({**AUTH, 'leadId': lid})
    req = urllib.request.Request(f"{HOST}/v2/OpportunityManagement.svc/GetOpportunitiesOfLead?{qs}",
        data=b'{}', method='POST', headers={'Content-Type': 'application/json'})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            opps = (json.loads(r.read()).get('List') or [])
    except urllib.error.HTTPError as e:
        if e.code == 429:
            time.sleep(2)
            try:
                with urllib.request.urlopen(req, timeout=30) as r:
                    opps = (json.loads(r.read()).get('List') or [])
            except Exception:
                errors += 1; opps = []
        else:
            errors += 1; opps = []
    except Exception:
        errors += 1; opps = []

    if not opps:
        no_opp += 1
    else:
        for o in opps:
            total_opps += 1
            opp_owner_uuid = o.get('Owner')
            opp_owner_name = o.get('OwnerName') or o.get('OwnerIdName') or ''
            lead_owner_name = o.get('P_OwnerIdName') or ''
            lead_owner_uuid = NAME_TO_UUID.get(lead_owner_name) if lead_owner_name else None

            if not opp_owner_uuid or not lead_owner_name:
                continue  # can't compare; skip silently
            if lead_owner_uuid and opp_owner_uuid == lead_owner_uuid:
                matched += 1
            elif opp_owner_name == lead_owner_name and opp_owner_name:
                # name match without UUID match — treat as matched (rare)
                matched += 1
            else:
                mismatched += 1
                pair_counts[(opp_owner_name or 'unknown', lead_owner_name or 'unknown')] += 1
                opp_owner_totals[opp_owner_name or 'unknown'] += 1
                mismatches.append({
                    'lead_id': lid,
                    'opp_id': o.get('OpportunityId'),
                    'opp_event': o.get('OpportunityEvent'),
                    'opp_stage': o.get('mx_Custom_2'),
                    'opp_status': o.get('Status'),
                    'opp_owner_id': opp_owner_uuid,
                    'opp_owner_name': opp_owner_name,
                    'lead_owner_id': lead_owner_uuid,
                    'lead_owner_name': lead_owner_name,
                    'seller_name': o.get('P_FirstName'),
                    'seller_email': o.get('P_EmailAddress'),
                    'deal_title': o.get('mx_Custom_1'),
                    'opp_modified': o.get('ModifiedOn'),
                })
    time.sleep(0.27)
    if i % 200 == 0:
        elapsed = time.time() - start
        eta = elapsed / i * (len(universe_list) - i)
        print(f"  [{TS()}] {i}/{len(universe_list)}  total_opps={total_opps}  matched={matched}  mismatched={mismatched}  no_opp={no_opp}  errors={errors}  eta={int(eta)}s")

print(f"\n[{TS()}] === GLOBAL OWNERSHIP CHECK COMPLETE ===")
print(f"Universe (leads checked):    {len(universe_list)}")
print(f"Errors during fetch:         {errors}")
print(f"Leads with no opp returned:   {no_opp}")
print(f"Total opportunities scanned: {total_opps}")
print(f"  Matched (opp.Owner == lead owner): {matched} ({matched*100//max(1,total_opps)}%)")
print(f"  Mismatched (opp owner != lead owner): {mismatched} ({mismatched*100//max(1,total_opps)}%)")

# Top opp owners with mismatches
print(f"\n=== Top opp owners with most mismatches ===")
print(f"  {'Opp Owner':25s}  {'Mismatched Opps':>15s}")
for owner, cnt in opp_owner_totals.most_common(20):
    print(f"  {owner[:25]:25s}  {cnt:>15d}")

# Top (opp_owner → lead_owner) pairs
print(f"\n=== Top (Opp Owner → Lead Owner) mismatch pairs ===")
print(f"  {'Opp Owner':25s}  {'Lead Owner':25s}  {'Count':>8s}")
for (oo, lo), cnt in pair_counts.most_common(30):
    print(f"  {oo[:25]:25s}  {lo[:25]:25s}  {cnt:>8d}")

# Save CSV
with open('snapshots/global_owner_mismatches.csv', 'w', newline='') as f:
    w = csv.writer(f)
    w.writerow(['Lead ID', 'Seller Name', 'Seller Email', 'Opp Event', 'Opp Stage',
                'Opp Status', 'Opp Owner', 'Lead Owner', 'Deal Title', 'Opp Modified', 'Opp ID'])
    for m in mismatches:
        w.writerow([m['lead_id'], m['seller_name'], m['seller_email'], m['opp_event'],
                    m['opp_stage'], m['opp_status'], m['opp_owner_name'], m['lead_owner_name'],
                    m['deal_title'], m['opp_modified'], m['opp_id']])
print(f"\nCSV: snapshots/global_owner_mismatches.csv ({len(mismatches)} rows)")

with open('/tmp/global_owner_mismatches.json', 'w') as f:
    json.dump({
        'universe_size': len(universe_list),
        'total_opps': total_opps,
        'matched': matched,
        'mismatched': mismatched,
        'errors': errors,
        'by_opp_owner': dict(opp_owner_totals.most_common()),
        'by_pair': {f"{oo}__{lo}": c for (oo, lo), c in pair_counts.items()},
        'mismatches': mismatches,
    }, f, indent=2, default=str)
