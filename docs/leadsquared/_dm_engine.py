"""
Demand analysis computation engine. Loads /tmp/dm_*.json caches, builds the
unified model, computes all tables, dumps /tmp/dm_results.json.

Definitions (locked with user):
- Visit month: LSQ mx_Custom_28 (visit date); sheet visit_date where status=completed.
  Unified = LSQ visits + sheet-completed visits not matched to an LSQ visit
  (dedup key cp_code|visit_date|buyer|unit-token). LSQ authoritative.
- Active broker (month) = >=1 completed visit that month.
- Revisit = 2nd+ LSQ event-12001 visit for the same buyer (RelatedProspectId), chrono.
- Negotiation/"meeting" = LSQ event-215 (Demand-Negotiation), by month.
- Broker onboarding month = broker_master.created_at; onboarder = added_by;
  CP owner = LSQ Lead Owner (cp_owner sheet 'CP owner' email -> user name).
- City from broker city; CP owner spanning >1 city => Multicity.
- Exclude Prashant Singh (prashant@openhouse.in / c61a4fb3-e7ad-11f0-...) from task-completion.
"""
import json, re, collections, datetime, sys
sys.stdout.reconfigure(line_buffering=True)

L=lambda n: json.load(open(f'/tmp/dm_{n}.json'))
visits_lsq=L('visits'); nego=L('nego'); avfu=L('avfu'); users=L('users'); tasks=L('tasks')
sv=json.load(open('/tmp/dm_sheet_visitors_data.json'))
bm=json.load(open('/tmp/dm_sheet_broker_master.json'))
cpo=json.load(open('/tmp/dm_sheet_cp_owner.json'))
prop=json.load(open('/tmp/dm_sheet_prop_master.json'))
liveinv=json.load(open('/tmp/dm_sheet_live_inv.json'))

MONTHS=[f'2025-{m:02d}' for m in range(8,13)]+[f'2026-{m:02d}' for m in range(1,6)]  # Aug25..May26
def mkey(s):
    s=str(s or '')[:10]
    return s[:7] if re.match(r'\d{4}-\d{2}',s) else None
def norm(s): return re.sub(r'[^a-z0-9]+',' ',str(s or '').lower()).strip()
def tok(s): return frozenset(t for t in norm(s).split() if t)
CITYMAP={'gurgaon':'Gurgaon','gurugram':'Gurgaon','noida':'Noida','greater noida':'Noida',
 'ghaziabad':'Ghaziabad','delhi':'Delhi','new delhi':'Delhi'}
def city_norm(c):
    c=norm(c)
    for k,v in CITYMAP.items():
        if k in c: return v
    return c.title() if c else 'Unknown'

# ---- user email->name ----
u_email={}; u_id={}
for u in users:
    nm=f"{u.get('FirstName','')} {u.get('LastName','')}".strip()
    if u.get('EmailAddress'): u_email[u['EmailAddress'].lower()]=nm
    if u.get('ID'): u_id[u['ID']]=nm
PRASHANT_EMAILS={'prashant@openhouse.in'}
PRASHANT_NAMES={'prashant singh','prashant'}

# ---- broker identity map: cp_code -> {onboard_month, added_by, city, cp_owner} ----
def fld(a,k):
    for f in (a.get('Fields') or []):
        if f.get('Key')==k: return f.get('Value')
    return None
def cp_from_desc(d):
    m=re.search(r'CP Code:\s*([A-Za-z0-9]+)',d or ''); return (m.group(1).strip().upper() if m else '')

broker={}  # cp_code -> dict
for r in bm:
    cc=str(r.get('cp_code') or '').strip().upper()
    if not cc or not cc.startswith('CP'): continue
    broker[cc]={'cp_code':cc,'onboard_m':mkey(r.get('created_at')),
                'added_by':str(r.get('added_by') or '').strip(),
                'city':city_norm(r.get('city')),'name':str(r.get('name') or '').strip(),
                'company':str(r.get('company_name') or '').strip()}
for r in cpo:
    cc=str(r.get('cp code') or '').strip().upper()
    if not cc: continue
    b=broker.setdefault(cc,{'cp_code':cc,'onboard_m':None,'added_by':'','city':'Unknown','name':'','company':''})
    em=str(r.get('CP owner') or '').strip().lower()
    b['cp_owner']=u_email.get(em, em or 'Unassigned')
    if b.get('city') in (None,'Unknown') and r.get('city'): b['city']=city_norm(r.get('city'))
    if not b.get('added_by') and r.get('added by'): b['added_by']=str(r.get('added by')).strip()
for b in broker.values(): b.setdefault('cp_owner','Unassigned')

# ---- unified visits : SHEET completed visits = the complete spine ----
# (LSQ is a downstream mirror of the visits sheet, confirmed ~1:1 per month;
#  the sheet also carries the full pre-LSQ history. So we count from the sheet.)
V=[]
for r in sv:
    if str(r.get('status','')).strip().lower()!='completed': continue
    vd=str(r.get('visit_date') or '')[:10]; m=mkey(vd)
    if not m: continue
    cc=str(r.get('cp_code') or '').strip().upper()
    city=city_norm(r.get('city') or (broker.get(cc,{}) or {}).get('city'))
    V.append({'cp':cc if cc.startswith('CP') else '','m':m,
              'buyer':norm(r.get('buyer_name')),'unit':tok(r.get('unit_address_line1')),
              'city':city,'sm':str(r.get('sales_manager') or '').strip(),'src':'SHEET',
              'pid':str(r.get('lead_key') or ''),'vdate':vd,
              'occ':str(r.get('lead_occurrence_count') or '1')})
sheet_only=len(V)
lsq_match=sum(1 for a in visits_lsq if str(fld(a,'mx_Custom_28') or '')[:10])  # for diag only

# ---- revisits: 2nd+ completed visit for same buyer (lead_key), chrono ----
byb=collections.defaultdict(list)
for v in V:
    if v['pid']: byb[v['pid']].append(v)
revisit_rows=[]
for pid,lst in byb.items():
    lst.sort(key=lambda x:x['vdate'])
    for v in lst[1:]:
        revisit_rows.append({'cp':v['cp'],'m':v['m'],'city':v['city']})

# ---- negotiations (event 215) ----
nego_rows=[]
for a in nego:
    vd=str(fld(a,'mx_Custom_28') or a.get('CreatedOn') or '')[:10]
    cc=cp_from_desc(fld(a,'mx_Custom_5'))
    nego_rows.append({'cp':cc,'m':mkey(vd),
        'city':city_norm(fld(a,'mx_Custom_15') or (broker.get(cc,{}) or {}).get('city'))})

# ===== helpers for monthly aggregation =====
def monthly_counts(rows, keyf):
    """rows-> {key: {month: count}}"""
    d=collections.defaultdict(lambda: collections.Counter())
    for r in rows:
        k=keyf(r)
        if k is None or not r.get('m'): continue
        d[k][r['m']]+=1
    return d

# ===== TABLE SET A: Broker-level (per cp_code) =====
def broker_meta(cc):
    b=broker.get(cc) or {}
    return (b.get('name','') , b.get('company',''), cc, b.get('cp_owner','Unassigned'),
            b.get('onboard_m',''), b.get('city','Unknown'))

vis_by_cp=monthly_counts([v for v in V if v['cp']], lambda r:r['cp'])
rev_by_cp=monthly_counts([r for r in revisit_rows if r['cp']], lambda r:r['cp'])
neg_by_cp=monthly_counts([r for r in nego_rows if r['cp']], lambda r:r['cp'])

def broker_table(src):
    out=[]
    for cc,mc in src.items():
        nm,co,cp,own,onm,city=broker_meta(cc)
        row={'Broker':nm,'Company':co,'CP Code':cp,'CP Owner':own,'Onboarding':onm,'City':city}
        for m in MONTHS: row[m]=mc.get(m,0)
        row['Total']=sum(mc.get(m,0) for m in MONTHS)
        out.append(row)
    return sorted(out,key=lambda x:(x['City'],-x['Total']))

T1=broker_table(vis_by_cp)      # MoM visits
T2=broker_table(rev_by_cp)      # MoM revisits
T3=broker_table(neg_by_cp)      # MoM negotiations
# T4: last 3 months trend combined
L3=MONTHS[-3:]
T4=[]
for cc in set(list(vis_by_cp)+list(rev_by_cp)+list(neg_by_cp)):
    nm,co,cp,own,onm,city=broker_meta(cc)
    r={'Broker':nm,'Company':co,'CP Code':cp,'CP Owner':own,'City':city}
    for m in L3:
        r[f'Visits {m}']=vis_by_cp.get(cc,{}).get(m,0)
        r[f'Revisits {m}']=rev_by_cp.get(cc,{}).get(m,0)
        r[f'Nego {m}']=neg_by_cp.get(cc,{}).get(m,0)
    r['Visits L3']=sum(vis_by_cp.get(cc,{}).get(m,0) for m in L3)
    T4.append(r)
T4=sorted(T4,key=lambda x:(x['City'],-x['Visits L3']))
# T5: brokers who used to give visits but stopped (1/2/3-month thresholds)
cur=MONTHS[-1]
def stopped(thr):
    res=[]
    last=MONTHS[-thr:]
    for cc,mc in vis_by_cp.items():
        tot=sum(mc.get(m,0) for m in MONTHS)
        recent=sum(mc.get(m,0) for m in last)
        if tot>0 and recent==0:
            nm,co,cp,own,onm,city=broker_meta(cc)
            lastm=max([m for m in MONTHS if mc.get(m,0)>0], default='')
            res.append({'Broker':nm,'Company':co,'CP Code':cp,'CP Owner':own,'City':city,
                        'Onboarding':onm,'Last active':lastm,'Lifetime visits':tot})
    return sorted(res,key=lambda x:(x['City'],-x['Lifetime visits']))
T5={f'{t}m':stopped(t) for t in (1,2,3)}

# ===== TABLE SET B: Cohorts (onboarding month) =====
cp_onm={cc:(broker.get(cc,{}) or {}).get('onboard_m') for cc in broker}
cohort_months=[m for m in MONTHS]  # Aug25..May26
# visits per cp per month already in vis_by_cp
cohort=[]
for com in cohort_months:
    cohort_cps=[cc for cc,o in cp_onm.items() if o==com]
    if not cohort_cps: continue
    rowV={'Cohort':com,'Brokers onboarded':len(cohort_cps),'Metric':'Visits'}
    rowU={'Cohort':com,'Brokers onboarded':len(cohort_cps),'Metric':'Unique active brokers'}
    rowA={'Cohort':com,'Brokers onboarded':len(cohort_cps),'Metric':'Active %'}
    for m in MONTHS:
        vis=sum(vis_by_cp.get(cc,{}).get(m,0) for cc in cohort_cps)
        act=sum(1 for cc in cohort_cps if vis_by_cp.get(cc,{}).get(m,0)>0)
        rowV[m]=vis; rowU[m]=act
        rowA[m]=round(100*act/len(cohort_cps),1) if cohort_cps else 0
    cohort+= [rowV,rowU,rowA]

# ===== founder metrics =====
# MAU = distinct active brokers / month ; visits/active broker ; retention
active_by_m={m:set() for m in MONTHS}
visits_by_m={m:0 for m in MONTHS}
for cc,mc in vis_by_cp.items():
    for m in MONTHS:
        if mc.get(m,0)>0: active_by_m[m].add(cc); visits_by_m[m]+=mc[m]
fm_mau=[{'Month':m,'MAU (active brokers)':len(active_by_m[m]),
         'Total visits':visits_by_m[m],
         'Visits / active broker':round(visits_by_m[m]/len(active_by_m[m]),2) if active_by_m[m] else 0}
        for m in MONTHS]
# DAU: distinct brokers per visit-day, avg per month
day_b=collections.defaultdict(set)
for v in V:
    if v['cp'] and v.get('vdate'): day_b[v['vdate']].add(v['cp'])
dau_m=collections.defaultdict(list)
for d,bset in day_b.items():
    mm=mkey(d)
    if mm: dau_m[mm].append(len(bset))
fm_dau=[{'Month':m,'Avg DAU (brokers/active day)':round(sum(dau_m[m])/len(dau_m[m]),2) if dau_m.get(m) else 0,
         'Active days':len(dau_m.get(m,[]))} for m in MONTHS]
# MoM carryover stickiness
fm_stick=[]
for i in range(1,len(MONTHS)):
    a,b=MONTHS[i-1],MONTHS[i]
    prev=active_by_m[a]; keep=len(prev & active_by_m[b])
    fm_stick.append({'From':a,'To':b,'Active prev':len(prev),'Retained':keep,
                     'Stickiness %':round(100*keep/len(prev),1) if prev else 0})
# cohort retention triangle (by onboarding month)
fm_cohort_ret=[]
for com in cohort_months:
    cps=[cc for cc,o in cp_onm.items() if o==com]
    if not cps: continue
    row={'Cohort':com,'Size':len(cps)}
    for j,m in enumerate(MONTHS):
        if m<com: row[f'M{j}']=''
        else:
            act=sum(1 for cc in cps if vis_by_cp.get(cc,{}).get(m,0)>0)
            row[m]=round(100*act/len(cps),1)
    fm_cohort_ret.append(row)
# visits per live property (historic from prop master: live window = AMA->Booking/Registry)
def pdate(r,*ks):
    for k in ks:
        v=str(r.get(k) or '').strip()
        if v and v not in ('None','-'):
            for fmt in ('%Y-%m-%d','%d-%b-%Y','%d/%m/%Y','%m/%d/%Y','%d-%b-%y'):
                try: return datetime.datetime.strptime(v[:11].strip(),fmt).strftime('%Y-%m')
                except: pass
    return None
live_by_m={m:0 for m in MONTHS}
for r in prop:
    start=pdate(r,'Date AMA','Key Handover')
    end=pdate(r,'Registry Date','Booking Date') or '2099-12'
    if not start: continue
    for m in MONTHS:
        if start<=m<=end: live_by_m[m]+=1
fm_perprop=[{'Month':m,'Total visits':visits_by_m[m],'Live properties':live_by_m[m],
             'Visits / live property':round(visits_by_m[m]/live_by_m[m],2) if live_by_m[m] else 0}
            for m in MONTHS]

# ===== CP-owner view (Jan2026+), city subgroup, exclude Prashant in tasks =====
CPO_MONTHS=[m for m in MONTHS if m>='2026-01']
# onboarding by added_by (onboarder)
onb=collections.defaultdict(lambda: collections.Counter())
for cc,b in broker.items():
    if b.get('onboard_m') in CPO_MONTHS and b.get('added_by'):
        onb[b['added_by']][b['onboard_m']]+=1
# active CPs & visits by CP owner (Lead Owner)
own_active=collections.defaultdict(lambda: collections.defaultdict(set))
own_vis=collections.defaultdict(lambda: collections.Counter())
own_city=collections.defaultdict(collections.Counter)
for cc,mc in vis_by_cp.items():
    own=(broker.get(cc,{}) or {}).get('cp_owner','Unassigned')
    cty=(broker.get(cc,{}) or {}).get('city','Unknown')
    for m in CPO_MONTHS:
        if mc.get(m,0)>0:
            own_active[own][m].add(cc); own_vis[own][m]+=mc[m]; own_city[own][cty]+=1
def owner_city(o):
    cs=[c for c,_ in own_city[o].most_common()]
    return 'Multicity' if len(cs)>1 else (cs[0] if cs else 'Unknown')
cp_owner_tbl=[]
for o in set(list(onb)+list(own_vis)):
    r={'CP Owner':o,'City':owner_city(o)}
    for m in CPO_MONTHS:
        r[f'Onboarded {m}']=onb.get(o,{}).get(m,0)
        r[f'Active CPs {m}']=len(own_active.get(o,{}).get(m,set()))
        r[f'Visits {m}']=own_vis.get(o,{}).get(m,0)
    r['Total visits']=sum(own_vis.get(o,{}).get(m,0) for m in CPO_MONTHS)
    cp_owner_tbl.append(r)
cp_owner_tbl=sorted(cp_owner_tbl,key=lambda x:(x['City'],-x['Total visits']))

# task-intent: completed by owner (exclude Prashant), since LSQ (2026-03-20)
LSQ_START='2026-03-20'
def is_prashant(nm,em):
    return (str(nm or '').strip().lower() in PRASHANT_NAMES) or (str(em or '').strip().lower() in PRASHANT_EMAILS)
ti=collections.defaultdict(lambda: collections.Counter())
for t in tasks:
    if t['sc']!=1: continue
    comp=str(t.get('completed') or '')[:10]
    if not comp: continue
    own=t.get('owner') or ''
    ownem=t.get('owner_email') or ''
    if is_prashant(t.get('completer'),'') : continue   # completed by Prashant -> exclude
    key=own
    tt=t['type']
    if tt=='Buyer- After Visit Follow Up' and comp>=LSQ_START: ti[key]['AVFU done']+=1
    elif tt=='Buyer- Re-Visit Follow Up' and comp>=LSQ_START: ti[key]['Revisit task done']+=1
    elif tt=='Buyer- Negotiations' and comp>=LSQ_START: ti[key]['Nego task done']+=1
    elif tt=='Regular Interaction Call -CP':
        # last 3 weeks only
        if comp>= (datetime.date.today()-datetime.timedelta(days=21)).strftime('%Y-%m-%d'):
            ti[key]['RegInteraction done (3w)']+=1
# created counts (visit-date / created in-period) for ratio
tc=collections.defaultdict(lambda: collections.Counter())
for t in tasks:
    cr=str(t.get('created') or '')[:10]
    own=t.get('owner') or ''
    tt=t['type']
    if cr and cr>=LSQ_START:
        if tt=='Buyer- After Visit Follow Up': tc[own]['AVFU created']+=1
        elif tt=='Buyer- Re-Visit Follow Up': tc[own]['Revisit created']+=1
        elif tt=='Buyer- Negotiations': tc[own]['Nego created']+=1
    if tt=='Regular Interaction Call -CP' and cr>=(datetime.date.today()-datetime.timedelta(days=21)).strftime('%Y-%m-%d'):
        tc[own]['RegInteraction created (3w)']+=1
intent_tbl=[]
for o in set(list(ti)+list(tc)):
    nm=o
    cty=owner_city(o) if o in own_city else 'Unknown'
    r={'CP Owner':nm,'City':cty}
    r.update({k:ti[o].get(k,0) for k in ['AVFU done','Revisit task done','Nego task done','RegInteraction done (3w)']})
    r.update({k:tc[o].get(k,0) for k in ['AVFU created','Revisit created','Nego created','RegInteraction created (3w)']})
    r['AVFU completion %']=round(100*r['AVFU done']/r['AVFU created'],1) if r['AVFU created'] else 0
    intent_tbl.append(r)
intent_tbl=sorted(intent_tbl,key=lambda x:(x['City'],-x['AVFU done']))

# tasks_intent: per-task records for client-side date filtering on Owners tab.
# Same scope/rules as intent_tbl (since LSQ_START, exclude Prashant-completed for done counts).
_TY_CODE={'Buyer- After Visit Follow Up':'a','Buyer- Re-Visit Follow Up':'r',
          'Buyer- Negotiations':'n','Regular Interaction Call -CP':'g'}
tasks_intent=[]
for t in tasks:
    tt=t.get('type')
    if tt not in _TY_CODE: continue
    own=t.get('owner') or ''
    if not own: continue
    cre=(str(t.get('created') or '')[:10])
    comp=(str(t.get('completed') or '')[:10])
    if (not cre or cre<LSQ_START) and (not comp or comp<LSQ_START): continue
    tasks_intent.append({
        'o':own,'t':_TY_CODE[tt],'s':int(t.get('sc') or 0),
        'c':cre,'d':comp,
        'p':1 if is_prashant(t.get('completer'),'') else 0,
    })

results={'MONTHS':MONTHS,'CPO_MONTHS':CPO_MONTHS,
 'diag':{'lsq_visits':len(visits_lsq),'sheet_only_visits':sheet_only,'unified_visits':len(V),
   'revisits':len(revisit_rows),'nego':len(nego_rows),'brokers':len(broker),
   'visits_by_month':visits_by_m,'active_by_month':{m:len(active_by_m[m]) for m in MONTHS}},
 'T1':T1,'T2':T2,'T3':T3,'T4':T4,'T5':T5,'cohort':cohort,
 'fm_mau':fm_mau,'fm_dau':fm_dau,'fm_stick':fm_stick,'fm_cohort_ret':fm_cohort_ret,
 'fm_perprop':fm_perprop,'cp_owner_tbl':cp_owner_tbl,'intent_tbl':intent_tbl,
 'tasks_intent':tasks_intent}
json.dump(results,open('/tmp/dm_results.json','w'),default=str)
print('ENGINE DONE')
print('diag:',json.dumps(results['diag'],indent=1,default=str)[:1200])
print('T1 rows',len(T1),'T2',len(T2),'T3',len(T3),'T4',len(T4),
      'T5',{k:len(v) for k,v in T5.items()},'cohort',len(cohort),
      'cp_owner',len(cp_owner_tbl),'intent',len(intent_tbl))
