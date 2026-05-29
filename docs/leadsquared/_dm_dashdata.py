"""Assemble dashboard data bundle: computed tables + raw filterable visits/brokers."""
import json, re, datetime, collections
R=json.load(open('/tmp/dm_results.json'))
sv=json.load(open('/tmp/dm_sheet_visitors_data.json'))
bm=json.load(open('/tmp/dm_sheet_broker_master.json'))
cpo=json.load(open('/tmp/dm_sheet_cp_owner.json'))
users=json.load(open('/tmp/dm_users.json'))
M=R['MONTHS']

u_email={u['EmailAddress'].lower():f"{u.get('FirstName','')} {u.get('LastName','')}".strip()
         for u in users if u.get('EmailAddress')}
CITYMAP={'gurgaon':'Gurgaon','gurugram':'Gurgaon','noida':'Noida','greater noida':'Noida',
 'ghaziabad':'Ghaziabad','delhi':'Delhi','new delhi':'Delhi'}
def cityn(c):
    c=re.sub(r'[^a-z ]','',str(c or '').lower()).strip()
    for k,v in CITYMAP.items():
        if k in c: return v
    return c.title() if c else 'Unknown'
def mk(s):
    s=str(s or '')[:10]; return s[:7] if re.match(r'\d{4}-\d{2}',s) else ''

broker={}
for r in bm:
    cc=str(r.get('cp_code') or '').strip().upper()
    if not cc.startswith('CP'): continue
    broker[cc]={'cp':cc,'name':str(r.get('name') or '').strip(),
      'company':str(r.get('company_name') or '').strip(),'city':cityn(r.get('city')),
      'added_by':str(r.get('added_by') or '').strip(),'onb':mk(r.get('created_at')),'owner':'Unassigned'}
for r in cpo:
    cc=str(r.get('cp code') or '').strip().upper()
    if not cc: continue
    b=broker.setdefault(cc,{'cp':cc,'name':'','company':'','city':'Unknown','added_by':'','onb':'','owner':'Unassigned'})
    em=str(r.get('CP owner') or '').strip().lower()
    if em: b['owner']=u_email.get(em,em)
    if b['city']=='Unknown' and r.get('city'): b['city']=cityn(r.get('city'))

# ALL visits w/ status (completed = spine for every tab; extra = VA-tab only).
raw_all=[]
for r in sv:
    st=str(r.get('status','')).strip().lower()
    if st not in ('completed','cancelled','upcoming'): continue
    vd=str(r.get('visit_date') or '')[:10]; m=mk(vd)
    if not m and st!='completed':           # cancelled/upcoming: use scheduled date
        vd=str(r.get('selected_date') or '')[:10]; m=mk(vd)
    if not m: continue
    cc=str(r.get('cp_code') or '').strip().upper()
    b=broker.get(cc,{})
    def gv(*ks):
        for k in ks:
            x=str(r.get(k) or '').strip()
            if x and x.lower() not in ('none','nan','null'): return x
        return ''
    ls=gv('lead_status'); ls='' if ls.lower() in ('select_status','select status') else ls
    rmk=' | '.join([p for p in [
        gv('all_feedback'),gv('sales_feedback'),gv('buyer_feedback'),
        gv('latest_followup_note'),ls] if p])[:600]
    raw_all.append({'date':vd,'month':m,'cp':cc if cc.startswith('CP') else '',
      'broker':str(r.get('broker_name') or '').strip(),'company':str(r.get('company_name') or '').strip(),
      'city':cityn(r.get('city') or b.get('city')),'buyer':str(r.get('buyer_name') or '').strip(),
      'buyer_contact':gv('buyer_contact'),'status':st,
      'sm':str(r.get('sales_manager') or '').strip(),'society':str(r.get('society_name') or '').strip(),
      'unit':((str(r.get('unit_address_line2') or '').strip()+' '+str(r.get('unit_address_line1') or '').strip()).strip()),'owner':b.get('owner','Unassigned'),
      'onb':b.get('onb',''),'lead_key':str(r.get('lead_key') or ''),'revisit':0,
      'pstatus':gv('listing_status'),'src':gv('source'),'added_by':gv('added_by'),
      'first_added_by':gv('first_added_by'),'lead_status':gv('lead_status'),
      'remarks':rmk})
# completed = the spine used by EVERY tab/computation (unchanged behaviour)
raw=[v for v in raw_all if v['status']=='completed']
# non-completed (cancelled/upcoming) — surfaced ONLY on the Visits-Analysis tab
raw_extra=[v for v in raw_all if v['status']!='completed']
seen=collections.Counter()
raw.sort(key=lambda x:x['date'])
for v in raw:
    if v['lead_key']:
        seen[v['lead_key']]+=1
        v['revisit']=1 if seen[v['lead_key']]>1 else 0

# broker summary rows
bvis=collections.defaultdict(lambda: collections.Counter())
for v in raw:
    if v['cp']: bvis[v['cp']][v['month']]+=1
brk=[]
for cc,b in broker.items():
    mc=bvis.get(cc,{})
    tot=sum(mc.values())
    last=max([m for m in M if mc.get(m,0)>0],default='')
    recent2=sum(mc.get(m,0) for m in M[-2:])
    brk.append({'cp':cc,'name':b['name'],'company':b['company'],'city':b['city'],
      'owner':b['owner'],'added_by':b['added_by'],'onb':b['onb'],'total':tot,
      'last_active':last,'status':('Active' if recent2>0 else ('Stopped' if tot>0 else 'Never')),
      **{m:mc.get(m,0) for m in M}})

bundle={'months':M,'cpo_months':R['CPO_MONTHS'],
 'fm_mau':R['fm_mau'],'fm_dau':R['fm_dau'],'fm_stick':R['fm_stick'],
 'fm_cohort_ret':R['fm_cohort_ret'],'fm_perprop':R['fm_perprop'],
 'cohort':R['cohort'],'cp_owner':R['cp_owner_tbl'],'intent':R['intent_tbl'],
 'tasks_intent':R.get('tasks_intent',[]),
 'stopped':{k:R['T5'][k] for k in R['T5']},
 'brokers':brk,'visits':raw,'visits_extra':raw_extra,
 'kpi':{'total_visits':sum(x['Total visits'] for x in R['fm_mau']),
        'brokers':len(broker),'ever_active':sum(1 for b in brk if b['total']>0),
        'revisits':sum(v['revisit'] for v in raw)}}
json.dump(bundle,open('/tmp/dm_dashboard_data.json','w'),separators=(',',':'),default=str)
import os
print('bundle bytes:',os.path.getsize('/tmp/dm_dashboard_data.json'),
      '| visits',len(raw),'| extra',len(raw_extra),'| brokers',len(brk))
