"""
Full supply-side backup — sellers (leads) + opps + tasks + notes/activities → Google Sheet.
Builds on the cached opp data from _supply_backup.py. Writes 4 tabs.

Phases:
 A. Seller leads — Leads.GetById per unique lead (threaded, rate-limited)
 B. Tasks — Task.svc/Retrieve per user (both statuses), dedupe, filter to supply leads
 C. Activities/Notes — RetrieveRecentlyModified for events 200,201,202,203,204,205,209
 D. Build curated Opps tab from existing cache
 E. Write 4 tabs to spreadsheet 1DnJFsP9RJDl2FJZOjlGtkyaBjml-4HDdVqMTxn7bhk4

Caches: /tmp/supply_leads.json, /tmp/supply_tasks.json, /tmp/supply_notes.json
Resumable on lead pull via /tmp/supply_leads_done.txt
"""
import urllib.parse, urllib.request, json, time, sys, os, threading
from concurrent.futures import ThreadPoolExecutor, as_completed
from collections import defaultdict

sys.stdout.reconfigure(line_buffering=True)
TS = lambda: time.strftime('%H:%M:%S')

os.chdir(os.path.dirname(os.path.abspath(__file__)))
env = dict(l.strip().split('=', 1) for l in open('.env') if '=' in l)
HOST = env['LSQ_API_HOST']
qs = urllib.parse.urlencode({'accessKey': env['LSQ_ACCESS_KEY'], 'secretKey': env['LSQ_SECRET_KEY']})

SID = '1DnJFsP9RJDl2FJZOjlGtkyaBjml-4HDdVqMTxn7bhk4'
KEY_FILE = 'dashboard-routine/service_account.json'

# Token-bucket: max 18 calls per 5 seconds (under 20 limit)
_lock = threading.Lock()
_bucket = []
_WINDOW = 5.0
_LIMIT = 18

def rate_limit():
    while True:
        with _lock:
            now = time.time()
            while _bucket and _bucket[0] < now - _WINDOW: _bucket.pop(0)
            if len(_bucket) < _LIMIT:
                _bucket.append(now); return
            wait = _WINDOW - (now - _bucket[0]) + 0.05
        time.sleep(wait)


def call(path, body=None, method='POST', retries=4):
    for a in range(retries + 1):
        rate_limit()
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


# Load cached opp data
print(f'[{TS()}] loading cached opps')
opps_by_lead = json.load(open('/tmp/supply_backup_opps.json'))
LEAD_IDS = sorted(opps_by_lead.keys())
LEAD_ID_SET = set(LEAD_IDS)
print(f'[{TS()}] {sum(len(v) for v in opps_by_lead.values())} opps across {len(LEAD_IDS)} leads')

# ============================================================================
# Phase A: Pull lead records
# ============================================================================
LEADS_CACHE = '/tmp/supply_leads.json'
LEADS_DONE = '/tmp/supply_leads_done.txt'
leads_by_id = json.load(open(LEADS_CACHE)) if os.path.exists(LEADS_CACHE) else {}
done = set(open(LEADS_DONE).read().splitlines()) if os.path.exists(LEADS_DONE) else set()
done_lock = threading.Lock()
done_fp = open(LEADS_DONE, 'a')


def fetch_lead(lid):
    d, err = call(f'/v2/LeadManagement.svc/Leads.GetById?id={lid}', method='GET')
    if err:
        return lid, None, err
    rec = d if isinstance(d, dict) else (d[0] if isinstance(d, list) and d else None)
    if isinstance(rec, list) and rec: rec = rec[0]
    return lid, rec, None


print(f'[{TS()}] === Phase A: lead pull ===  remaining: {len(LEAD_IDS) - len(done)}/{len(LEAD_IDS)}')
todo = [l for l in LEAD_IDS if l not in done]
phase_start = time.time()
phase_done = 0
phase_err = 0

with ThreadPoolExecutor(max_workers=4) as ex:
    futs = {ex.submit(fetch_lead, lid): lid for lid in todo}
    for f in as_completed(futs):
        lid, rec, err = f.result()
        if err:
            phase_err += 1
        else:
            leads_by_id[lid] = rec
        with done_lock:
            done.add(lid); done_fp.write(lid + '\n'); done_fp.flush()
        phase_done += 1
        if phase_done % 100 == 0:
            elapsed = time.time() - phase_start
            rate = phase_done / elapsed if elapsed else 0
            eta = (len(todo) - phase_done) / rate / 60 if rate else 0
            print(f'[{TS()}] leads {phase_done}/{len(todo)} ({phase_err} err); {rate:.1f}/s; ETA {eta:.0f}min')
        if phase_done % 500 == 0:
            json.dump(leads_by_id, open(LEADS_CACHE, 'w'), default=str)

json.dump(leads_by_id, open(LEADS_CACHE, 'w'), default=str)
done_fp.close()
print(f'[{TS()}] leads pulled: {len(leads_by_id)} ({phase_err} errors)')


# ============================================================================
# Phase B: Pull tasks per user, filter to supply leads
# ============================================================================
TASKS_CACHE = '/tmp/supply_tasks.json'
if os.path.exists(TASKS_CACHE):
    tasks = json.load(open(TASKS_CACHE))
    print(f'[{TS()}] tasks loaded from cache: {len(tasks)}')
else:
    print(f'[{TS()}] === Phase B: task pull ===')
    users = json.load(open('snapshots/raw/users.json'))
    if isinstance(users, dict): users = users.get('Users', [])
    emails = sorted({u.get('EmailAddress') for u in users if u.get('EmailAddress')})
    print(f'[{TS()}] {len(emails)} users to scan for tasks')

    def fetch_user_tasks(email):
        out = []
        for sc in (0, 1):  # open + completed
            pg = 1
            while pg <= 60:
                body = {
                    'Parameter': {'LookupName': 'OwnerEmailAddress', 'LookupValue': email, 'StatusCode': sc},
                    'Paging': {'PageIndex': pg, 'PageSize': 1000},
                    'Sorting': {'ColumnName': 'CreatedOn', 'Direction': '1'},
                }
                d, err = call('/v2/Task.svc/Retrieve', body=body)
                if err: break
                lst = (d or {}).get('List') or (d or {}).get('Tasks') or (d or {}).get('Records') or []
                if not lst: break
                out.extend(lst)
                if len(lst) < 1000: break
                pg += 1
        return email, out

    raw_tasks = []
    with ThreadPoolExecutor(max_workers=4) as ex:
        futs = {ex.submit(fetch_user_tasks, e): e for e in emails}
        n = 0
        for f in as_completed(futs):
            e, lst = f.result()
            raw_tasks.extend(lst)
            n += 1
            if n % 5 == 0:
                print(f'[{TS()}] users scanned {n}/{len(emails)}; raw tasks {len(raw_tasks)}')

    # Dedupe by UserTaskId, filter to supply leads
    seen = {}
    for t in raw_tasks:
        tid = t.get('UserTaskId')
        if tid and tid not in seen: seen[tid] = t
    print(f'[{TS()}] {len(seen)} unique tasks after dedupe')
    tasks = [t for t in seen.values() if t.get('RelatedEntityId') in LEAD_ID_SET]
    print(f'[{TS()}] {len(tasks)} tasks on supply leads')
    json.dump(tasks, open(TASKS_CACHE, 'w'), default=str)


# ============================================================================
# Phase C: Pull supply-side activities for notes/comments
# ============================================================================
NOTES_CACHE = '/tmp/supply_notes.json'
SUPPLY_EVENTS = [200, 201, 202, 203, 204, 205, 209]
EVENT_NAMES = {
    200: 'Phone Call', 201: 'Lead Qualification', 202: 'Home Visit',
    203: 'Offer Qualification', 204: 'Seller Meeting Details',
    205: 'Negotiation & Token', 209: 'Schedule Seller Meeting',
}

if os.path.exists(NOTES_CACHE):
    notes = json.load(open(NOTES_CACHE))
    print(f'[{TS()}] notes loaded from cache: {len(notes)}')
else:
    print(f'[{TS()}] === Phase C: activity/note pull (events {SUPPLY_EVENTS}) ===')

    def pull_event(ev):
        out = []
        start = time.mktime(time.strptime('2024-08-01', '%Y-%m-%d'))
        end_t = time.time()
        chunk = 30 * 86400
        cur = start
        while cur < end_t:
            ce = min(cur + chunk, end_t)
            body = {
                'Parameter': {
                    'FromDate': time.strftime('%Y-%m-%d %H:%M:%S', time.localtime(cur)),
                    'ToDate': time.strftime('%Y-%m-%d %H:%M:%S', time.localtime(ce)),
                    'ActivityEvent': ev,
                    'IncludeCustomFields': 1,
                },
                'Paging': {'PageIndex': 1, 'PageSize': 1000},
                'Sorting': {'ColumnName': 'CreatedOn', 'Direction': '0'},
            }
            p = 1
            while p <= 60:
                body['Paging']['PageIndex'] = p
                d, err = call('/v2/ProspectActivity.svc/RetrieveRecentlyModified', body=body)
                if err: break
                acts = (d or {}).get('ProspectActivities') or []
                out.extend(acts)
                if len(acts) < 1000: break
                p += 1
            cur = ce + 1
        seen = {}
        for a in out: seen[a.get('Id')] = a
        return ev, list(seen.values())

    notes = []
    with ThreadPoolExecutor(max_workers=4) as ex:
        futs = {ex.submit(pull_event, ev): ev for ev in SUPPLY_EVENTS}
        for f in as_completed(futs):
            ev, lst = f.result()
            on_supply = [a for a in lst if a.get('RelatedProspectId') in LEAD_ID_SET]
            notes.extend(on_supply)
            print(f'[{TS()}] event {ev} ({EVENT_NAMES.get(ev)}): {len(lst)} total → {len(on_supply)} on supply leads')

    json.dump(notes, open(NOTES_CACHE, 'w'), default=str)
    print(f'[{TS()}] notes/activities cached: {len(notes)}')


# ============================================================================
# Build flat tables for each tab
# ============================================================================
print(f'[{TS()}] === building flat tables ===')

# ---- Tab 2: Opportunities (curated) ----
OPP_KEEP = [
    ('OpportunityId', 'OpportunityId'),
    ('ProspectId', 'LeadId'),
    ('LeadName', 'LeadName'),
    ('Phone', 'Lead Phone'),
    ('OwnerName', 'Opp Owner'),
    ('P_OwnerIdName', 'Lead Owner'),
    ('mx_Custom_1', 'Deal Name'),
    ('mx_Custom_2', 'Stage'),
    ('mx_Custom_3', 'Source'),
    ('mx_Custom_27', 'Society'),
    ('mx_Custom_28', 'Locality'),
    ('mx_Custom_33', 'Micromarket'),
    ('mx_Custom_35', 'City'),
    ('mx_Custom_24', 'Floor'),
    ('mx_Custom_25', 'Unit'),
    ('mx_Custom_4', 'Configuration'),
    ('mx_Custom_12', 'Configuration Addons'),
    ('mx_Custom_13', 'Furnishing Status'),
    ('mx_Custom_14', 'Super Builtup Area (sqft)'),
    ('mx_Custom_15', 'Carpet Area (sqft)'),
    ('mx_Custom_17', 'Price Expectation (lacs)'),
    ('mx_Custom_18', 'Occupancy Status'),
    ('mx_Custom_37', 'Exit Facing'),
    ('mx_Custom_38', 'Video URL'),
    ('mx_Custom_26', 'Listing Link'),
    ('mx_Custom_36', 'Listing ID'),
    ('mx_Custom_6', 'Offer Price'),
    ('mx_Custom_7', 'Expected Deal Size'),
    ('mx_Custom_8', 'Expected Closure Date'),
    ('mx_Custom_9', 'Actual Closure Date'),
    ('mx_Custom_30', 'Follow Up Date'),
    ('mx_Custom_31', 'Assisted by'),
    ('mx_Custom_19', 'Comment'),
    ('mx_Custom_32', 'Supply Closure Notes'),
    ('mx_Custom_34', 'Supply Closure Status'),
    ('mx_Custom_11', 'Origin'),
    ('OpportunityNote', 'Opportunity Note'),
    ('CreatedOn', 'Created On'),
    ('ModifiedOn', 'Modified On'),
    ('CreatedByName', 'Created By'),
    ('OpportunityAge', 'Opportunity Age (days)'),
]

opp_rows = [[disp for _, disp in OPP_KEEP]]
for lid in sorted(opps_by_lead.keys()):
    for r in opps_by_lead[lid]:
        row = []
        for k, _ in OPP_KEEP:
            v = r.get(k)
            if v is None: v = ''
            elif not isinstance(v, (str, int, float, bool)): v = str(v)
            row.append(v)
        opp_rows.append(row)
print(f'[{TS()}] Opportunities tab: {len(opp_rows)-1} rows × {len(OPP_KEEP)} cols')


# ---- Tab 1: Sellers (lead records) ----
# Pick relevant lead columns: contact + supply-relevant mx_* + standard
def first_value(d, keys):
    for k in keys:
        v = (d or {}).get(k)
        if v not in (None, '', '0', 0): return v
    return ''

SELLER_KEEP = [
    ('ProspectID', 'LeadId'),
    ('FirstName', 'First Name'),
    ('LastName', 'Last Name'),
    ('EmailAddress', 'Email'),
    ('Phone', 'Phone'),
    ('Mobile', 'Mobile'),
    ('OwnerIdName', 'Lead Owner'),
    ('ProspectStage', 'Lead Stage'),
    ('Source', 'Source'),
    ('mx_CP_code', 'CP Code'),
    ('mx_Lead_Status', 'Lead Status'),
    ('mx_Total_Deal_Count', 'Total Deal Count'),
    ('mx_Onboarded_By', 'Onboarded By'),
    ('mx_City_latest', 'City'),
    ('mx_Micromarket', 'Micromarket'),
    ('mx_Active_Micromarket_for_CP', 'Active Micromarket (CP)'),
    ('mx_Locality_for_CP', 'Locality (CP)'),
    ('mx_Designation_Role', 'Designation/Role'),
    ('mx_d30_visits', 'Visits L30d'),
    ('mx_d60_visits', 'Visits L60d'),
    ('mx_d90_visits', 'Visits L90d'),
    ('mx_all_time_visits', 'Visits All-time'),
    ('mx_Key_Societies_Projects', 'Key Societies/Projects'),
    ('CreatedOn', 'Created On'),
    ('ModifiedOn', 'Modified On'),
    ('CreatedByName', 'Created By'),
    ('ModifiedByName', 'Modified By'),
    ('DoNotCall', 'Do Not Call'),
    ('DoNotEmail', 'Do Not Email'),
]

seller_rows = [[disp for _, disp in SELLER_KEEP]]
for lid in sorted(LEAD_ID_SET):
    lead = leads_by_id.get(lid) or {}
    # Try ProspectID + LeadPropertyList shape
    if isinstance(lead, dict) and 'LeadPropertyList' in lead:
        flat = {p.get('Attribute'): p.get('Value') for p in lead.get('LeadPropertyList', [])}
        flat['ProspectID'] = lead.get('ProspectID', lid)
        lead = flat
    if not lead: lead = {'ProspectID': lid}
    row = []
    for k, _ in SELLER_KEEP:
        v = lead.get(k)
        if v is None: v = ''
        elif not isinstance(v, (str, int, float, bool)): v = str(v)
        row.append(v)
    seller_rows.append(row)
print(f'[{TS()}] Sellers tab: {len(seller_rows)-1} rows × {len(SELLER_KEEP)} cols')


# ---- Tab 3: Tasks ----
TASK_KEEP = [
    ('UserTaskId', 'TaskId'),
    ('RelatedEntityId', 'LeadId'),
    ('FirstName', 'Lead First Name'),
    ('LastName', 'Lead Last Name'),
    ('Phone', 'Lead Phone'),
    ('Subject', 'Subject'),
    ('Description', 'Description'),
    ('StatusCode', 'Status (0=open/1=done)'),
    ('CreatedOn', 'Created On'),
    ('DueDate', 'Due Date'),
    ('CompletedOn', 'Completed On'),
    ('OwnerName', 'Owner'),
    ('OwnerEmailAddress', 'Owner Email'),
    ('CreatedByName', 'Created By'),
    ('ModifiedByName', 'Modified By'),
    ('ModifiedOn', 'Modified On'),
]


def task_type(t):
    tt = t.get('TaskType')
    if isinstance(tt, dict): return tt.get('Name') or ''
    return tt or ''


task_rows = [['TaskType'] + [disp for _, disp in TASK_KEEP]]
for t in tasks:
    row = [task_type(t)]
    for k, _ in TASK_KEEP:
        v = t.get(k)
        if v is None: v = ''
        elif not isinstance(v, (str, int, float, bool)): v = str(v)
        row.append(v)
    task_rows.append(row)
print(f'[{TS()}] Tasks tab: {len(task_rows)-1} rows × {len(task_rows[0])} cols')


# ---- Tab 4: Notes/Activities ----
NOTE_KEEP = [
    ('Id', 'ActivityId'),
    ('RelatedProspectId', 'LeadId'),
    ('CreatedOn', 'Created On'),
    ('ActivityNote', 'Note'),
    ('Status', 'Status'),
    ('Owner', 'Owner'),
    ('CreatedByName', 'Created By'),
]


def flatten_data(a):
    return {d.get('Key'): d.get('Value') for d in (a.get('Data') or [])}


def flatten_fields(a):
    return {d.get('Key'): d.get('Value') for d in (a.get('Fields') or [])}


# Generic columns + custom field columns per event
all_field_keys = set()
for a in notes:
    fk = flatten_fields(a)
    all_field_keys.update(fk.keys())
sorted_fields = sorted(all_field_keys, key=lambda k: (int(k.replace('mx_Custom_', '')) if k.startswith('mx_Custom_') and k.replace('mx_Custom_', '').isdigit() else 999))

note_header = ['Event', 'EventName'] + [disp for _, disp in NOTE_KEEP] + sorted_fields
note_rows = [note_header]
for a in notes:
    fk = flatten_fields(a)
    dk = flatten_data(a)
    base = [a.get('EventCode'), EVENT_NAMES.get(a.get('EventCode'), a.get('EventName', ''))]
    for k, _ in NOTE_KEEP:
        v = a.get(k) if k != 'ActivityNote' else (dk.get('NotableEventDescription') or fk.get('ActivityEvent_Note') or '')
        if k == 'CreatedByName' and not v: v = dk.get('CreatedByName', '')
        if v is None: v = ''
        elif not isinstance(v, (str, int, float, bool)): v = str(v)
        base.append(v)
    for fkey in sorted_fields:
        v = fk.get(fkey, '')
        if v is None: v = ''
        elif not isinstance(v, (str, int, float, bool)): v = str(v)
        base.append(v)
    note_rows.append(base)
print(f'[{TS()}] Notes tab: {len(note_rows)-1} rows × {len(note_header)} cols')


# ============================================================================
# Write to Google Sheet — 4 tabs
# ============================================================================
print(f'[{TS()}] === writing 4 tabs to sheet ===')
from google.oauth2.service_account import Credentials
from googleapiclient.discovery import build

creds = Credentials.from_service_account_file(KEY_FILE, scopes=['https://www.googleapis.com/auth/spreadsheets'])
svc = build('sheets', 'v4', credentials=creds)

# Ensure tabs exist
meta = svc.spreadsheets().get(spreadsheetId=SID).execute()
existing = {s['properties']['title']: s['properties']['sheetId'] for s in meta['sheets']}
TABS = [('Sellers', seller_rows), ('Opportunities', opp_rows), ('Tasks', task_rows), ('Notes', note_rows)]

reqs = []
for name, _ in TABS:
    if name not in existing:
        reqs.append({'addSheet': {'properties': {'title': name}}})
if reqs:
    svc.spreadsheets().batchUpdate(spreadsheetId=SID, body={'requests': reqs}).execute()
    meta = svc.spreadsheets().get(spreadsheetId=SID).execute()
    existing = {s['properties']['title']: s['properties']['sheetId'] for s in meta['sheets']}

# Resize each tab + clear + write
for name, rows in TABS:
    sid = existing[name]
    rc = max(len(rows) + 50, 1000)
    cc = max(len(rows[0]) if rows else 1, 26)
    svc.spreadsheets().batchUpdate(spreadsheetId=SID, body={'requests': [
        {'updateSheetProperties': {
            'properties': {'sheetId': sid, 'gridProperties': {'rowCount': rc, 'columnCount': cc}},
            'fields': 'gridProperties.rowCount,gridProperties.columnCount',
        }},
    ]}).execute()
    svc.spreadsheets().values().clear(spreadsheetId=SID, range=name).execute()
    CHUNK = 2000
    i = 0
    while i < len(rows):
        chunk = rows[i:i + CHUNK]
        rng = f'{name}!A{1 + i}'
        svc.spreadsheets().values().update(
            spreadsheetId=SID, range=rng, valueInputOption='RAW',
            body={'values': chunk}).execute()
        i += CHUNK
    svc.spreadsheets().batchUpdate(spreadsheetId=SID, body={'requests': [
        {'updateSheetProperties': {
            'properties': {'sheetId': sid, 'gridProperties': {'frozenRowCount': 1}},
            'fields': 'gridProperties.frozenRowCount',
        }},
    ]}).execute()
    print(f'[{TS()}] wrote {name}: {len(rows)-1} rows')

# Remove the old Sheet1 if still present (it now duplicates Opportunities)
if 'Sheet1' in existing and 'Sheet1' not in [t[0] for t in TABS]:
    try:
        svc.spreadsheets().batchUpdate(spreadsheetId=SID, body={'requests': [
            {'deleteSheet': {'sheetId': existing['Sheet1']}},
        ]}).execute()
        print(f'[{TS()}] deleted old Sheet1')
    except Exception as e:
        print(f'[{TS()}] could not delete Sheet1: {e}')

print(f'[{TS()}] DONE — https://docs.google.com/spreadsheets/d/{SID}/edit')
