"""
Cloud Run Job entrypoint — LSQ Demand Dashboard refresh.

Runs AS the Cloud Run job's service account (sqlanalytics@…). No key file:
Google access = Application Default Credentials (ADC). LSQ keys come from env
(mounted from Secret Manager). Output = a PRIVATE GCS object the Netlify
data function reads at runtime (no Netlify redeploy).

env (set by deploy.sh / Cloud Run job):
  MODE = hourly | daily
  LSQ_ACCESS_KEY, LSQ_SECRET_KEY, LSQ_API_HOST   (from Secret Manager)
  GCS_BUCKET            e.g. oh-lsq-dashboard-data
  GCS_BUNDLE_OBJECT     default dm_bundle.json.gz
  GCS_CACHES_OBJECT     default dm_caches.tgz

hourly: pull caches obj -> refresh light (sheets + event-12001 + propstatus)
        -> engine/dashdata/enrich -> upload bundle obj            (~4 min)
daily : full extract (incl. ~30-min task scan) + 215/216/217/220/221
        -> engine/dashdata/enrich -> upload bundle + caches obj   (~50 min)
"""
import os, sys, io, gzip, tarfile, subprocess, time
from google.cloud import storage   # google-cloud-storage; ADC on Cloud Run

ROOT = '/app'                      # project copied here in the image
MODE = os.environ.get('MODE','hourly')
BUCKET = os.environ['GCS_BUCKET']
B_OBJ = os.environ.get('GCS_BUNDLE_OBJECT','dm_bundle.json.gz')
C_OBJ = os.environ.get('GCS_CACHES_OBJECT','dm_caches.tgz')
HEAVY = ['dm_visits','dm_nego','dm_avfu','dm_booking','dm_ats','dm_payment','dm_users',
         'dm_tasks','dm_sheet_visitors_data','dm_sheet_broker_master','dm_sheet_visit_form',
         'dm_sheet_prop_master','dm_sheet_live_inv','dm_sheet_cp_owner','dm_propstatus']

def sh(script):
    print(f'> {script}', flush=True)
    subprocess.run([sys.executable, os.path.join(ROOT, script)], check=True, cwd=ROOT)

def gcs():
    return storage.Client()        # ADC = job's service account

def put(obj, data: bytes):
    gcs().bucket(BUCKET).blob(obj).upload_from_string(data)
    print(f'uploaded gs://{BUCKET}/{obj} ({len(data)} bytes)', flush=True)

def get(obj) -> bytes:
    return gcs().bucket(BUCKET).blob(obj).download_as_bytes()

def pack():
    buf=io.BytesIO()
    with tarfile.open(fileobj=buf,mode='w:gz') as t:
        for n in HEAVY:
            p=f'/tmp/{n}.json'
            if os.path.exists(p): t.add(p, arcname=os.path.basename(p))
    return buf.getvalue()

def main():
    t0=time.time()
    if MODE=='daily':
        sh('_dm_extract_lsq.py')                 # SLOW full incl. tasks
        sh('automation/_dm_extract_events.py')   # 216/217/220
        sh('automation/_dm_extract_sheets_adc.py')
        sh('automation/_dm_extract_propstatus.py')
    else:  # hourly
        with tarfile.open(fileobj=io.BytesIO(get(C_OBJ)),mode='r:gz') as t: t.extractall('/tmp')
        sh('automation/_dm_extract_sheets_adc.py')
        sh('automation/_dm_extract_visits_only.py')
        sh('automation/_dm_extract_propstatus.py')
    sh('_dm_engine.py'); sh('_dm_dashdata.py'); sh('_dm_enrich.py')
    gz=gzip.compress(open('/tmp/dm_dashboard_data.json','rb').read(),6)
    put(B_OBJ, gz)
    if MODE=='daily': put(C_OBJ, pack())
    print(f'OK {MODE} in {int(time.time()-t0)}s', flush=True)

if __name__=='__main__': main()
