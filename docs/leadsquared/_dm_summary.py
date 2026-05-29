import json
from google.oauth2.service_account import Credentials
from googleapiclient.discovery import build
KEY='/Users/akshit.chaudhary/Documents/Claude Code/Property level report/credentials/service_account.json'
SID='1JJt4rGX_qFcS0UYnUm1a2LCxrCIs58IDWseimGQ9fo4'
creds=Credentials.from_service_account_file(KEY,scopes=['https://www.googleapis.com/auth/spreadsheets'])
svc=build('sheets','v4',credentials=creds)
R=json.load(open('/tmp/dm_results.json'))
mau=R['fm_mau']; stick=R['fm_stick']; pp=R['fm_perprop']; T5=R['T5']

rows=[]
A=rows.append
A(['LSQ DEMAND ANALYSIS — SUMMARY & RECOMMENDATIONS'])
A(['Generated 2026-05-18 · Spine = Visitors sheet completed visits (LSQ is a 1:1 downstream mirror) · *May-26 partial (to 18th)'])
A([])
A(['1. HEADLINE — why demand/purchases are down'])
A(['Total visits keep rising (44 in Aug-25 → 1,152 in Apr-26) BUT this is almost entirely from onboarding more brokers, not from existing brokers doing more.'])
A(['Visits per active broker plateaued at ~2.5/mo since Jan-26 (peaked 2.79 in Jan, 2.27 in May). Engagement depth is flat; growth is a treadmill of new onboarding.'])
A(['Broker retention is the core problem: MoM stickiness ~30-46% (no upward trend) and every onboarding cohort decays to <10% active within ~4 months.'])
A(['Net: we acquire brokers fast but lose them faster — the active base is shallow and leaky, so qualified visits → purchases pipeline is starved.'])
A([])
A(['2. KEY METRICS SNAPSHOT'])
A(['Month','Active brokers (MAU)','Total visits','Visits / active broker','MoM stickiness %','Visits / live property'])
sd={s['To']:s['Stickiness %'] for s in stick}
ppd={p['Month']:p for p in pp}
for r in mau:
    m=r['Month']
    A([m,r['MAU (active brokers)'],r['Total visits'],r['Visits / active broker'],
       sd.get(m,'—'),ppd.get(m,{}).get('Visits / live property','—')])
A([])
A(['3. FOUNDER QUESTIONS — ANSWERED'])
A(['Q','Answer (data)'])
A(['MAU','Active brokers/mo grew 34→431 (Apr-26); 332 in May (partial). Growth = onboarding-led.'])
A(['DAU','See Founder-Metrics tab — avg distinct brokers per active visit-day; tracks MAU shape, low absolute (most brokers do <1 visit/active day).'])
A(['Broker retention / stickiness (MoM)','30-46%, NO improving trend. ~2 of 3 active brokers do not return next month. Apr→May fell to 29%.'])
A(['Is visits/active-broker increasing?','NO. Plateaued ~2.4-2.7 since Jan-26 (peak 2.79 Jan, 2.27 May). Total-visit growth is new-broker-driven, not deepening.'])
A(['Is the visit increase "real"? (per live property)','Partly inventory-driven. Visits/live-property is ~8-11 and flat (not improving). Live properties grew 31→113; total visits scale with inventory + onboarding, not efficiency.'])
A(['Progress, or just new brokers doing visits?','Just new brokers. Cohort retention shows old cohorts near-dead (<10%); each month leans on freshly onboarded brokers.'])
A(['Target for visits/broker','Recommend: lift visits per ACTIVE broker from ~2.5 → 4.0/mo within 2 quarters, AND raise MoM stickiness from ~35% → 55%. Combined that ~doubles qualified visits without increasing onboarding.'])
A([])
A(['4. FINDINGS'])
for f in [
 'F1. Onboarding treadmill: 4,431 brokers onboarded (≈990 in Apr-26 alone) but only ~1,207 ever produced a visit; active base is ~330-430/mo.',
 f'F2. Churn is severe: {len(T5["1m"])} brokers stopped after 1 zero-month, {len(T5["2m"])} after 2, {len(T5["3m"])} after 3 (of ~1,207 ever-active). See Broker-Level Table 5.',
 'F3. Cohort decay: e.g. Sep-25 cohort (273) → 18.7% active month 1, single digits by month 5. No cohort sustains >20%.',
 'F4. Engagement depth flat: visits/active broker stuck ~2.5 since Jan-26 despite 2x inventory growth.',
 'F5. NEGOTIATION/CLOSING IS UNTRACKED IN LSQ: only 29 Demand-Negotiation (event 215) records all-time, none CP-attributed. Closing-stage funnel is invisible — likely a key reason "purchases down" cannot be diagnosed at stage level.',
 'F6. Task execution gap: AVFU task completion is low (e.g. a top CP owner at 45% done vs created). Many after-visit follow-ups created but not completed — leakage right after the visit.',
 'F7. Revisits low: 1,977 revisits vs 5,588 visits (~35% of visits are 2nd+); but concentrated — most brokers never generate a revisit.']:
    A([f])
A([])
A(['5. RECOMMENDATIONS'])
for i,r in enumerate([
 'Shift KPI from total visits to (a) visits per active broker and (b) % brokers retained MoM. Total visits is a vanity metric while inventory grows.',
 'Set the target: visits/active broker 2.5→4.0 and MoM stickiness 35%→55% in 2 quarters; instrument both in a weekly dashboard.',
 'Re-activation program for the 570 "stopped (2m)" brokers (Broker-Level T5) — they already know the product; cheapest incremental visits.',
 'Cap/condition onboarding on activation: measure CP owners on % of their onboarded brokers that give ≥1 visit in 30 days, not raw onboarding counts.',
 'FIX NEGOTIATION TRACKING: make Demand-Negotiation (event 215) mandatory in the SM flow; without closing-stage data the visit→purchase drop is undiagnosable.',
 'Enforce after-visit follow-up SLA: AVFU completion % by CP owner (CP-Owner tab) should be a managed metric; low completion = lost buyers.',
 'Focus owners on depth: per-CP-owner targets for visits/active broker and revisit rate, city-segmented (see CP-Owner tab).',
 'Investigate Apr→May stickiness drop (46%→29%) — sharp, recent; possible ops/assignment change worth a root-cause.']):
    A([f'R{i+1}. {r}'])
A([])
A(['6. DATA CAVEATS'])
for c in [
 '*May-26 is partial (through the 18th) — do not read May as a full month; use run-rate.',
 'Visit spine = Visitors-data sheet completed rows; LSQ event-12001 is a ~1:1 downstream mirror (confirmed per-month). Dedup on LSQ side unreliable (mx_Custom_5 CP code truncated) so sheet is authoritative.',
 'Revisit = 2nd+ completed visit for same buyer (lead_key), chronological — full history.',
 'Negotiation = LSQ event-215 only; effectively unpopulated (29 all-time) → Table 3 not produced.',
 'CP owner = LSQ Lead Owner (LeadSquare mapping); onboarding credited to added_by. Prashant Singh excluded from task-completion.',
 'Tabs: Broker-Level, Cohorts, CP-Owner, Founder-Metrics — all city-subgrouped (Gurgaon/Noida/Ghaziabad/Delhi/Multicity).']:
    A([c])

svc.spreadsheets().values().update(spreadsheetId=SID,range='Summary & Recommendations!A1',
    valueInputOption='RAW',body={'values':rows}).execute()
# bold title row + section rows
meta=svc.spreadsheets().get(spreadsheetId=SID).execute()
tid={s['properties']['title']:s['properties']['sheetId'] for s in meta['sheets']}['Summary & Recommendations']
svc.spreadsheets().batchUpdate(spreadsheetId=SID,body={'requests':[
 {'repeatCell':{'range':{'sheetId':tid,'startRowIndex':0,'endRowIndex':1},
   'cell':{'userEnteredFormat':{'textFormat':{'bold':True,'fontSize':13}}},'fields':'userEnteredFormat.textFormat'}},
 {'updateSheetProperties':{'properties':{'sheetId':tid,'gridProperties':{'frozenRowCount':1}},'fields':'gridProperties.frozenRowCount'}},
 {'autoResizeDimensions':{'dimensions':{'sheetId':tid,'dimension':'COLUMNS','startIndex':0,'endIndex':6}}}]}).execute()
print('Summary written:',len(rows),'rows')
