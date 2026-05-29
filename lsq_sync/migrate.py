"""One-shot LeadSquared -> Demand CRM migration.

WHAT IT DOES
  Pulls the LSQ demand pipeline (Opportunity event 12001 = the "visit", plus the
  sparse activity history 221/215/216/217/218/220) and lands it in the CRM Neon DB:
    * enriches matched visits with the LIVE stage/status from the opportunity
    * inserts the few opps that have no matching sheet visit
    * loads activity history into `followups` (idempotent on lsq_activity_id)
    * backfills lsq ids on users/brokers/buyers
    * creates inactive users for genuine ex-RMs; a ghost user for junk owners
  It does NOT touch buyer phone columns (per decision) and does NOT write to LSQ.
  The LSQ write-back of mx_Migrated_To_CRM is a SEPARATE, separately-gated phase.

MODES
  --dry-run  (default) : reads only. Writes nothing to LSQ or the DB. Prints the
                         exact projected changes + a JSON report to /tmp.
  --execute            : performs the DB writes inside one transaction.
  --use-cache          : reuse /tmp/lsq_migration_cache.json instead of re-crawling.

Matching key: cp_code + visit_date, disambiguated by buyer first-name.
(99.6% of opps match an existing sheet visit — see docs/LSQ_HANDOVER.md + discovery.)
"""
from __future__ import annotations
import argparse, json, os, re, sys, time, urllib.parse, urllib.request, urllib.error
from collections import defaultdict, Counter
from datetime import datetime, timedelta

CACHE = "/tmp/lsq_migration_cache.json"
REPORT = "/tmp/lsq_migration_report.json"
LSQ_ENV = os.environ.get("LSQ_ENV_PATH", "/Users/akshit.chaudhary/Documents/Claude Code/Credentials/.env")
CRM_ENV = os.environ.get("CRM_ENV_PATH", "/Users/akshit.chaudhary/Documents/Claude Code/Demand CRM/.env")
CRAWL_START = datetime(2025, 1, 1)

# LSQ Opportunity Stage (mx_Custom_2) -> canonical CRM stage
STAGE_MAP = {
    "visited": "avfu",
    "not interested after visit": "not_interested",
    "need to see more properties": "need_more",
    "future prospect": "future_prospect",
    "revisit scheduled": "revisit_scheduled",
    "negotiation meeting scheduled": "negotiation",
    "negotiation meeting done": "negotiation",
    "booking done": "booking",
    "ats executed": "ats",
    "registry done": "ats",
    "duplicate/invalid lead": "cancelled",
    "": "avfu",
}
STATUS_MAP = {"hot": "hot", "warm": "warm", "cold": "cold", "dead": "dead", "": "unc"}
VALID_STATUS = {"hot", "warm", "cold", "dead", "future_prospect", "unc"}
# activity event code -> canonical stage / which mx field holds each value.
# (Field meanings differ PER activity — see snapshots/activity_schemas.md.)
ACT_STAGE = {221: "avfu", 215: "negotiation", 216: "booking", 217: "ats", 218: "need_more", 220: "ats"}
ACT_STATUS_FIELD = {221: "mx_Custom_3", 215: "mx_Custom_4", 216: "mx_Custom_9", 220: "mx_Custom_2"}
ACT_NEXTFU_FIELD = {221: "mx_Custom_1", 215: "mx_Custom_1", 216: "mx_Custom_6", 217: "mx_Custom_4", 220: "mx_Custom_1"}
ACT_REVISIT_FIELD = {221: "mx_Custom_2"}  # only AVFU carries a revisit date


def load_env(path):
    e = {}
    for line in open(path):
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            e[k.strip()] = v.strip().strip("'").strip('"')
    return e


# --------------------------------------------------------------------------- LSQ
class LSQ:
    def __init__(self, env):
        self.host = env["LSQ_API_HOST"].rstrip("/")
        self.qs = urllib.parse.urlencode({"accessKey": env["LSQ_ACCESS_KEY"], "secretKey": env["LSQ_SECRET_KEY"]})
        self.fmt = "%Y-%m-%d %H:%M:%S"

    def _req(self, url, data=None, method="GET"):
        rq = urllib.request.Request(url, data=data, method=method, headers={"Content-Type": "application/json"})
        for a in range(5):
            try:
                with urllib.request.urlopen(rq, timeout=120) as r:
                    return json.loads(r.read()), None
            except urllib.error.HTTPError as e:
                if e.code == 429:
                    time.sleep(2 * (a + 1)); continue
                return None, f"HTTP {e.code}: {e.read()[:160].decode(errors='replace')}"
            except Exception as e:
                time.sleep(1)
                if a == 4:
                    return None, str(e)
        return None, "retries exhausted"

    def post(self, path, body):
        return self._req(f"{self.host}{path}?{self.qs}", json.dumps(body).encode(), "POST")

    def users(self):
        d, err = self._req(f"{self.host}/v2/UserManagement.svc/Users.Get?{self.qs}", method="GET")
        if err:
            print("  WARN Users.Get:", err); return []
        return d if isinstance(d, list) else d.get("Users") or d.get("List") or []

    def crawl_event(self, event):
        """All-time crawl of an activity/opportunity event in 14-day windows."""
        out, seen = [], set()
        cur, end = CRAWL_START, datetime.now()
        while cur < end:
            nxt = min(cur + timedelta(days=14), end)
            for page in range(1, 25):
                body = {"Parameter": {"FromDate": cur.strftime(self.fmt), "ToDate": nxt.strftime(self.fmt),
                                      "ActivityEvent": event, "IncludeCustomFields": 1},
                        "Paging": {"PageIndex": page, "PageSize": 1000},
                        "Sorting": {"ColumnName": "CreatedOn", "Direction": "1"}}
                d, err = self.post("/v2/ProspectActivity.svc/RetrieveRecentlyModified", body)
                if err:
                    print(f"  WARN ev{event} {cur.date()} p{page}: {err}"); break
                rows = d.get("ProspectActivities") or []
                for r in rows:
                    if r.get("Id") in seen:
                        continue
                    seen.add(r.get("Id"))
                    out.append(r)
                if len(rows) < 1000:
                    break
                time.sleep(0.2)
            cur = nxt
        return out


def fields(row):
    fm = {}
    for f in row.get("Fields", []) or []:
        fm[f.get("Key")] = f.get("Value")
    for f in row.get("Data", []) or []:
        fm["d:" + str(f.get("Key"))] = f.get("Value")
    return fm


CPRE = re.compile(r"CP\s*Code\s*:\s*([A-Za-z0-9]+)", re.I)


def parse_opp(row):
    fm = fields(row)
    m = CPRE.search(fm.get("mx_Custom_5") or "")
    return {
        "lsq_id": row.get("Id"),
        "rpid": row.get("RelatedProspectId"),
        "cp_code": (m.group(1).upper() if m else None),
        "visit_date": (fm.get("mx_Custom_28") or "")[:10] or None,
        "buyer_name": (fm.get("mx_Custom_4") or "").strip(),
        "stage_raw": (fm.get("mx_Custom_2") or "").strip(),
        "status_raw": (fm.get("mx_Custom_24") or "").strip(),
        "rm": (fm.get("mx_Custom_37") or "").strip(),
        "society": (fm.get("mx_Custom_44") or "").strip(),
        "sales_feedback": (fm.get("mx_Custom_36") or "").strip(),
        "next_fu": (fm.get("mx_Custom_33") or "")[:19] or None,
        "created_on": (row.get("CreatedOn") or "")[:19] or None,
    }


def parse_activity(row, code):
    fm = fields(row)
    return {
        "lsq_id": row.get("Id"),
        "code": code,
        "rpid": row.get("RelatedProspectId"),
        "created_on": (row.get("CreatedOn") or "")[:19] or None,
        "note": (fm.get("ActivityEvent_Note") or "").strip(),
        "status_raw": (fm.get(ACT_STATUS_FIELD.get(code, "")) or "").strip(),
        "rm": (fm.get("mx_Custom_37") or "").strip(),
        "next_fu": (fm.get(ACT_NEXTFU_FIELD.get(code, "")) or "")[:19] or None,
        "revisit": (fm.get(ACT_REVISIT_FIELD.get(code, "")) or "")[:19] or None,
    }


def map_stage(raw):
    return STAGE_MAP.get((raw or "").strip().lower(), "avfu")


def map_status(raw):
    return STATUS_MAP.get((raw or "").strip().lower(), "unc")


# ------------------------------------------------------------------------- fetch
def fetch_all(lsq, use_cache):
    if use_cache and os.path.exists(CACHE):
        print(f"[cache] loading {CACHE}")
        return json.load(open(CACHE))
    print("[lsq] users...")
    users = lsq.users()
    print(f"       {len(users)} users")
    print("[lsq] opportunities 12001 (visits)...")
    opps = [parse_opp(r) for r in lsq.crawl_event(12001)]
    print(f"       {len(opps)} opps")
    acts = []
    for code in (221, 215, 216, 217, 218, 220):
        rows = lsq.crawl_event(code)
        acts += [parse_activity(r, code) for r in rows]
        print(f"[lsq] activity {code}: {len(rows)}")
    data = {"users": users, "opps": opps, "acts": acts}
    json.dump(data, open(CACHE, "w"))
    print(f"[cache] saved {CACHE}")
    return data


# -------------------------------------------------------------------------- Neon
def load_neon(env):
    conn = _connect(env["DATABASE_URL"])
    conn.set_session(readonly=True)
    c = conn.cursor()
    c.execute("SELECT id, email, lower(name), team, active, lsq_user_id FROM users")
    users = [{"id": r[0], "email": (r[1] or "").lower(), "name": r[2], "team": r[3],
              "active": r[4], "lsq_user_id": r[5]} for r in c.fetchall()]
    c.execute("SELECT id, cp_code FROM brokers WHERE deleted_at IS NULL")
    brokers = {(r[1] or "").upper(): r[0] for r in c.fetchall()}
    c.execute("SELECT id, cp_code, visit_date, lower(coalesce(buyer_name,'')), buyer_id, "
              "current_stage, current_status, lsq_visit_activity_id FROM visits")
    visits = [{"id": r[0], "cp": (r[1] or "").upper(), "date": r[2].isoformat() if r[2] else None,
               "name": r[3], "buyer_id": r[4], "stage": r[5], "status": r[6], "lsq": r[7]}
              for r in c.fetchall()]
    conn.close()
    return users, brokers, visits


# ------------------------------------------------------------------- match + plan
def first(name):
    return (name or "").strip().lower().split()[0] if (name or "").strip() else ""


def build_plan(data, neon_users, brokers, visits):
    by_cp_date = defaultdict(list)
    for v in visits:
        if v["cp"] and v["date"]:
            by_cp_date[(v["cp"], v["date"])].append(v)

    # owner resolution maps
    lsq_users = data["users"]
    lsq_by_name = {}
    lsq_by_email = {}
    for u in lsq_users:
        nm = f"{(u.get('FirstName') or '').strip()} {(u.get('LastName') or '').strip()}".strip().lower()
        if nm:
            lsq_by_name[nm] = u
        em = (u.get("EmailAddress") or "").lower()
        if em:
            lsq_by_email[em] = u
    crm_by_email = {u["email"]: u for u in neon_users if u["email"]}
    crm_by_name = {u["name"]: u for u in neon_users if u["name"]}

    plan = {
        "enrich": [], "new_visit": [], "ambiguous": [],
        "followups": [], "deferred_acts": Counter(),
        "users_backfill_lsqid": [], "users_create_inactive": {}, "ghost_needed": False,
        "buyers_backfill_lsqid": set(), "brokers_unmatched_cp": set(),
        "rpid_to_visit": defaultdict(list), "rpid_to_rm": {},
        "stage_dist": Counter(), "status_dist": Counter(),
    }

    def resolve_owner(rm_name):
        """Return ('existing', user_id) | ('create', lsq_user) | ('ghost', None)."""
        nm = (rm_name or "").strip().lower()
        if not nm or nm in ("none", "testing oh", "test onboarding", "sakamoto"):
            plan["ghost_needed"] = True
            return ("ghost", None)
        lu = lsq_by_name.get(nm)
        if lu:
            em = (lu.get("EmailAddress") or "").lower()
            cu = crm_by_email.get(em) or crm_by_name.get(nm)  # name fallback: LSQ/CRM emails differ
            if cu:
                return ("existing", cu["id"])
            plan["users_create_inactive"][em] = lu  # genuine ex-RM not in CRM
            return ("create", lu)
        cu = crm_by_name.get(nm)  # not in LSQ roster but is a CRM user by name
        if cu:
            return ("existing", cu["id"])
        plan["ghost_needed"] = True
        return ("ghost", None)

    # ---- opps -> visits : greedy buyer-name pairing within each (cp, date) bucket
    def nm_tokens(s):
        return set(re.sub(r"[^a-z ]", " ", (s or "").lower()).split())

    def assign(o, v):
        plan["enrich"].append({"visit_id": v["id"], "opp": o["lsq_id"], "stage": o["_stage"],
                               "status": o["_status"], "rpid": o["rpid"], "buyer_id": v["buyer_id"]})
        if o["rpid"] and v["buyer_id"]:
            plan["rpid_to_visit"][o["rpid"]].append((o["created_on"] or o["visit_date"] or "", v["id"]))
            plan["buyers_backfill_lsqid"].add(o["rpid"])

    opp_buckets = defaultdict(list)
    loose = []
    for o in data["opps"]:
        o["_stage"] = map_stage(o["stage_raw"]); o["_status"] = map_status(o["status_raw"])
        if o["rpid"] and o["rm"]:
            plan["rpid_to_rm"][o["rpid"]] = o["rm"]   # deal RM, used to attribute this buyer's activities
        resolve_owner(o["rm"])
        if o["cp_code"] and o["cp_code"] not in brokers:
            plan["brokers_unmatched_cp"].add(o["cp_code"])
        key = (o["cp_code"], o["visit_date"])
        if o["cp_code"] and o["visit_date"] and key in by_cp_date:
            opp_buckets[key].append(o)
        else:
            loose.append(o)

    for key, ops in opp_buckets.items():
        pool = list(by_cp_date[key])
        # collapse same-buyer (rpid) opps on the same cp+date into one representative
        # (the latest by created_on = the live status); they are one real visit.
        groups = defaultdict(list)
        for o in ops:
            groups[o["rpid"] or o["lsq_id"]].append(o)
        reps = []
        for _rid, gr in groups.items():
            gr.sort(key=lambda x: x["created_on"] or "")
            reps.append(gr[-1])
        for rep in reps:
            if not pool:
                plan["new_visit"].append(rep); continue
            ot = nm_tokens(rep["buyer_name"])
            best, best_sc = None, -1
            for v in pool:
                sc = len(ot & nm_tokens(v["name"]))
                if sc > best_sc:
                    best, best_sc = v, sc
            if best_sc <= 0 and len(pool) > 1:
                plan["ambiguous"].append({"opp": rep["lsq_id"], "cp": key[0], "date": key[1],
                                          "buyer": rep["buyer_name"], "candidates": len(pool)})
            plan["stage_dist"][rep["_stage"]] += 1; plan["status_dist"][rep["_status"]] += 1
            assign(rep, best); pool.remove(best)
    # loose opps (no matching sheet visit): collapse same-buyer to one before inserting as new
    loose_groups = {}
    for o in loose:
        gk = (o["cp_code"], o["visit_date"], o["rpid"] or o["lsq_id"])
        cur = loose_groups.get(gk)
        if cur is None or (o["created_on"] or "") > (cur["created_on"] or ""):
            loose_groups[gk] = o
    for o in loose_groups.values():
        plan["stage_dist"][o["_stage"]] += 1; plan["status_dist"][o["_status"]] += 1
        plan["new_visit"].append(o)

    # ---- users backfill lsq id (email match, missing id)
    for u in neon_users:
        lu = lsq_by_email.get(u["email"])
        if lu and not u["lsq_user_id"]:
            plan["users_backfill_lsqid"].append({"email": u["email"], "lsq_user_id": lu.get("ID")})

    # ---- activities -> followups (attach to nearest-dated visit for the buyer)
    for a in data["acts"]:
        # activities don't carry the RM field; attribute to the deal RM for that buyer
        owner = resolve_owner(plan["rpid_to_rm"].get(a["rpid"]) or a["rm"])
        cands = plan["rpid_to_visit"].get(a["rpid"], [])
        if not cands:
            plan["deferred_acts"][f"{a['code']}:no_visit_for_buyer"] += 1
            continue
        target = min(cands, key=lambda cv: abs_days(cv[0], a["created_on"]))[1]
        stage = ACT_STAGE.get(a["code"], "avfu")
        status = map_status(a["status_raw"]) if a["code"] in ACT_STATUS_FIELD else "unc"
        if a["code"] == 218:
            status = "dead"
        note = a["note"] or f"[LSQ {a['code']} migrated {a['created_on'] or ''}]"
        plan["followups"].append({"visit_id": target, "lsq_activity_id": a["lsq_id"],
                                  "lsq_activity_type": a["code"], "stage": stage,
                                  "buyer_status": status if status in VALID_STATUS else "unc",
                                  "note": note, "owner": owner, "next_fu": a["next_fu"],
                                  "revisit": a["revisit"], "created_on": a["created_on"]})
    return plan


def abs_days(a, b):
    try:
        da = datetime.fromisoformat((a or "")[:10]); db = datetime.fromisoformat((b or "")[:10])
        return abs((da - db).days)
    except Exception:
        return 99999


# ------------------------------------------------------------------------ report
def report(plan):
    print("\n" + "=" * 64)
    print("DRY-RUN PROJECTED CHANGES (no writes performed)")
    print("=" * 64)
    print(f"visits to ENRICH (live stage/status + lsq id) : {len(plan['enrich'])}")
    print(f"visits to INSERT (no sheet match)             : {len(plan['new_visit'])}")
    print(f"ambiguous matches (same CP+date, logged)      : {len(plan['ambiguous'])}")
    print(f"followups to INSERT                           : {len(plan['followups'])}")
    print(f"unique buyers to backfill lsq_lead_id         : {len(plan['buyers_backfill_lsqid'])}")
    print(f"users to backfill lsq_user_id                 : {len(plan['users_backfill_lsqid'])}")
    print(f"inactive ex-RM users to CREATE                : {len(plan['users_create_inactive'])}")
    if plan["users_create_inactive"]:
        for em, lu in list(plan["users_create_inactive"].items())[:20]:
            print(f"    + {lu.get('FirstName','')} {lu.get('LastName','')}  <{em}>")
    print(f"ghost user (system@openhouse.in) needed       : {plan['ghost_needed']}")
    print(f"CP codes on opps NOT in brokers               : {len(plan['brokers_unmatched_cp'])}")
    print("\n  enriched stage distribution :", dict(plan["stage_dist"].most_common()))
    print("  enriched status distribution:", dict(plan["status_dist"].most_common()))
    if plan["deferred_acts"]:
        print("\n  activities NOT loaded (no visit for buyer / deferred):", dict(plan["deferred_acts"]))
    out = {k: (len(v) if isinstance(v, (list, set)) else v)
           for k, v in plan.items() if k not in ("rpid_to_visit", "stage_dist", "status_dist",
                                                  "users_create_inactive", "deferred_acts", "enrich",
                                                  "followups", "new_visit", "ambiguous")}
    out["enrich"] = len(plan["enrich"]); out["new_visit"] = len(plan["new_visit"])
    out["followups"] = len(plan["followups"]); out["ambiguous"] = len(plan["ambiguous"])
    out["stage_dist"] = dict(plan["stage_dist"]); out["status_dist"] = dict(plan["status_dist"])
    out["deferred_acts"] = dict(plan["deferred_acts"])
    json.dump(out, open(REPORT, "w"), indent=2, default=str)
    print(f"\nSaved -> {REPORT}")
    print("NOTE: --dry-run made NO changes to the DB or LSQ.")


def _d(s):
    s = (s or "")[:10]
    return s if re.match(r"\d{4}-\d{2}-\d{2}$", s) else None


def _ts(s):
    s = (s or "")[:19]
    return s if re.match(r"\d{4}-\d{2}-\d{2}", s) else None


def _connect(dsn):
    import psycopg2
    last = None
    for a in range(6):
        try:
            return psycopg2.connect(dsn, connect_timeout=20, keepalives=1, keepalives_idle=15,
                                    keepalives_interval=8, keepalives_count=5)
        except Exception as e:
            last = e; time.sleep(3)
    raise last


def execute(plan, env):
    """Apply writes inside ONE transaction using bulk staging tables (few round-trips,
    resilient to a flaky long-haul link). Snapshots affected rows to a backup JSON first
    so the whole run is reversible via --rollback <backup.json>."""
    from psycopg2.extras import execute_values
    os.makedirs(os.path.join(os.path.dirname(__file__), "backups"), exist_ok=True)
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    bpath = os.path.join(os.path.dirname(__file__), "backups", f"backup_{ts}.json")
    backup = {"ts": ts, "users_created": [], "users_lsqid_before": [], "buyers_lsqid_before": [],
              "buyers_created": [], "visits_before": [], "visits_created": [], "followups_inserted": 0}

    conn = _connect(env["DATABASE_URL"]); conn.autocommit = False
    c = conn.cursor()
    try:
        c.execute("SELECT count(*) FROM followups WHERE source='lsq_migration'")
        if c.fetchone()[0] > 0:
            raise SystemExit("Refusing: followups source='lsq_migration' already exist. Roll back first.")

        # ---- 0. SNAPSHOT enriched visits before any write ----
        enrich_ids = list({e["visit_id"] for e in plan["enrich"]})
        SNAP_COLS = ("current_stage", "current_status", "lead_status", "lsq_visit_activity_id",
                     "latest_followup_id", "latest_followup_at", "latest_followup_date",
                     "latest_followup_note", "next_followup_date", "revisit_date", "synced_from_lsq_at")
        c.execute(f"SELECT id,{','.join(SNAP_COLS)} FROM visits WHERE id = ANY(%s::uuid[])", (enrich_ids,))
        for row in c.fetchall():
            backup["visits_before"].append({"id": str(row[0]),
                **{col: (str(row[i + 1]) if row[i + 1] is not None else None) for i, col in enumerate(SNAP_COLS)}})
        json.dump(backup, open(bpath, "w"), indent=2)
        print(f"[backup] snapshot ({len(backup['visits_before'])} visits) -> {bpath}")

        # ---- 1. ghost + ex-RM users (few; individual) ----
        def ensure_user(slug, email, name, team, role, active, lsq_user_id):
            c.execute("SELECT id FROM users WHERE lower(email)=lower(%s)", (email,))
            r = c.fetchone()
            if r:
                return r[0]
            c.execute("INSERT INTO users (slug,email,name,team,role,active,lsq_user_id,metadata) "
                      "VALUES (%s,%s,%s,%s,%s,%s,%s,'{\"created_by\":\"lsq_migration\"}') RETURNING id",
                      (slug, email, name, team, role, active, lsq_user_id))
            uid = c.fetchone()[0]; backup["users_created"].append(str(uid)); return uid

        ghost_id = None
        if plan["ghost_needed"]:
            ghost_id = ensure_user("system", "system@openhouse.in", "System (LSQ migration)",
                                   "Ground", "system", False, None)
        created_by_email = {}
        for em, lu in plan["users_create_inactive"].items():
            slug = "exrm_" + re.sub(r"[^a-z0-9]", "", em.split("@")[0].lower())[:24]
            created_by_email[em] = ensure_user(slug, em,
                f"{lu.get('FirstName','')} {lu.get('LastName','')}".strip() or em,
                "Ground", "ex_rm", False, lu.get("ID"))

        # ---- 2. users.lsq_user_id backfill (bulk) ----
        urows = [(u["email"], u["lsq_user_id"]) for u in plan["users_backfill_lsqid"]]
        if urows:
            c.execute("CREATE TEMP TABLE stg_u (email text, lsq_user_id text) ON COMMIT DROP")
            execute_values(c, "INSERT INTO stg_u VALUES %s", urows)
            c.execute("UPDATE users u SET lsq_user_id=s.lsq_user_id, updated_at=now() FROM stg_u s "
                      "WHERE lower(u.email)=lower(s.email) AND u.lsq_user_id IS NULL "
                      "AND NOT EXISTS (SELECT 1 FROM users u2 WHERE u2.lsq_user_id=s.lsq_user_id) RETURNING u.id")
            backup["users_lsqid_before"] = [str(r[0]) for r in c.fetchall()]

        # ---- 3. buyers.lsq_lead_id backfill (bulk) ----
        seen_rp = set(); brows = []
        for e in plan["enrich"]:
            rp, bid = e.get("rpid"), e.get("buyer_id")
            if rp and bid and rp not in seen_rp:
                seen_rp.add(rp); brows.append((bid, rp))
        if brows:
            c.execute("CREATE TEMP TABLE stg_b (buyer_id uuid, rpid text) ON COMMIT DROP")
            execute_values(c, "INSERT INTO stg_b VALUES %s", brows)
            c.execute("UPDATE buyers b SET lsq_lead_id=s.rpid, updated_at=now() "
                      "FROM (SELECT DISTINCT ON (buyer_id) buyer_id, rpid FROM stg_b) s "
                      "WHERE b.id=s.buyer_id AND b.lsq_lead_id IS NULL "
                      "AND NOT EXISTS (SELECT 1 FROM buyers b2 WHERE b2.lsq_lead_id=s.rpid) RETURNING b.id")
            backup["buyers_lsqid_before"] = [str(r[0]) for r in c.fetchall()]

        # ---- 4. insert new visits (+ buyers) (few; individual w/ savepoints) ----
        for o in plan["new_visit"]:
            c.execute("SAVEPOINT sp")
            try:
                broker_id = None
                if o["cp_code"]:
                    c.execute("SELECT id FROM brokers WHERE upper(cp_code)=%s AND deleted_at IS NULL", (o["cp_code"],))
                    r = c.fetchone(); broker_id = r[0] if r else None
                buyer_id = None
                if o["rpid"]:
                    c.execute("INSERT INTO buyers (name,lsq_lead_id) VALUES (%s,%s) "
                              "ON CONFLICT (lsq_lead_id) DO NOTHING RETURNING id",
                              (o["buyer_name"] or "Unknown (LSQ)", o["rpid"]))
                    r = c.fetchone()
                    if r:
                        buyer_id = r[0]; backup["buyers_created"].append(str(buyer_id))
                    else:
                        c.execute("SELECT id FROM buyers WHERE lsq_lead_id=%s", (o["rpid"],)); buyer_id = c.fetchone()[0]
                c.execute("INSERT INTO visits (visit_code,buyer_id,broker_id,cp_code,buyer_name,society_name,"
                          "visit_date,sales_manager,current_stage,current_status,lsq_visit_activity_id,source,"
                          "synced_from_lsq_at) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,'lsq_migration',now()) "
                          "ON CONFLICT (lsq_visit_activity_id) DO NOTHING RETURNING id",
                          ("LSQ-" + (o["lsq_id"] or "")[:32], buyer_id, broker_id, o["cp_code"], o["buyer_name"],
                           o["society"] or None, _d(o["visit_date"]), o["rm"], o["_stage"], o["_status"], o["lsq_id"]))
                r = c.fetchone()
                if r:
                    backup["visits_created"].append(str(r[0]))
                c.execute("RELEASE SAVEPOINT sp")
            except Exception as e3:
                c.execute("ROLLBACK TO SAVEPOINT sp"); print("  skip new visit", o["lsq_id"], e3)

        # ---- 5. followups (bulk via staging; dedup on lsq_activity_id) ----
        def owner_id(owner):
            kind, val = owner
            if kind == "existing":
                return val
            if kind == "create":
                return created_by_email.get((val.get("EmailAddress") or "").lower(), ghost_id)
            return ghost_id
        frows = []
        for f in plan["followups"]:
            uid = owner_id(f["owner"]) or ghost_id
            if not uid:
                continue
            frows.append((f["visit_id"], uid, f["buyer_status"], f["stage"], f["note"],
                          _d(f["next_fu"]), _ts(f["revisit"]), f["lsq_activity_id"], f["lsq_activity_type"]))
        if frows:
            c.execute("CREATE TEMP TABLE stg_fu (visit_id uuid, by_user_id uuid, buyer_status text, stage text, "
                      "note text, next_fu date, revisit timestamptz, lsq_activity_id text, lsq_activity_type int) "
                      "ON COMMIT DROP")
            execute_values(c, "INSERT INTO stg_fu VALUES %s", frows)
            c.execute("INSERT INTO followups (visit_id,by_user_id,buyer_status,stage,note,next_followup_date,"
                      "revisit_date,lsq_activity_id,lsq_activity_type,source) "
                      "SELECT DISTINCT ON (s.lsq_activity_id) s.visit_id,s.by_user_id,s.buyer_status,s.stage,"
                      "s.note,s.next_fu,s.revisit,s.lsq_activity_id,s.lsq_activity_type,'lsq_migration' "
                      "FROM stg_fu s WHERE NOT EXISTS "
                      "(SELECT 1 FROM followups f WHERE f.lsq_activity_id=s.lsq_activity_id) "
                      "ORDER BY s.lsq_activity_id")
            backup["followups_inserted"] = c.rowcount

        # ---- 6. OVERRIDE current_* from the opp (authoritative live status) (bulk) ----
        done = set(); vrows = []
        for e in plan["enrich"]:
            if e["visit_id"] in done:
                continue
            done.add(e["visit_id"])
            lead = "select_status" if e["status"] == "unc" else e["status"]
            vrows.append((e["visit_id"], e["stage"], e["status"], lead, e["opp"]))
        if vrows:
            c.execute("CREATE TEMP TABLE stg_v (id uuid, stage text, status text, lead text, opp text) ON COMMIT DROP")
            execute_values(c, "INSERT INTO stg_v VALUES %s", vrows)
            c.execute("UPDATE visits v SET current_stage=s.stage, current_status=s.status, lead_status=s.lead, "
                      "lsq_visit_activity_id=COALESCE(v.lsq_visit_activity_id, s.opp), "
                      "synced_from_lsq_at=now(), updated_at=now() FROM stg_v s WHERE v.id=s.id")
            # defensive: guarantee lead_status is consistent with current_status on every migrated visit
            c.execute("UPDATE visits SET lead_status = CASE WHEN current_status='unc' THEN 'select_status' "
                      "ELSE current_status END WHERE lsq_visit_activity_id IS NOT NULL AND lead_status <> "
                      "CASE WHEN current_status='unc' THEN 'select_status' ELSE current_status END")

        json.dump(backup, open(bpath, "w"), indent=2)
        conn.commit()
        print("\n=== EXECUTE COMMITTED ===")
        print(f"  visits enriched : {len(done)}")
        print(f"  visits created  : {len(backup['visits_created'])}")
        print(f"  buyers created  : {len(backup['buyers_created'])}")
        print(f"  buyers lsq id   : {len(backup['buyers_lsqid_before'])}")
        print(f"  users created   : {len(backup['users_created'])}")
        print(f"  users lsq id    : {len(backup['users_lsqid_before'])}")
        print(f"  followups added : {backup['followups_inserted']}")
        print(f"  BACKUP (for rollback): {bpath}")
    except Exception:
        conn.rollback(); print("ROLLED BACK (transaction aborted)."); raise
    finally:
        conn.close()


def fix_owners(plan, env):
    """Repair followups.by_user_id for already-migrated rows (source='lsq_migration')
    using the corrected per-buyer RM attribution, without re-running the migration."""
    from psycopg2.extras import execute_values
    conn = _connect(env["DATABASE_URL"]); conn.autocommit = False; c = conn.cursor()
    try:
        c.execute("SELECT lower(email), id FROM users")
        uid_by_email = {r[0]: str(r[1]) for r in c.fetchall()}
        c.execute("SELECT id FROM users WHERE email='system@openhouse.in'")
        r = c.fetchone(); ghost = str(r[0]) if r else None
        rows = []
        for f in plan["followups"]:
            kind, val = f["owner"]
            if kind == "existing":
                uid = str(val)
            elif kind == "create":
                uid = uid_by_email.get((val.get("EmailAddress") or "").lower(), ghost)
            else:
                uid = ghost
            if uid:
                rows.append((f["lsq_activity_id"], uid))
        c.execute("CREATE TEMP TABLE stg_o (aid text, uid uuid) ON COMMIT DROP")
        execute_values(c, "INSERT INTO stg_o VALUES %s", rows)
        c.execute("UPDATE followups f SET by_user_id=s.uid FROM stg_o s "
                  "WHERE f.lsq_activity_id=s.aid AND f.source='lsq_migration' AND f.by_user_id <> s.uid")
        n = c.rowcount
        conn.commit()
        print(f"fix-owners: updated by_user_id on {n} followups (of {len(rows)} mapped)")
    except Exception:
        conn.rollback(); print("fix-owners ROLLED BACK"); raise
    finally:
        conn.close()


def rollback(env, bpath):
    b = json.load(open(bpath))
    conn = _connect(env["DATABASE_URL"]); conn.autocommit = False; c = conn.cursor()
    try:
        c.execute("DELETE FROM followups WHERE source='lsq_migration'")
        fu = c.rowcount
        if b["visits_created"]:
            c.execute("DELETE FROM visits WHERE id = ANY(%s::uuid[])", (b["visits_created"],))
        if b["buyers_created"]:
            c.execute("DELETE FROM buyers WHERE id = ANY(%s::uuid[])", (b["buyers_created"],))
        if b["users_created"]:
            c.execute("DELETE FROM users WHERE id = ANY(%s::uuid[])", (b["users_created"],))
        if b["users_lsqid_before"]:
            c.execute("UPDATE users SET lsq_user_id=NULL WHERE id = ANY(%s::uuid[])", (b["users_lsqid_before"],))
        if b["buyers_lsqid_before"]:
            c.execute("UPDATE buyers SET lsq_lead_id=NULL WHERE id = ANY(%s::uuid[])", (b["buyers_lsqid_before"],))
        for v in b["visits_before"]:
            c.execute("UPDATE visits SET current_stage=%s,current_status=%s,lead_status=%s,"
                      "lsq_visit_activity_id=%s,latest_followup_id=%s,latest_followup_at=%s,"
                      "latest_followup_date=%s,latest_followup_note=%s,next_followup_date=%s,"
                      "revisit_date=%s,synced_from_lsq_at=%s,updated_at=now() WHERE id=%s",
                      (v["current_stage"], v["current_status"], v["lead_status"], v["lsq_visit_activity_id"],
                       v["latest_followup_id"], v["latest_followup_at"], v["latest_followup_date"],
                       v["latest_followup_note"], v["next_followup_date"], v["revisit_date"],
                       v["synced_from_lsq_at"], v["id"]))
        conn.commit()
        print(f"ROLLBACK complete: deleted {fu} followups, {len(b['visits_created'])} visits, "
              f"{len(b['buyers_created'])} buyers, {len(b['users_created'])} users; "
              f"restored {len(b['visits_before'])} visits, {len(b['users_lsqid_before'])} users, "
              f"{len(b['buyers_lsqid_before'])} buyers.")
    except Exception:
        conn.rollback(); print("ROLLBACK FAILED — transaction aborted."); raise
    finally:
        conn.close()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--execute", action="store_true")
    ap.add_argument("--use-cache", action="store_true")
    ap.add_argument("--fix-owners", action="store_true")
    ap.add_argument("--rollback", metavar="BACKUP_JSON")
    args = ap.parse_args()
    crm_env = load_env(CRM_ENV)

    if args.rollback:
        rollback(crm_env, args.rollback)
        return

    lsq = LSQ(load_env(LSQ_ENV))
    data = fetch_all(lsq, args.use_cache)
    neon_users, brokers, visits = load_neon(crm_env)
    print(f"[neon] users={len(neon_users)} brokers={len(brokers)} visits={len(visits)}")
    plan = build_plan(data, neon_users, brokers, visits)
    if args.fix_owners:
        fix_owners(plan, crm_env)
        return
    report(plan)
    if args.execute:
        execute(plan, crm_env)


if __name__ == "__main__":
    main()
