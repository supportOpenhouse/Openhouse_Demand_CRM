/**
 * =============================================================================
 * LeadSquared SUPPLY (Daily Report Generator) — Google Apps Script
 * =============================================================================
 *
 * VERSION : 2.3.0
 * DATE    : 2026-02-24
 *
 * NOTE: This is an archived reference copy. The live script lives in the
 * user's Google Apps Script project. Credentials below are placeholders.
 *
 * Daily report on the SELLER (supply) side of the funnel. Distinct from the
 * Demand Dashboard which tracks CP/buyer activity.
 *
 * Per-user output:
 *   - Tab "Leads — Kavita", "Leads — Arti", "Leads — Prakhar", "Leads —
 *     Apurva", "Leads — Sushmita", "Leads — Rupali" (Prashant excluded)
 *   - Tab "All Leads" combining all 7 report users
 *   - "What Changed" column derived from yesterday's activities + completed
 *     tasks; blank if not modified yesterday
 *   - "Lead Active?" derived from stage; "Task Overdue?" from open tasks
 *
 * Aggregate output:
 *   - "Daily Dashboard" — Owner × Status matrix for ALL assigned leads,
 *     plus "Modified Yesterday" and "Created Yesterday" matrices, plus
 *     a per-user breakdown of leads/tasks/activities
 *   - "Tasks Completed", "Tasks Open" — per-user with CP tasks excluded
 *   - "New Leads Created", "Status Changes" — yesterday only
 *
 * v2.3 highlights:
 *   - Individual lead tabs show ALL leads per person (via Leads.Get with
 *     OwnerId lookup) — sorted by Modified On DESC
 *   - "What Changed" lists items changed on the day last modified (Status
 *     Change, Phone Call, Lead Qualification, Form Submission, Deal Created,
 *     Task Completed). Blank if not modified yesterday.
 *   - Dashboard restricted to the 7 supply users; all CP-stage leads
 *     filtered out from every summary.
 * =============================================================================
 */

// =============================================================================
// CONFIGURATION
// =============================================================================
var ACCESS_KEY        = '__REDACTED__';  // see ../.env LSQ_ACCESS_KEY
var SECRET_KEY        = '__REDACTED__';  // see ../.env LSQ_SECRET_KEY
var API_HOST          = 'https://api-in21.leadsquared.com';
var PAGE_SIZE         = 1000;
var MAX_RETRIES       = 3;

// =============================================================================
// REPORT USERS — Only these 7 appear in summaries & get individual tabs
// =============================================================================
var REPORT_USERS = [
  { firstName: 'Kavita',   email: 'kavita.rawat@openhouse.in' },
  { firstName: 'Arti',     email: 'arti.ahirwar@openhouse.in' },
  { firstName: 'Prakhar',  email: 'prakhar.vaish@openhouse.in' },
  { firstName: 'Apurva',   email: 'apurv.nath@openhouse.in' },
  { firstName: 'Sushmita', email: 'Sushmita.roy@openhouse.in' },
  { firstName: 'Rupali',   email: 'rupali.prasad@openhouse.in' },
  { firstName: 'Prashant', email: 'prashant@openhouse.in' }
];

// Users who get their own individual tab (Prashant excluded)
var INDIVIDUAL_TAB_USERS = [
  { firstName: 'Kavita',   email: 'kavita.rawat@openhouse.in' },
  { firstName: 'Arti',     email: 'arti.ahirwar@openhouse.in' },
  { firstName: 'Prakhar',  email: 'prakhar.vaish@openhouse.in' },
  { firstName: 'Apurva',   email: 'apurv.nath@openhouse.in' },
  { firstName: 'Sushmita', email: 'Sushmita.roy@openhouse.in' },
  { firstName: 'Rupali',   email: 'rupali.prasad@openhouse.in' }
];

// =============================================================================
// ACTIVE LEAD STAGES (supply side) — everything else is dead/inactive
// =============================================================================
var ACTIVE_STAGES = [
  'new lead',
  'visit to be scheduled',
  'visit scheduled',
  'seller meeting done',
  'follow up',
  'seller meeting scheduled',
  'visited'
];

// =============================================================================
// CP STAGES TO EXCLUDE from all supply summaries
// =============================================================================
var CP_STAGES = [
  'new cp', 'cp meeting done', 'cp meeting scheduled', 'cp onboarded',
  'cp follow up', 'cp rejected', 'broker', 'cp- phone call'
];

// =============================================================================
// ACTIVITY EVENT CODE → HUMAN-READABLE LABEL (supply-side)
// Noise events (auto-system) are excluded from "What Changed"
// =============================================================================
var EVENT_LABELS = {
  '200':   'Phone Call',
  '201':   'Lead Qualification',
  '97':    'Form Submission',
  '33':    'Opportunity Captured',
  '3002':  'Status Change',
  '3004':  'Source Changed',
  '12000': 'Deal Created'  // Supply Deal
};

// Auto / system events — skip from "What Changed"
var NOISE_EVENTS = {
  '211':  true,   // Share Lead (bulk auto)
  '3001': true    // LeadAssigned (auto round-robin)
};

// =============================================================================
// TASK ENDPOINT
// =============================================================================
var TASK_ENDPOINT = '/v2/Task.svc/Retrieve';

// (Full implementation omitted in this archived copy — see live Apps Script
// project. The business-knowledge constants are all above; flow/README.md
// synthesizes how supply and demand sides interact.)
