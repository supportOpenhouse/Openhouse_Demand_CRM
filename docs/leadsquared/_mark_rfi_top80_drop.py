"""
Mark complete the RFI tasks that fell outside the per-owner quota
(per snapshots/rfi_top80_drop_tasks.json).
Resumable: tracks completed task IDs in done file.
"""
import urllib.parse, urllib.request, json, sys, time, os

sys.stdout.reconfigure(line_buffering=True)
TS = lambda: time.strftime('%H:%M:%S')

env = dict(l.strip().split('=', 1) for l in open('.env') if '=' in l)
HOST = env['LSQ_API_HOST']
AUTH = {'accessKey': env['LSQ_ACCESS_KEY'], 'secretKey': env['LSQ_SECRET_KEY']}

INPUT = 'snapshots/rfi_top80_drop_tasks.json'
DONE_LOG = 'snapshots/rfi_top80_done.txt'
FAIL_LOG = 'snapshots/rfi_top80_fail.jsonl'

# Resume support
done_set = set()
if os.path.exists(DONE_LOG):
    with open(DONE_LOG) as f:
        for line in f:
            done_set.add(line.strip())
    print(f"[{TS()}] Resume: {len(done_set)} already-completed task IDs found")

targets = json.load(open(INPUT))
print(f"[{TS()}] Total drop targets: {len(targets)}")
remaining = [t for t in targets if t['task_id'] not in done_set]
print(f"[{TS()}] Remaining to process: {len(remaining)}")
if not remaining:
    print(f"[{TS()}] Nothing to do.")
    sys.exit(0)


def mark_complete(task_id, retries=2):
    qs = urllib.parse.urlencode({**AUTH, 'id': task_id})
    url = f"{HOST}/v2/Task.svc/MarkComplete?{qs}"
    for a in range(retries + 1):
        try:
            with urllib.request.urlopen(url, timeout=20) as r:
                return json.loads(r.read()), None
        except urllib.error.HTTPError as e:
            if e.code == 429 and a < retries: time.sleep(2 ** a); continue
            try: msg = e.read().decode()[:200]
            except: msg = ''
            return None, f"HTTP {e.code}: {msg}"
        except Exception as e:
            return None, f"{type(e).__name__}: {e}"
    return None, "exhausted"


ok = 0
fail = 0
start = time.time()
done_fh = open(DONE_LOG, 'a')
fail_fh = open(FAIL_LOG, 'a')

print(f"\n[{TS()}] Starting mark-complete loop...")
try:
    for i, t in enumerate(remaining, 1):
        tid = t['task_id']
        res, err = mark_complete(tid)
        if err:
            fail += 1
            fail_fh.write(json.dumps({**t, 'error': err, 'ts': time.strftime('%Y-%m-%d %H:%M:%S')}) + '\n')
            fail_fh.flush()
        else:
            ok += 1
            done_fh.write(tid + '\n')
            done_fh.flush()
        if i % 100 == 0:
            elapsed = time.time() - start
            rate = i / max(1, elapsed)
            eta = (len(remaining) - i) / max(0.1, rate)
            print(f"  [{TS()}] {i}/{len(remaining)}  ok={ok}  fail={fail}  rate={rate:.1f}/s  eta={int(eta)}s ({int(eta/60)}m)")
        time.sleep(0.27)
except KeyboardInterrupt:
    print(f"\n[{TS()}] Interrupted. Resume by re-running.")
finally:
    done_fh.close()
    fail_fh.close()

print(f"\n[{TS()}] === DROP-BATCH DONE ===")
print(f"  Processed this run:  {ok + fail}")
print(f"  Success this run:    {ok}")
print(f"  Failed this run:     {fail}")
print(f"  See {DONE_LOG} for cumulative success log")
