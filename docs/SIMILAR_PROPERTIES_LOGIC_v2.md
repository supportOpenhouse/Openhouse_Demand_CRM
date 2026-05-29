# Similar Properties Selection Logic — v2

Replaces the logic in `SIMILAR_PROPERTIES_LOGIC.md`. Designed for the **selling flow**: shows comparable listings to a seller against their own home.

## Endpoint

- API class: `SimilarPropertiesAPIView`
- File: `core/oh/properties_similar_views.py`
- Input: `home_id` (source), optional `limit`

## Output contract

- **Always return exactly 5 homes.** The fill ladder is designed so the API never returns fewer than 5 — except when total eligible inventory in the city has fewer than 5 candidates (true data edge case).
- Default `limit = 5`. Cap at 20.

## Source home load

Fetch source and resolve:
- micromarket / locality
- society
- BHK (`layout.name`)
- price (total)
- super built-up size

If source has no micromarket, return empty (cannot compute comps).

## Hard filters (always applied)

1. `status ∈ {Ready, Coming Soon}` — exclude ARCHIVE, DRAFT, INACTIVE, anything else
2. `home_id ≠ source.home_id`

Micromarket and BHK are enforced through the fill ladder (below), not as static hard filters.

## Fill ladder

Fill from Tier 1 downward. **Stop the moment 5 candidates are collected.** Within each tier, rank by score (below) and pick top-N until count reaches 5.

A Tier-1 candidate always beats a Tier-3 candidate, even if Tier-3 has a higher raw score. Re-ranking only happens within a single tier.

| Tier | Micromarket | BHK | Price & Size cap |
|------|-------------|-----|------------------|
| 1 | Same | Same | both ≤ 10% |
| 2 | Same | Same | both ≤ 15% |
| 3 | Same | Same | no cap |
| 4 | Same | BHK + 1 | both ≤ 15% |
| 5 | Same | BHK + 1 | no cap |
| 6 | Same | BHK − 1 | both ≤ 15% |
| 7 | Same | BHK − 1 | no cap |
| 8 | Outside MM (same city) | Same | both ≤ 15% |
| 9 | Outside MM (same city) | Same | no cap |
| 10 | Outside MM (same city) | BHK + 1 | no cap |
| 11 | Outside MM (same city) | BHK − 1 | no cap |

Notes:
- "Both ≤ 10%" means `|Δprice| ≤ 10%` AND `|Δsize| ≤ 10%`.
- If source is missing price OR size, that constraint becomes a no-op (cannot evaluate). The other still applies.
- If source is missing both price AND size, Tiers 1/2/4/6/8 collapse into their "no cap" siblings (3/5/7/9).
- BHK − 1 tiers (6, 7, 11) are skipped if source is 1BHK.

## Score (used to rank within a tier)

```
score =
  3.0  · same_society           // the "++" bonus
+ 2.0  · price_closeness        // 1.0 at 0% Δ → 0 at 15% Δ (linear, floored at 0)
+ 1.5  · size_closeness         // 1.0 at 0% Δ → 0 at 15% Δ (linear, floored at 0)
+ 1.0  · is_ready               // +1 if Ready, 0 if Coming Soon
+ tag_boost                     // each tag = +0.5, total capped at +1.0
```

Where:
- `same_society = 1` if `candidate.society_id == source.society_id`, else 0
- `price_closeness = max(0, 1 − |Δprice%| / 0.15)`, with `Δprice% = (cand.price − src.price) / src.price`
- `size_closeness = max(0, 1 − |Δsize%| / 0.15)`, similar formula on super built-up
- `tag_boost = min(1.0, 0.5·has_hot_offer + 0.5·has_price_drop)`

**BHK and micromarket are intentionally not in the score** — the tier already settles them, so adding them to the score would double-count.

## Tie-breakers (within a tier, after score)

1. smaller `|Δprice%|`
2. smaller `|Δsize%|`
3. more recent (`-created_at`)

## Response payload

Per home:
- `id`, `property_code`, `listing_status`
- `society`, `locality` / `micromarket`, `bhk`
- `price`, `super_built_up`, `photo`
- `tier` (1–11) — for observability/QA, optional in UI
- `match_score`
- `matchReasons` (see below)
- `tags` (list including `hot_offer`, `price_drop` if present)

## Match reasons (priority order, max 3 shown)

1. **BHK** — "Same BHK" if same; else "3 BHK comp for your 2 BHK"
2. **Location** — "Same society — {name}" if same society; else "Same locality — {micromarket}"; else "Same city"
3. **Price** — "₹{price} ({n}% below/above yours)" when `|Δprice%| > 1%`; else "Same price band"

Plus pills (independent of the 3-reason list):
- Status pill: "Ready" or "Coming Soon"
- Tag pills: "🔥 Hot Offer", "📉 Price Drop"

## Pseudocode

```python
def fill_similar_homes(source, limit=5):
    selected = []
    seen = set()
    for tier in TIERS:                         # 1..11 in order
        bucket = query_candidates(source, tier)
        bucket = dedup(bucket, seen)           # drop already-selected
        bucket = rank_by_score(bucket, source) # score + tie-breakers
        for home in bucket:
            selected.append(home)
            seen.add(home.id)
            if len(selected) == limit:
                return selected
    return selected   # < limit only if entire city inventory < limit
```

## Edge cases

- **1BHK source** → BHK − 1 tiers (6, 7, 11) are skipped.
- **Missing price/size on source** → see Fill Ladder notes.
- **No micromarket on source** → return empty.
- **Inventory < 5 city-wide** → return whatever exists; do not pad with random homes.
- **Duplicate listings** (same society + BHK + size + ±2% price + same broker) → dedup before ranking; keep the most recently created.

## What changed from v1

| Area | v1 | v2 |
|------|----|----|
| Geo anchor | Same city | **Same micromarket** (city only as last-resort fallback) |
| BHK | Hard filter, also +2 in score | Hard within tier; relaxed via ladder (BHK+1 → BHK−1 → outside MM); not in score |
| Status filter | Only excludes ARCHIVE | Hard whitelist: `{Ready, Coming Soon}` |
| Status in score | Not used | `+1` for Ready |
| Price/size band | Binary, ±5% / ±10% | Continuous closeness, ladder caps at 10%/15%/no-cap |
| Tags | Not used | `Hot Offer` + `Price Drop`, +0.5 each, capped at +1 |
| Result count | Up to `limit`, can be fewer | **Always 5** via fill ladder |
| Default limit | 4 | 5 |
| Tie-breakers | Reused score booleans | Continuous deltas (price → size → recency) |
