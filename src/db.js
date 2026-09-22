'use strict';
/**
 * SQLite storage. One file, no server to install.
 *
 * Every piece of configuration the admin panel edits lives here - employees,
 * teams, classifications, templates and troubleshooting cases - so the
 * application code never has to change to add a team or a troubleshooting flow.
 */

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const config = require('./config');

fs.mkdirSync(path.dirname(config.DB_PATH), { recursive: true });

const db = new Database(config.DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

db.exec(`
CREATE TABLE IF NOT EXISTS app_meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);

-- ---------------------------------------------------------------- employees
-- An employee row is created the first time somebody signs in with Zoho, and
-- can also be pre-created or deactivated from the admin panel.
CREATE TABLE IF NOT EXISTS employees (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  full_name     TEXT NOT NULL,
  email         TEXT NOT NULL UNIQUE,
  zoho_user_id  TEXT,
  desk_agent_id TEXT,
  is_admin      INTEGER NOT NULL DEFAULT 0,
  active        INTEGER NOT NULL DEFAULT 1,
  last_seen_at  TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Zoho refresh token per employee, encrypted at rest with APP_SECRET.
CREATE TABLE IF NOT EXISTS employee_tokens (
  employee_id       INTEGER PRIMARY KEY REFERENCES employees(id) ON DELETE CASCADE,
  refresh_token_enc TEXT NOT NULL,
  scopes            TEXT,
  has_desk_seat     INTEGER NOT NULL DEFAULT 0,
  granted_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  id          TEXT PRIMARY KEY,
  employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  is_admin    INTEGER NOT NULL DEFAULT 0,
  expires_at  TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Short-lived OAuth state values, to defend the redirect against CSRF.
CREATE TABLE IF NOT EXISTS oauth_states (
  state      TEXT PRIMARY KEY,
  expires_at TEXT NOT NULL
);

-- -------------------------------------------------------------------- teams
CREATE TABLE IF NOT EXISTS teams (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT NOT NULL UNIQUE,
  name_ar      TEXT,
  desk_team_id TEXT,
  template_key TEXT NOT NULL DEFAULT 'GENERAL',
  active       INTEGER NOT NULL DEFAULT 1,
  sort         INTEGER NOT NULL DEFAULT 100,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ---------------------------------------------------------------- templates
-- body uses {placeholder} tokens rendered by templates.js. Editing a template
-- here changes the ticket body with no code change.
CREATE TABLE IF NOT EXISTS templates (
  key         TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  body        TEXT NOT NULL,
  notes       TEXT,
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ----------------------------------------------------------- classifications
-- desk_value is the exact string Zoho Desk stores in its Classification field.
-- needs_review = 1 blocks ticket creation instead of guessing a team.
CREATE TABLE IF NOT EXISTS classifications (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL UNIQUE,
  name_ar       TEXT,
  desk_value    TEXT,
  team_id       INTEGER REFERENCES teams(id) ON DELETE SET NULL,
  template_key  TEXT,
  priority      TEXT,
  ticket_type   TEXT,
  needs_review  INTEGER NOT NULL DEFAULT 0,
  active        INTEGER NOT NULL DEFAULT 1,
  sort          INTEGER NOT NULL DEFAULT 100,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- --------------------------------------------------- troubleshooting engine
-- A case is a directed graph of steps. Each option carries the Arabic label the
-- employee reads, the professional English sentence recorded on the ticket, and
-- either the next step or a terminal outcome.
CREATE TABLE IF NOT EXISTS ts_cases (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  name_en           TEXT NOT NULL,
  name_ar           TEXT NOT NULL,
  description_ar    TEXT,
  team_id           INTEGER REFERENCES teams(id) ON DELETE SET NULL,
  classification_id INTEGER REFERENCES classifications(id) ON DELETE SET NULL,
  start_step_id     INTEGER,
  active            INTEGER NOT NULL DEFAULT 1,
  sort              INTEGER NOT NULL DEFAULT 100,
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS ts_steps (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  case_id        INTEGER NOT NULL REFERENCES ts_cases(id) ON DELETE CASCADE,
  step_key       TEXT NOT NULL,
  instruction_ar TEXT NOT NULL,
  hint_ar        TEXT,
  sort           INTEGER NOT NULL DEFAULT 100,
  UNIQUE (case_id, step_key)
);

CREATE TABLE IF NOT EXISTS ts_options (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  step_id      INTEGER NOT NULL REFERENCES ts_steps(id) ON DELETE CASCADE,
  label_ar     TEXT NOT NULL,
  record_en    TEXT NOT NULL,
  next_step_id INTEGER REFERENCES ts_steps(id) ON DELETE SET NULL,
  outcome      TEXT,            -- RESOLVED | PERSISTS | PARTIAL | UNKNOWN
  sort         INTEGER NOT NULL DEFAULT 100
);

-- A live walk through a case. The path is authoritative and server-side; the
-- browser never tells us which steps were taken.
CREATE TABLE IF NOT EXISTS ts_runs (
  id              TEXT PRIMARY KEY,
  employee_id     INTEGER REFERENCES employees(id) ON DELETE CASCADE,
  case_id         INTEGER NOT NULL REFERENCES ts_cases(id) ON DELETE CASCADE,
  current_step_id INTEGER,
  path_json       TEXT NOT NULL DEFAULT '[]',
  outcome         TEXT,
  status          TEXT NOT NULL DEFAULT 'active',  -- active | finished | abandoned
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ------------------------------------------------------------- submissions
-- One row per Create Ticket attempt, claimed before Zoho is called. This is the
-- idempotency record and the audit trail of what each stage did.
CREATE TABLE IF NOT EXISTS submissions (
  id             TEXT PRIMARY KEY,           -- idempotency key from the browser
  employee_id    INTEGER REFERENCES employees(id) ON DELETE SET NULL,
  status         TEXT NOT NULL,              -- claimed | created | partial | failed
  mode           TEXT,                       -- troubleshooting | direct
  crm_url        TEXT,
  account_name   TEXT,
  account_id     TEXT,
  team_name      TEXT,
  classification TEXT,
  subject        TEXT,
  ticket_id      TEXT,
  ticket_number  TEXT,
  ticket_url     TEXT,
  note_id        TEXT,
  note_status    TEXT,                       -- ok | failed | skipped
  note_author    TEXT,                       -- employee | service
  link_status    TEXT,                       -- linked | unlinked | unknown
  cf_status      TEXT,                       -- ok | failed
  error_ref      TEXT,
  error_stage    TEXT,
  payload_json   TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS audit_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  at          TEXT NOT NULL DEFAULT (datetime('now')),
  employee_id INTEGER,
  employee    TEXT,
  action      TEXT NOT NULL,
  entity      TEXT,
  detail_json TEXT
);

-- Cache of what was last synced from Zoho, so the admin panel can show real
-- departments / teams / agents / classification values without inventing any.
CREATE TABLE IF NOT EXISTS zoho_sync (
  kind       TEXT PRIMARY KEY,   -- departments | teams | agents | classifications | priorities
  data_json  TEXT NOT NULL,
  synced_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_sessions_expiry    ON sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_submissions_time   ON submissions(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_time         ON audit_log(at DESC);
CREATE INDEX IF NOT EXISTS idx_ts_steps_case      ON ts_steps(case_id);
CREATE INDEX IF NOT EXISTS idx_ts_options_step    ON ts_options(step_id);
CREATE INDEX IF NOT EXISTS idx_ts_runs_employee   ON ts_runs(employee_id, status);
`);

/**
 * Add a column to an existing database if it is missing. Lets the schema above
 * grow without a migration framework.
 */
function ensureColumn(table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (columns.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

// Highest step total shown so far in a run, so the "Step 3 of 7" counter never
// goes backwards when a branch turns out to be shorter than another.
ensureColumn('ts_runs', 'peak_total', 'INTEGER NOT NULL DEFAULT 0');

/** Remove expired sessions, OAuth states and stale troubleshooting runs. */
function sweep() {
  db.prepare("DELETE FROM sessions WHERE expires_at < datetime('now')").run();
  db.prepare("DELETE FROM oauth_states WHERE expires_at < datetime('now')").run();
  db.prepare(
    `UPDATE ts_runs SET status='abandoned'
      WHERE status='active' AND updated_at < datetime('now', ?)`
  ).run(`-${config.RUN_TTL_MINUTES} minutes`);
  db.prepare("DELETE FROM ts_runs WHERE created_at < datetime('now','-30 days')").run();
}

function meta(key, value) {
  if (value === undefined) {
    const row = db.prepare('SELECT value FROM app_meta WHERE key = ?').get(key);
    return row ? row.value : null;
  }
  db.prepare(
    'INSERT INTO app_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, value);
  return value;
}

module.exports = { db, sweep, meta, ensureColumn };
