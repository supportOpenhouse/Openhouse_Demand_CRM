"""
Supply Deal backup — dump every supply opportunity (event 12000) with its current
state to a Google Sheet. Team is migrating off LSQ for supply tomorrow.

Pipeline:
 1. Pull all 12000 activities → unique RelatedProspectIds (seller leads)
 2. For each lead, GetOpportunitiesOfLead?type=12000 (paginated) → live opp records
 3. Pull all lead fields once for cross-reference (mx_LeadStage etc.)
 4. Build a flat table with display-name headers
 5. Write to spreadsheet 1DnJFsP9RJDl2FJZOjlGtkyaBjml-4HDdVqMTxn7bhk4 (Sheet1)

Resumable: caches at /tmp/supply_backup_*.json
"""
import urllib.parse, urllib.request, json, time, sys, os
from collections import defaultdict

sys.stdout.reconfigure(line_buffering=True)
TS = lambda: time.strftime('%H:%M:%S')

WORKDIR = os.path.dirname(os.path.abspath(__file__))
os.chdir(WORKDIR)

env = dict(l.strip().split('=', 1) for l in open('.env') if '=' in l)
HOST = env['LSQ_API_HOST']
qs = urllib.parse.urlencode({'accessKey': env['LSQ_ACCESS_KEY'], 'secretKey': env['LSQ_SECRET_KEY']})

SID = '1DnJFsP9RJDl2FJZOjlGtkyaBjml-4HDdVqMTxn7bhk4'
KEY_FILE = 'dashboard-routine/service_account.json'


def call(path, body=None, method='POST', retries=4):
    for a in range(retries + 1):
        try:
            sep = '&' if '?' in path else '?'
            rq = urllib.request.Request(
                f'{HOST}{path}{sep}{qs}', method=method,
                data=(json.dumps(body).encode() if body is not None else None),
                headers={'Content-Type': 'application/json'},
            )
            with urllib.request.urlopen(rq, timeout=90) as r:
                return json.loads(r.read()), None
        except urllib.error.HTTPError as e:
            if e.code == 429 and a < retries:
                time.sleep(2 ** a); continue
            try: msg = e.read().decode()[:200]
            except: msg = ''
            if a < retries: time.sleep(1 + a); continue
            return None, f'HTTP {e.code} {msg}'
        except Exception as e:
            if a < retries: time.sleep(1 + a); continue
            return None, f'{type(e).__name__}: {e}'
    return None, 'exhausted'


# -------- Step 1: Pull all 12000 activities to find seller leads --------
ACTS_CACHE = '/tmp/supply_backup_activities.json'
if os.path.exists(ACTS_CACHE):
    activities = json.load(open(ACTS_CACHE))
    print(f'[{TS()}] activities loaded from cache: {len(activities)}')
else:
    print(f'[{TS()}] === Pulling all 12000 (Supply Deal) activities ===')
    activities = []
    chunk = 30 * 86400
    cur = time.mktime(time.strptime('2024-08-01', '%Y-%m-%d'))
    now = time.time()
    while cur < now:
        ce = min(cur + chunk, now)
        body = {
            'Parameter': {
                'FromDate': time.strftime('%Y-%m-%d %H:%M:%S', time.localtime(cur)),
                'ToDate': time.strftime('%Y-%m-%d %H:%M:%S', time.localtime(ce)),
                'ActivityEvent': 12000,
                'IncludeCustomFields': 1,
            },
            'Paging': {'PageIndex': 1, 'PageSize': 1000},
            'Sorting': {'ColumnName': 'CreatedOn', 'Direction': '0'},
        }
        p = 1
        chunk_total = 0
        while p <= 50:
            body['Paging']['PageIndex'] = p
            d, err = call('/v2/ProspectActivity.svc/RetrieveRecentlyModified', body=body)
            if err:
                print(f'  err {err}'); break
            acts = d.get('ProspectActivities') or []
            activities.extend(acts)
            chunk_total += len(acts)
            if len(acts) < 1000: break
            p += 1
            time.sleep(0.27)
        print(f'[{TS()}] {time.strftime("%Y-%m-%d", time.localtime(cur))}..{time.strftime("%Y-%m-%d", time.localtime(ce))}: +{chunk_total} (total {len(activities)})')
        cur = ce + 1
    # dedup by Id
    seen = {}
    for a in activities: seen[a.get('Id')] = a
    activities = list(seen.values())
    json.dump(activities, open(ACTS_CACHE, 'w'), default=str)
    print(f'[{TS()}] cached {len(activities)} unique activities → {ACTS_CACHE}')


# -------- Step 2: Unique leads from activities --------
lead_ids = sorted({a.get('RelatedProspectId') for a in activities if a.get('RelatedProspectId')})
print(f'[{TS()}] unique seller leads: {len(lead_ids)}')


# -------- Step 3: GetOpportunitiesOfLead per lead --------
OPPS_CACHE = '/tmp/supply_backup_opps.json'
DONE_FILE = '/tmp/supply_backup_done.txt'
opps_by_lead = json.load(open(OPPS_CACHE)) if os.path.exists(OPPS_CACHE) else {}
done = set(open(DONE_FILE).read().splitlines()) if os.path.exists(DONE_FILE) else set()
done_fp = open(DONE_FILE, 'a')

print(f'[{TS()}] resumable: already done {len(done)} of {len(lead_ids)} leads')

start = time.time()
for i, lid in enumerate(lead_ids, 1):
    if lid in done:
        continue
    page = 1
    rows = []
    while True:
        url = f'/v2/OpportunityManagement.svc/GetOpportunitiesOfLead?leadId={lid}&opportunityType=12000'
        d, err = call(url, body={'Paging': {'PageIndex': page, 'PageSize': 100}})
        if err:
            print(f'  lead {lid[:8]} err {err}'); break
        lst = (d or {}).get('List') or []
        rows.extend(lst)
        if len(lst) < 100: break
        page += 1
        time.sleep(0.27)
    opps_by_lead[lid] = rows
    done.add(lid); done_fp.write(lid + '\n'); done_fp.flush()
    if i % 50 == 0:
        elapsed = time.time() - start
        rate = i / elapsed
        eta = (len(lead_ids) - i) / rate if rate > 0 else 0
        n_opps = sum(len(v) for v in opps_by_lead.values())
        print(f'[{TS()}] {i}/{len(lead_ids)} leads; {n_opps} opps; {rate:.1f}/s; ETA {eta/60:.0f}min')
    if i % 500 == 0:
        json.dump(opps_by_lead, open(OPPS_CACHE, 'w'), default=str)
    time.sleep(0.05)

json.dump(opps_by_lead, open(OPPS_CACHE, 'w'), default=str)
done_fp.close()

n_opps = sum(len(v) for v in opps_by_lead.values())
print(f'[{TS()}] DONE pulling opps: {n_opps} supply opps across {len(opps_by_lead)} leads')


# -------- Step 4: Build flat table --------
# Pull schema for column headers (display names)
meta, _ = call('/v2/OpportunityManagement.svc/GetOpportunityTypeMetadata?code=12000', method='GET')
schema_fields = meta.get('Fields', [])
schema_name_to_display = {f['SchemaName']: f.get('DisplayName', f['SchemaName']) for f in schema_fields}

# Find all unique keys across all opp records (to capture parent-lead fields too)
all_keys = set()
for rows in opps_by_lead.values():
    for r in rows: all_keys.update(r.keys())

# Order columns: identifiers → lead-side → opportunity custom fields by number → audit
ID_COLS = ['OpportunityId', 'ProspectId', 'OpportunityEvent', 'OpportunityAge']
LEAD_COLS = ['LeadName', 'P_FirstName', 'P_LastName', 'Phone', 'EmailAddress',
             'OwnerName', 'P_OwnerIdName', 'POwnerEmail', 'PAOwnerEmail',
             'P_DoNotCall', 'P_DoNotEmail', 'P_CreatedOn']
OPP_STD_COLS = ['Status', 'Owner', 'OpportunityNote', 'StatusReason', 'Score',
                'CreatedOn', 'ModifiedOn', 'CreatedByName', 'CreatedByEmail',
                'ModifiedByEmail', 'PACreatedByName', 'PACreatedByEmail',
                'PACreatedOn', 'PAModifiedOn', 'PCreatedByEmail', 'PModifiedByEmail',
                'Propensity', 'PropensityScore', 'RecommendedActionCode']

# Custom fields in numeric order
def custom_sort(k):
    if k.startswith('mx_Custom_'):
        try: return int(k.replace('mx_Custom_', '').split('~')[0])
        except: return 99999
    return 99999

custom_cols = sorted([k for k in all_keys if k.startswith('mx_Custom_')], key=custom_sort)

# Build the final column list (only include cols that actually appear in data)
seen_cols = []
for c in ID_COLS + LEAD_COLS + OPP_STD_COLS + custom_cols:
    if c in all_keys and c not in seen_cols:
        seen_cols.append(c)
# Add any remaining (rare) keys at the end
for c in sorted(all_keys):
    if c not in seen_cols: seen_cols.append(c)

# Header row: prefer display name with schema code for custom fields
def header_label(c):
    if c.startswith('mx_Custom_'):
        base = c.split('~')[0]
        disp = schema_name_to_display.get(base, base)
        return f'{disp} ({base})'
    return c

headers = [header_label(c) for c in seen_cols]

# Build rows
sheet_rows = [headers]
for lid in sorted(opps_by_lead.keys()):
    for r in opps_by_lead[lid]:
        row = []
        for c in seen_cols:
            v = r.get(c)
            if v is None: v = ''
            elif not isinstance(v, (str, int, float, bool)): v = str(v)
            row.append(v)
        sheet_rows.append(row)

print(f'[{TS()}] flat table: {len(sheet_rows)-1} data rows × {len(headers)} cols')


# -------- Step 5: Write to Google Sheet --------
from google.oauth2.service_account import Credentials
from googleapiclient.discovery import build

creds = Credentials.from_service_account_file(KEY_FILE, scopes=['https://www.googleapis.com/auth/spreadsheets'])
svc = build('sheets', 'v4', credentials=creds)

# Clear existing Sheet1 content
svc.spreadsheets().values().clear(spreadsheetId=SID, range='Sheet1').execute()
print(f'[{TS()}] cleared Sheet1')

# Sheets API has a per-request size limit (~10MB). Chunk by row groups if huge.
CHUNK = 5000
total = len(sheet_rows)
start_row = 1
i = 0
while i < total:
    chunk = sheet_rows[i:i + CHUNK]
    rng = f'Sheet1!A{start_row + i}'
    svc.spreadsheets().values().update(
        spreadsheetId=SID, range=rng,
        valueInputOption='RAW',
        body={'values': chunk},
    ).execute()
    print(f'[{TS()}] wrote rows {start_row + i}..{start_row + i + len(chunk) - 1}')
    i += CHUNK

# Freeze header row
svc.spreadsheets().batchUpdate(spreadsheetId=SID, body={'requests': [
    {'updateSheetProperties': {
        'properties': {'sheetId': 0, 'gridProperties': {'frozenRowCount': 1}},
        'fields': 'gridProperties.frozenRowCount',
    }},
]}).execute()

print(f'[{TS()}] DONE — sheet ID {SID}')
print(f'[{TS()}] {len(sheet_rows)-1} supply opps × {len(headers)} columns written')
