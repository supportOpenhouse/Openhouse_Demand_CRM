"""
Dry-run for sheet → LSQ visit update.
- Re-read the Visitors form responses sheet
- Pre-fetch all LSQ event-12001 visits in the relevant window into memory
- Match each sheet row by (buyer name + society + unit) with date proximity tiebreak
- For matched rows, look up:
    - the buyer lead's current mx_Lead_Status (where Hot/Warm/Cold lives)
    - the visit's current mx_Custom_36 (Sales Feedback / Note)
- Output side-by-side: sheet value → current LSQ → proposed update
- No writes.
"""
import urllib.parse, urllib.request, json, sys, time, re, csv
from collections import defaultdict, Counter

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
            return None, f"HTTP {e.code}"
        except Exception as e:
            return None, f"{type(e).__name__}"
    return None, "exhausted"


# === LOAD SHEET ROWS ===
# We saved the natural-language Drive read earlier; pass it via stdin or file.
# For this dry-run we'll re-parse from a saved snapshot the user already loaded.
SHEET_PATH = '/tmp/visits_sheet_content.txt'
print(f"[{TS()}] Loading sheet content from {SHEET_PATH}...")
content = open(SHEET_PATH).read()

# Parse markdown tables: split into row arrays. Header = first row of pipe-separated names.
def parse_md_tables(text):
    rows = []
    lines = text.split('\n')
    headers = None
    for ln in lines:
        if not ln.strip().startswith('|'):
            continue
        cells = [c.strip() for c in ln.strip().strip('|').split('|')]
        # Skip alignment rows (:-: :-: ...)
        if all(re.match(r'^:?-+:?$', c) for c in cells if c):
            continue
        # Detect header
        if headers is None or cells[0].lower() == 'timestamp':
            if cells[0].lower() in ('timestamp', 'sm name', 'cp owner'):
                headers = cells
                continue
        if headers and len(cells) == len(headers):
            rows.append(dict(zip(headers, cells)))
    return rows

raw_rows = parse_md_tables(content)
# Filter to actual visit rows (have a Buyer Name and a Visit Date)
visit_rows = [r for r in raw_rows if r.get('Buyer Name') and r.get('Visit Date') and r.get('Society')]
print(f"  Total parsed rows: {len(raw_rows)}, visit rows: {len(visit_rows)}")

# === FETCH ALL LSQ VISITS IN WINDOW ===
print(f"\n[{TS()}] Fetching LSQ event-12001 visits, last 60 days...")
visits = []
now_t = time.time()
cursor = now_t - 60 * 86400
chunk = 14 * 86400
while cursor < now_t:
    chunk_end = min(cursor + chunk, now_t)
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
    print(f"  [{TS()}] {f_str[:10]} → {t_str[:10]}: total visits so far={len(visits)}")
print(f"\n[{TS()}] Total LSQ visits in window: {len(visits)}")

def fld(a, key):
    if a.get(key) is not None: return a.get(key)
    for f in (a.get('Fields') or []):
        if f.get('Key') == key: return f.get('Value')
    return None

# === BUILD MATCH INDEX ===
# Index visits by normalized (buyer_name, society_token).
# We'll use society as the strongest match key, then disambiguate with buyer name and date.
def norm(s):
    return re.sub(r'[^a-z0-9]+', ' ', (s or '').lower()).strip()

idx = defaultdict(list)
for v in visits:
    buyer = fld(v, 'mx_Custom_4') or ''
    unit = fld(v, 'mx_Custom_42') or ''
    nb = norm(buyer)
    if not nb: continue
    idx[nb[:30]].append({
        'visit': v,
        'buyer': buyer,
        'unit_address': unit,
        'visit_date': fld(v, 'mx_Custom_28') or fld(v, 'mx_Custom_39') or '',
        'created_on': v.get('CreatedOn'),
    })

# === MATCH SHEET ROWS ===
print(f"\n[{TS()}] Matching {len(visit_rows)} sheet rows to LSQ visits...")
matched = []
unmatched = []
ambiguous = []

for r in visit_rows:
    sheet_buyer = norm(r.get('Buyer Name'))[:30]
    sheet_society = norm(r.get('Society'))
    sheet_unit = norm(r.get('Unit'))
    sheet_visit_date = r.get('Visit Date', '').strip()
    candidates = idx.get(sheet_buyer, [])
    # filter candidates by society token presence in unit_address
    society_tokens = set(sheet_society.split())
    society_tokens.discard('')
    refined = []
    for c in candidates:
        ua = norm(c['unit_address'])
        # require any society token to appear in ua
        if society_tokens and any(tok in ua for tok in society_tokens if len(tok) > 2):
            refined.append(c)
    pick = None
    if len(refined) == 1:
        pick = refined[0]
    elif len(refined) > 1:
        # disambiguate by visit date
        same_date = [c for c in refined if sheet_visit_date and sheet_visit_date in str(c['visit_date'])]
        if len(same_date) == 1: pick = same_date[0]
        elif len(same_date) > 1:
            # pick the one whose unit number also matches (last 4 chars of sheet unit)
            u_last = sheet_unit.replace(' ', '')[-4:]
            tighter = [c for c in same_date if u_last and u_last in norm(c['unit_address']).replace(' ', '')]
            pick = tighter[0] if len(tighter) == 1 else None
            if not pick:
                ambiguous.append({'sheet': r, 'candidates': len(refined)})
                continue
        else:
            ambiguous.append({'sheet': r, 'candidates': len(refined)})
            continue
    if pick:
        matched.append({'sheet': r, 'visit': pick['visit']})
    elif candidates:
        # buyer matched but no society — likely wrong match; mark unmatched
        unmatched.append({'sheet': r, 'reason': 'buyer found but society/unit not aligned',
                          'candidates_with_buyer_only': len(candidates)})
    else:
        unmatched.append({'sheet': r, 'reason': 'buyer not found in window'})

print(f"\n  Matched:   {len(matched)}")
print(f"  Unmatched: {len(unmatched)}")
print(f"  Ambiguous: {len(ambiguous)}")
print(f"  Match rate: {len(matched)*100//max(1,len(visit_rows))}%")

# === FOR MATCHED, FETCH BUYER LEAD'S CURRENT mx_Lead_Status ===
print(f"\n[{TS()}] Fetching current lead-status for {len(matched)} matched buyers...")

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
for i, m in enumerate(matched, 1):
    sheet = m['sheet']
    visit = m['visit']
    pid = visit.get('RelatedProspectId')
    lead = fetch_lead(pid) if pid else None
    cur_lead_status = (lead.get('mx_Lead_Status') if lead else '') or ''
    cur_visit_note  = fld(visit, 'mx_Custom_36') or ''
    sheet_intent = (sheet.get('Buyer Intent') or '').strip()
    sheet_notes  = (sheet.get('SM Notes') or '').strip()
    sheet_concern = (sheet.get('Primary Concern') or '').strip()
    sheet_next   = (sheet.get('Next Step') or '').strip()

    intent_change = (sheet_intent.lower() != cur_lead_status.lower())
    note_change   = bool(sheet_notes) and (sheet_notes != cur_visit_note)

    dryrun.append({
        'buyer': sheet.get('Buyer Name'),
        'society': sheet.get('Society'),
        'unit': sheet.get('Unit'),
        'visit_date': sheet.get('Visit Date'),
        'sm': sheet.get('SM Name'),
        'sheet_intent': sheet_intent,
        'cur_lead_status': cur_lead_status,
        'intent_changes': intent_change,
        'sheet_sm_notes': (sheet_notes[:120] + '…') if len(sheet_notes) > 120 else sheet_notes,
        'cur_visit_note': (cur_visit_note[:120] + '…') if len(cur_visit_note) > 120 else cur_visit_note,
        'note_changes': note_change,
        'sheet_concern': sheet_concern,
        'sheet_next_step': sheet_next,
        'lead_id': pid,
        'visit_id': visit.get('Id'),
    })
    if i % 30 == 0:
        print(f"  {i}/{len(matched)}")
    time.sleep(0.27)

# === SUMMARY ===
print(f"\n[{TS()}] === DRY-RUN SUMMARY ===")
print(f"Sheet rows total:      {len(visit_rows)}")
print(f"  Matched to LSQ:      {len(matched)}")
print(f"  Unmatched:           {len(unmatched)}")
print(f"  Ambiguous:           {len(ambiguous)}")

# Aggregate change counts
intent_changes = sum(1 for d in dryrun if d['intent_changes'])
note_changes = sum(1 for d in dryrun if d['note_changes'])
print(f"\nOf {len(dryrun)} matched rows:")
print(f"  mx_Lead_Status would change:  {intent_changes}")
print(f"  mx_Custom_36 would change:    {note_changes}")
print(f"  Both unchanged (no-op):       {sum(1 for d in dryrun if not d['intent_changes'] and not d['note_changes'])}")

# Distribution of current vs proposed for Buyer Intent
print(f"\nCurrent mx_Lead_Status distribution (matched leads):")
cur_dist = Counter(d['cur_lead_status'] or '(blank)' for d in dryrun)
for v, c in cur_dist.most_common():
    print(f"  {v:25s}  {c}")
print(f"\nSheet's Buyer Intent distribution (matched):")
sheet_dist = Counter(d['sheet_intent'] or '(blank)' for d in dryrun)
for v, c in sheet_dist.most_common():
    print(f"  {v:25s}  {c}")

# Save full dry-run CSV
with open('snapshots/visits_dryrun.csv', 'w', newline='') as f:
    w = csv.writer(f)
    w.writerow(['Buyer', 'Society', 'Unit', 'Visit Date', 'SM',
                'Sheet Intent (proposed)', 'LSQ mx_Lead_Status (current)', 'Intent will change?',
                'Sheet SM Notes (proposed)', 'LSQ mx_Custom_36 (current)', 'Note will change?',
                'Sheet Primary Concern', 'Sheet Next Step',
                'Lead ID', 'Visit ID'])
    for d in dryrun:
        w.writerow([d['buyer'], d['society'], d['unit'], d['visit_date'], d['sm'],
                    d['sheet_intent'], d['cur_lead_status'], 'YES' if d['intent_changes'] else 'no',
                    d['sheet_sm_notes'], d['cur_visit_note'], 'YES' if d['note_changes'] else 'no',
                    d['sheet_concern'], d['sheet_next_step'],
                    d['lead_id'], d['visit_id']])
print(f"\nFull dry-run CSV: snapshots/visits_dryrun.csv ({len(dryrun)} rows)")

# Sample of would-change rows
print(f"\n=== First 10 rows where Buyer Intent would change ===")
chg = [d for d in dryrun if d['intent_changes']][:10]
for d in chg:
    print(f"  {d['buyer'][:18]:18s} | {d['society'][:25]:25s} | sheet: {d['sheet_intent']:8s} | current: {d['cur_lead_status'] or '(blank)':12s} | sm: {d['sm'][:15]}")

# Sample unmatched rows
print(f"\n=== First 10 unmatched sheet rows ===")
for u in unmatched[:10]:
    s = u['sheet']
    print(f"  {(s.get('Buyer Name') or '')[:18]:18s} | {(s.get('Society') or '')[:25]:25s} | unit={(s.get('Unit') or '')[:12]:12s} | date={s.get('Visit Date')} | reason={u['reason']}")

# Save raw lists
with open('/tmp/visits_dryrun_full.json', 'w') as f:
    json.dump({
        'sheet_total': len(visit_rows),
        'matched': len(matched),
        'unmatched_count': len(unmatched),
        'ambiguous_count': len(ambiguous),
        'intent_changes': intent_changes,
        'note_changes': note_changes,
        'unmatched': unmatched,
        'ambiguous': ambiguous,
        'dryrun': dryrun,
    }, f, indent=2, default=str)
print(f"\nFull JSON: /tmp/visits_dryrun_full.json")
