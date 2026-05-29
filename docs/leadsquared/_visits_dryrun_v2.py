"""
Refined dry-run v2:
  - Pipeline status (mx_Lead_Status): only update if blank OR lead hasn't been
    modified since creation (using ModifiedOn vs CreatedOn proxy).
  - Visit-level note (mx_Custom_36): build a comprehensive form-detail note
    from ALL sheet fields and overwrite.
  - Output CSV with current/proposed values for both, plus the per-row decision.
"""
import urllib.parse, urllib.request, json, sys, time, re, csv
from collections import defaultdict, Counter
from datetime import datetime

sys.stdout.reconfigure(line_buffering=True)
TS = lambda: time.strftime('%H:%M:%S')

env = dict(l.strip().split('=', 1) for l in open('.env') if '=' in l)
HOST = env['LSQ_API_HOST']
AUTH = {'accessKey': env['LSQ_ACCESS_KEY'], 'secretKey': env['LSQ_SECRET_KEY']}

CSV_PATH = '/Users/akshit.chaudhary/Downloads/Visitors form responses - Responses (2).csv'
MOD_TOLERANCE_SEC = 60  # ModifiedOn within this many seconds of CreatedOn = "not modified since creation"


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


def parse_lsq_date(s):
    """Parse LSQ datetime in either '2026-04-30 10:12:46.000' or '4/30/2026 10:12:46 AM' format."""
    if not s: return None
    s = str(s).strip().split('.')[0]
    for fmt in ('%Y-%m-%d %H:%M:%S', '%m/%d/%Y %I:%M:%S %p', '%m/%d/%Y %H:%M:%S'):
        try:
            return datetime.strptime(s, fmt)
        except ValueError:
            continue
    return None


def build_form_note(row):
    """Build a comprehensive note from ALL sheet fields, including a clear header."""
    parts = []
    sm = (row.get('SM Name') or '').strip()
    visit_date = (row.get('Visit Date') or '').strip()
    visit_time = (row.get('Visit Time') or '').strip()
    parts.append(f"=== Visit Intent Form ({visit_date}{(' '+visit_time) if visit_time else ''}, SM: {sm}) ===")

    fields_in_order = [
        ('Visitor ID', 'Visitor ID'),
        ('Buyer Name', 'Buyer'),
        ('Buyer Contact', 'Contact'),
        ('Society', 'Society'),
        ('Unit', 'Unit'),
        ('Broker Name', 'CP'),
        ('CP Code', 'CP Code'),
        ('Company', 'Company'),
        ('City', 'City'),
        ('Outcome', 'Outcome'),
        ('Time Spent', 'Time Spent'),
        ('Society Tour', 'Society Tour'),
        ('Price Negotiation', 'Price Negotiation'),
        ('Loan Discussion', 'Loan Discussion'),
        ('Closing Signal', 'Closing Signal'),
        ('OH Mentioned', 'OH Mentioned'),
        ('Other Property Recommended', 'Other Property Recommended'),
        ('Buyer Intent', 'Buyer Intent'),
        ('Primary Concern', 'Primary Concern'),
        ('Next Step', 'Next Step'),
        ('SM Notes', 'SM Notes'),
    ]
    for sheet_col, label in fields_in_order:
        val = (row.get(sheet_col) or '').strip()
        if val:
            parts.append(f"{label}: {val}")
    return '\n'.join(parts)


# === LOAD CSV ===
print(f"[{TS()}] Reading CSV...")
visit_rows = []
with open(CSV_PATH, 'r', newline='') as f:
    reader = csv.DictReader(f)
    for row in reader:
        if row.get('Buyer Name') and row.get('Visit Date') and row.get('Society'):
            visit_rows.append(row)
print(f"  Total visit rows: {len(visit_rows)}")

# === FETCH LSQ visits ===
print(f"\n[{TS()}] Fetching LSQ event-12001 visits, last 60 days...")
visits = []
now_t = time.time()
cursor = now_t - 60 * 86400
while cursor < now_t:
    chunk_end = min(cursor + 14 * 86400, now_t)
    f_str = time.strftime('%Y-%m-%d %H:%M:%S', time.localtime(cursor))
    t_str = time.strftime('%Y-%m-%d %H:%M:%S', time.localtime(chunk_end))
    page = 1
    while page <= 30:
        body = {"Parameter": {"FromDate": f_str, "ToDate": t_str,
                               "ActivityEvent": 12001, "IncludeCustomFields": 1},
                "Paging": {"PageIndex": page, "PageSize": 1000},
                "Sorting": {"ColumnName": "ModifiedOn", "Direction": "1"}}
        r, err = call("/v2/ProspectActivity.svc/RetrieveRecentlyModified", body=body)
        if err: break
        acts = r.get('ProspectActivities') or []
        if not acts: break
        visits.extend(acts)
        if len(acts) < 1000: break
        page += 1
        time.sleep(0.27)
    cursor = chunk_end + 1
print(f"  Total LSQ visits: {len(visits)}")


def fld(a, key):
    if a.get(key) is not None: return a.get(key)
    for f in (a.get('Fields') or []):
        if f.get('Key') == key: return f.get('Value')
    return None


def norm(s):
    return re.sub(r'[^a-z0-9]+', ' ', (s or '').lower()).strip()


idx = defaultdict(list)
for v in visits:
    buyer = fld(v, 'mx_Custom_4') or ''
    nb = norm(buyer)
    if not nb: continue
    idx[nb[:30]].append({
        'visit': v,
        'unit_address': fld(v, 'mx_Custom_42') or '',
        'visit_date': fld(v, 'mx_Custom_28') or fld(v, 'mx_Custom_39') or '',
        'created_on': v.get('CreatedOn'),
    })


# === MATCH ===
print(f"\n[{TS()}] Matching {len(visit_rows)} sheet rows...")
matched = []
unmatched = []
for r in visit_rows:
    sheet_buyer = norm(r.get('Buyer Name'))[:30]
    sheet_society = norm(r.get('Society'))
    sheet_unit = norm(r.get('Unit'))
    sheet_visit_date = (r.get('Visit Date') or '').strip()
    candidates = idx.get(sheet_buyer, [])
    society_tokens = {t for t in sheet_society.split() if len(t) > 2}
    refined = [c for c in candidates if society_tokens and any(tok in norm(c['unit_address']) for tok in society_tokens)]
    pick = None
    if len(refined) == 1:
        pick = refined[0]
    elif len(refined) > 1:
        same_date = [c for c in refined if sheet_visit_date and sheet_visit_date in str(c['visit_date'])]
        if len(same_date) == 1:
            pick = same_date[0]
        elif len(same_date) > 1:
            u_last = sheet_unit.replace(' ', '')[-4:]
            tighter = [c for c in same_date if u_last and u_last in norm(c['unit_address']).replace(' ', '')]
            pick = tighter[0] if len(tighter) == 1 else sorted(same_date, key=lambda c: str(c['created_on']), reverse=True)[0]
        else:
            pick = sorted(refined, key=lambda c: str(c['visit_date']) or '', reverse=True)[0]
    if pick:
        matched.append({'sheet': r, 'visit': pick['visit']})
    else:
        unmatched.append(r)

print(f"  Matched: {len(matched)}, Unmatched: {len(unmatched)}")


# === FETCH LEAD + CHECK GATES ===
print(f"\n[{TS()}] Per-matched-row: fetch lead, evaluate gate, build note diff...")

def fetch_lead(lid):
    qs = urllib.parse.urlencode({**AUTH, 'id': lid})
    try:
        with urllib.request.urlopen(f"{HOST}/v2/LeadManagement.svc/Leads.GetById?{qs}", timeout=30) as r:
            d = json.loads(r.read())
        leads = d if isinstance(d, list) else d.get('Leads', [])
        return leads[0] if leads else None
    except Exception:
        return None


dryrun = []
gate_stats = Counter()
for i, m in enumerate(matched, 1):
    sheet = m['sheet']
    visit = m['visit']
    pid = visit.get('RelatedProspectId')
    lead = fetch_lead(pid) if pid else None

    cur_lead_status = (lead.get('mx_Lead_Status') if lead else '') or ''
    sheet_intent = (sheet.get('Buyer Intent') or '').strip()

    created_on = parse_lsq_date(lead.get('CreatedOn') if lead else '')
    modified_on = parse_lsq_date(lead.get('ModifiedOn') if lead else '')

    # GATE for pipeline status update
    if not sheet_intent:
        gate = 'SKIP_no_sheet_intent'
        propose_status = ''
    elif sheet_intent.lower() == cur_lead_status.lower():
        gate = 'SKIP_already_matches'
        propose_status = sheet_intent
    elif not cur_lead_status.strip():
        gate = 'UPDATE_status_blank'
        propose_status = sheet_intent
    elif created_on and modified_on:
        delta = (modified_on - created_on).total_seconds()
        if delta <= MOD_TOLERANCE_SEC:
            gate = 'UPDATE_unmodified_since_creation'
            propose_status = sheet_intent
        else:
            gate = 'SKIP_lead_modified_after_creation'
            propose_status = cur_lead_status  # unchanged
    else:
        gate = 'SKIP_no_dates_safety'
        propose_status = cur_lead_status

    gate_stats[gate] += 1

    cur_visit_note = fld(visit, 'mx_Custom_36') or ''
    proposed_note = build_form_note(sheet)
    note_changes = (proposed_note != cur_visit_note)

    dryrun.append({
        'buyer': sheet.get('Buyer Name'),
        'society': sheet.get('Society'),
        'unit': sheet.get('Unit'),
        'visit_date': sheet.get('Visit Date'),
        'sm': sheet.get('SM Name'),

        'sheet_intent': sheet_intent,
        'cur_lead_status': cur_lead_status,
        'lead_created_on': lead.get('CreatedOn') if lead else '',
        'lead_modified_on': lead.get('ModifiedOn') if lead else '',
        'lead_modified_delta_sec': int((modified_on - created_on).total_seconds()) if (created_on and modified_on) else '',
        'gate_decision': gate,
        'proposed_status': propose_status,

        'cur_visit_note': cur_visit_note,
        'proposed_visit_note': proposed_note,
        'note_changes': note_changes,

        'lead_id': pid,
        'visit_id': visit.get('Id'),
    })

    if i % 50 == 0:
        print(f"  {i}/{len(matched)}")
    time.sleep(0.27)


# === SUMMARY ===
print(f"\n[{TS()}] === DRY-RUN v2 SUMMARY ===")
print(f"Sheet rows: {len(visit_rows)}, matched: {len(matched)}, unmatched: {len(unmatched)}")

print(f"\n=== Gate decisions for pipeline-status update ===")
print(f"  {'gate':40s}  count")
for g, c in gate_stats.most_common():
    label = {
        'UPDATE_status_blank': 'UPDATE — current status is blank',
        'UPDATE_unmodified_since_creation': 'UPDATE — lead unmodified since creation',
        'SKIP_already_matches': 'SKIP — sheet already matches current',
        'SKIP_lead_modified_after_creation': 'SKIP — lead has been modified post-creation',
        'SKIP_no_sheet_intent': 'SKIP — sheet has blank Buyer Intent',
        'SKIP_no_dates_safety': 'SKIP — could not parse lead dates',
    }.get(g, g)
    print(f"  {label:40s}  {c}")

updates = sum(c for g, c in gate_stats.items() if g.startswith('UPDATE_'))
skips = sum(c for g, c in gate_stats.items() if g.startswith('SKIP_'))
print(f"\n  Status updates that WILL run:  {updates}")
print(f"  Status updates that will SKIP: {skips}")

note_count = sum(1 for d in dryrun if d['note_changes'])
print(f"\n  Visit notes (mx_Custom_36) that will change:  {note_count} of {len(dryrun)}")

# === SAVE CSV ===
out_path = 'snapshots/visits_dryrun_v2.csv'
with open(out_path, 'w', newline='') as f:
    w = csv.writer(f)
    w.writerow([
        'Buyer', 'Society', 'Unit', 'Visit Date', 'SM',
        # Status side
        'Sheet Intent', 'LSQ Current mx_Lead_Status',
        'Lead CreatedOn', 'Lead ModifiedOn', 'Lead Modified Delta (s)',
        'Status Gate Decision', 'Status WILL Update?', 'Proposed Status',
        # Note side
        'Note WILL Update?', 'LSQ Current Note', 'Proposed Full Form Note',
        # Reference IDs
        'Lead ID', 'Visit ID',
    ])
    for d in dryrun:
        will_update_status = 'YES' if d['gate_decision'].startswith('UPDATE_') else 'no'
        will_update_note = 'YES' if d['note_changes'] else 'no'
        w.writerow([
            d['buyer'], d['society'], d['unit'], d['visit_date'], d['sm'],
            d['sheet_intent'], d['cur_lead_status'],
            d['lead_created_on'], d['lead_modified_on'], d['lead_modified_delta_sec'],
            d['gate_decision'], will_update_status, d['proposed_status'],
            will_update_note, d['cur_visit_note'], d['proposed_visit_note'],
            d['lead_id'], d['visit_id'],
        ])
print(f"\nCSV saved: {out_path}")

with open('/tmp/visits_dryrun_v2.json', 'w') as f:
    json.dump({
        'sheet_total': len(visit_rows),
        'matched': len(matched),
        'unmatched': len(unmatched),
        'gate_stats': dict(gate_stats),
        'updates': updates,
        'skips': skips,
        'note_changes': note_count,
    }, f, indent=2)


# Quick sample of full proposed note
print(f"\n=== SAMPLE proposed full-form note (first one) ===")
if dryrun:
    print(dryrun[0]['proposed_visit_note'])
