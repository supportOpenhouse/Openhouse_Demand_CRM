# CRM Revisit & Reschedule APIs

Server-to-server APIs for an existing schedule visit. Auth is the same on both.

## Auth

| Header      | Value         |
|-------------|---------------|
| `X-CRM-Key` | `CRM_API_KEY` |
| `Content-Type` | `application/json` |

`sales_manager_id` is **not** required. The visit keeps its current sales manager (or the home’s SM on revisit if the old visit has none).

## Staging

```
https://staging-561394753846.asia-south2.run.app/api/v1/oh
```

---

## 1. Revisit

Creates a **new** upcoming visit by cloning a **completed** visit (new id). Use this after a visit is done and the buyer will come again.

```
POST /crm/revisit-visits/
```

### Body

```json
{
  "visit_id": 3099,
  "selected_date": "2026-09-22",
  "selected_time": "3 - 5 PM"
}
```

### Success `201`

New visit payload plus `old_visit_id` (the completed visit you cloned).  
`sales_manager_id` on the new visit matches the original visit.

### Rules

- `visit_id` must be **completed**
- Same buyer + broker + home + date + time + SM already upcoming → `400` `This visit is already created.`
- Same completed visit with a **different** slot → another new visit is created

---

## 2. Reschedule

Updates **the same** upcoming visit’s date/time. Visit id does not change. Sales manager does not change.

```
POST /crm/reschedule-visits/
```

### Body

```json
{
  "visit_id": 3139,
  "selected_date": "2026-09-20",
  "selected_time": "11 - 1 PM"
}
```

### Success `200`

Same visit object, updated `selected_date` / `selected_time`, plus `visit_id`.

### Rules

- `visit_id` must be **upcoming**
- Completed / cancelled → `400` `Only upcoming visits can be rescheduled.`
- Another upcoming visit already on that slot → `400` `This visit is already created.`

---

## When to use which

| | Revisit | Reschedule |
|--|---------|------------|
| Visit status | completed | upcoming |
| Result | **new** visit id | **same** visit id |
| Sales manager | copied from original | unchanged |
| Typical use | buyer coming again after a done visit | move an upcoming visit to a new slot |

---

## Errors (both)

| Status | When |
|--------|------|
| `400` | Missing fields, wrong status, invalid date (`YYYY-MM-DD`), duplicate slot |
| `401` | Bad / missing `X-CRM-Key` |
| `404` | Visit not found |
| `503` | `CRM_API_KEY` not configured |
