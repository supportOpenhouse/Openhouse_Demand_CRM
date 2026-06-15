# App Backend — Visit-Booking API for the CRM

**For:** OpenHouse **core/app** backend dev
**From:** Demand CRM
**Goal:** let the CRM (super-admins) schedule **1–10 visits in one action**. The CRM already holds all the data (units, CPs); it just needs **one endpoint** on the app backend to create the visits.

---

## TL;DR — build ONE endpoint

`POST /api/v1/oh/crm/schedule-visits/`

- Takes **all the visits at once** (max 10) in a single request.
- **Creates them SEQUENTIALLY** — one after another — by reusing your **existing** single-visit creation path. **This is NOT a new atomic bulk-insert.** Loop over the list and, per item, run the same logic the app already runs (duplicate check → create buyer → create ScheduleVisit → notifications). If item 3 fails, items 1–2 stay created; keep going and report per-item status.
- Returns a **result per visit** (created / failed + reason), in order.

Everything below is detail.

---

## Auth — two layers

1. **Service key (header):** `X-CRM-Key: <shared secret>`
   Server-to-server only (the CRM **backend** calls you, never the browser). Reject missing/wrong key → `401`.

2. **Who is booking (in the body):** `created_by`
   The visits must be attributed to the **Sales Manager** who triggered them in the CRM. Map them to your `SalesManager` table:
   - Primary: **phone** → `SalesManager.phone_number` (normalise both: strip `+91`/spaces/leading `0`, compare last 10 digits).
   - Fallback: **email** → `SalesManager.email` (all CRM users have an `@openhouse.in` email; some don't have a phone on file — see ⚠️ below).
   - No match on either → `422 {"error":"sales_manager_not_found"}` so the CRM can tell the admin to fix their profile.
   - Set the created visit's `sales_manager` FK + `created_by = "sales:<sm_id>"` (same convention as the app).

> ⚠️ **Heads-up:** the two CRM super-admins rolling this out first (**Akshit**, **Saransh**) currently have **no phone** in the CRM. Please support the **email** fallback (or we'll add their phones first). Confirm which `SalesManager` records they map to.

---

## Request

```jsonc
POST /api/v1/oh/crm/schedule-visits/
Headers: { "X-CRM-Key": "<secret>", "Content-Type": "application/json" }

{
  "created_by": {
    "name":  "Akshit Chaudhary",
    "phone": "9810012345",          // may be empty — then match by email
    "email": "akshit@openhouse.in"
  },
  "visits": [                        // 1..10 — reject empty or >10 with 400
    {
      "home_id":       217,         // = your Home.id (the CRM already stores this per unit)
      "broker_id":     2505,        // = your Broker.id (the CRM has it; = broker.external_id)
      "cp_code":       "CP02505",   // sent too, as a fallback if broker_id is ever stale
      "buyer_name":    "Rahul Sharma",
      "buyer_mobile":  "98765",     // last 5–10 digits ONLY (partial by design — CP privacy)
      "selected_date": "2026-06-15",// YYYY-MM-DD
      "selected_time": "5-7 PM",    // one of the 6 slots below — verbatim
      "source":        "channel_partner"  // or "direct"
    }
    // … up to 10
  ]
}
```

### Field reference
| Field | Notes |
|---|---|
| `home_id` | Your `Home.id`. The CRM's inventory is keyed on it already — no lookup needed your side. |
| `broker_id` | Your `Broker.id`. The CRM stores it (as `broker.external_id`). Prefer it; fall back to `cp_code` → `get-broker-by-cp-code` if absent. |
| `buyer_mobile` | **Partial** (last 5–10 digits) — same privacy model as the CP app. Store as `Buyer.mobile_number`. The 45-day duplicate check uses the last 5. |
| `selected_time` | Exactly one of: `9-11 AM`, `11-1 PM`, `1-3 PM`, `3-5 PM`, `5-7 PM`, `7-9 PM`. |
| `source` | `channel_partner` (default — a CP is always chosen) or `direct`. |
| `status` | Always created as `upcoming` — the CRM does not send it. |

---

## Per-visit processing (sequential — reuse what you already have)

For each item, in order:

1. **Resolve broker** by `broker_id` (else `cp_code`). Not found → row error `broker_not_found`.
2. **45-day lock check** — reuse `check-existing-buyer-for-home` (`home_id` + last-5 of `buyer_mobile` + `buyer_name`). If the buyer is locked to a **different** CP → **do not create**; row error `locked` + `remaining_days`.
3. **Buyer** — find-or-create (same as `/buyer/`): `Buyer{name, mobile_number=buyer_mobile, broker, added_by="sales:<sm_id>"}`.
4. **ScheduleVisit** — create (same as `/schedule-visit/`): `{buyer, broker, home, selected_date, selected_time, status:"upcoming", source, sales_manager=<mapped SM>}`; generate `visit_uuid`.
5. **Notifications — KEEP THEM ON (confirmed).** Fire the same WhatsApp + the 4-hr lock-OTP you already send on a normal schedule-visit. CRM bookings should behave exactly like app bookings for the buyer & CP.

> The CRM shows a final **"this cannot be changed once created"** confirmation before calling you, so treat every call as a committed booking.

---

## Response

Return **per-row** results, in the same order (partial success is expected — don't fail the whole batch for one bad row):

```jsonc
HTTP 200
{
  "created_by_sales_manager_id": 42,
  "booked": 1,
  "failed": 2,
  "results": [
    { "home_id": 217, "ok": true,  "visit_id": 18440, "visit_uuid": "…" },
    { "home_id": 153, "ok": false, "error": "locked", "remaining_days": 31, "locked_to_cp": "CP01088" },
    { "home_id": 296, "ok": false, "error": "home_not_found" }
  ]
}
```

### Error codes
| HTTP | When |
|---|---|
| `401` | missing/invalid `X-CRM-Key` |
| `422` | `created_by` could not be matched to a Sales Manager (phone & email both failed) |
| `400` | `visits` empty, `> 10`, or a row missing a required field / bad date / unknown time-slot |
| per-row in `results[]` | `locked`, `home_not_found`, `broker_not_found` (soft — other rows still process) |

---

## Why this shape (and not the existing endpoints)

Your existing `/schedule-visit/` needs a **per-user broker/sales SessionToken** and books one at a time. The CRM is **server-to-server**, books on behalf of **many different CPs**, and needs **batched + sequential** creation with per-row results. So this is a thin wrapper that **calls your existing creation logic in a loop** — please don't build a new atomic bulk path; reuse `check-existing-buyer-for-home`, the buyer create, and `schedule-visit` internals.

## What we need back from you
1. The deployed **endpoint URL** (staging + prod).
2. The **`X-CRM-Key`** (shared secret) to store in the CRM backend.
3. Confirmation of the **`created_by` mapping** (phone primary, email fallback) and which `SalesManager` rows Akshit & Saransh map to.
4. Confirm the exact **`selected_time`** strings you accept match the six above.

Once we have these, the CRM wires its server-side call and we flip the feature live for the two super-admins first.
