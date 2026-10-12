"""Hourly "Sold Property P&L - System Generated" refresh (Render cron job).

Writes two tabs of the target sheet: Sheet1 (active deals) and Cancelled Deals. Every value is read
live on each run — there are no snapshot files. Sources, column by column (approved by Akshit, Oct 2026):

  Universe        supply DB booking_details (Demand Dashboard bookings, any token type incl. conditional)
                  + booking_details_archive (where the Transaction Management Dashboard moves CANCELLED bookings).
                  One live row per unit: the latest MAILED booking (re-saves leave unmailed duplicates).
  Cancelled       archived booking, or a live booking whose unit went back to Available / Dead.
  Test (dropped)  society "DLF The Camellias", or society / unit / buyer literally named "test".
  Society/City/Unit  supply properties (legacy_properties for LEG-* units)
  Broker / Code / Buyer / Sale Price / Booking Date / Buyer Sourcing   the booking
  Date of AMA / Key Handover   exactly what the Demand Dashboard list shows (its api/list.js logic, see dd_dates())
  Purchase Price  supply properties.guaranteed_sale_price x 1,00,000 (stored in lakhs) -> AMA register
                  "Acquisition Price" (LEG-* units) -> TMD deals.acquisition_price
  Brokerage Income / Sale Brokerage   booking brokerage_amount, by booking source Direct / CP
  Acquisition Brokerage   supply form 3: total_brokerage_amount + additional_brokerage + incentive_owner_meeting
                  + incentive_visit; 0 for Direct-sourced units (the TMD hides sourcing brokerage for them)
  Rental          TMD finance_payments, kind = rent
  ATS Date        TMD deals.ats_date (the typed ATS date; stage ticks are click dates, not used)
  Registry        TMD deals.registry_done_date -> "Done", else "Pending" (blank on cancelled deals)
  Property Manager + micro-market   inventory sheet "All Properties" tab (the app's sales manager on the home)
  MM Lead         MM_LEAD_SET_BY_AKSHIT, else the CRM team lead carrying that micro-market, else the City Head
  Derived columns live sheet formulas, same as the manual P&L.

Safety: every database session is READ ONLY. Before writing it refuses to publish if the active row count
drops by more than 20% against the sheet, or required fields are missing; after writing it reads the tabs
back and fails the run (exit 1) on any mismatch or formula error.

Env: NEON_SUPPLY_URL, NEON_TMD_URL, CRM_DATABASE_URL, GOOGLE_SERVICE_ACCOUNT_JSON; optional PNL_SHEET_ID,
PNL_START (YYYY-MM-DD), DRY_RUN=1 (build + checks, no write; writes ./pnl_dry_run.json).
"""
import collections
import datetime as dt
import json
import os
import re
import sys

import gspread
import psycopg2
import psycopg2.extras

PNL_SHEET_ID = os.environ.get('PNL_SHEET_ID', '1f_r2z-ZorD6Yu3xvFSjLRVQHLh_10DhOWt6Q1pKj_qM')
INVENTORY_SHEET_ID = '1-kxlCnXUv7absl4rpWeMoYIxSAHpWykyjpd9v_5df-o'
INVENTORY_TAB_GID = 1970867601                     # "All Properties"
AMA_REGISTER_SHEET_ID = '1PZC6MHbqMVldSBWSQ8d7Pw_B101PcofRXFpWaVRWUL8'   # "Openhouse Acquired Properties"
START = dt.date.fromisoformat(os.environ.get('PNL_START', '2026-06-01'))
DRY_RUN = os.environ.get('DRY_RUN') == '1'
IST = dt.timezone(dt.timedelta(hours=5, minutes=30))

# Micro-markets whose lead Akshit set directly (the CRM doesn't mark these TLs yet). Wins over the CRM marking.
MM_LEAD_SET_BY_AKSHIT = {'noida extension': 'Ajitesh Singh', 'raj nagar extension': 'Aditya Bhasker',
                         'nh24, ghaziabad': 'Manish Pal'}
# Society spellings that differ between the supply DB and the inventory sheet (same building).
SOCIETY_ALIASES = {'mittalrajnagarresidency': 'rajnagarresidency',
                   'amrapaliprinceleyestate': 'amrapaliprincelyestate',
                   'mahagunmywoodsphase1': 'mahagunmywoodsphase12'}
# Demand Dashboard api/list.js KH_DATE_FROM_ACK_MAIL (main @367f768): (uid, date shown, only while supply holds)
KH_DATE_FROM_ACK_MAIL = [('OHND1074', '2026-08-14', '2026-08-10'), ('OHGC1023', '2026-04-15', None)]
DD_VISIBLE_STATUSES = ('AMA Signed', 'Key Handover Done')       # Demand Dashboard _db.js gate


def log(*a):
    print(*a, flush=True)


def ro(url):
    conn = psycopg2.connect(url, connect_timeout=20)    # Neon's pooler rejects startup options,
    conn.set_session(readonly=True)                     # so read-only is set on the session instead
    cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
    cur.execute("SET statement_timeout = '60s'")
    return cur


def gclient():
    raw = os.environ.get('GOOGLE_SERVICE_ACCOUNT_JSON', '').strip()
    if raw and raw[0] in "'\"" and raw[-1] == raw[0]:
        raw = raw[1:-1]
    if not raw:
        sys.exit('GOOGLE_SERVICE_ACCOUNT_JSON is not set')
    gc = gspread.service_account_from_dict(json.loads(raw))
    if hasattr(gc, 'set_timeout'):
        gc.set_timeout(60)                  # never let one hung Google call stall the cron
    return gc


def retry(fn, *a, **k):
    """Google API call with backoff on 429 / 5xx / timeouts (gspread does not retry 5xx itself)."""
    import time
    for attempt in range(4):
        try:
            return fn(*a, **k)
        except Exception as e:              # noqa: BLE001 — APIError, timeouts, connection resets
            code = getattr(getattr(e, 'response', None), 'status_code', None)
            if attempt == 3 or (code is not None and code not in (408, 429) and code < 500):
                raise
            time.sleep(5 * 2 ** attempt)


def num(x):
    """One plain number ('12,40,000', '₹ 58.2', 81000.0) -> float; anything else (e.g. '25000+5000') -> None."""
    if x in (None, ''):
        return None
    if isinstance(x, (int, float)):
        return float(x)
    s = re.sub(r'[,\s₹]', '', str(x))
    return float(s) if re.fullmatch(r'-?\d+(\.\d+)?', s) else None


def pdate(s):
    s = (s or '').strip()
    for cand in (s, s[:10]):
        for f in ('%Y-%m-%d', '%d-%m-%Y', '%d/%m/%Y', '%d-%b-%Y', '%d %b %Y', '%d %B %Y', '%d.%m.%Y'):
            try:
                return dt.datetime.strptime(cand, f).date()
            except ValueError:
                pass
    return None


def ist(ts):
    return ts.astimezone(IST).date() if ts else None


def ist_day(v):
    """A date or timestamp string from activity_logs -> IST calendar date."""
    s = str(v or '').strip()
    if not re.match(r'^\d{4}-\d{2}-\d{2}', s):
        return None
    try:
        if re.match(r'^\d{4}-\d{2}-\d{2}$', s):
            return dt.date.fromisoformat(s)
        t = dt.datetime.fromisoformat(s.replace('Z', '+00:00'))
        return (t if t.tzinfo else t.replace(tzinfo=dt.timezone.utc)).astimezone(IST).date()
    except ValueError:                      # one malformed log value must not stop every run
        return None


norm = lambda x: re.sub(r'[^a-z0-9]', '', str(x or '').lower())


def soc_key(x):
    k = norm(x)
    return SOCIETY_ALIASES.get(k, k)


def unit_key(x):
    """'PGN 04-0404' == 'PGN 04 - 404'; '(Top Floor)' and 'Tower' dropped; digit groups compared as numbers."""
    s = re.sub(r'\(.*?\)', ' ', str(x or '').lower())
    toks = [t for t in re.findall(r'[a-z]+|\d+', s) if t not in ('tower', 'top', 'floor', 'flat', 'unit', 'no')]
    return '|'.join(str(int(t)) if t.isdigit() else t for t in toks)


_GENERIC = {'the', 'phase', 'tower', 'avenue', 'city', 'sector', 'homes', 'estate', 'apartments', 'residency', 'greens'}


def society_match(a, b):
    """Same society spelt differently (register vs supply): every distinctive word of the shorter name must appear
    in the longer one — 'Princeley Estate' ~ 'Amrapali Princeley Estate', '14th Avenue' ~ 'Gaur City 2 14th Avenue',
    'Bestech Ananda' ~ 'Bestech Park View Ananda' — but never 'Mywoods Phase 1' ~ 'Phase 2' or two projects of one
    builder. Only used when no exact name match exists (see purchase_price)."""
    wa = set(re.findall(r'[a-z0-9]+', str(a or '').lower())) - _GENERIC
    wb = set(re.findall(r'[a-z0-9]+', str(b or '').lower())) - _GENERIC
    if not wa or not wb:
        return False
    small, big = (wa, wb) if len(wa) <= len(wb) else (wb, wa)
    return small <= big


def unit_match(register_unit, uk):
    """Register unit equals ours, or is its tail ('14003' vs 'A 14003')."""
    rk = unit_key(register_unit)
    return bool(rk) and (rk == uk or (len(rk) >= 4 and ('|' + uk).endswith('|' + rk)))


def unit_label(p):
    tw, un = (p.get('tower_no') or '').strip(), (p.get('unit_no') or '').strip()
    return f"{tw}-{un}" if tw and un and not un.upper().startswith(tw.upper()) else (un or tw)


def eff_date(b):
    return pdate(b['booking_date']) or ist(b['mail_sent_at']) or ist(b['created_at'])


# --------------------------------------------------------------------------- data
def load(env):
    s = ro(env['NEON_SUPPLY_URL'])
    s.execute("SELECT * FROM booking_details ORDER BY uid, created_at")
    live_rows = s.fetchall()
    s.execute("SELECT * FROM booking_details_archive ORDER BY uid, created_at")
    arch_rows = s.fetchall()

    def pick(rows):
        for cond in (lambda b: b['mail_sent_at'], lambda b: b['consideration_amount'], lambda b: True):
            hit = [b for b in rows if cond(b)]
            if hit:
                return hit[-1]
    by_uid = collections.defaultdict(list)
    for b in live_rows:
        by_uid[b['uid']].append(b)
    live = {u: pick(r) for u, r in by_uid.items()}
    live = {u: b for u, b in live.items() if eff_date(b) and eff_date(b) >= START}
    arch, seen = [], set()
    for b in sorted(arch_rows, key=lambda b: b['created_at'], reverse=True):
        if not (b['consideration_amount'] or (b['buyer_name'] or '').strip()):
            continue
        key = (b['uid'], norm(b['buyer_name']), b['consideration_amount'])
        if key in seen or not eff_date(b) or eff_date(b) < START:
            continue
        seen.add(key)
        arch.append(b)
    uids = sorted(set(live) | {b['uid'] for b in arch})

    s.execute("""SELECT p.*, apd.status AS ap_status FROM properties p
                 LEFT JOIN ap_details apd ON apd.uid = p.uid WHERE p.uid = ANY(%s)""", (uids,))
    P = {r['uid']: r for r in s.fetchall()}
    s.execute("SELECT * FROM legacy_properties WHERE uid = ANY(%s)", (uids,))
    L = {r['uid']: r for r in s.fetchall()}
    s.execute("SELECT uid, availability_status, updated_at FROM demand_details WHERE uid = ANY(%s)", (uids,))
    D = {r['uid']: r for r in s.fetchall()}
    # Demand Dashboard recoverBlankedKeyHandoverDates (api/list.js): KH blanked in supply after the KH ack mail
    s.execute("""
      WITH mail AS (
        SELECT uid, MAX(created_at) AS last_mail FROM activity_logs
         WHERE action = 'email_key_handover' AND COALESCE(details->>'gmail_id', '') <> '' GROUP BY uid)
      SELECT DISTINCT ON (l.uid) l.uid,
             COALESCE(l.details->'changes'->'key_handover_date'->>'old', l.details->>'from') AS old_value
        FROM activity_logs l
        JOIN mail m ON m.uid = l.uid AND l.created_at > m.last_mail
        JOIN properties p ON p.uid = l.uid AND p.key_handover_date IS NULL
       WHERE (l.details->'changes' ? 'key_handover_date'
              AND COALESCE(l.details->'changes'->'key_handover_date'->>'new', '') = ''
              AND COALESCE(l.details->'changes'->'key_handover_date'->>'old', '') <> '')
          OR (l.details->>'field' = 'key_handover_date'
              AND COALESCE(l.details->>'to', '') = '' AND COALESCE(l.details->>'from', '') <> '')
       ORDER BY l.uid, l.created_at DESC""")
    kh_override = [(u, d, sup) for u, d, sup in KH_DATE_FROM_ACK_MAIL]
    kh_override += [(r['uid'], ist_day(r['old_value']).isoformat(), None) for r in s.fetchall() if ist_day(r['old_value'])]
    s.execute("SELECT society_name, micro_market FROM master_societies WHERE micro_market IS NOT NULL")
    MASTER_MM = {soc_key(r['society_name']): r['micro_market'] for r in s.fetchall()}

    t = ro(env['NEON_TMD_URL'])
    t.execute("""SELECT un.property_uid, un.source AS unit_source, d.id deal_id, d.status, d.acquisition_price,
                        d.ats_date, d.registry_done_date
                 FROM deals d JOIN units un ON un.id = d.unit_id WHERE un.property_uid = ANY(%s)
                 ORDER BY d.created_at""", (uids,))
    T = {r['property_uid']: r for r in t.fetchall()}
    t.execute("SELECT deal_id, sum(amount) amt FROM finance_payments WHERE kind = 'rent' AND deal_id = ANY(%s) GROUP BY 1",
              ([r['deal_id'] for r in T.values()],))
    RENT = {r['deal_id']: float(r['amt'] or 0) for r in t.fetchall()}

    c = ro(env['CRM_DATABASE_URL'])
    c.execute("SELECT name, role, micro_markets FROM users WHERE active AND team = 'TL'")
    tl_lead, head_lead = {}, {}
    for u in c.fetchall():
        for mm in (u['micro_markets'] or []):
            (head_lead if u['role'] == 'city_head' else tl_lead).setdefault(mm.strip().lower(), []).append(u['name'])
    c.execute("SELECT society_name, micro_market FROM hiring_mm_overrides")
    CRM_SOC_MM = {soc_key(r['society_name']): r['micro_market'] for r in c.fetchall()}
    c.execute("SELECT society_name, micro_market, count(*) n FROM all_properties WHERE deleted_at IS NULL "
              "AND micro_market IS NOT NULL AND micro_market <> '' GROUP BY 1, 2")
    soc_majority = collections.defaultdict(collections.Counter)
    for r in c.fetchall():
        soc_majority[soc_key(r['society_name'])][r['micro_market']] += r['n']
    c.execute("SELECT locality_or_sector, micro_market, count(*) n FROM all_properties WHERE deleted_at IS NULL "
              "AND micro_market IS NOT NULL AND micro_market <> '' GROUP BY 1, 2")
    sector_majority = collections.defaultdict(collections.Counter)
    for r in c.fetchall():
        sector_majority[norm(r['locality_or_sector'])][r['micro_market']] += r['n']

    gc = gclient()
    inv_ws = next(w for w in gc.open_by_key(INVENTORY_SHEET_ID).worksheets() if w.id == INVENTORY_TAB_GID)
    inv = inv_ws.get_all_values()
    ih = inv[1]
    INV = [dict(zip(ih, r)) for r in inv[2:] if any(x.strip() for x in r)]
    reg = []
    sh = gc.open_by_key(AMA_REGISTER_SHEET_ID)
    for tab in ('Gurgaon', 'Noida/GN', 'Ghaziabad'):
        v = sh.worksheet(tab).get_all_values()
        hi = next(i for i, r in enumerate(v[:15]) if any(re.search(r'society', x, re.I) for x in r))
        H = [re.sub(r'\s+', ' ', h).strip() for h in v[hi]]
        si, ui, pi = H.index('Society Name'), H.index('Unit No'), H.index('Acquisition Price')
        reg += [(tab, r[si], r[ui], num(r[pi])) for r in v[hi + 1:] if len(r) > pi and num(r[pi])]
    return dict(live=live, arch=arch, P=P, L=L, D=D, T=T, RENT=RENT, kh_override=kh_override, MASTER_MM=MASTER_MM,
                tl_lead=tl_lead, head_lead=head_lead, CRM_SOC_MM=CRM_SOC_MM, soc_majority=soc_majority,
                sector_majority=sector_majority,
                INV=INV, REG=reg)


# --------------------------------------------------------------------------- data points
def dd_dates(u, S):
    """Date of AMA / Key Handover exactly as the Demand Dashboard list shows them."""
    p, lg = S['P'].get(u), S['L'].get(u)
    if p and p.get('ap_status') in DD_VISIBLE_STATUSES and p.get('replicated') is not True:
        kh = p.get('key_handover_date')
        for ou, od, sup in S['kh_override']:
            if ou == u and (kh.isoformat() if kh else None) == sup:
                kh = dt.date.fromisoformat(od)
                break
        return p.get('ama_date'), kh
    if lg:
        return lg.get('ama_date'), lg.get('key_handover_date')
    return None, None


def purchase_price(u, S, soc, unit):
    p, lg, tr = S['P'].get(u) or {}, S['L'].get(u) or {}, S['T'].get(u) or {}
    gsp = num(p.get('guaranteed_sale_price')) or num(lg.get('guaranteed_sale_price'))      # lakhs
    if gsp:
        return gsp * 1e5
    uk = unit_key(unit)
    city = (p.get('city') or lg.get('city') or '').strip().lower()
    tab = 'Gurgaon' if 'gurgaon' in city or 'gurugram' in city else 'Ghaziabad' if 'ghaziabad' in city else 'Noida/GN'
    same_city = [x for x in S['REG'] if x[0] == tab]
    hit = {pr for _, rs, ru, pr in same_city if soc_key(rs) == soc_key(soc) and unit_match(ru, uk)}      # exact name
    if not hit:
        hit = {pr for _, rs, ru, pr in same_city if society_match(rs, soc) and unit_match(ru, uk)}    # spelling variant
    if len(hit) == 1:                      # only an unambiguous register price is used
        return hit.pop()
    return num(tr.get('acquisition_price'))


def acq_brokerage(u, S):
    p, lg, tr = S['P'].get(u) or {}, S['L'].get(u) or {}, S['T'].get(u) or {}
    src = (p.get('source') or tr.get('unit_source') or lg.get('source') or '').strip()
    if src.lower() == 'direct':
        return 0.0
    if not p:
        return None
    total = num(p.get('total_brokerage_amount'))
    if total is None:
        a, b = num(p.get('total_cp_amount')), num(p.get('brokerage_registry_amount'))
        if a is None and b is None:
            return None
        total = (a or 0) + (b or 0)
    extras = [num(p.get(k)) for k in ('additional_brokerage', 'incentive_owner_meeting', 'incentive_visit')]
    return total + sum(x for x in extras if x)


def inventory_row(u, S, soc, unit):
    p = S['P'].get(u) or {}
    rows = [r for r in S['INV'] if r.get('supply_form_uid', '').strip() == u]
    if not rows and p.get('core_home_id'):
        rows = [r for r in S['INV'] if r.get('home_id', '').strip() == str(p['core_home_id'])]
    if not rows:
        sk, uk = soc_key(soc), unit_key(unit)
        rows = [r for r in S['INV'] if soc_key(r.get('society_name')) == sk
                and unit_key(r.get('property_name', '').split(',')[0]) == uk]
    if not rows:
        return None
    sms = {r.get('sales_manager', '').strip() for r in rows}
    if len(sms) > 1:                       # ambiguous duplicate homes: prefer the Sold one
        sold = [r for r in rows if r.get('listing_status', '').lower() == 'sold']
        rows = sold if len({r.get('sales_manager', '').strip() for r in sold}) == 1 else rows
    return rows[0] if len({r.get('sales_manager', '').strip() for r in rows}) == 1 else None


def micro_market(inv_row, S, soc):
    known = set(S['tl_lead']) | set(S['head_lead']) | set(MM_LEAD_SET_BY_AKSHIT)
    mm = (inv_row or {}).get('micro_market', '').strip()
    if mm.lower() in known:
        return mm
    sk = soc_key(soc)
    for cand in (S['CRM_SOC_MM'].get(sk), S['MASTER_MM'].get(sk)):
        for k in sorted(known, key=len, reverse=True):
            if cand and cand.strip().lower().startswith(k):
                return cand.strip()[:len(k)]
    maj = [m for m, _ in S['soc_majority'].get(sk, collections.Counter()).most_common() if m.strip().lower() in known]
    if maj:
        return maj[0]
    # e.g. the pre-split 'New Gurgaon' label: the micro-market the CRM uses most for the same sector
    sec = norm((inv_row or {}).get('locality_or_sector'))
    maj = [m for m, _ in S['sector_majority'].get(sec, collections.Counter()).most_common() if m.strip().lower() in known] if sec else []
    return maj[0] if maj else mm


def mm_lead(mm, S):
    k = (mm or '').strip().lower()
    names = [MM_LEAD_SET_BY_AKSHIT[k]] if k in MM_LEAD_SET_BY_AKSHIT else (S['tl_lead'].get(k) or S['head_lead'].get(k) or [])
    return ' / '.join(names)


# --------------------------------------------------------------------------- rows
def build(S):
    def record(u, b, reason, archived=False):
        p = S['P'].get(u) or S['L'].get(u) or {}
        tr, d = S['T'].get(u) or {}, S['D'].get(u) or {}
        if archived and u in S['live']:     # unit re-booked since: the TMD deal (ATS / registry / rent) is the new buyer's
            tr = {}
        soc, unit = (p.get('society_name') or '').strip(), unit_label(p)
        ama, kh = dd_dates(u, S)
        inv = inventory_row(u, S, soc, unit)
        mm = micro_market(inv, S, soc)
        src = (b['source'] or '').strip()
        reg = tr.get('registry_done_date')
        return dict(
            uid=u, society=soc, city=(p.get('city') or '').strip(), unit=unit,
            broker=(b['selling_cp_name'] or '').strip(), broker_code=(b['selling_cp_code'] or '').strip(),
            buyer='\n'.join(x for x in [(b['buyer_name'] or '').strip(), (b['co_buyer_name'] or '').strip()] if x),
            booking=eff_date(b), sale=b['consideration_amount'], ama=ama, kh=kh,
            purchase=purchase_price(u, S, soc, unit), brok_income=b['brokerage_amount'] if src == 'Direct' else None,
            acq_brok=acq_brokerage(u, S), sale_brok=b['brokerage_amount'] if src == 'CP' else None,
            rental=S['RENT'].get(tr.get('deal_id')), sourcing=src,
            remarks='; '.join(x for x in [('Conditional booking' if (b['token_type'] or '').lower() == 'conditional' else ''),
                                           reason or (d.get('availability_status') or '')] if x),
            ats=tr.get('ats_date'), reg_date=reg, reg_status='Done' if reg else ('' if reason else 'Pending'),
            pm=(inv or {}).get('sales_manager', '').strip(), mm=mm, mm_lead=mm_lead(mm, S),
            test=('camellias' in soc.lower() and 'dlf' in soc.lower())
                 or any(re.search(r'\btest\b', str(x or ''), re.I) for x in (soc, unit, b['buyer_name'])))

    active, cancelled, tests = [], [], []
    for u, b in S['live'].items():
        d, tr = S['D'].get(u) or {}, S['T'].get(u) or {}
        av = d.get('availability_status') or ''
        when = d['updated_at'].astimezone(IST).strftime('%d-%b-%Y') if d.get('updated_at') else ''
        reason = (f'Cancelled: unit back to Available ({when})' if av == 'Available' else
                  f'Cancelled: unit marked Dead ({when})' if av == 'Dead' else
                  'Cancelled in Transaction Management' if (tr.get('status') or '') == 'cancelled' else '')
        r = record(u, b, reason)
        (tests if r['test'] else cancelled if reason else active).append(r)
    for b in S['arch']:
        when = b['archived_at'].astimezone(IST).strftime('%d-%b-%Y') if b.get('archived_at') else ''
        r = record(b['uid'], b, f'Cancelled: booking archived ({when})' if when else 'Cancelled: booking archived',
                   archived=True)
        (tests if r['test'] else cancelled).append(r)
    for lst in (active, cancelled):
        lst.sort(key=lambda r: (r['booking'], r['society'], r['unit']))
    return active, cancelled, tests


COLS = ['Sl No.', 'Society', 'City', 'Unit No.', 'Broker Name', 'Broker Code', 'Buyer Name', 'Date of Sales Booking',
        'Sale (Booking) Month', 'Sale Price', 'Date of AMA', 'Date of Key Handover', 'Purchase Price', 'Brokerage Income',
        'Loan Commission', 'Gross Profit', 'Acquisition Brokerage', 'Uplifting Cost', 'Sale Brokerage', 'Seller Profit Share',
        'Rental', 'GST', 'Total Expenses', 'Net Profit', 'Gross Profit%', 'Net Profit%', 'Buyer Sourcing', 'Remarks',
        'ATS Date', 'Sale TAT', 'Registry Status', 'Date of Registry', 'Gross Profit% ', 'Net Profit% ',
        'Property Manager', 'MM Lead']          # the trailing-space twins are the "% of sale" columns
HDR = [c.strip() for c in COLS]
COL = {c: gspread.utils.rowcol_to_a1(1, i + 1)[:-1] for i, c in enumerate(COLS)}
FMT = {('DATE', 'dd-mmm-yyyy'): ['Date of Sales Booking', 'Date of AMA', 'Date of Key Handover', 'ATS Date', 'Date of Registry'],
       ('DATE', 'mmm yyyy'): ['Sale (Booking) Month'],
       ('NUMBER', '#,##0'): ['Sale Price', 'Purchase Price', 'Brokerage Income', 'Loan Commission', 'Gross Profit',
                             'Acquisition Brokerage', 'Uplifting Cost', 'Sale Brokerage', 'Seller Profit Share', 'Rental',
                             'GST', 'Total Expenses', 'Net Profit'],
       ('PERCENT', '0.00%'): ['Gross Profit%', 'Net Profit%', 'Gross Profit% ', 'Net Profit% '],
       ('NUMBER', '0'): ['Sale TAT']}


def sheet_rows(subset):
    D_ = lambda x: x.isoformat() if x else ''
    N_ = lambda x: round(float(x)) if x not in (None, '') else ''
    T_ = lambda x: "'" + x if x else ''      # leading ' = always stored as text
    rows = [HDR]
    for i, r in enumerate(subset):
        n = i + 2
        c = lambda name: f"{COL[name]}{n}"
        I, L, N, O, T, W = c('Sale Price'), c('Purchase Price'), c('Loan Commission'), c('Gross Profit'), c('Rental'), c('Net Profit')
        G, K = c('Date of Sales Booking'), c('Date of Key Handover')
        v = {'Sl No.': 1 if n == 2 else f"={COL['Sl No.']}{n - 1}+1", 'Society': T_(r['society']), 'City': T_(r['city']),
             'Unit No.': T_(r['unit']), 'Broker Name': T_(r['broker']), 'Broker Code': T_(r['broker_code']),
             'Buyer Name': T_(r['buyer']), 'Date of Sales Booking': D_(r['booking']),
             'Sale (Booking) Month': f'=IF({G}="","",DATE(YEAR({G}),MONTH({G}),1))', 'Sale Price': N_(r['sale']),
             'Date of AMA': D_(r['ama']), 'Date of Key Handover': D_(r['kh']), 'Purchase Price': N_(r['purchase']),
             'Brokerage Income': N_(r['brok_income']), 'Loan Commission': '', 'Gross Profit': f'=IF({L}="","",({I}-{L})+{N})',
             'Acquisition Brokerage': N_(r['acq_brok']), 'Uplifting Cost': '', 'Sale Brokerage': N_(r['sale_brok']),
             'Seller Profit Share': '', 'Rental': N_(r['rental']), 'GST': f'=IF({L}="","",ROUND(({O}-{N}-{T})/1.18*0.18,0))',
             'Total Expenses': f'=IF({L}="","",SUM({c("Acquisition Brokerage")}:{c("GST")}))',
             'Net Profit': f'=IF({L}="","",{O}-{c("Total Expenses")})', 'Gross Profit%': f'=IF({L}="","",{O}/{L})',
             'Net Profit%': f'=IF({L}="","",{W}/{L})', 'Buyer Sourcing': T_(r['sourcing']), 'Remarks': T_(r['remarks']),
             'ATS Date': D_(r['ats']), 'Sale TAT': f'=IF(OR({G}="",{K}=""),"",{G}-{K}+1)', 'Registry Status': T_(r['reg_status']),
             'Date of Registry': D_(r['reg_date']), 'Gross Profit% ': f'=IF(OR({L}="",{I}=""),"",{O}/{I})',
             'Net Profit% ': f'=IF(OR({L}="",{I}=""),"",{W}/{I})', 'Property Manager': T_(r['pm']), 'MM Lead': T_(r['mm_lead'])}
        rows.append([v[k] for k in COLS])
    return rows


# --------------------------------------------------------------------------- checks + write
TRACKED = {'Purchase Price': 'purchase', 'Date of AMA': 'ama', 'Date of Key Handover': 'kh', 'Acquisition Brokerage': 'acq_brok',
           'ATS Date': 'ats', 'Date of Registry': 'reg_date', 'Rental': 'rental', 'Property Manager': 'pm', 'MM Lead': 'mm_lead',
           'Broker Code': 'broker_code'}
TAB_SUFFIX = os.environ.get('PNL_TAB_SUFFIX', '')          # e.g. ' (test)' to rehearse the write on throwaway tabs
FIRST_RUN = os.environ.get('FIRST_RUN') == '1'


def tab_stats(sh, title):
    """Rows + per-column non-blank counts of what the tab holds now (None if the tab doesn't exist)."""
    try:
        vals = retry(sh.worksheet(title).get_all_values)
    except gspread.WorksheetNotFound:
        return None
    data = [r for r in vals[1:] if any(x.strip() for x in r)]
    head = vals[0] if vals else []
    return {'rows': len(data), 'filled': {h: sum(1 for r in data if i < len(r) and r[i].strip()) for i, h in enumerate(head) if h}}


def precheck(new, stats, label):
    """Refuse to publish a build that looks like a partial source outage."""
    if stats is None or stats['rows'] == 0:
        return [] if FIRST_RUN else [f'{label}: tab missing or empty — set FIRST_RUN=1 to publish anyway']
    problems = []
    if stats['rows'] >= 10 and len(new) < 0.8 * stats['rows']:
        problems.append(f"{label}: rows fell from {stats['rows']} to {len(new)} (>20% drop)")
    for col, key in TRACKED.items():
        before = stats['filled'].get(col, 0)
        after = sum(1 for r in new if r[key] not in (None, ''))
        if before >= 10 and after < 0.8 * before and before - after >= 5:   # an outage blanks a column; ±3 is life
            problems.append(f'{label}: {col} filled {before} -> {after} (>20% drop)')
    dup = [u for u, n in collections.Counter(r['uid'] for r in new).items() if n > 1] if label == 'Sheet1' else []
    if dup:
        problems.append(f'{label}: duplicate units {dup[:5]}')
    problems += [f"{label}: missing society/unit/booking date for {r['uid']}" for r in new
                 if not (r['society'] and r['unit'] and r['booking'])]
    return problems


def write_tab(sh, title, rows):
    """Overwrite in place (never clear first): one values call, padded with blanks over any older, longer data.
    If that call fails the tab still holds the previous version. Formatting/trimming come after and are cosmetic."""
    try:
        ws = sh.worksheet(title)
    except gspread.WorksheetNotFound:
        ws = retry(sh.add_worksheet, title=title, rows=len(rows) + 50, cols=len(rows[0]))
    ncols = len(rows[0])
    used = len(retry(ws.get_all_values))
    rows = rows + [[''] * ncols for _ in range(max(0, used - len(rows)))]
    if ws.row_count < len(rows) or ws.col_count < ncols:
        retry(ws.resize, rows=max(ws.row_count, len(rows) + 20), cols=max(ws.col_count, ncols))
    retry(ws.update, rows, 'A1', value_input_option='USER_ENTERED')
    n = len([r for r in rows if any(str(x) for x in r)])
    req = [{'repeatCell': {'range': {'sheetId': ws.id}, 'cell': {}, 'fields': 'userEnteredFormat'}}]
    for (t, pat), names in FMT.items():
        for name in names:
            req.append({'repeatCell': {'range': gspread.utils.a1_range_to_grid_range(f'{COL[name]}2:{COL[name]}{max(n, 2)}', ws.id),
                                       'cell': {'userEnteredFormat': {'numberFormat': {'type': t, 'pattern': pat}}},
                                       'fields': 'userEnteredFormat.numberFormat'}})
    req += [{'repeatCell': {'range': {'sheetId': ws.id, 'startRowIndex': 0, 'endRowIndex': 1},
                            'cell': {'userEnteredFormat': {'textFormat': {'bold': True}}}, 'fields': 'userEnteredFormat.textFormat.bold'}},
            {'updateSheetProperties': {'properties': {'sheetId': ws.id, 'gridProperties': {'frozenRowCount': 1}},
                                       'fields': 'gridProperties.frozenRowCount'}},
            {'setBasicFilter': {'filter': {'range': {'sheetId': ws.id, 'startRowIndex': 0, 'endRowIndex': n,
                                                     'startColumnIndex': 0, 'endColumnIndex': ncols}}}}]
    retry(sh.batch_update, {'requests': req})
    retry(ws.resize, rows=max(200, n + 20), cols=ncols)
    return ws


def postcheck(ws, rows, recs):
    vals = retry(ws.get_all_values, value_render_option='UNFORMATTED_VALUE')
    shown = retry(ws.get_all_values)
    data = [r for r in vals[1:] if any(str(x).strip() for x in r)]
    problems = []
    if vals[0][:len(HDR)] != HDR:
        problems.append('header mismatch')
    if len(data) != len(rows) - 1:
        problems.append(f'{len(data)} rows in sheet vs {len(rows) - 1} written')
    errs = sum(1 for r in shown[1:] for x in r if str(x).startswith('#'))
    if errs:
        problems.append(f'{errs} formula error cells')
    si = HDR.index('Sale Price')
    want = sum(round(float(r['sale'])) for r in recs if r['sale'] not in (None, ''))
    got = sum(r[si] for r in data if isinstance(r[si], (int, float)))
    if want != got:
        problems.append(f'sale price total {got} != source {want}')
    return problems


def main():
    env = {k: os.environ.get(k) for k in ('NEON_SUPPLY_URL', 'NEON_TMD_URL', 'CRM_DATABASE_URL', 'GOOGLE_SERVICE_ACCOUNT_JSON')}
    missing = [k for k, v in env.items() if not v]
    if missing:
        sys.exit(f'missing env: {missing}')
    S = load(env)
    active, cancelled, tests = build(S)
    log(f'built: active {len(active)}, cancelled {len(cancelled)}, test dropped {len(tests)} '
        f'({[(r["society"], r["unit"]) for r in tests]})')
    log(f"active fill: { {c: sum(1 for r in active if r[k] not in (None, '')) for c, k in TRACKED.items()} }")
    sh = retry(gclient().open_by_key, PNL_SHEET_ID)
    tabs = (('Sheet1' + TAB_SUFFIX, active), ('Cancelled Deals' + TAB_SUFFIX, cancelled))
    problems = [p for title, new in tabs for p in precheck(new, tab_stats(sh, title), title)]
    if problems:
        log('PRECHECK FAILED — sheet not touched:', problems)
        sys.exit(1)
    rows = {title: sheet_rows(new) for title, new in tabs}
    if DRY_RUN:
        json.dump({'rows': rows[tabs[0][0]], 'rows_cancel': rows[tabs[1][0]], 'recs': active, 'recs_cancel': cancelled,
                   'tests': [{k: r[k] for k in ('uid', 'society', 'unit')} for r in tests]},
                  open('pnl_dry_run.json', 'w'), default=str)
        log('DRY_RUN: built + prechecked, nothing written (pnl_dry_run.json)')
        return
    issues = []
    for title, new in tabs:
        ws = write_tab(sh, title, rows[title])
        issues += [f'{title}: {p}' for p in postcheck(ws, rows[title], new)]
    if issues:
        log('POSTCHECK FAILED:', issues)
        sys.exit(1)
    log(f'OK: wrote {tabs[0][0]} {len(active)} rows, {tabs[1][0]} {len(cancelled)} rows; all checks passed')


if __name__ == '__main__':
    main()
