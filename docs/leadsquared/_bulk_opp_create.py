"""
Bulk-create Supply Deal opportunities for the 1,431 remaining 'New Lead'
sellers identified by snapshot.

Per-lead flow:
  1. Leads.GetById        — fetch full lead fields
  2. GetOpportunitiesOfLead (event 12000) — last-second dedup, skip if any opp exists
  3. Capture              — create the opp

Owner of each new opp = the lead's current OwnerId. No lead fields touched
(LeadDetails carries only SearchBy=EmailAddress).

Stop conditions: 5 consecutive create failures aborts the run.
"""
import urllib.parse, urllib.request, json, sys, time
from collections import Counter

sys.stdout.reconfigure(line_buffering=True)

env = dict(l.strip().split('=', 1) for l in open('.env') if '=' in l)
HOST = env['LSQ_API_HOST']
AUTH = {'accessKey': env['LSQ_ACCESS_KEY'], 'secretKey': env['LSQ_SECRET_KEY']}
TS = lambda: time.strftime('%H:%M:%S')

# Load candidate leads (1,436 New Lead) and exclude the 5 already done
all_leads = json.load(open('/tmp/supply_team_leads.json'))
verified = json.load(open('/tmp/no_opp_verified.json'))
DONE_IN_TEST = {
    '4db7ff02-9396-4d36-8b90-99f26d5d4cc2',
    'd79562c2-bc2e-4b11-94e8-fe2d0854dec3',
    '0d40381f-0887-48ef-9794-f909c7a682fa',
    'f81d5cac-7363-4431-84d1-585081812cc2',
    '86c4a4a1-22c3-11f1-a635-0630e4b64663',
}
new_lead_ids = [lid for lid in verified['lead_ids']
                if all_leads.get(lid, {}).get('stage') == 'New Lead'
                and lid not in DONE_IN_TEST]
print(f"[{TS()}] Bulk run target: {len(new_lead_ids)} leads (1,436 total minus 5 from test)")


def fetch_lead(lid, retries=2):
    qs = urllib.parse.urlencode({**AUTH, 'id': lid})
    for attempt in range(retries + 1):
        try:
            with urllib.request.urlopen(f"{HOST}/v2/LeadManagement.svc/Leads.GetById?{qs}", timeout=30) as r:
                d = json.loads(r.read())
            leads = d if isinstance(d, list) else d.get('Leads', [])
            return (leads[0] if leads else None), None
        except urllib.error.HTTPError as e:
            if e.code == 429 and attempt < retries:
                time.sleep(2 ** attempt); continue
            return None, f"HTTP {e.code}"
        except Exception as e:
            return None, f"{type(e).__name__}: {e}"
    return None, "exhausted"


def get_opps(lid, retries=2):
    qs = urllib.parse.urlencode({**AUTH, 'leadId': lid, 'opportunityType': '12000'})
    for attempt in range(retries + 1):
        try:
            req = urllib.request.Request(
                f"{HOST}/v2/OpportunityManagement.svc/GetOpportunitiesOfLead?{qs}",
                data=b'{}', method='POST', headers={'Content-Type': 'application/json'})
            with urllib.request.urlopen(req, timeout=30) as r:
                return (json.loads(r.read()).get('List') or []), None
        except urllib.error.HTTPError as e:
            if e.code == 429 and attempt < retries:
                time.sleep(2 ** attempt); continue
            return None, f"HTTP {e.code}"
        except Exception as e:
            return None, f"{type(e).__name__}: {e}"
    return None, "exhausted"


def capture(lead, retries=2):
    email = (lead.get('EmailAddress') or '').strip()
    pid = lead.get('ProspectID')
    if email:
        lead_details = [
            {"Attribute": "EmailAddress", "Value": email},
            {"Attribute": "SearchBy", "Value": "EmailAddress"},
        ]
    else:
        lead_details = [
            {"Attribute": "ProspectID", "Value": pid},
            {"Attribute": "SearchBy", "Value": "ProspectID"},
        ]
    owner_id = lead.get('OwnerId') or ''
    first_name = (lead.get('FirstName') or '').strip()
    society = (lead.get('mx_Society') or '').strip()
    deal_name = ' - '.join([x for x in [first_name, society] if x]) or f"Deal - {pid}"
    opp_fields = [
        {"SchemaName": "mx_Custom_2", "Value": "New Deal"},
        {"SchemaName": "Owner", "Value": owner_id},
        {"SchemaName": "mx_Custom_1", "Value": deal_name},
    ]
    for src, dst in [
        ('Source', 'mx_Custom_3'),
        ('mx_Society', 'mx_Custom_27'),
        ('mx_Locality', 'mx_Custom_28'),
        ('mx_Posting_Date', 'mx_Posting_Date'),
        ('mx_Listing_Link', 'mx_Listing_Link'),
        ('Notes', 'mx_Supply_Closure_Notes'),
        ('mx_Configuration', 'mx_Configuration'),
        ('mx_Super_Built_Up_Area', 'mx_Super_Built_Up_Area'),
        ('mx_Floor', 'mx_Floor'),
        ('mx_Price_Expectation_Lacs', 'mx_Price_Expectation_Lacs'),
    ]:
        v = lead.get(src)
        if v not in (None, ''):
            opp_fields.append({"SchemaName": dst, "Value": str(v)})
    body = {
        "LeadDetails": lead_details,
        "Opportunity": {
            "OpportunityEventCode": 12000,
            "UpdateEmptyFields": True,
            "Fields": opp_fields,
        }
    }
    qs = urllib.parse.urlencode(AUTH)
    for attempt in range(retries + 1):
        try:
            req = urllib.request.Request(
                f"{HOST}/v2/OpportunityManagement.svc/Capture?{qs}",
                data=json.dumps(body).encode(), method='POST',
                headers={'Content-Type': 'application/json'})
            with urllib.request.urlopen(req, timeout=30) as r:
                return json.loads(r.read()), None
        except urllib.error.HTTPError as e:
            if e.code == 429 and attempt < retries:
                time.sleep(2 ** attempt); continue
            return None, f"HTTP {e.code}: {e.read().decode()[:200]}"
        except Exception as e:
            return None, f"{type(e).__name__}: {e}"
    return None, "exhausted"


# --- Main loop ---
results = []
created = 0
skipped_existing = 0
errors = 0
consecutive_failures = 0
start = time.time()
checkpoint_every = 100

for i, lid in enumerate(new_lead_ids, 1):
    lead, err = fetch_lead(lid)
    if err or not lead:
        results.append({'lead_id': lid, 'status': 'fetch_failed', 'error': err or 'no lead'})
        errors += 1; consecutive_failures += 1
    else:
        existing, err = get_opps(lid)
        if err:
            results.append({'lead_id': lid, 'status': 'dedup_failed', 'error': err})
            errors += 1; consecutive_failures += 1
        elif existing:
            results.append({'lead_id': lid, 'status': 'skipped', 'reason': 'opp_exists',
                            'existing_opp_count': len(existing)})
            skipped_existing += 1
            consecutive_failures = 0
        else:
            res, err = capture(lead)
            if err:
                results.append({'lead_id': lid, 'status': 'create_failed', 'error': err})
                errors += 1; consecutive_failures += 1
            else:
                opp_id = res.get('CreatedOpportunityId')
                if opp_id:
                    results.append({
                        'lead_id': lid, 'status': 'created', 'opp_id': opp_id,
                        'owner_id': lead.get('OwnerId'),
                        'owner_name': lead.get('OwnerIdName'),
                    })
                    created += 1
                    consecutive_failures = 0
                else:
                    results.append({'lead_id': lid, 'status': 'no_opp_id_returned',
                                    'response': res})
                    errors += 1; consecutive_failures += 1

    if consecutive_failures >= 5:
        print(f"[{TS()}] STOP — 5 consecutive failures. Aborting at lead {i}.")
        break

    if i % 50 == 0 or i == len(new_lead_ids):
        elapsed = time.time() - start
        eta = elapsed / i * (len(new_lead_ids) - i)
        print(f"  [{TS()}] {i}/{len(new_lead_ids)}  created={created}  skipped={skipped_existing}  errors={errors}  eta={int(eta)}s")

    if i % checkpoint_every == 0:
        with open('snapshots/opp_creation_results_2026-04-30.json', 'w') as f:
            json.dump({
                'timestamp': time.strftime('%Y-%m-%d %H:%M:%S %Z'),
                'in_progress': True,
                'processed': i, 'total': len(new_lead_ids),
                'created': created, 'skipped': skipped_existing, 'errors': errors,
                'results': results,
            }, f, indent=2, default=str)

    time.sleep(0.3)

print(f"\n[{TS()}] === BULK RUN COMPLETE ===")
print(f"Total processed:  {len(results)} / {len(new_lead_ids)}")
print(f"Created:          {created}")
print(f"Skipped (had opp): {skipped_existing}")
print(f"Errors:           {errors}")

# By owner breakdown of created
owner_counts = Counter(r['owner_name'] for r in results if r['status'] == 'created')
print("\nBy owner:")
for o, c in owner_counts.most_common():
    print(f"  {c:5d}  {o}")

# Save final results
with open('snapshots/opp_creation_results_2026-04-30.json', 'w') as f:
    json.dump({
        'timestamp': time.strftime('%Y-%m-%d %H:%M:%S %Z'),
        'in_progress': False,
        'processed': len(results), 'total': len(new_lead_ids),
        'created': created, 'skipped': skipped_existing, 'errors': errors,
        'by_owner': dict(owner_counts),
        'results': results,
    }, f, indent=2, default=str)
print(f"\nAudit log: snapshots/opp_creation_results_2026-04-30.json")
