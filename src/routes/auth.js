'use strict';
/**
 * Employee sign-in.
 *
 * The employee authorises this app against their own Zoho account. We keep their
 * refresh token (encrypted) and use it for everything done on their behalf, so
 * the CRM note is genuinely theirs rather than the service account's.
 *
 * The admin panel is gated separately by a shared password.
 */

const express = require('express');
const config = require('../config');
const { db } = require('../db');
const zoho = require('../zoho');
const { randomId, safeEqual } = require('../crypto');
const log = require('../log');

const router = express.Router();

// ------------------------------------------------------------- sessions

function createSession(employeeId, isAdmin) {
  const id = randomId(32);
  db.prepare(
    `INSERT INTO sessions (id, employee_id, is_admin, expires_at)
     VALUES (?, ?, ?, datetime('now', ?))`
  ).run(id, employeeId, isAdmin ? 1 : 0, `+${config.SESSION_HOURS} hours`);
  return id;
}

function setSessionCookie(res, sessionId) {
  res.cookie(config.COOKIE_NAME, sessionId, {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.COOKIE_SECURE,
    maxAge: config.SESSION_HOURS * 3600 * 1000,
    path: '/',
  });
}

/** Attach req.employee when a valid session cookie is present. */
function attachSession(req, res, next) {
  const sessionId = req.cookies?.[config.COOKIE_NAME];
  if (!sessionId) return next();

  const row = db
    .prepare(
      `SELECT s.id AS sid, s.is_admin, e.*
         FROM sessions s
         JOIN employees e ON e.id = s.employee_id
        WHERE s.id = ? AND s.expires_at > datetime('now')`
    )
    .get(sessionId);

  if (row && row.active) {
    req.employee = {
      id: row.id,
      full_name: row.full_name,
      email: row.email,
      zoho_user_id: row.zoho_user_id,
      is_admin: Boolean(row.is_admin || row.is_admin === 1),
    };
    req.sessionId = row.sid;
    req.sessionIsAdmin = Boolean(row.is_admin);
    db.prepare("UPDATE employees SET last_seen_at = datetime('now') WHERE id = ?").run(row.id);
  }
  return next();
}

function requireEmployee(req, res, next) {
  if (!req.employee) {
    return res.status(401).json({ error: 'Please sign in with your Zoho account.', code: 'signin' });
  }
  return next();
}

function requireAdmin(req, res, next) {
  if (!req.employee) {
    return res.status(401).json({ error: 'Please sign in with your Zoho account.', code: 'signin' });
  }
  if (!req.sessionIsAdmin) {
    return res.status(403).json({ error: 'Admin access is required for this action.', code: 'admin' });
  }
  return next();
}

// ---------------------------------------------------------------- routes

router.get('/me', (req, res) => {
  if (!req.employee) return res.json({ signedIn: false });
  const token = db
    .prepare('SELECT has_desk_seat, granted_at FROM employee_tokens WHERE employee_id = ?')
    .get(req.employee.id);
  res.json({
    signedIn: true,
    employee: {
      id: req.employee.id,
      name: req.employee.full_name,
      email: req.employee.email,
      isAdmin: req.sessionIsAdmin,
      hasDeskSeat: Boolean(token?.has_desk_seat),
    },
  });
});

router.get('/zoho/start', (req, res) => {
  const problems = config.validate();
  if (problems.length) {
    return res.status(500).send(problems.join(' '));
  }
  const state = randomId(24);
  db.prepare(
    "INSERT INTO oauth_states (state, expires_at) VALUES (?, datetime('now','+10 minutes'))"
  ).run(state);
  res.redirect(zoho.authorizeUrl(state));
});

router.get('/zoho/callback', async (req, res) => {
  const { code, state, error: oauthError } = req.query;

  const fail = (message) =>
    res.status(400).send(
      `<!doctype html><meta charset="utf-8"><title>Sign-in failed</title>` +
        `<body style="font-family:system-ui;padding:3rem;max-width:32rem;margin:auto">` +
        `<h1 style="font-size:1.25rem">Sign-in failed</h1><p>${message}</p>` +
        `<p><a href="/">Back to the ticketing tool</a></p></body>`
    );

  if (oauthError) return fail('Zoho did not grant access. Please try again.');
  if (!code || !state) return fail('The sign-in link was incomplete. Please try again.');

  const stateRow = db
    .prepare("SELECT state FROM oauth_states WHERE state = ? AND expires_at > datetime('now')")
    .get(state);
  db.prepare('DELETE FROM oauth_states WHERE state = ?').run(state);
  if (!stateRow) return fail('The sign-in request expired. Please try again.');

  try {
    const tokens = await zoho.exchangeCode(code);

    // Who signed in, according to Zoho CRM itself.
    const me = await zoho.crm(tokens.refresh_token).get('/users', { type: 'CurrentUser' });
    const user = me?.users?.[0];
    if (!user?.email) return fail('Could not read your Zoho CRM profile. Do you have a CRM licence?');

    // Does this person have a Zoho Desk agent seat? If so their own token can
    // raise the ticket; if not, the service token does that part.
    let hasDeskSeat = false;
    let deskAgentId = null;
    try {
      const deskMe = await zoho.desk(tokens.refresh_token).get('/agents/me');
      hasDeskSeat = Boolean(deskMe?.id);
      deskAgentId = deskMe?.id || null;
    } catch {
      hasDeskSeat = false;
    }

    const email = String(user.email).toLowerCase();
    const existing = db.prepare('SELECT * FROM employees WHERE lower(email) = ?').get(email);

    let employeeId;
    if (existing) {
      if (!existing.active) {
        return fail('Your account has been deactivated in this tool. Please contact your administrator.');
      }
      employeeId = existing.id;
      db.prepare(
        `UPDATE employees SET full_name = ?, zoho_user_id = ?, desk_agent_id = ?, last_seen_at = datetime('now')
          WHERE id = ?`
      ).run(user.full_name || existing.full_name, String(user.id), deskAgentId, employeeId);
    } else {
      employeeId = db
        .prepare(
          `INSERT INTO employees (full_name, email, zoho_user_id, desk_agent_id) VALUES (?, ?, ?, ?)`
        )
        .run(user.full_name || email, email, String(user.id), deskAgentId).lastInsertRowid;
    }

    zoho.storeEmployeeToken(employeeId, tokens.refresh_token, tokens.scope || config.ZOHO.SCOPES, hasDeskSeat);

    const employee = db.prepare('SELECT * FROM employees WHERE id = ?').get(employeeId);
    setSessionCookie(res, createSession(employeeId, employee.is_admin));

    log.audit('auth.signin', {
      employee: { id: employeeId, full_name: employee.full_name },
      detail: { deskSeat: hasDeskSeat },
    });
    res.redirect('/');
  } catch (error) {
    log.error('auth.callback_failed', { message: error.message, status: error.status });
    fail('Zoho sign-in could not be completed. Please try again.');
  }
});

router.post('/signout', (req, res) => {
  if (req.sessionId) db.prepare('DELETE FROM sessions WHERE id = ?').run(req.sessionId);
  res.clearCookie(config.COOKIE_NAME, { path: '/' });
  res.json({ ok: true });
});

/** Disconnect Zoho entirely: forget the refresh token as well as the session. */
router.post('/disconnect', requireEmployee, (req, res) => {
  zoho.revokeEmployeeToken(req.employee.id);
  db.prepare('DELETE FROM sessions WHERE employee_id = ?').run(req.employee.id);
  res.clearCookie(config.COOKIE_NAME, { path: '/' });
  log.audit('auth.disconnect', { employee: req.employee });
  res.json({ ok: true });
});

/** Elevate the current session to admin with the shared admin password. */
router.post('/admin', requireEmployee, (req, res) => {
  const password = String(req.body?.password || '');
  if (!config.ADMIN_PASSWORD || !safeEqual(password.padEnd(64, '\0').slice(0, 64), config.ADMIN_PASSWORD.padEnd(64, '\0').slice(0, 64))) {
    log.warn('auth.admin_rejected', { employee: req.employee.email });
    return res.status(401).json({ error: 'Incorrect admin password.' });
  }
  db.prepare('UPDATE sessions SET is_admin = 1 WHERE id = ?').run(req.sessionId);
  db.prepare('UPDATE employees SET is_admin = 1 WHERE id = ?').run(req.employee.id);
  log.audit('auth.admin_granted', { employee: req.employee });
  res.json({ ok: true });
});

module.exports = { router, attachSession, requireEmployee, requireAdmin };
