"""Finish the supply backup: resize sheet to fit, write remaining rows.

The main script failed on row 5001 because Sheet1 defaults to 5000 rows.
This rebuilds the flat table from cache and writes everything fresh after
resizing the grid.
"""
import json, time, sys, urllib.parse, urllib.request, os

sys.stdout.reconfigure(line_buffering=True)
TS = lambda: time.strftime('%H:%M:%S')

os.chdir(os.path.dirname(os.path.abspath(__file__)))
env = dict(l.strip().split('=', 1) for l in open('.env') if '=' in l)
qs = urllib.parse.urlencode({'accessKey': env['LSQ_ACCESS_KEY'], 'secretKey': env['LSQ_SECRET_KEY']})

SID = '1DnJFsP9RJDl2FJZOjlGtkyaBjml-4HDdVqMTxn7bhk4'
KEY_FILE = 'dashboard-routine/service_account.json'

print(f'[{TS()}] loading cached opps')
opps_by_lead = json.load(open('/tmp/supply_backup_opps.json'))
print(f'[{TS()}] cached: {sum(len(v) for v in opps_by_lead.values())} opps across {len(opps_by_lead)} leads')


# Fetch supply opp schema for header labels
def call_lsq(path, body=None, method='POST'):
    sep = '&' if '?' in path else '?'
    rq = urllib.request.Request(
        f"{env['LSQ_API_HOST']}{path}{sep}{qs}", method=method,
        data=(json.dumps(body).encode() if body is not None else None),
        headers={'Content-Type': 'application/json'},
    )
    with urllib.request.urlopen(rq, timeout=60) as r:
        return json.loads(r.read())


meta = call_lsq('/v2/OpportunityManagement.svc/GetOpportunityTypeMetadata?code=12000', method='GET')
schema_name_to_display = {f['SchemaName']: f.get('DisplayName', f['SchemaName']) for f in meta.get('Fields', [])}


# Re-build flat table
all_keys = set()
for rows in opps_by_lead.values():
    for r in rows: all_keys.update(r.keys())

ID_COLS = ['OpportunityId', 'ProspectId', 'OpportunityEvent', 'OpportunityAge']
LEAD_COLS = ['LeadName', 'P_FirstName', 'P_LastName', 'Phone', 'EmailAddress',
             'OwnerName', 'P_OwnerIdName', 'POwnerEmail', 'PAOwnerEmail',
             'P_DoNotCall', 'P_DoNotEmail', 'P_CreatedOn']
OPP_STD_COLS = ['Status', 'Owner', 'OpportunityNote', 'StatusReason', 'Score',
                'CreatedOn', 'ModifiedOn', 'CreatedByName', 'CreatedByEmail',
                'ModifiedByEmail', 'PACreatedByName', 'PACreatedByEmail',
                'PACreatedOn', 'PAModifiedOn', 'PCreatedByEmail', 'PModifiedByEmail',
                'Propensity', 'PropensityScore', 'RecommendedActionCode']


def custom_sort(k):
    if k.startswith('mx_Custom_'):
        try: return int(k.replace('mx_Custom_', '').split('~')[0])
        except: return 99999
    return 99999


custom_cols = sorted([k for k in all_keys if k.startswith('mx_Custom_')], key=custom_sort)
seen_cols = []
for c in ID_COLS + LEAD_COLS + OPP_STD_COLS + custom_cols:
    if c in all_keys and c not in seen_cols: seen_cols.append(c)
for c in sorted(all_keys):
    if c not in seen_cols: seen_cols.append(c)


def header_label(c):
    if c.startswith('mx_Custom_'):
        base = c.split('~')[0]
        disp = schema_name_to_display.get(base, base)
        return f'{disp} ({base})'
    return c


headers = [header_label(c) for c in seen_cols]
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

print(f'[{TS()}] flat table rebuilt: {len(sheet_rows)} rows × {len(headers)} cols')


# Write to sheet
from google.oauth2.service_account import Credentials
from googleapiclient.discovery import build

creds = Credentials.from_service_account_file(KEY_FILE, scopes=['https://www.googleapis.com/auth/spreadsheets'])
svc = build('sheets', 'v4', credentials=creds)

# Resize Sheet1 to hold all rows + 100 buffer
needed_rows = len(sheet_rows) + 100
needed_cols = max(len(headers), 30)
print(f'[{TS()}] resizing Sheet1 to {needed_rows} rows × {needed_cols} cols')

svc.spreadsheets().batchUpdate(spreadsheetId=SID, body={'requests': [
    {'updateSheetProperties': {
        'properties': {'sheetId': 0, 'gridProperties': {
            'rowCount': needed_rows, 'columnCount': needed_cols,
        }},
        'fields': 'gridProperties.rowCount,gridProperties.columnCount',
    }},
]}).execute()

# Clear then write
svc.spreadsheets().values().clear(spreadsheetId=SID, range='Sheet1').execute()
print(f'[{TS()}] cleared Sheet1')

CHUNK = 2000
i = 0
while i < len(sheet_rows):
    chunk = sheet_rows[i:i + CHUNK]
    rng = f'Sheet1!A{1 + i}'
    svc.spreadsheets().values().update(
        spreadsheetId=SID, range=rng,
        valueInputOption='RAW',
        body={'values': chunk},
    ).execute()
    print(f'[{TS()}] wrote rows {1 + i}..{i + len(chunk)}')
    i += CHUNK

# Freeze header
svc.spreadsheets().batchUpdate(spreadsheetId=SID, body={'requests': [
    {'updateSheetProperties': {
        'properties': {'sheetId': 0, 'gridProperties': {'frozenRowCount': 1}},
        'fields': 'gridProperties.frozenRowCount',
    }},
]}).execute()

print(f'[{TS()}] DONE — {len(sheet_rows)-1} supply opps × {len(headers)} columns written to https://docs.google.com/spreadsheets/d/{SID}/edit')
