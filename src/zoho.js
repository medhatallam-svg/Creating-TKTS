'use strict';
/**
 * Zoho OAuth and HTTP clients for CRM and Desk.
 *
 * Two kinds of identity exist here:
 *
 *   employee  - a refresh token granted by the employee themselves when they
 *               signed in. Used for everything done on their behalf, and in
 *               particular for creating the CRM note, so that the note is
 *               genuinely authored by them. Zoho's Notes API does not allow
 *               Created_By to be set, so this is the only honest way.
 *
 *   service   - a single Self Client refresh token. Used for admin sync, and as
 *               a fallback for Zoho Desk when an employee has no Desk agent
 *               seat. Never used to write CRM notes.
 */

const config = require('./config');
const { db } = require('./db');
const { encrypt, decrypt } = require('./crypto');
const log = require('./log');

/** access_token cache, keyed by refresh token. { token, expiresAt } */
const accessCache = new Map();

class ZohoError extends Error {
  constructor(message, { status, body, stage } = {}) {
    super(message);
    this.name = 'ZohoError';
    this.status = status;
    this.body = body;
    this.stage = stage;
  }
}

async function httpJson(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.HTTP_TIMEOUT_MS);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const text = await response.text();
    let body = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = { raw: text };
      }
    }
    return { status: response.status, ok: response.ok, body };
  } catch (error) {
    if (error.name === 'AbortError') {
      throw new ZohoError('Zoho request timed out', { status: 504 });
    }
    throw new ZohoError(`Zoho request failed: ${error.message}`, { status: 0 });
  } finally {
    clearTimeout(timer);
  }
}

// ------------------------------------------------------------------- OAuth

function authorizeUrl(state) {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: config.ZOHO.CLIENT_ID,
    scope: config.ZOHO.SCOPES,
    redirect_uri: config.ZOHO.REDIRECT_URI,
    access_type: 'offline',
    // Force the consent screen so a refresh token is always issued, even if the
    // employee has authorised this client before.
    prompt: 'consent',
    state,
  });
  return `${config.ZOHO.ACCOUNTS_HOST}/oauth/v2/auth?${params}`;
}

async function exchangeCode(code) {
  const params = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: config.ZOHO.CLIENT_ID,
    client_secret: config.ZOHO.CLIENT_SECRET,
    redirect_uri: config.ZOHO.REDIRECT_URI,
    code,
  });
  const { ok, body, status } = await httpJson(`${config.ZOHO.ACCOUNTS_HOST}/oauth/v2/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  if (!ok || !body || body.error || !body.refresh_token) {
    throw new ZohoError(`Token exchange failed: ${body?.error || status}`, { status, body });
  }
  return body; // { access_token, refresh_token, expires_in, api_domain, ... }
}

async function accessTokenFor(refreshToken) {
  if (!refreshToken) throw new ZohoError('No Zoho refresh token available', { status: 401 });

  const cached = accessCache.get(refreshToken);
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;

  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: config.ZOHO.CLIENT_ID,
    client_secret: config.ZOHO.CLIENT_SECRET,
    refresh_token: refreshToken,
  });
  const { ok, body, status } = await httpJson(`${config.ZOHO.ACCOUNTS_HOST}/oauth/v2/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  if (!ok || !body?.access_token) {
    throw new ZohoError(`Token refresh failed: ${body?.error || status}`, { status: status || 401, body });
  }
  accessCache.set(refreshToken, {
    token: body.access_token,
    expiresAt: Date.now() + (body.expires_in || 3600) * 1000,
  });
  return body.access_token;
}

function forgetAccessToken(refreshToken) {
  accessCache.delete(refreshToken);
}

// ------------------------------------------------------------- identities

function storeEmployeeToken(employeeId, refreshToken, scopes, hasDeskSeat) {
  db.prepare(
    `INSERT INTO employee_tokens (employee_id, refresh_token_enc, scopes, has_desk_seat, granted_at)
     VALUES (?, ?, ?, ?, datetime('now'))
     ON CONFLICT(employee_id) DO UPDATE SET
       refresh_token_enc = excluded.refresh_token_enc,
       scopes            = excluded.scopes,
       has_desk_seat     = excluded.has_desk_seat,
       granted_at        = excluded.granted_at`
  ).run(employeeId, encrypt(refreshToken), scopes || null, hasDeskSeat ? 1 : 0);
}

function employeeRefreshToken(employeeId) {
  const row = db
    .prepare('SELECT refresh_token_enc FROM employee_tokens WHERE employee_id = ?')
    .get(employeeId);
  if (!row) return null;
  try {
    return decrypt(row.refresh_token_enc);
  } catch (error) {
    log.error('token.decrypt', { employeeId, message: error.message });
    return null;
  }
}

function revokeEmployeeToken(employeeId) {
  const token = employeeRefreshToken(employeeId);
  if (token) forgetAccessToken(token);
  db.prepare('DELETE FROM employee_tokens WHERE employee_id = ?').run(employeeId);
}

const serviceRefreshToken = () => config.ZOHO.SERVICE_REFRESH_TOKEN || null;

// ------------------------------------------------------------ API clients

/**
 * Perform a Zoho call with one automatic retry after a 401, in case the cached
 * access token was invalidated server-side before it expired.
 */
async function call(refreshToken, url, options = {}, stage = 'zoho') {
  const attempt = async () => {
    const accessToken = await accessTokenFor(refreshToken);
    const headers = {
      Authorization: `Zoho-oauthtoken ${accessToken}`,
      ...(options.headers || {}),
    };
    if (options.body && !headers['content-type'] && !headers['Content-Type']) {
      headers['content-type'] = 'application/json';
    }
    return httpJson(url, { ...options, headers });
  };

  let result = await attempt();
  if (result.status === 401) {
    forgetAccessToken(refreshToken);
    result = await attempt();
  }
  if (!result.ok) {
    throw new ZohoError(`Zoho ${stage} returned ${result.status}`, {
      status: result.status,
      body: result.body,
      stage,
    });
  }
  return result.body;
}

const crm = (refreshToken) => ({
  get: (pathname, query) =>
    call(
      refreshToken,
      `${config.ZOHO.CRM_API}${pathname}${query ? `?${new URLSearchParams(query)}` : ''}`,
      { method: 'GET' },
      'crm'
    ),
  post: (pathname, payload) =>
    call(
      refreshToken,
      `${config.ZOHO.CRM_API}${pathname}`,
      { method: 'POST', body: JSON.stringify(payload) },
      'crm'
    ),
});

const desk = (refreshToken) => {
  const headers = { orgId: String(config.ZOHO.DESK_ORG_ID) };
  return {
    get: (pathname, query) =>
      call(
        refreshToken,
        `${config.ZOHO.DESK_API}${pathname}${query ? `?${new URLSearchParams(query)}` : ''}`,
        { method: 'GET', headers },
        'desk'
      ),
    post: (pathname, payload) =>
      call(
        refreshToken,
        `${config.ZOHO.DESK_API}${pathname}`,
        { method: 'POST', body: JSON.stringify(payload), headers },
        'desk'
      ),
    patch: (pathname, payload) =>
      call(
        refreshToken,
        `${config.ZOHO.DESK_API}${pathname}`,
        { method: 'PATCH', body: JSON.stringify(payload), headers },
        'desk'
      ),
  };
};

/** Direct URL of a ticket in the Azeer help centre. */
const ticketUrl = (ticketId) =>
  `${config.ZOHO.DESK_PORTAL_URL}/ShowHomePage.do#Cases/dv/${ticketId}`;

/** URL of a CRM record, used for the {crmUrl} template token. */
const crmRecordUrl = (moduleName, recordId) =>
  `https://crm.zoho.${config.ZOHO.DC}/crm/org${config.ZOHO.CRM_ORG_ID}/tab/${moduleName}/${recordId}`;

module.exports = {
  ZohoError,
  authorizeUrl,
  exchangeCode,
  accessTokenFor,
  forgetAccessToken,
  storeEmployeeToken,
  employeeRefreshToken,
  revokeEmployeeToken,
  serviceRefreshToken,
  crm,
  desk,
  ticketUrl,
  crmRecordUrl,
};
