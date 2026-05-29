"""
Apply v2 — note-format fall-through:
  1. Try non-compact (verbose) appended block; if <= 200 chars total, use it
  2. Else try compact format; if <= 200, use it
  3. Else skip this row's note update (existing preserved untouched)
Plus: 36 lead-status updates as before.

Endpoints:
  - Note (opportunity): POST /v2/OpportunityManagement.svc/Update with mx_Custom_36 in Fields[]
  - Status (lead):       POST /v2/LeadManagement.svc/Lead.Update with mx_Lead_Status
"""
import urllib.parse, urllib.request, json, sys, time, csv, re

sys.stdout.reconfigure(line_buffering=True)
TS = lambda: time.strftime('%H:%M:%S')

env = dict(l.strip().split('=', 1) for l in open('.env') if '=' in l)
HOST = env['LSQ_API_HOST']
AUTH = {'accessKey': env['LSQ_ACCESS_KEY'], 'secretKey': env['LSQ_SECRET_KEY']}

MAX_LEN = 200

# === FORMAT BUILDERS ===
def build_non_compact(existing, sm, visit_date, visit_time,
                      time_spent, society_tour, price_neg, loan_disc, closing_sig, buyer_intent):
    """Verbose readable form, multi-line, full field names + values."""
    body_lines = []
    if time_spent:    body_lines.append(f"Time Spent: {time_spent}")
    if society_tour:  body_lines.append(f"Society Tour: {society_tour}")
    if price_neg:     body_lines.append(f"Price Negotiation: {price_neg}")
    if loan_disc:     body_lines.append(f"Loan Discussion: {loan_disc}")
    if closing_sig:   body_lines.append(f"Closing Signal: {closing_sig}")
    if buyer_intent:  body_lines.append(f"Buyer Intent: {buyer_intent}")
    if not body_lines: return existing  # nothing to add
    header = f"[Form {visit_date}{(' '+visit_time) if visit_time else ''}, SM: {sm}]"
    block = header + '\n' + '\n'.join(body_lines)
    return (existing.rstrip() + '\n\n---\n' + block) if existing.strip() else block


VAL_ABBREV = {
    'Yes': 'Y', 'No': 'N',
    'No — did not ask': 'NoAsk',
    'Asked multiple questions': 'Multi-Q',
    'Casually asked 1 aspect': 'Casual',
    'Deep probing & compared': 'Deep',
    'Skipped': 'Skip',
    'Quick walk-through': 'Quick',
    'Full amenity tour': 'Full',
    'Detailed tour & society enquiry': 'Detail',
    'Non-committal': 'NonCom',
    'Wants revisit/comparison': 'Revisit',
    'Asked booking process': 'Book',
    'Asked for brochure/plan': 'Brc',
    '< 5 min': '<5m',
    '5–10 min': '5-10m',
    '10–15 min': '10-15m',
    '15–20 min': '15-20m',
    '20–30 min': '20-30m',
    '30–50 min': '30-50m',
}
def abbr(v): return VAL_ABBREV.get(v, v)

def build_compact(existing, sm, visit_date, visit_time,
                  time_spent, society_tour, price_neg, loan_disc, closing_sig, buyer_intent):
    """Compact one-line abbreviated form."""
    parts = []
    if time_spent:   parts.append(f"T:{abbr(time_spent)}")
    if society_tour: parts.append(f"Tour:{abbr(society_tour)}")
    if price_neg:    parts.append(f"Neg:{abbr(price_neg)}")
    if loan_disc:    parts.append(f"Loan:{abbr(loan_disc)}")
    if closing_sig:  parts.append(f"Sig:{abbr(closing_sig)}")
    if buyer_intent: parts.append(f"Intent:{buyer_intent}")
    if not parts: return existing
    header = f"[Form {visit_date}{(' '+visit_time) if visit_time else ''}, SM: {sm}]"
    block = header + ' ' + ' | '.join(parts)
    return (existing.rstrip() + ' | ' + block) if existing.strip() else block


# === LOAD INPUTS ===
print(f"[{TS()}] Loading data...")

# Re-read original CSV to get the per-field sheet values
sheet_csv = '/Users/akshit.chaudhary/Downloads/Visitors form responses - Responses (2).csv'
sheet_rows = list(csv.DictReader(open(sheet_csv)))
print(f"  Sheet rows: {len(sheet_rows)}")

# Load strict-HIGH dryrun for the matched lead/visit IDs and existing notes
strict = list(csv.DictReader(open('snapshots/visits_dryrun_strict_high.csv')))
print(f"  Strict-HIGH rows: {len(strict)}")

# Build a map from (buyer normalized, society normalized, visit date, unit) → strict-HIGH row
def norm(s): return re.sub(r'[^a-z0-9]+', ' ', (s or '').lower()).strip()
def key(r): return (
    norm(r.get('Sheet Buyer') or r.get('Buyer Name'))[:30],
    norm(r.get('Sheet Society') or r.get('Society'))[:40],
    norm(r.get('Sheet Unit') or r.get('Unit')),
    (r.get('Sheet Visit Date') or r.get('Visit Date') or '').strip(),
)
strict_index = {key(r): r for r in strict}

# === API HELPERS ===
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
            try: msg = e.read().decode()[:200]
            except: msg = ''
            return None, f"HTTP {e.code}: {msg}"
        except Exception as e:
            return None, f"{type(e).__name__}: {e}"
    return None, "exhausted"


def update_opp_note(visit_id, lead_id, value):
    body = {
        "ProspectOpportunityId": visit_id,
        "RelatedProspectId": lead_id,
        "OpportunityEvent": 12001,
        "Fields": [{"SchemaName": "mx_Custom_36", "Value": value}]
    }
    return call("/v2/OpportunityManagement.svc/Update", body=body)


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
        return None, f"HTTP {e.code}: {(e.read() or b'').decode()[:200]}"
    except Exception as e:
        return None, f"{type(e).__name__}: {e}"


# === MATCH SHEET ROWS TO STRICT-HIGH + DECIDE FORMAT ===
print(f"\n[{TS()}] Matching sheet rows to strict-HIGH targets, deciding formats...")
to_run_notes = []
to_run_status = []
fmt_counts = {'non_compact': 0, 'compact': 0, 'skip_too_long': 0, 'no_form_data': 0, 'no_strict_match': 0}

for r in sheet_rows:
    if not (r.get('Buyer Name') and r.get('Visit Date') and r.get('Society')):
        continue
    k = key(r)
    sh = strict_index.get(k)
    if not sh:
        continue  # not a strict-HIGH match

    visit_id = sh['Visit ID']
    lead_id = sh['Lead ID']
    existing = sh['LSQ Current Note (mx_Custom_36)'] or ''

    sm = (r.get('SM Name') or '').strip()
    visit_date = (r.get('Visit Date') or '').strip()
    visit_time = (r.get('Visit Time') or '').strip()
    fields = (
        (r.get('Time Spent') or '').strip(),
        (r.get('Society Tour') or '').strip(),
        (r.get('Price Negotiation') or '').strip(),
        (r.get('Loan Discussion') or '').strip(),
        (r.get('Closing Signal') or '').strip(),
        (r.get('Buyer Intent') or '').strip(),
    )
    if not any(fields):
        fmt_counts['no_form_data'] += 1
        continue

    # Try non-compact first
    nc = build_non_compact(existing, sm, visit_date, visit_time, *fields)
    if len(nc) <= MAX_LEN:
        chosen = nc
        fmt = 'non_compact'
    else:
        cm = build_compact(existing, sm, visit_date, visit_time, *fields)
        if len(cm) <= MAX_LEN:
            chosen = cm
            fmt = 'compact'
        else:
            fmt_counts['skip_too_long'] += 1
            continue
    fmt_counts[fmt] += 1

    # Skip if the proposed value is identical to existing (no actual change)
    if chosen == existing:
        continue

    to_run_notes.append({
        'visit_id': visit_id, 'lead_id': lead_id,
        'existing': existing, 'proposed': chosen, 'format': fmt,
        'buyer': r.get('Buyer Name'), 'society': r.get('Society'),
    })

# Status update list — from strict-HIGH where Status WILL Update? = YES
for sh in strict:
    if sh['Status WILL Update?'] == 'YES':
        to_run_status.append({
            'lead_id': sh['Lead ID'],
            'proposed_status': sh['Proposed Status'],
            'buyer': sh['Sheet Buyer'],
        })

print(f"\n  Format breakdown:")
for fmt, n in fmt_counts.items():
    print(f"    {fmt:20s}  {n}")
print(f"\n  Note updates to run:    {len(to_run_notes)}")
print(f"  Status updates to run:  {len(to_run_status)}")


# === RUN ===
print(f"\n[{TS()}] STEP 1: applying note updates ({len(to_run_notes)} rows)...")
note_ok = 0; note_fail = 0
note_results = []
for i, item in enumerate(to_run_notes, 1):
    res, err = update_opp_note(item['visit_id'], item['lead_id'], item['proposed'])
    if err:
        note_fail += 1
        note_results.append({**item, 'status': 'fail', 'error': err})
    else:
        note_ok += 1
        note_results.append({**item, 'status': 'ok'})
    if i % 25 == 0 or i == len(to_run_notes):
        print(f"  [{TS()}] {i}/{len(to_run_notes)}  ok={note_ok}  fail={note_fail}")
    time.sleep(0.27)

print(f"\n[{TS()}] STEP 2: applying lead-status updates ({len(to_run_status)} rows)...")
status_ok = 0; status_fail = 0
status_results = []
for i, item in enumerate(to_run_status, 1):
    res, err = update_lead_status(item['lead_id'], item['proposed_status'])
    if err:
        status_fail += 1
        status_results.append({**item, 'status': 'fail', 'error': err})
    else:
        status_ok += 1
        status_results.append({**item, 'status': 'ok'})
    if i % 10 == 0 or i == len(to_run_status):
        print(f"  [{TS()}] {i}/{len(to_run_status)}  ok={status_ok}  fail={status_fail}")
    time.sleep(0.27)


# === FINAL ===
print(f"\n[{TS()}] === COMPLETE ===")
print(f"Notes:   {note_ok} ok, {note_fail} fail (out of {len(to_run_notes)})")
print(f"Status:  {status_ok} ok, {status_fail} fail (out of {len(to_run_status)})")

# Save audit log
with open('snapshots/visits_apply_v2_results.json', 'w') as f:
    json.dump({
        'timestamp': time.strftime('%Y-%m-%d %H:%M:%S %Z'),
        'fmt_counts': fmt_counts,
        'note_total': len(to_run_notes), 'note_ok': note_ok, 'note_fail': note_fail,
        'status_total': len(to_run_status), 'status_ok': status_ok, 'status_fail': status_fail,
        'note_results': note_results,
        'status_results': status_results,
    }, f, indent=2)
print(f"Audit log: snapshots/visits_apply_v2_results.json")
