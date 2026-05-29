"""
LSQ Demand Dashboard — automated refresh pipeline.

Modes:
  --mode daily   : full extract (incl. ~30-min task scan) + 215/216/217/220/221 + sheets
                   + property-status -> engine/dashdata/enrich -> upload bundle.gz + caches.tgz
  --mode hourly  : download caches.tgz (from last daily) -> refresh ONLY light caches
                   (Visitors sheet, LSQ event-12001, Property-Status) -> engine/dashdata/
                   enrich -> upload bundle.gz   (~3-4 min; NO Netlify redeploy)
  --init-drive   : create the two Drive files (bundle.gz, caches.tgz) and print their ids

Secrets / env (GitHub Actions secrets, or local .env for dev):
  LSQ_ACCESS_KEY, LSQ_SECRET_KEY, LSQ_API_HOST
  GS_SA_JSON                (full service-account JSON string)  — or local SA_PATH for dev
  DRIVE_BUNDLE_FILE_ID      (Drive file id serving /tmp/dm_dashboard_data.json gz)
  DRIVE_CACHES_FILE_ID      (Drive file id holding tgz of /tmp/dm_*.json heavy caches)

data.mjs on Netlify downloads DRIVE_BUNDLE_FILE_ID at runtime (15-min cache) — so refreshing
the Drive file = fresh dashboard data with zero Netlify redeploys.

NOTE: this orchestrator reuses the existing _dm_*.py scripts unchanged. It is scaffolded and
documented; first end-to-end run happens once the GitHub repo + secrets + Drive files exist.
"""
import os, sys, json, subprocess, tarfile, io, gzip, time, argparse, glob, tempfile
from google.oauth2.service_account import Credentials
from googleapiclient.discovery import build
from googleapiclient.http import MediaIoBaseUpload, MediaIoBaseDownload

HERE = os.path.dirname(os.path.abspath(__file__))
SA_PATH = os.environ.get('SA_PATH',
  '/Users/akshit.chaudhary/Documents/Claude Code/Property level report/credentials/service_account.json')
HEAVY = ['dm_visits','dm_nego','dm_avfu','dm_booking','dm_ats','dm_payment','dm_users','dm_tasks',
         'dm_sheet_visitors_data','dm_sheet_broker_master','dm_sheet_visit_form',
         'dm_sheet_prop_master','dm_sheet_live_inv','dm_sheet_cp_owner','dm_propstatus']

def sa_creds():
    j = os.environ.get('GS_SA_JSON')
    scopes = ['https://www.googleapis.com/auth/drive','https://www.googleapis.com/auth/spreadsheets']
    if j:
        return Credentials.from_service_account_info(json.loads(j), scopes=scopes)
    return Credentials.from_service_account_file(SA_PATH, scopes=scopes)

def drive():
    return build('drive','v3',credentials=sa_creds())

def drive_create(name):
    d=drive()
    f=d.files().create(body={'name':name,'mimeType':'application/octet-stream'},
                        media_body=MediaIoBaseUpload(io.BytesIO(b'{}'),mimetype='application/octet-stream'),
                        fields='id').execute()
    return f['id']

def drive_upload(file_id, data: bytes):
    d=drive()
    d.files().update(fileId=file_id,
        media_body=MediaIoBaseUpload(io.BytesIO(data),mimetype='application/octet-stream',resumable=True)).execute()

def drive_download(file_id) -> bytes:
    d=drive(); req=d.files().get_media(fileId=file_id)
    buf=io.BytesIO(); dl=MediaIoBaseDownload(buf,req)
    done=False
    while not done: _,done=dl.next_chunk()
    return buf.getvalue()

def run(script, *args):
    print(f'  > {script} {" ".join(args)}', flush=True)
    subprocess.run([sys.executable, os.path.join(HERE,script), *args], check=True, cwd=HERE)

def extract_light():
    """Refresh only fast caches: all sheets + LSQ event-12001 + property-status."""
    run('_dm_extract_sheets.py')
    # event-12001 only (fast); reuse the inline pattern from _dm_extract_lsq via a tiny helper
    run('_dm_extract_visits_only.py')          # see automation/ helper (event 12001)
    run('_dm_extract_propstatus.py')           # property-ageing 'Property Status' tab

def extract_full():
    run('_dm_extract_lsq.py')                  # SLOW: visits/215/221/users/tasks (~30 min)
    run('_dm_extract_events.py')               # 216/217/220
    run('_dm_extract_sheets.py')
    run('_dm_extract_propstatus.py')

def build_bundle():
    run('_dm_engine.py'); run('_dm_dashdata.py'); run('_dm_enrich.py')
    raw=open('/tmp/dm_dashboard_data.json','rb').read()
    return gzip.compress(raw, 6)

def pack_caches() -> bytes:
    buf=io.BytesIO()
    with tarfile.open(fileobj=buf,mode='w:gz') as t:
        for n in HEAVY:
            p=f'/tmp/{n}.json'
            if os.path.exists(p): t.add(p, arcname=os.path.basename(p))
    return buf.getvalue()

def unpack_caches(data: bytes):
    with tarfile.open(fileobj=io.BytesIO(data),mode='r:gz') as t:
        t.extractall('/tmp')

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument('--mode',choices=['hourly','daily'])
    ap.add_argument('--init-drive',action='store_true')
    a=ap.parse_args()
    if a.init_drive:
        b=drive_create('dm_bundle.json.gz'); c=drive_create('dm_caches.tgz')
        print('DRIVE_BUNDLE_FILE_ID=',b); print('DRIVE_CACHES_FILE_ID=',c); return
    BID=os.environ['DRIVE_BUNDLE_FILE_ID']; CID=os.environ['DRIVE_CACHES_FILE_ID']
    t0=time.time()
    if a.mode=='daily':
        print('[daily] full extract...'); extract_full()
        gz=build_bundle()
        drive_upload(BID,gz); drive_upload(CID,pack_caches())
    else:
        print('[hourly] pulling caches.tgz from last daily...')
        unpack_caches(drive_download(CID))
        extract_light()
        gz=build_bundle()
        drive_upload(BID,gz)
    print(f'done in {int(time.time()-t0)}s; bundle {len(gz)} bytes -> Drive {BID}')

if __name__=='__main__': main()
