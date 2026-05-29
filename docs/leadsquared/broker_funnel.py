"""
STANDALONE broker-funnel builder — writes ONLY to the 'Investor data' sheet,
new tab 'Broker Funnel'. Touches no dashboard / no other sheet / no DB writes.

Flow:  Total Onboarded -> Active (did >=1 visit OR sourced >=1 property)
        split into Only Demand (visit) / Only Sourcing / Both ; plus Inactive.
Cuts:  Overall + Gurgaon + Noida + Ghaziabad + Q1(Jan-Mar26) + Q2(Apr-May26).

Sources (all READ-ONLY):
  - Broker_data_query  Sheet1   -> onboarded universe (cp_code, phone, name, city)
  - Visitors data      Sheet1   -> completed visits (cp_code, broker_contact, date)
  - Neon properties (source='CP') + cp_master -> sourcing (cp_code/phone/name)
  - Neon legacy_properties      -> legacy sourcing (owner_broker_name only)
"""
import re, datetime, collections
import psycopg2
from google.oauth2.service_account import Credentials
from googleapiclient.discovery import build

SA = "/Users/akshit.chaudhary/Documents/Claude Code/Property level report/credentials/service_account.json"
NEON = ("postgresql://neondb_owner:npg_t4e6GvKaUTyZ@ep-restless-lake-a82ey6wx-pooler"
        ".eastus2.azure.neon.tech/neondb?sslmode=require")
BROKER_SHEET = "1bUkpfbceA7lLpMhRh2aoB-oGCwnzUiyD4sIclm25Z1k"
VISITORS_SHEET = "17eEX021t97pGnJasMJ6v7ERE0jezKEC0S8teKepJRWQ"
TARGET_SHEET = "1N3pT1EhSX-b69Jm0qModx8Y9C7s1772Ux8oxt6VFXUI"
TARGET_TAB = "Broker Funnel"
SUPPLY_SHEET = "1JwUQvG4NajAGDXkEHbHthdVf700Z0ghbx_70MMwGB3c"   # supply-closure CP form
SUPPLY_TAB = "Form Responses 1"                                  # gid 1902319178

Q1 = ("2026-01-01", "2026-03-31")          # Jan-Mar 2026
Q2 = ("2026-04-01", "2026-05-31")          # Apr-May 2026
CITIES = ["Gurgaon", "Noida", "Ghaziabad"]

cred = Credentials.from_service_account_file(SA, scopes=['https://www.googleapis.com/auth/spreadsheets'])
svc = build('sheets', 'v4', credentials=cred)

def norm_name(s):
    s = re.sub(r'[^a-z0-9]+', ' ', str(s or '').lower()).strip()
    return s
def ph10(s):
    d = re.sub(r'\D', '', str(s or ''))
    return d[-10:] if len(d) >= 10 else ''
def cpc(s):
    s = str(s or '').strip().upper()
    return s if s.startswith('CP') else ''
def city_norm(c):
    c = re.sub(r'[^a-z ]', '', str(c or '').lower()).strip()
    if 'gurgaon' in c or 'gurugram' in c: return 'Gurgaon'
    if 'noida' in c: return 'Noida'
    if 'ghaziabad' in c: return 'Ghaziabad'
    return 'Other'
def grab(sid, tab):
    v = svc.spreadsheets().values().get(spreadsheetId=sid, range=tab,
        valueRenderOption='UNFORMATTED_VALUE', dateTimeRenderOption='FORMATTED_STRING'
        ).execute().get('values', [])
    if not v: return []
    h = [str(x).strip() for x in v[0]]
    return [dict(zip(h, [('' if c is None else c) for c in (list(r) + [''] * (len(h) - len(r)))])) for r in v[1:]]
def ymd(s):
    s = str(s or '')[:10]
    return s if re.match(r'\d{4}-\d{2}-\d{2}', s) else ''
def inq(d, q):
    return bool(d) and q[0] <= d <= q[1]
def ym(v):
    """Year-Month col -> 'YYYY-MM' (handles 'YYYY-MM' strings & Sheets serials)."""
    s = str(v or '').strip()
    if re.match(r'20\d\d-\d\d$', s):
        return s
    try:
        n = float(s)
        if 30000 < n < 80000:
            dt = datetime.date(1899, 12, 30) + datetime.timedelta(days=int(n))
            return dt.strftime('%Y-%m')
    except (ValueError, TypeError):
        pass
    return ''
def qof(m):
    """'YYYY-MM' -> 'Q1'(2026-01..03) / 'Q2'(2026-04..05) / None."""
    if Q1[0][:7] <= m <= Q1[1][:7]: return 'Q1'
    if Q2[0][:7] <= m <= Q2[1][:7]: return 'Q2'
    return None
def to_date(v):
    """Any cell -> 'YYYY-MM-DD' (handles date strings & Sheets serials)."""
    s = str(v or '').strip()
    if re.match(r'20\d\d-\d\d-\d\d', s): return s[:10]
    try:
        n = float(s)
        if 30000 < n < 80000:
            return (datetime.date(1899, 12, 30) + datetime.timedelta(days=int(n))).strftime('%Y-%m-%d')
    except (ValueError, TypeError):
        pass
    return s[:10]

# ---------- 1. ONBOARDED universe (Broker_data_query Sheet1) ----------
brk = grab(BROKER_SHEET, "Sheet1")
onb = {}                       # cp_code -> {city,name,phone}
by_phone, by_name = {}, {}
for r in brk:
    cc = cpc(r.get('cp_code'))
    if not cc: continue
    if cc not in onb:
        onb[cc] = {'city': city_norm(r.get('city')),
                    'name': norm_name(r.get('name')),
                    'phone': ph10(r.get('phone_number')),
                    'name_disp': str(r.get('name') or '').strip(),
                    'company': str(r.get('company_name') or '').strip(),
                    'phone_disp': str(r.get('phone_number') or '').strip(),
                    'mm': str(r.get('micro_markets') or '').strip(),
                    'onb_date': to_date(r.get('created_at'))}
    p = ph10(r.get('phone_number'));  n = norm_name(r.get('name'))
    if p and p not in by_phone: by_phone[p] = cc
    if n and len(n) > 3 and n not in by_name: by_name[n] = cc
TOTAL_ONB = len(onb)

def resolve(cc, phone, name):
    """map an external (sourced/visited) identity to an onboarded cp_code."""
    cc = cpc(cc)
    if cc and cc in onb: return cc
    p = ph10(phone)
    if p and p in by_phone: return by_phone[p]
    n = norm_name(name)
    if n and len(n) > 3 and n in by_name: return by_name[n]
    return None

# ---------- 2. VISITED (Visitors sheet, status=completed) ----------
vis = grab(VISITORS_SHEET, "Sheet1")
visited = collections.defaultdict(set)        # cp_code -> set(quarter)
visited_any = set()
vc_all, vc_q1, vc_q2 = collections.Counter(), collections.Counter(), collections.Counter()
for r in vis:
    if str(r.get('status', '')).strip().lower() != 'completed': continue
    cc = resolve(r.get('cp_code'), r.get('broker_contact'), r.get('broker_name'))
    if not cc: continue
    visited_any.add(cc)
    vc_all[cc] += 1
    d = ymd(r.get('visit_date')) or ymd(r.get('selected_date'))
    if inq(d, Q1): visited[cc].add('Q1'); vc_q1[cc] += 1
    if inq(d, Q2): visited[cc].add('Q2'); vc_q2[cc] += 1

# ---------- 3. SOURCED ----------
sourced = collections.defaultdict(set)        # cp_code -> set(quarter)
sourced_any = set()
sc_all, sc_q1, sc_q2 = collections.Counter(), collections.Counter(), collections.Counter()
counts = {}

# 3a. PRIMARY: supply-closure CP form (CP Code / Contact / Name + Year-Month)
form = grab(SUPPLY_SHEET, f"'{SUPPLY_TAB}'")
form_rows = form_attr = 0
for r in form:
    code = r.get('CP Code') or r.get('Referred by - Email ID')
    phone = r.get('CP Contact No'); name = r.get('CP Name')
    if not (str(code or '').strip() or str(phone or '').strip() or str(name or '').strip()):
        continue
    form_rows += 1
    cc = resolve(code, phone, name)
    if not cc:
        continue
    form_attr += 1
    sourced_any.add(cc)
    sc_all[cc] += 1
    q = qof(ym(r.get('Year-Month')))
    if q == 'Q1': sourced[cc].add('Q1'); sc_q1[cc] += 1
    elif q == 'Q2': sourced[cc].add('Q2'); sc_q2[cc] += 1
counts['form'] = (form_rows, form_attr)

# 3b. Neon (read-only): properties source=CP + cp_inventory + cp_master canon; legacy
conn = psycopg2.connect(NEON); cur = conn.cursor()
cur.execute("select cp_code,cp_phone,cp_name from cp_master")
cpm_by_code, cpm_by_phone = {}, {}
for code, phone, name in cur.fetchall():
    rec = {'cp_code': cpc(code), 'phone': ph10(phone), 'name': norm_name(name)}
    if rec['cp_code']: cpm_by_code[rec['cp_code']] = rec
    if rec['phone']: cpm_by_phone[rec['phone']] = rec

def neon_src(code, phone, name, created):
    code_c, ph_c, nm_c = cpc(code), ph10(phone), norm_name(name)
    m = cpm_by_code.get(code_c) or cpm_by_phone.get(ph_c)
    if m:
        code_c = code_c or m['cp_code']; ph_c = ph_c or m['phone']; nm_c = nm_c or m['name']
    if not (code_c or ph_c or nm_c): return False
    cc = resolve(code_c, ph_c, nm_c)
    if not cc: return False
    sourced_any.add(cc)
    sc_all[cc] += 1
    d = str(created)[:10] if created else ''
    if inq(d, Q1): sourced[cc].add('Q1'); sc_q1[cc] += 1
    if inq(d, Q2): sourced[cc].add('Q2'); sc_q2[cc] += 1
    return True

cur.execute("select cp_code,cp_phone,cp_name,created_at from properties where source='CP'")
counts['neon_properties'] = sum(1 for a in cur.fetchall() if neon_src(*a))
cur.execute("select cp_code,cp_contact,cp_name,created_at from cp_inventory")
counts['neon_cp_inventory'] = sum(1 for a in cur.fetchall() if neon_src(*a))
cur.execute("select owner_broker_name,contact_no,created_at from legacy_properties")
counts['neon_legacy'] = sum(1 for nm, ph, cr in cur.fetchall() if neon_src('', ph, nm, cr))
conn.close()

# ---------- 4. funnel computation ----------
def funnel(cp_set, vset, sset):
    """cp_set = onboarded universe for this cut; vset/sset = visited/sourced cp's."""
    v = cp_set & vset
    s = cp_set & sset
    active = v | s
    both = v & s
    return {
        'onboarded': len(cp_set),
        'active': len(active),
        'only_demand': len(v - s),
        'only_sourcing': len(s - v),
        'both': len(both),
        'inactive': len(cp_set) - len(active),
    }

ALL = set(onb)
flows = []
flows.append(("OVERALL (all cities, all time)", funnel(ALL, visited_any, sourced_any)))
for ct in CITIES:
    cset = {c for c in onb if onb[c]['city'] == ct}
    flows.append((f"CITY — {ct}", funnel(cset, visited_any, sourced_any)))
for qn, qk in (("Q1 Jan–Mar 2026", 'Q1'), ("Q2 Apr–May 2026", 'Q2')):
    vq = {c for c, qs in visited.items() if qk in qs}
    sq = {c for c, qs in sourced.items() if qk in qs}
    flows.append((f"TIME — {qn}  (onboarded held constant)", funnel(ALL, vq, sq)))

# ---------- 5. write ONLY to target sheet, new tab ----------
meta = svc.spreadsheets().get(spreadsheetId=TARGET_SHEET).execute()
tabs = {s['properties']['title']: s['properties']['sheetId'] for s in meta['sheets']}
if TARGET_TAB not in tabs:
    svc.spreadsheets().batchUpdate(spreadsheetId=TARGET_SHEET, body={
        'requests': [{'addSheet': {'properties': {'title': TARGET_TAB}}}]}).execute()
else:
    svc.spreadsheets().values().clear(spreadsheetId=TARGET_SHEET, range=f"'{TARGET_TAB}'").execute()

gen = datetime.datetime.now().strftime('%Y-%m-%d %H:%M')
out = []
out.append([f"Broker Funnel — Onboarded → Active (visit / sourcing / both)"])
out.append([f"Generated {gen}  ·  read-only; written to a NEW tab only"])
out.append([])
out.append(["DEFINITIONS"])
out.append(["Total Onboarded", "distinct cp_code in Broker_data_query · Sheet1"])
out.append(["Visited (Demand)", "≥1 status=completed visit in Visitors-data sheet"])
out.append(["Sourced", "≥1 property submitted in the supply-closure CP form OR a Neon CP-source row"])
out.append(["Sourcing data", "PRIMARY: supply-closure sheet 'Form Responses 1' (CP Code/Contact/Name). "
            "Plus Neon properties(source=CP) + cp_inventory + legacy, canonicalised via cp_master."])
out.append(["Match keys", "cp_code → phone(10-digit) → normalized name → onboarded universe"])
out.append(["City cut", "by broker's onboarding city (Broker_data_query.city)"])
out.append(["Time cut", "Active = visited or sourced within the quarter; Total Onboarded held constant"])
out.append([])
out.append(["Sourcing source breakdown (rows matched to an onboarded broker):"])
out.append([f"   Supply-closure form: {counts['form'][1]} of {counts['form'][0]} non-empty submissions matched"])
out.append([f"   Neon properties(CP)={counts['neon_properties']}  cp_inventory={counts['neon_cp_inventory']}"
            f"  legacy={counts['neon_legacy']}  →  {len(sourced_any)} distinct sourced brokers"])
out.append([])
hdr = ["Flow", "Total Onboarded", "Active (visit OR source)", "  Only Demand (visit)",
        "  Only Sourcing", "  Both", "Inactive (neither)", "Active %"]
out.append(hdr)
for title, f in flows:
    ap = f"{round(100*f['active']/f['onboarded'],1)}%" if f['onboarded'] else "—"
    out.append([title, f['onboarded'], f['active'], f['only_demand'],
                f['only_sourcing'], f['both'], f['inactive'], ap])
out.append([])
out.append(["Note: Only Demand + Only Sourcing + Both = Active.  Active + Inactive = Total Onboarded."])

svc.spreadsheets().values().update(
    spreadsheetId=TARGET_SHEET, range=f"'{TARGET_TAB}'!A1",
    valueInputOption='RAW', body={'values': out}).execute()

print(f"WROTE {len(out)} rows to '{TARGET_TAB}' tab of Investor-data sheet.")
print(f"Total onboarded={TOTAL_ONB} | visited_any={len(visited_any)} | sourced_any={len(sourced_any)}")
print(f"sourcing matched: {counts}")
for t, f in flows:
    print(f"  {t}: onb={f['onboarded']} active={f['active']} "
          f"(demand={f['only_demand']} src={f['only_sourcing']} both={f['both']}) inactive={f['inactive']}")

# ---------- 6. 'Broker Details' tab — ALL onboarded brokers ----------
DETAIL_TAB = "Broker Details"
meta = svc.spreadsheets().get(spreadsheetId=TARGET_SHEET).execute()
tabs = {s['properties']['title']: s['properties']['sheetId'] for s in meta['sheets']}
if DETAIL_TAB not in tabs:
    svc.spreadsheets().batchUpdate(spreadsheetId=TARGET_SHEET, body={
        'requests': [{'addSheet': {'properties': {'title': DETAIL_TAB}}}]}).execute()
else:
    svc.spreadsheets().values().clear(spreadsheetId=TARGET_SHEET, range=f"'{DETAIL_TAB}'").execute()

det = [["Broker Name", "Broker Code", "Broker Phone", "Company Name", "City",
        "Date of Onboarding", "MM Working In", "Visits — Overall",
        "Visits — Q1 (Jan–Mar 26)", "Visits — Q2 (Apr–May 26)",
        "Supply Shared — Overall", "Supply Shared — Q1", "Supply Shared — Q2"]]
order = sorted(onb, key=lambda c: (-(vc_all[c] + sc_all[c]),
                                   onb[c].get('name_disp', '').lower()))
for c in order:
    o = onb[c]
    det.append([o.get('name_disp', ''), c, o.get('phone_disp', ''),
                o.get('company', ''), o.get('city', ''), o.get('onb_date', ''),
                o.get('mm', ''), vc_all[c], vc_q1[c], vc_q2[c],
                sc_all[c], sc_q1[c], sc_q2[c]])
svc.spreadsheets().values().update(
    spreadsheetId=TARGET_SHEET, range=f"'{DETAIL_TAB}'!A1",
    valueInputOption='RAW', body={'values': det}).execute()
print(f"WROTE {len(det)-1} broker rows to '{DETAIL_TAB}' tab "
      f"(visits>0={sum(1 for c in onb if vc_all[c])}, supply>0={sum(1 for c in onb if sc_all[c])}).")
