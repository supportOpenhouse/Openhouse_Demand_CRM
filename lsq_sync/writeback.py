"""LSQ write-back: stamp mx_Migrated_To_CRM (Date) on every migrated lead (buyers + CPs).

REVERSIBLE: every executed run writes a backup JSON of the exact lead IDs it set;
`--rollback <backup.json>` clears the field (sets "") on precisely those leads.

SAFETY:
  * Refuses to run unless the field exists in LSQ (LeadsMetaData.Get).
  * --dry-run (default) writes NOTHING — resolves the target lead IDs and reports counts.
  * Idempotent: progress file records done IDs; re-runs/resume skip them.
  * Per-lead retry + failure log; never aborts the whole run on one bad lead.

Targets:
  * buyers  = unique RelatedProspectId from the cached opps (these ARE lead IDs)
  * CPs     = unique cp_code -> ProspectID resolved via Leads.Get (cached to /tmp)
"""
from __future__ import annotations
import argparse, json, os, re, time, urllib.parse, urllib.request, urllib.error
from datetime import date

CACHE = "/tmp/lsq_migration_cache.json"
CP_MAP = "/tmp/lsq_cpcode_to_leadid.json"
# Repurposed unused field 'mx_Test' (MultiSelect a/b) as the "moved to CRM" flag.
# It's 0% filled on both buyer + CP leads. Value "a" = migrated. Reversible: clear to "".
FIELD = "mx_Test"
MARK_VALUE = "a"
LSQ_ENV = os.environ.get("LSQ_ENV_PATH", "/Users/akshit.chaudhary/Documents/Claude Code/Credentials/.env")


def load_env(p):
    e = {}
    for l in open(p):
        l = l.strip()
        if l and not l.startswith("#") and "=" in l:
            k, v = l.split("=", 1); e[k.strip()] = v.strip().strip("'").strip('"')
    return e


class LSQ:
    def __init__(self):
        env = load_env(LSQ_ENV)
        self.host = env["LSQ_API_HOST"].rstrip("/")
        self.qs = urllib.parse.urlencode({"accessKey": env["LSQ_ACCESS_KEY"], "secretKey": env["LSQ_SECRET_KEY"]})

    def _call(self, path, data=None, method="GET", extra=None):
        qs = self.qs + ("&" + urllib.parse.urlencode(extra) if extra else "")
        url = f"{self.host}{path}?{qs}"
        body = json.dumps(data).encode() if data is not None else None
        for a in range(5):
            try:
                rq = urllib.request.Request(url, data=body, method=method, headers={"Content-Type": "application/json"})
                with urllib.request.urlopen(rq, timeout=60) as r:
                    return json.loads(r.read()), None
            except urllib.error.HTTPError as e:
                if e.code == 429:
                    time.sleep(2 * (a + 1)); continue
                return None, f"HTTP {e.code}: {e.read()[:140].decode(errors='replace')}"
            except Exception as e:
                time.sleep(1)
                if a == 4:
                    return None, str(e)
        return None, "retries"

    def field_exists(self):
        d, err = self._call("/v2/LeadManagement.svc/LeadsMetaData.Get")
        if err:
            return None
        flds = d if isinstance(d, list) else d.get("Fields") or []
        names = {(f.get("SchemaName") or f.get("schemaName")) for f in flds if isinstance(f, dict)}
        return FIELD in names

    def resolve_cp(self, cp_code):
        body = [{"LookupName": "mx_CP_code", "LookupValue": cp_code, "SqlOperator": "="}]
        d, err = self._call("/v2/LeadManagement.svc/Leads.Get", data={
            "Parameter": {"LookupName": "mx_CP_code", "LookupValue": cp_code}}, method="POST")
        if err or not d:
            return None
        rows = d if isinstance(d, list) else d.get("Leads") or d.get("List") or []
        if rows and isinstance(rows[0], dict):
            return rows[0].get("ProspectID") or rows[0].get("ProspectId")
        return None

    def set_field(self, lead_id, value):
        d, err = self._call("/v2/LeadManagement.svc/Lead.Update", method="POST",
                            data=[{"Attribute": FIELD, "Value": value}], extra={"leadId": lead_id})
        return err


def targets():
    cache = json.load(open(CACHE))
    buyers = sorted({o["rpid"] for o in cache["opps"] if o.get("rpid")})
    cps = sorted({o["cp_code"] for o in cache["opps"] if o.get("cp_code")})
    return buyers, cps


def resolve_cp_ids(lsq, cps, use_cache=True):
    cmap = {}
    if use_cache and os.path.exists(CP_MAP):
        cmap = json.load(open(CP_MAP))
    todo = [c for c in cps if c not in cmap]
    for i, c in enumerate(todo):
        cmap[c] = lsq.resolve_cp(c)
        if i % 100 == 0:
            json.dump(cmap, open(CP_MAP, "w")); print(f"   resolved {i}/{len(todo)} CP leads")
        time.sleep(0.12)
    json.dump(cmap, open(CP_MAP, "w"))
    return cmap


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--execute", action="store_true")
    ap.add_argument("--rollback", metavar="BACKUP_JSON")
    ap.add_argument("--value", default=MARK_VALUE)
    args = ap.parse_args()
    lsq = LSQ()
    bdir = os.path.join(os.path.dirname(__file__), "backups"); os.makedirs(bdir, exist_ok=True)

    if args.rollback:
        b = json.load(open(args.rollback))
        ids = b["written_lead_ids"]
        print(f"ROLLBACK: clearing {FIELD} on {len(ids)} leads...")
        fail = 0
        for i, lid in enumerate(ids):
            if lsq.set_field(lid, ""):
                fail += 1
            if i % 100 == 0:
                print(f"   {i}/{len(ids)}")
            time.sleep(0.1)
        print(f"rollback done. failures={fail}")
        return

    exists = lsq.field_exists()
    print(f"[precheck] field '{FIELD}' exists in LSQ: {exists}")
    buyers, cps = targets()
    print(f"[targets] buyer leads={len(buyers)}  unique CP codes={len(cps)}")

    if not exists:
        print("\nABORT: field does not exist in LSQ. Create it in LSQ admin "
              "(Settings -> Lead Fields -> Date field 'mx_Migrated_To_CRM'), then re-run.")
        return

    print("[resolve] CP codes -> lead IDs ...")
    cmap = resolve_cp_ids(lsq, cps)
    cp_ids = sorted({v for v in cmap.values() if v})
    all_ids = sorted(set(buyers) | set(cp_ids))
    print(f"[targets] buyer leads={len(buyers)}  resolved CP leads={len(cp_ids)}  TOTAL unique={len(all_ids)}")
    print(f"          CP codes unresolved: {sum(1 for v in cmap.values() if not v)}")

    if not args.execute:
        print("\nDRY-RUN: no writes. Re-run with --execute to stamp the field.")
        return

    ts = time.strftime("%Y%m%d_%H%M%S")
    prog = os.path.join(bdir, "writeback_progress.json")
    done = set(json.load(open(prog))) if os.path.exists(prog) else set()
    written, failures = [], []
    for i, lid in enumerate(all_ids):
        if lid in done:
            continue
        err = lsq.set_field(lid, args.value)
        if err:
            failures.append({"lead": lid, "err": err})
        else:
            written.append(lid); done.add(lid)
        if i % 100 == 0:
            json.dump(sorted(done), open(prog, "w"))
            print(f"   {i}/{len(all_ids)}  written={len(written)} failed={len(failures)}")
        time.sleep(0.1)
    json.dump(sorted(done), open(prog, "w"))
    bpath = os.path.join(bdir, f"writeback_{ts}.json")
    json.dump({"ts": ts, "field": FIELD, "value": args.value,
               "written_lead_ids": written, "failures": failures}, open(bpath, "w"), indent=2)
    print(f"\nEXECUTE done. written={len(written)} failed={len(failures)}")
    print(f"BACKUP (for rollback): {bpath}")


if __name__ == "__main__":
    main()
