"""Extract LSQ events 216/217/220 -> /tmp/dm_{booking,ats,payment}.json"""
import urllib.parse,urllib.request,json,time,os
env=dict(l.strip().split('=',1) for l in open(os.path.join(os.path.dirname(__file__),'..','.env')) if '=' in l) if os.path.exists(os.path.join(os.path.dirname(__file__),'..','.env')) else dict(LSQ_API_HOST=os.environ['LSQ_API_HOST'],LSQ_ACCESS_KEY=os.environ['LSQ_ACCESS_KEY'],LSQ_SECRET_KEY=os.environ['LSQ_SECRET_KEY'])
HOST=env['LSQ_API_HOST'];qs=urllib.parse.urlencode({'accessKey':env['LSQ_ACCESS_KEY'],'secretKey':env['LSQ_SECRET_KEY']})
def pull(ev):
 out=[];now=time.time();cur=time.mktime(time.strptime('2026-01-01','%Y-%m-%d'));ch=14*86400
 while cur<now:
  ce=min(cur+ch,now)
  b={'Parameter':{'FromDate':time.strftime('%Y-%m-%d %H:%M:%S',time.localtime(cur)),'ToDate':time.strftime('%Y-%m-%d %H:%M:%S',time.localtime(ce)),'ActivityEvent':ev,'IncludeCustomFields':1},'Paging':{'PageIndex':1,'PageSize':1000},'Sorting':{'ColumnName':'CreatedOn','Direction':'0'}}
  p=1
  while p<=20:
   b['Paging']['PageIndex']=p
   try:
    r=urllib.request.Request(f'{HOST}/v2/ProspectActivity.svc/RetrieveRecentlyModified?{qs}',method='POST',data=json.dumps(b).encode(),headers={'Content-Type':'application/json'})
    d=json.loads(urllib.request.urlopen(r,timeout=90).read())
   except Exception:
    time.sleep(3);continue
   a=d.get('ProspectActivities') or [];out.extend(a)
   if len(a)<1000:break
   p+=1;time.sleep(0.4)
  cur=ce+1
 return list({x.get('Id'):x for x in out}.values())
for ev,n in [(216,'booking'),(217,'ats'),(220,'payment')]:
 json.dump(pull(ev),open(f'/tmp/dm_{n}.json','w'),default=str);print(n,'done')
