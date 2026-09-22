'use strict';
/**
 * Central configuration. Everything that varies between environments comes from
 * the process environment; nothing secret is ever sent to the browser.
 *
 * Values under ZOHO.* that are *identifiers* (department, layout) were read live
 * from the Azeer Zoho portal and are verified. They can still be overridden by
 * environment variables or changed from the Admin panel.
 */

const path = require('path');
const fs = require('fs');

// --- tiny .env loader (no dependency) -------------------------------------
(function loadDotEnv() {
  const file = path.join(__dirname, '..', '.env');
  if (!fs.existsSync(file)) return;
  for (const rawLine of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
})();

const env = (key, fallback) => {
  const value = process.env[key];
  return value === undefined || value === '' ? fallback : value;
};
const bool = (key, fallback) => {
  const value = process.env[key];
  if (value === undefined || value === '') return fallback;
  return /^(1|true|yes|on)$/i.test(value);
};
const int = (key, fallback) => {
  const value = parseInt(process.env[key], 10);
  return Number.isFinite(value) ? value : fallback;
};

const ROOT = path.join(__dirname, '..');

const config = {
  ROOT,
  NODE_ENV: env('NODE_ENV', 'production'),
  PORT: int('PORT', 8080),

  /** Public base URL of this app. Required for the Zoho OAuth redirect. */
  APP_BASE_URL: env('APP_BASE_URL', 'http://localhost:8080').replace(/\/+$/, ''),

  /** Path of the SQLite database file. */
  DB_PATH: env('DB_PATH', path.join(ROOT, 'data', 'azeer-tickets.db')),

  /**
   * 32+ character random string. Used to sign session cookies and to encrypt
   * Zoho refresh tokens at rest. Rotating it logs everybody out and invalidates
   * every stored refresh token.
   */
  APP_SECRET: env('APP_SECRET', ''),

  SESSION_HOURS: int('SESSION_HOURS', 12),
  COOKIE_NAME: 'azeer_sid',
  COOKIE_SECURE: bool('COOKIE_SECURE', env('APP_BASE_URL', '').startsWith('https://')),

  ZOHO: {
    /** Data centre. com | eu | in | com.au | jp | ca | sa */
    DC: env('ZOHO_DC', 'com'),
    CLIENT_ID: env('ZOHO_CLIENT_ID', ''),
    CLIENT_SECRET: env('ZOHO_CLIENT_SECRET', ''),

    /**
     * Service refresh token (Self Client). Used only as a fallback for Zoho Desk
     * when the signed-in employee has no Desk agent seat, and for admin sync.
     * CRM notes are NEVER created with this token - see docs in README.
     */
    SERVICE_REFRESH_TOKEN: env('ZOHO_SERVICE_REFRESH_TOKEN', ''),

    /** Zoho Desk organisation id (Twerlo). Verified live. */
    DESK_ORG_ID: env('ZOHO_DESK_ORG_ID', '723454380'),
    /** Zoho Desk help-centre host, used to build the direct ticket URL. */
    DESK_PORTAL_URL: env(
      'ZOHO_DESK_PORTAL_URL',
      'https://help.azeer.com/support/twerlo'
    ).replace(/\/+$/, ''),
    /** Azeer department. Verified live. */
    DESK_DEPARTMENT_ID: env('ZOHO_DESK_DEPARTMENT_ID', '527933000044745084'),
    /** "Azeer Ticket" layout. Verified live. */
    DESK_LAYOUT_ID: env('ZOHO_DESK_LAYOUT_ID', '527933000064576994'),

    /** CRM org id and the module that holds the Azeer platform data. */
    CRM_ORG_ID: env('ZOHO_CRM_ORG_ID', '717404780'),
    CRM_AZEER_MODULE: env('ZOHO_CRM_AZEER_MODULE', 'Azeer'),

    /**
     * Scopes requested when an employee signs in. CRM scopes are required.
     * Desk scopes are requested too so that, where the employee has a Desk seat,
     * the ticket is genuinely raised by them.
     */
    SCOPES: env(
      'ZOHO_SCOPES',
      [
        'ZohoCRM.modules.ALL',
        'ZohoCRM.settings.fields.READ',
        'ZohoCRM.users.READ',
        'ZohoCRM.org.READ',
        'Desk.tickets.ALL',
        'Desk.basic.READ',
        'Desk.search.READ',
        'Desk.contacts.READ',
        'Desk.settings.READ',
      ].join(',')
    ),
  },

  AI: {
    /** Anthropic API key, server side only. */
    API_KEY: env('ANTHROPIC_API_KEY', ''),
    BASE_URL: env('ANTHROPIC_BASE_URL', 'https://api.anthropic.com'),
    MODEL: env('AI_MODEL', 'claude-haiku-4-5-20251001'),
    MAX_TOKENS: int('AI_MAX_TOKENS', 1200),
    TIMEOUT_MS: int('AI_TIMEOUT_MS', 45000),
  },

  /** Copy platform login credentials into ticket bodies (per Medhat, currently on). */
  INCLUDE_CREDENTIALS: bool('INCLUDE_CREDENTIALS', true),

  /** Shared password that gates the admin panel. Separate from employee sign-in. */
  ADMIN_PASSWORD: env('ADMIN_PASSWORD', ''),

  /** How long an unfinished troubleshooting run or draft stays resumable. */
  RUN_TTL_MINUTES: int('RUN_TTL_MINUTES', 240),

  HTTP_TIMEOUT_MS: int('HTTP_TIMEOUT_MS', 30000),
};

/** Zoho regional hosts derived from the data centre. */
const DC_SUFFIX = { com: 'com', eu: 'eu', in: 'in', 'com.au': 'com.au', jp: 'jp', ca: 'ca', sa: 'sa' };
const suffix = DC_SUFFIX[config.ZOHO.DC] || 'com';
config.ZOHO.ACCOUNTS_HOST = `https://accounts.zoho.${suffix}`;
config.ZOHO.CRM_API = `https://www.zohoapis.${suffix}/crm/v8`;
config.ZOHO.DESK_API = `https://desk.zoho.${suffix}/api/v1`;
config.ZOHO.REDIRECT_URI = `${config.APP_BASE_URL}/api/auth/zoho/callback`;

/** Fail fast on misconfiguration rather than half-working at runtime. */
config.validate = function validate() {
  const problems = [];
  if (!config.APP_SECRET || config.APP_SECRET.length < 32) {
    problems.push('APP_SECRET must be set to a random string of at least 32 characters.');
  }
  if (!config.ZOHO.CLIENT_ID || !config.ZOHO.CLIENT_SECRET) {
    problems.push('ZOHO_CLIENT_ID and ZOHO_CLIENT_SECRET must be set.');
  }
  if (!config.ADMIN_PASSWORD) {
    problems.push('ADMIN_PASSWORD must be set to protect the admin panel.');
  }
  return problems;
};

/** Warnings that degrade features but do not stop the server. */
config.warnings = function warnings() {
  const list = [];
  if (!config.AI.API_KEY) {
    list.push('ANTHROPIC_API_KEY is not set - English rewriting and subject generation are disabled.');
  }
  if (!config.ZOHO.SERVICE_REFRESH_TOKEN) {
    list.push('ZOHO_SERVICE_REFRESH_TOKEN is not set - employees without a Desk seat cannot create tickets.');
  }
  return list;
};

module.exports = config;
