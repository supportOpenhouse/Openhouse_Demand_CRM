"""Enrich /tmp/dm_dashboard_data.json with:
   - per-visit pipeline intent (pi): AVFU intent (pref) -> visit intent -> Unknown
   - brokers[].pis: set of pipeline intents across the broker's visits
   - lsq_funnel: per-LSQ-visit funnel record (filter-aware client-side funnel)
"""
import json, re, collections, time

B=json.load(open('/tmp/dm_dashboard_data.json'))
visits=json.load(open('/tmp/dm_visits.json'))      # 12001
avfu=json.load(open('/tmp/dm_avfu.json'))          # 221
nego=json.load(open('/tmp/dm_nego.json'))          # 215
booking=json.load(open('/tmp/dm_booking.json'))    # 216
ats=json.load(open('/tmp/dm_ats.json'))            # 217
pay=json.load(open('/tmp/dm_payment.json'))        # 220

def fld(a,k):
    for f in (a.get('Fields') or []):
        if f.get('Key')==k: return f.get('Value')
    return None
def norm(s): return re.sub(r'[^a-z0-9]+',' ',str(s or '').lower()).strip()
def mkey(s):
    s=str(s or '')[:10]; return s[:7] if re.match(r'\d{4}-\d{2}',s) else ''
def cpfromdesc(d):
    m=re.search(r'CP Code:\s*([A-Za-z0-9]+)',d or ''); return (m.group(1).strip().upper() if m else '')
def NI(v):
    v=(str(v or '').strip().title())
    return v if v in ('Hot','Warm','Cold','Dead') else 'Unknown'

# lead -> latest AVFU (by CreatedOn) intent + status
avfu_by_lead={}
for a in avfu:
    lid=a.get('RelatedProspectId');
    if not lid: continue
    co=a.get('CreatedOn') or ''
    cur=avfu_by_lead.get(lid)
    rec={'intent':fld(a,'mx_Custom_3'),'status':(fld(a,'Status') or '').strip(),'on':co}
    if (cur is None) or (co> cur['on']): avfu_by_lead[lid]=rec
lead_has_nego={a.get('RelatedProspectId') for a in nego if a.get('RelatedProspectId')}
lead_has_book={a.get('RelatedProspectId') for a in booking if a.get('RelatedProspectId')}
lead_has_ats={a.get('RelatedProspectId') for a in ats if a.get('RelatedProspectId')}
lead_has_pay={a.get('RelatedProspectId') for a in pay if a.get('RelatedProspectId')}

# lead -> count of 12001 visits (for revisit detection) + visit intent
lead_visits=collections.defaultdict(list)
for a in visits:
    lid=a.get('RelatedProspectId')
    if lid: lead_visits[lid].append(a)

# index LSQ visits by (cp, visitdate, buyer) for joining intent onto sheet visits
def vintent(a): return fld(a,'mx_Custom_24')
lsq_idx={}
for a in visits:
    cp=cpfromdesc(fld(a,'mx_Custom_5')); vd=str(fld(a,'mx_Custom_28') or '')[:10]
    by=norm(fld(a,'mx_Custom_4'))
    lsq_idx.setdefault((cp,vd,by),a)

# ---- attach pi to each sheet visit ----
def pi_for(cp,vd,buyer,lead_key):
    a=lsq_idx.get((str(cp or '').upper(),str(vd)[:10],norm(buyer)))
    lid=a.get('RelatedProspectId') if a else None
    if lid and lid in avfu_by_lead and NI(avfu_by_lead[lid]['intent'])!='Unknown':
        return NI(avfu_by_lead[lid]['intent'])
    if a and NI(vintent(a))!='Unknown': return NI(vintent(a))
    return 'Unknown'

def lsq_remarks(cp,vd,buyer):
    a=lsq_idx.get((str(cp or '').upper(),str(vd)[:10],norm(buyer)))
    if not a: return ''
    parts=[]
    for k,lbl in [('mx_Custom_36','SalesFB'),('mx_Custom_35','LatestComm')]:
        x=fld(a,k)
        if x and str(x).strip() not in ('','None','NULL'): parts.append(f'{lbl}: {str(x).strip()}')
    lid=a.get('RelatedProspectId')
    if lid in avfu_by_lead and avfu_by_lead[lid].get('status'):
        parts.append('AVFU: '+avfu_by_lead[lid]['status'])
    return ' | '.join(parts)

bro_pis=collections.defaultdict(set)
for v in B['visits']:
    p=pi_for(v.get('cp'),v.get('date'),v.get('buyer'),v.get('lead_key'))
    v['pi']=p
    lr=lsq_remarks(v.get('cp'),v.get('date'),v.get('buyer'))
    if lr:
        v['remarks']=((v.get('remarks','')+' | ') if v.get('remarks') else '')+lr
    if v.get('cp'): bro_pis[v['cp']].add(p)
for b in B['brokers']:
    b['pis']=sorted(bro_pis.get(b['cp'],[])) or ['Unknown']
# enrich VA-only extra visits with pi/remarks too (NOT fed into broker pis/spine)
for v in B.get('visits_extra',[]):
    v['pi']=pi_for(v.get('cp'),v.get('date'),v.get('buyer'),v.get('lead_key'))
    lr=lsq_remarks(v.get('cp'),v.get('date'),v.get('buyer'))
    if lr:
        v['remarks']=((v.get('remarks','')+' | ') if v.get('remarks') else '')+lr

# ---- lsq_funnel : one row per LSQ 12001 visit (since-LSQ) ----
FWD={'Revisit','Negotiation Meeting','Booking Done'}
PARK={'Follow Up','Need to Visit More Properties','Future Prospect'}
OUTS={'Not Interested'}
fun=[]
cp_owner={b['cp']:b.get('owner','Unassigned') for b in B['brokers']}
for a in visits:
    vd=str(fld(a,'mx_Custom_28') or '')[:10]; m=mkey(vd)
    if not m or m<'2026-03': continue   # LSQ era
    lid=a.get('RelatedProspectId')
    cp=cpfromdesc(fld(a,'mx_Custom_5'))
    av=avfu_by_lead.get(lid)
    intent = NI(av['intent']) if (av and NI(av['intent'])!='Unknown') else NI(vintent(a))
    st=(av['status'] if av else '')
    fun.append({
      'm':m,'city':(fld(a,'mx_Custom_15') or '').strip().title() or 'Unknown',
      'cp':cp,'owner':cp_owner.get(cp,'Unassigned'),'pi':intent,
      'avfu': 1 if av else 0,
      'st': st,
      'fwd': 1 if st in FWD else 0,
      'park': 1 if st in PARK else 0,
      'out': 1 if (st in OUTS or intent=='Dead') else 0,
      'revisit': 1 if st=='Revisit' else 0,
      'nego': 1 if (lid in lead_has_nego or st=='Negotiation Meeting') else 0,
      'booking': 1 if (lid in lead_has_book or st=='Booking Done') else 0,
      'ats': 1 if lid in lead_has_ats else 0,
      'pay': 1 if lid in lead_has_pay else 0,
    })

B['lsq_funnel']=fun
B['funnel_meta']={'sheet_unique_visits_lsqera':
   sum(1 for v in B['visits'] if v.get('month','')>='2026-03'),
   'lsq_visits_lsqera':len(fun),
   'avfu_total':len(avfu),'nego':len(nego),'booking':len(booking),'ats':len(ats),'pay':len(pay)}
try:
    ps=json.load(open('/tmp/dm_propstatus.json'))
    B['propstatus']=ps
    print('propstatus rows:',len(ps.get('rows',[])),'cols:',len(ps.get('headers',[])))
except Exception as e:
    B['propstatus']={'headers':[],'rows':[]}; print('propstatus load failed:',e)
json.dump(B,open('/tmp/dm_dashboard_data.json','w'),separators=(',',':'),default=str)
import os
print('bundle:',os.path.getsize('/tmp/dm_dashboard_data.json'),'bytes')
print('funnel rows (LSQ-era visits):',len(fun))
print('pi distribution on sheet visits:',dict(collections.Counter(v['pi'] for v in B['visits'])))
print('funnel meta:',B['funnel_meta'])
print('funnel: avfu_done',sum(x['avfu'] for x in fun),'fwd',sum(x['fwd'] for x in fun),
      'park',sum(x['park'] for x in fun),'out',sum(x['out'] for x in fun),
      'revisit',sum(x['revisit'] for x in fun),'nego',sum(x['nego'] for x in fun),
      'booking',sum(x['booking'] for x in fun))
