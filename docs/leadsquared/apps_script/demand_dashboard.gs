/**
 * =============================================================================
 * LeadSquared DEMAND Dashboard — Google Apps Script
 * =============================================================================
 *
 * VERSION : 2.8.0
 * DATE    : 2026-04-28
 *
 * NOTE: This is an archived reference copy. The live script lives in the
 * user's Google Apps Script project. Credentials below are placeholders;
 * the live script has the real values. See ../.env for the local copy.
 *
 * v2.8.0 — three new detail tabs for deep team / property tracking:
 *
 *   "Hot & Warm Leads 60d"
 *     Every Hot or Warm visit in the last 60 days, one row per visit, full
 *     context: buyer name+phone, society/unit/floor/facing, sales owner,
 *     CP code+name+phone, stage, sales feedback, after-visit-followup
 *     task count + overdue + latest status, buyer lead H/W/C, days since
 *     visit. Sorted Hot-first then by visit date desc.
 *
 *   "Society Detail 60d"
 *     One row per society. Total visits, unique units, unique buyers,
 *     active sales owners, top owner, full Hot/Warm/Cold/Dead/Blank
 *     pipeline split, full stage breakdown, AV-FU task counts.
 *
 *   "Unit Detail 60d"
 *     Same layout as Society Detail but one row per unit.
 *
 *   All three tabs use a fixed 60-day window (the Daily Dashboard period
 *   filter does NOT apply here).
 *
 * v2.7.0 — fix the 30-minute timeout. Data-volume diet:
 *   - Supply-side users (Arti, Ashish, Nisha, Prashant, Rupali, Sushmita)
 *     skipped everywhere.
 *   - Tasks fetched newest-first; pagination breaks at cutoff.
 *   - "Other" category tasks dropped at write boundary.
 *   - Activity event 3002 (StageChange) and 204 (Seller Meeting) removed.
 *   - _writeRows uses applyRowBanding (single call) instead of per-row loop.
 *   - LEAD_LOOKBACK_DAYS 730 → 365; TASK_COMPLETED_DAYS 90 → 60;
 *     new TASK_OPEN_DAYS = 365.
 *
 * v2.6.0 — Daily Dashboard period filter + Section J (weekly Friday
 *   engagement) + Section K (visits without after-visit-followup task).
 *
 * v2.5.0 — Daily Dashboard expanded to 9 sections: KEY METRICS + A through I.
 *
 * v2.4.0 — fixes after live sheet validation:
 *   - Aggregate by 'Sales Owner' not 'Owner'
 *   - 'Sales Feedback / Note' is the right column name
 *   - Pipeline (H/W/C) resolved via 'All Leads (Raw)' lookup
 *   - Bucket by 'Visit Date' not 'Created On'
 *
 * v2.3.0 — visits via activity 12001 (Demand Deal), field-slot map baked in,
 *   CP filter via mx_CP_code, opportunity API removed.
 *
 * PRODUCES:
 *   Raw tabs:   Users, All CPs, All Visits, All Tasks, All Activities
 *   Dashboards: CP Owner Scorecard, Last 60d Visits, Daily Dashboard,
 *               Hot & Warm Leads 60d, Society Detail 60d, Unit Detail 60d
 *   Required external tab: All Leads (Raw) — used to resolve buyer H/W/C
 * =============================================================================
 */

// =============================================================================
// CONFIG
// =============================================================================
var ACCESS_KEY = '__REDACTED__';  // see ../.env LSQ_ACCESS_KEY
var SECRET_KEY = '__REDACTED__';  // see ../.env LSQ_SECRET_KEY
var API_HOST   = 'https://api-in21.leadsquared.com';

var PAGE_SIZE   = 1000;
var MAX_RETRIES = 3;

var LEAD_LOOKBACK_DAYS      = 365;
var OPP_LOOKBACK_DAYS       = 180;
var ACTIVITY_LOOKBACK_DAYS  = 30;
var TASK_COMPLETED_DAYS     = 60;
var TASK_OPEN_DAYS          = 365;

// Supply-side users — excluded from raw tabs and dashboards.
// Match is first-name-prefix, case-insensitive.
var SUPPLY_SIDE_USERS = ['Arti', 'Ashish', 'Nisha', 'Prashant', 'Rupali', 'Sushmita'];

var CP_STAGE_KEYWORDS = ['cp', 'broker', 'channel partner', 'channel-partner'];

// On this LSQ tenant: 12001 = Demand Deal (CP visits), 12000 = Supply Deal.
var VISIT_OPP_EVENT_CODE = 12001;

var CLOSING_STAGES = ['Booking Done', 'Registry Done', 'ATS Executed'];

// Demand Deal (12001) custom field slot map.
var VISIT_FIELD_MAP = {
  dealTitle:      'mx_Custom_1',
  stage:          'mx_Custom_2',
  leadSource:     'mx_Custom_3',
  buyerName:      'mx_Custom_4',
  brokerInfo:     'mx_Custom_5',
  revisitDate:    'mx_Custom_8',
  salesOwnerTxt:  'mx_Custom_11',
  buyerPhone:     'mx_Custom_13',
  city:           'mx_Custom_15',
  visitDate:      'mx_Custom_28',
  salesFeedback:  'mx_Custom_36',
  salesOwnerName: 'mx_Custom_37',
  brokerType:     'mx_Custom_38',
  visitDate2:     'mx_Custom_39',
  floor:          'mx_Custom_40',
  facing:         'mx_Custom_41',
  unitAddress:    'mx_Custom_42',
  ownerId:        'Owner'
};

// v2.7: dropped 3002 (StageChange) and 204 (Seller Meeting Details — supply).
var GENUINE_ACTIVITY_CODES = [
  12001,  // Demand Deal (visit)
  216,    // Demand- Booking Done
  215,    // Demand- Negotiation
  221,    // Demand- After Visit Follow Up
  201,    // Lead Qualification
  210,    // WhatsApp Message
  200     // Phone Call
];

var REQUIRE_NOTE_UNLESS_CODE = {
  '216':  true,
  '215':  true,
  '12001': true
};

// Styling
var HEADER_COLOR   = '#1B5E20';
var HEADER_FONT    = '#FFFFFF';
var ALT_ROW        = '#F1F8E9';
var SECTION_COLOR  = '#2E7D32';
var KPI_BG         = '#E8F5E9';
var ACCENT_RED     = '#FFCDD2';
var ACCENT_ORANGE  = '#FFE0B2';
var ACCENT_GREEN   = '#C8E6C9';
var ACCENT_YELLOW  = '#FFF9C4';

// (Full implementation omitted in this archived copy — see live Apps Script
// project. The pieces that capture business knowledge are all in the
// constants above and in flow/README.md. The remaining ~1500 lines are
// fetch/aggregate/render plumbing.)
