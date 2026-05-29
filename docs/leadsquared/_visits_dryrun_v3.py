"""
Dry-run v3:
  - Adds match-validation columns: LSQ-side buyer/society/unit/date next to sheet side
  - Computes per-row match-confidence (HIGH / MEDIUM / LOW)
  - Note: APPEND (don't overwrite) with only the 6 trimmed fields, blanks omitted
  - Pipeline status gate unchanged (update only if blank or unmodified-since-creation)
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
MOD_TOLERANCE_SEC = 60

# Only these six fields go into the appended block, in this order
NOTE_FIELDS = [
    ('Time Spent', 'Time Spent'),
    ('Society Tour', 'Society Tour'),
    ('Price Negotiation', 'Price Negotiation'),
    ('Loan Discussion', 'Loan Discussion'),
    ('Closing Signal', 'Closing Signal'),
    ('Buyer Intent', 'Buyer Intent'),
]


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
    if not s: return None
    s = str(s).strip().split('.')[0]
    for fmt in ('%Y-%m-%d %H:%M:%S', '%m/%d/%Y %I:%M:%S %p', '%m/%d/%Y %H:%M:%S'):
        try: return datetime.strptime(s, fmt)
        except ValueError: continue
    return None


def norm(s):
    return re.sub(r'[^a-z0-9]+', ' ', (s or '').lower()).strip()


def extract_unit_tokens(s):
    """Extract unit-number-like tokens from a unit string. e.g. '102, B' -> {'102','B'}"""
    s = (s or '').upper()
    tokens = set(re.findall(r'[A-Z0-9-]+', s))
    return {t for t in tokens if t}


def visit_date_only(s):
    """Extract YYYY-MM-DD from any LSQ datetime string."""
    if not s: return ''
    s = str(s)
    m = re.search(r'(\d{4}-\d{2}-\d{2})', s)
    if m: return m.group(1)
    m = re.search(r'(\d{1,2})/(\d{1,2})/(\d{4})', s)
    if m:
        return f"{m.group(3)}-{int(m.group(1)):02d}-{int(m.group(2)):02d}"
    return ''


def build_appended_block(row, existing_note):
    """Return the new full note: existing + appended trimmed block.
       If sheet has nothing in the 6 fields, return existing unchanged."""
    parts = []
    sm = (row.get('SM Name') or '').strip()
    visit_date = (row.get('Visit Date') or '').strip()
    visit_time = (row.get('Visit Time') or '').strip()

    body_lines = []
    for sheet_col, label in NOTE_FIELDS:
        val = (row.get(sheet_col) or '').strip()
        if val:
            body_lines.append(f"{label}: {val}")

    if not body_lines:
        return existing_note, False  # nothing to append

    header = f"[Form {visit_date}{(' '+visit_time) if visit_time else ''}, SM: {sm}]"
    new_block = header + '\n' + '\n'.join(body_lines)

    if existing_note.strip():
        full = existing_note.rstrip() + '\n\n---\n' + new_block
    else:
        full = new_block

    # Skip if existing note already contains this exact block (idempotency safety)
    if new_block in (existing_note or ''):
        return existing_note, False
    return full, True


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


# Index by buyer prefix
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


# === MATCH WITH CONFIDENCE SCORING ===
print(f"\n[{TS()}] Matching {len(visit_rows)} sheet rows with confidence scoring...")

def confidence(sheet_row, lsq):
    """Return (level, score, breakdown).
       Stricter society + unit matching to avoid false positives like
       'Godrej Icon' incorrectly matching 'Godrej Oasis' on shared token 'godrej'."""
    s_buyer = norm(sheet_row.get('Buyer Name'))
    # Drop common/short tokens — these alone shouldn't make a match
    BORING = {'the','of','and','sector','phase','road','sec','plot'}
    s_society_tokens = {t for t in norm(sheet_row.get('Society')).split()
                        if len(t) > 2 and t not in BORING}
    s_unit_tokens = extract_unit_tokens(sheet_row.get('Unit'))
    s_visit_date = visit_date_only(sheet_row.get('Visit Date'))

    l_buyer = norm(lsq['buyer'])
    l_unit_addr = norm(lsq['unit_address'])
    l_unit_num_tokens = extract_unit_tokens(lsq['unit_address'])
    l_visit_date = visit_date_only(lsq['visit_date']) or visit_date_only(lsq['created_on'])

    breakdown = {}

    # Buyer
    s_words = set(s_buyer.split())
    l_words = set(l_buyer.split())
    name_overlap = len(s_words & l_words) / max(1, len(s_words))
    breakdown['buyer_match'] = 'EXACT' if s_buyer == l_buyer else ('PARTIAL' if name_overlap >= 0.5 else 'WEAK')

    # Society — strict: ALL non-trivial sheet society tokens must appear in LSQ unit_address
    if s_society_tokens:
        all_present = all(tok in l_unit_addr for tok in s_society_tokens)
        any_present = any(tok in l_unit_addr for tok in s_society_tokens)
        if all_present:
            breakdown['society_match'] = 'FULL'
        elif any_present:
            breakdown['society_match'] = 'PARTIAL'
        else:
            breakdown['society_match'] = 'NO'
    else:
        breakdown['society_match'] = 'NO'

    # Unit — at least one numeric/letter unit token must overlap
    unit_overlap = s_unit_tokens & l_unit_num_tokens
    breakdown['unit_match'] = 'YES' if len(unit_overlap) >= 1 else 'NO'

    # Date
    breakdown['date_match'] = 'YES' if (s_visit_date and s_visit_date == l_visit_date) else 'NO'

    # Score with new society levels
    score = 0
    score += 2 if breakdown['buyer_match'] == 'EXACT' else (1 if breakdown['buyer_match'] == 'PARTIAL' else 0)
    if breakdown['society_match'] == 'FULL':
        score += 2  # full society match is strong
    elif breakdown['society_match'] == 'PARTIAL':
        score += 0  # partial-only is unreliable, no points
    score += 1 if breakdown['unit_match'] == 'YES' else 0
    score += 1 if breakdown['date_match'] == 'YES' else 0

    # Confidence levels (max possible = 6: buyer 2 + society 2 + unit 1 + date 1)
    if score >= 5:
        level = 'HIGH'
    elif score >= 4:
        level = 'MEDIUM'
    else:
        level = 'LOW'

    return level, score, breakdown


matched = []
unmatched = []
for r in visit_rows:
    sheet_buyer = norm(r.get('Buyer Name'))[:30]
    candidates = idx.get(sheet_buyer, [])
    sheet_society_tokens = {t for t in norm(r.get('Society')).split() if len(t) > 2}
    refined = [c for c in candidates if sheet_society_tokens and any(tok in norm(c['unit_address']) for tok in sheet_society_tokens)]
    if not refined:
        unmatched.append({'sheet': r, 'reason': 'no LSQ visit with same buyer + society'})
        continue
    # Score every candidate, pick highest
    scored = []
    for c in refined:
        lvl, score, br = confidence(r, c)
        scored.append((score, lvl, br, c))
    scored.sort(key=lambda x: x[0], reverse=True)
    score, lvl, br, pick = scored[0]
    matched.append({'sheet': r, 'visit': pick['visit'], 'lsq_meta': pick,
                    'confidence': lvl, 'score': score, 'breakdown': br})

print(f"  Matched: {len(matched)}")
print(f"  Unmatched: {len(unmatched)}")
conf_dist = Counter(m['confidence'] for m in matched)
print(f"  Confidence: HIGH={conf_dist['HIGH']}, MEDIUM={conf_dist['MEDIUM']}, LOW={conf_dist['LOW']}")


# === FETCH LEAD + DECIDE GATES ===
print(f"\n[{TS()}] Per-matched-row: fetch lead, evaluate gates, build proposed updates...")

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
note_change_count = 0

for i, m in enumerate(matched, 1):
    sheet = m['sheet']
    visit = m['visit']
    pid = visit.get('RelatedProspectId')
    lead = fetch_lead(pid) if pid else None

    cur_lead_status = (lead.get('mx_Lead_Status') if lead else '') or ''
    sheet_intent = (sheet.get('Buyer Intent') or '').strip()

    created_on = parse_lsq_date(lead.get('CreatedOn') if lead else '')
    modified_on = parse_lsq_date(lead.get('ModifiedOn') if lead else '')

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
            propose_status = cur_lead_status
    else:
        gate = 'SKIP_no_dates_safety'
        propose_status = cur_lead_status
    gate_stats[gate] += 1

    cur_visit_note = fld(visit, 'mx_Custom_36') or ''
    proposed_full_note, note_will_update = build_appended_block(sheet, cur_visit_note)
    if note_will_update:
        note_change_count += 1

    dryrun.append({
        # Sheet
        'sheet_buyer': sheet.get('Buyer Name'),
        'sheet_society': sheet.get('Society'),
        'sheet_unit': sheet.get('Unit'),
        'sheet_visit_date': sheet.get('Visit Date'),
        'sheet_sm': sheet.get('SM Name'),
        # LSQ side (for visual validation)
        'lsq_buyer': m['lsq_meta']['buyer'],
        'lsq_unit_address': m['lsq_meta']['unit_address'],
        'lsq_visit_date': m['lsq_meta']['visit_date'],
        # Confidence
        'match_confidence': m['confidence'],
        'match_score': m['score'],
        'buyer_match': m['breakdown']['buyer_match'],
        'society_match': m['breakdown']['society_match'],
        'unit_match': m['breakdown']['unit_match'],
        'date_match': m['breakdown']['date_match'],
        # Status
        'sheet_intent': sheet_intent,
        'cur_lead_status': cur_lead_status,
        'lead_created_on': lead.get('CreatedOn') if lead else '',
        'lead_modified_on': lead.get('ModifiedOn') if lead else '',
        'lead_modified_delta_sec': int((modified_on - created_on).total_seconds()) if (created_on and modified_on) else '',
        'gate_decision': gate,
        'proposed_status': propose_status,
        # Note
        'note_will_update': note_will_update,
        'cur_visit_note': cur_visit_note,
        'proposed_full_note': proposed_full_note,
        # IDs
        'lead_id': pid,
        'visit_id': visit.get('Id'),
    })

    if i % 50 == 0:
        print(f"  {i}/{len(matched)}")
    time.sleep(0.27)


# === SUMMARY ===
print(f"\n[{TS()}] === DRY-RUN v3 SUMMARY ===")
print(f"Sheet rows: {len(visit_rows)}, matched: {len(matched)}, unmatched: {len(unmatched)}")
print(f"\nMatch confidence:")
for lvl in ['HIGH', 'MEDIUM', 'LOW']:
    print(f"  {lvl}: {conf_dist[lvl]}")
print(f"\nPipeline-status gate decisions:")
for g, c in gate_stats.most_common():
    print(f"  {g:45s}  {c}")

# Cross-tab confidence × gate
print(f"\nConfidence × Gate cross-tab:")
ct = Counter()
for d in dryrun:
    ct[(d['match_confidence'], d['gate_decision'])] += 1
print(f"  {'confidence':10s}  {'gate':45s}  count")
for (c, g), n in sorted(ct.items()):
    print(f"  {c:10s}  {g:45s}  {n}")

updates_status = sum(c for g, c in gate_stats.items() if g.startswith('UPDATE_'))
print(f"\n  Status updates that WILL run:  {updates_status}")
print(f"  Status updates that will SKIP: {sum(c for g, c in gate_stats.items() if g.startswith('SKIP_'))}")
print(f"  Note appends that WILL run:    {note_change_count}")

# === SAVE CSV ===
out_path = 'snapshots/visits_dryrun_v3.csv'
with open(out_path, 'w', newline='') as f:
    w = csv.writer(f)
    w.writerow([
        # Identity
        'Sheet Buyer', 'Sheet Society', 'Sheet Unit', 'Sheet Visit Date', 'SM',
        # LSQ side for visual validation
        'LSQ Buyer (mx_Custom_4)', 'LSQ Unit/Society (mx_Custom_42)', 'LSQ Visit Date (mx_Custom_28)',
        # Confidence
        'Match Confidence', 'Match Score', 'Buyer Match', 'Society Match', 'Unit Match', 'Date Match',
        # Status side
        'Sheet Intent', 'LSQ Current mx_Lead_Status',
        'Lead CreatedOn', 'Lead ModifiedOn', 'Modified Delta (s)',
        'Status Gate Decision', 'Status WILL Update?', 'Proposed Status',
        # Note side
        'Note WILL Update?', 'LSQ Current Note (mx_Custom_36)', 'Proposed Full Note (after append)',
        # IDs
        'Lead ID', 'Visit ID',
    ])
    for d in dryrun:
        w.writerow([
            d['sheet_buyer'], d['sheet_society'], d['sheet_unit'], d['sheet_visit_date'], d['sheet_sm'],
            d['lsq_buyer'], d['lsq_unit_address'], d['lsq_visit_date'],
            d['match_confidence'], d['match_score'], d['buyer_match'], d['society_match'], d['unit_match'], d['date_match'],
            d['sheet_intent'], d['cur_lead_status'],
            d['lead_created_on'], d['lead_modified_on'], d['lead_modified_delta_sec'],
            d['gate_decision'],
            'YES' if d['gate_decision'].startswith('UPDATE_') else 'no',
            d['proposed_status'],
            'YES' if d['note_will_update'] else 'no',
            d['cur_visit_note'], d['proposed_full_note'],
            d['lead_id'], d['visit_id'],
        ])
print(f"\nCSV saved: {out_path}")

# Summary JSON
with open('/tmp/visits_dryrun_v3.json', 'w') as f:
    json.dump({
        'sheet_total': len(visit_rows),
        'matched': len(matched),
        'unmatched': len(unmatched),
        'match_confidence': {k: conf_dist[k] for k in ['HIGH','MEDIUM','LOW']},
        'gate_stats': dict(gate_stats),
        'updates_status': updates_status,
        'note_appends': note_change_count,
    }, f, indent=2)

# Sample of HIGH-confidence row + sample of LOW
print(f"\n=== Sample HIGH-confidence match ===")
for d in dryrun:
    if d['match_confidence'] == 'HIGH':
        print(f"  Sheet: {d['sheet_buyer']} | {d['sheet_society']} | {d['sheet_unit']} | {d['sheet_visit_date']}")
        print(f"  LSQ:   {d['lsq_buyer']} | {d['lsq_unit_address']} | {d['lsq_visit_date']}")
        print(f"  Score: {d['match_score']}  buyer={d['buyer_match']} society={d['society_match']} unit={d['unit_match']} date={d['date_match']}")
        break

print(f"\n=== Sample LOW-confidence match (worth eyeballing) ===")
for d in dryrun:
    if d['match_confidence'] == 'LOW':
        print(f"  Sheet: {d['sheet_buyer']} | {d['sheet_society']} | {d['sheet_unit']} | {d['sheet_visit_date']}")
        print(f"  LSQ:   {d['lsq_buyer']} | {d['lsq_unit_address']} | {d['lsq_visit_date']}")
        print(f"  Score: {d['match_score']}  buyer={d['buyer_match']} society={d['society_match']} unit={d['unit_match']} date={d['date_match']}")
        break

print(f"\n=== Sample proposed full note (after append) — first row ===")
if dryrun:
    print(dryrun[0]['proposed_full_note'])
