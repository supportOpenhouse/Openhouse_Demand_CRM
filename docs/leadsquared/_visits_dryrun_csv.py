"""
Full dry-run using the user-supplied CSV.
Same matching logic as _visits_dryrun.py but reads from CSV instead of markdown.
"""
import urllib.parse, urllib.request, json, sys, time, re, csv
from collections import defaultdict, Counter

sys.stdout.reconfigure(line_buffering=True)
TS = lambda: time.strftime('%H:%M:%S')

env = dict(l.strip().split('=', 1) for l in open('.env') if '=' in l)
HOST = env['LSQ_API_HOST']
AUTH = {'accessKey': env['LSQ_ACCESS_KEY'], 'secretKey': env['LSQ_SECRET_KEY']}

CSV_PATH = '/Users/akshit.chaudhary/Downloads/Visitors form responses - Responses (2).csv'

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

# === LOAD CSV ===
print(f"[{TS()}] Reading {CSV_PATH}...")
visit_rows = []
with open(CSV_PATH, 'r', newline='') as f:
    reader = csv.DictReader(f)
    for row in reader:
        if row.get('Buyer Name') and row.get('Visit Date') and row.get('Society'):
            visit_rows.append(row)
print(f"  Total visit rows: {len(visit_rows)}")

# Earliest / latest visit dates to bound LSQ fetch
visit_dates = [r['Visit Date'] for r in visit_rows if r.get('Visit Date')]
print(f"  Visit-date range: {min(visit_dates)} → {max(visit_dates)}")

# === FETCH LSQ event-12001 visits in 60-day window ===
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
print(f"  Total LSQ visits in window: {len(visits)}")

def fld(a, key):
    if a.get(key) is not None: return a.get(key)
    for f in (a.get('Fields') or []):
        if f.get('Key') == key: return f.get('Value')
    return None

def norm(s):
    return re.sub(r'[^a-z0-9]+', ' ', (s or '').lower()).strip()

# Index visits by normalized buyer name prefix
idx = defaultdict(list)
for v in visits:
    buyer = fld(v, 'mx_Custom_4') or ''
    nb = norm(buyer)
    if not nb: continue
    idx[nb[:30]].append({
        'visit': v,
        'buyer': buyer,
        'unit_address': fld(v, 'mx_Custom_42') or '',
        'visit_date': fld(v, 'mx_Custom_28') or fld(v, 'mx_Custom_39') or '',
        'created_on': v.get('CreatedOn'),
    })

# === MATCH SHEET → LSQ ===
print(f"\n[{TS()}] Matching {len(visit_rows)} sheet rows...")
matched = []
unmatched = []
ambiguous = []

for r in visit_rows:
    sheet_buyer = norm(r.get('Buyer Name'))[:30]
    sheet_society = norm(r.get('Society'))
    sheet_unit = norm(r.get('Unit'))
    sheet_visit_date = (r.get('Visit Date') or '').strip()
    candidates = idx.get(sheet_buyer, [])
    society_tokens = {t for t in sheet_society.split() if len(t) > 2}
    refined = []
    for c in candidates:
        ua = norm(c['unit_address'])
        if society_tokens and any(tok in ua for tok in society_tokens):
            refined.append(c)
    pick = None
    if len(refined) == 1:
        pick = refined[0]
    elif len(refined) > 1:
        same_date = [c for c in refined if sheet_visit_date and sheet_visit_date in str(c['visit_date'])]
        if len(same_date) == 1:
            pick = same_date[0]
        elif len(same_date) > 1:
            # Last-resort: match by unit number's last 4 chars
            u_last = sheet_unit.replace(' ', '')[-4:]
            tighter = [c for c in same_date if u_last and u_last in norm(c['unit_address']).replace(' ', '')]
            pick = tighter[0] if len(tighter) == 1 else None
            if not pick:
                # If still ambiguous, just take the most recently created (best-effort)
                pick = sorted(same_date, key=lambda c: str(c['created_on']), reverse=True)[0]
        else:
            # No same-date match — take the one closest in time to the sheet visit date
            pick = sorted(refined, key=lambda c: str(c['visit_date']) or '', reverse=True)[0]
    if pick:
        matched.append({'sheet': r, 'visit': pick['visit']})
    elif candidates:
        unmatched.append({'sheet': r, 'reason': 'buyer found but society/unit not aligned',
                          'cands_with_buyer_only': len(candidates)})
    else:
        unmatched.append({'sheet': r, 'reason': 'buyer not found in window'})

print(f"\n  Matched:   {len(matched)}")
print(f"  Unmatched: {len(unmatched)}")
print(f"  Ambiguous (auto-resolved by best-effort): {len(ambiguous)}")
print(f"  Match rate: {len(matched)*100//max(1,len(visit_rows))}%")

# === FETCH BUYER LEAD STATUS ===
print(f"\n[{TS()}] Fetching current lead status for {len(matched)} matched buyers...")
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
        'sheet_sm_notes': sheet_notes[:200],
        'cur_visit_note': cur_visit_note[:200],
        'note_changes': note_change,
        'sheet_concern': (sheet.get('Primary Concern') or '').strip(),
        'sheet_next_step': (sheet.get('Next Step') or '').strip(),
        'lead_id': pid,
        'visit_id': visit.get('Id'),
    })
    if i % 50 == 0:
        print(f"  {i}/{len(matched)}")
    time.sleep(0.27)

# === SUMMARY ===
print(f"\n[{TS()}] === DRY-RUN SUMMARY (full sheet) ===")
print(f"Sheet rows total:      {len(visit_rows)}")
print(f"  Matched to LSQ:      {len(matched)}")
print(f"  Unmatched:           {len(unmatched)}")
print(f"  Match rate:          {len(matched)*100//max(1,len(visit_rows))}%")

intent_changes = sum(1 for d in dryrun if d['intent_changes'])
note_changes = sum(1 for d in dryrun if d['note_changes'])
print(f"\nOf {len(dryrun)} matched rows:")
print(f"  mx_Lead_Status would change:  {intent_changes}")
print(f"  mx_Custom_36 would change:    {note_changes}")
print(f"  Both unchanged (no-op):       {sum(1 for d in dryrun if not d['intent_changes'] and not d['note_changes'])}")

print(f"\nCurrent mx_Lead_Status distribution (matched leads):")
cur_dist = Counter(d['cur_lead_status'] or '(blank)' for d in dryrun)
for v, c in cur_dist.most_common():
    print(f"  {v:25s}  {c}")
print(f"\nSheet's Buyer Intent distribution (matched):")
sheet_dist = Counter(d['sheet_intent'] or '(blank)' for d in dryrun)
for v, c in sheet_dist.most_common():
    print(f"  {v:25s}  {c}")

# Cross-tab: current → proposed
print(f"\nCross-tab: current LSQ status → proposed sheet intent")
crosstab = Counter()
for d in dryrun:
    cur = (d['cur_lead_status'] or '(blank)').lower()
    prop = (d['sheet_intent'] or '(blank)').lower()
    crosstab[(cur, prop)] += 1
print(f"  {'current':12s} → {'proposed':10s}  count")
for (cur, prop), cnt in sorted(crosstab.items(), key=lambda x: -x[1]):
    marker = ' (no change)' if cur == prop else ''
    print(f"  {cur[:12]:12s} → {prop[:10]:10s}  {cnt}{marker}")

# Save full CSV
with open('snapshots/visits_dryrun_full_csv.csv', 'w', newline='') as f:
    w = csv.writer(f)
    w.writerow(['Buyer', 'Society', 'Unit', 'Visit Date', 'SM',
                'Sheet Intent', 'LSQ Current Status', 'Intent will change?',
                'Sheet SM Notes', 'LSQ Current Note (mx_Custom_36)', 'Note will change?',
                'Sheet Primary Concern', 'Sheet Next Step',
                'Lead ID', 'Visit ID'])
    for d in dryrun:
        w.writerow([d['buyer'], d['society'], d['unit'], d['visit_date'], d['sm'],
                    d['sheet_intent'], d['cur_lead_status'], 'YES' if d['intent_changes'] else 'no',
                    d['sheet_sm_notes'], d['cur_visit_note'], 'YES' if d['note_changes'] else 'no',
                    d['sheet_concern'], d['sheet_next_step'],
                    d['lead_id'], d['visit_id']])
print(f"\nFull CSV: snapshots/visits_dryrun_full_csv.csv ({len(dryrun)} rows)")

# Sample of unmatched
print(f"\n=== Sample unmatched (first 15) ===")
for u in unmatched[:15]:
    s = u['sheet']
    print(f"  {(s.get('Buyer Name') or '')[:20]:20s} | {(s.get('Society') or '')[:25]:25s} | unit={(s.get('Unit') or '')[:12]:12s} | date={s.get('Visit Date')} | reason={u['reason']}")

with open('/tmp/visits_dryrun_full_csv.json', 'w') as f:
    json.dump({
        'sheet_total': len(visit_rows),
        'matched': len(matched),
        'unmatched': len(unmatched),
        'intent_changes': intent_changes,
        'note_changes': note_changes,
        'unmatched_list': [u['sheet'].get('Buyer Name') + ' | ' + u['sheet'].get('Society','') for u in unmatched[:50]],
        'crosstab': {f"{k[0]}->{k[1]}": v for k, v in crosstab.items()},
    }, f, indent=2)
