'use strict';
/**
 * The employee-facing API. Everything here requires a signed-in employee.
 *
 * Errors are translated once, here, into a short human sentence plus an optional
 * reference. Nothing technical, and no token or Zoho payload, reaches the browser.
 */

const express = require('express');
const config = require('../config');
const { db, meta } = require('../db');
const zoho = require('../zoho');
const llm = require('../llm');
const tickets = require('../tickets');
const troubleshoot = require('../troubleshoot');
const { resolveAccount, ResolveError } = require('../resolve');
const { errorRef } = require('../crypto');
const log = require('../log');
const { requireEmployee } = require('./auth');

const router = express.Router();
router.use(requireEmployee);

/** Turn any thrown error into a safe response. */
function fail(res, error, fallbackStage = 'unknown') {
  if (error instanceof tickets.TicketError || error instanceof ResolveError || error instanceof troubleshoot.TsError) {
    return res.status(400).json({ error: error.message, code: error.code, ref: error.ref });
  }
  if (error instanceof llm.LlmError) {
    const ref = errorRef();
    log.error('api.llm_failed', { ref, message: error.message, status: error.status });
    return res.status(502).json({ error: tickets.SAFE_MESSAGES.llm, code: 'llm', ref });
  }
  if (error instanceof zoho.ZohoError) {
    const ref = errorRef();
    log.error('api.zoho_failed', { ref, stage: error.stage, status: error.status, body: error.body });
    const message =
      error.stage === 'desk' ? tickets.SAFE_MESSAGES.desk : tickets.SAFE_MESSAGES.crm;
    const code = error.status === 401 ? 'reauth' : error.stage || fallbackStage;
    return res.status(502).json({ error: message, code, ref });
  }
  const ref = errorRef();
  log.error('api.unhandled', { ref, message: error.message, stack: error.stack });
  return res.status(500).json({ error: tickets.SAFE_MESSAGES.unknown, code: 'unknown', ref });
}

const asyncRoute = (handler) => (req, res) => Promise.resolve(handler(req, res)).catch((e) => fail(res, e));

// ---------------------------------------------------------------- config

/**
 * Everything the UI needs to render its pickers. No ids that are secret, no
 * credentials, and only active rows.
 */
router.get('/config', (req, res) => {
  const teams = db
    .prepare(
      `SELECT id, name, name_ar, template_key, (desk_team_id IS NOT NULL AND desk_team_id != '') AS configured
         FROM teams WHERE active = 1 ORDER BY sort, name`
    )
    .all();

  const classifications = db
    .prepare(
      `SELECT c.id, c.name, c.name_ar, c.team_id, c.template_key, c.needs_review,
              t.name AS team_name
         FROM classifications c
         LEFT JOIN teams t ON t.id = c.team_id
        WHERE c.active = 1 ORDER BY c.sort, c.name`
    )
    .all();

  res.json({
    teams: teams.map((t) => ({ ...t, configured: Boolean(t.configured) })),
    classifications: classifications.map((c) => ({ ...c, needs_review: Boolean(c.needs_review) })),
    cases: troubleshoot.listCases(),
    priorities: JSON.parse(meta('priorities') || '[]'),
    features: {
      aiEnabled: llm.isConfigured(),
      includeCredentials: config.INCLUDE_CREDENTIALS,
    },
  });
});

// --------------------------------------------------------------- account

/** Live account preview as soon as a CRM URL is pasted. */
router.post(
  '/account/resolve',
  asyncRoute(async (req, res) => {
    const employeeToken = zoho.employeeRefreshToken(req.employee.id);
    if (!employeeToken) {
      return res.status(401).json({ error: 'Your Zoho sign-in has expired. Please sign in again.', code: 'reauth' });
    }
    const deskSeat = db
      .prepare('SELECT has_desk_seat FROM employee_tokens WHERE employee_id = ?')
      .get(req.employee.id);

    const account = await resolveAccount(req.body?.crmUrl, {
      crmToken: employeeToken,
      deskToken: deskSeat?.has_desk_seat ? employeeToken : zoho.serviceRefreshToken() || employeeToken,
    });

    res.json({
      found: true,
      accountName: account.crm.azeerName || account.crm.accountsName,
      azeerName: account.crm.azeerName,
      accountsName: account.crm.accountsName,
      accountId: account.crm.accountsId,
      azeerId: account.crm.azeerId,
      accountOwner: account.crm.accountOwner,
      accountManager: account.crm.accountManager,
      platformName: account.crm.platformName,
      waba: account.crm.waba,
      businessId: account.crm.businessId,
      contact: account.contact,
      deskAccountName: account.desk.accountName,
      hasDeskAccount: Boolean(account.desk.accountId),
      warnings: account.warnings,
    });
  })
);

// ------------------------------------------------------- troubleshooting

router.get('/ts/cases', (req, res) => res.json({ cases: troubleshoot.listCases() }));

router.post(
  '/ts/start',
  asyncRoute(async (req, res) => {
    res.json(troubleshoot.start(req.employee.id, Number(req.body?.caseId)));
  })
);

router.post(
  '/ts/answer',
  asyncRoute(async (req, res) => {
    res.json(troubleshoot.answer(String(req.body?.runId || ''), req.employee.id, Number(req.body?.optionId)));
  })
);

router.post(
  '/ts/back',
  asyncRoute(async (req, res) => {
    res.json(troubleshoot.back(String(req.body?.runId || ''), req.employee.id));
  })
);

router.post(
  '/ts/restart',
  asyncRoute(async (req, res) => {
    res.json(troubleshoot.restart(String(req.body?.runId || ''), req.employee.id));
  })
);

// ---------------------------------------------------------------- ticket

/** Preview: resolve, rewrite, generate the subject, render the real body. */
router.post(
  '/ticket/preview',
  asyncRoute(async (req, res) => {
    const preview = await tickets.buildPreview(req.employee, {
      crmUrl: req.body?.crmUrl,
      teamId: Number(req.body?.teamId) || null,
      classificationId: Number(req.body?.classificationId) || null,
      mode: req.body?.mode === 'troubleshooting' ? 'troubleshooting' : 'direct',
      runId: req.body?.runId || null,
      description: req.body?.description || '',
      descriptionEn: req.body?.descriptionEn || '',
      subject: req.body?.subject || '',
      prepared: req.body?.prepared || null,
    });
    delete preview._internal; // never leaves the server
    res.json(preview);
  })
);

/** Create. Idempotent on idempotencyKey. */
router.post(
  '/ticket/create',
  asyncRoute(async (req, res) => {
    const result = await tickets.createTicket(req.employee, {
      idempotencyKey: req.body?.idempotencyKey,
      crmUrl: req.body?.crmUrl,
      teamId: Number(req.body?.teamId) || null,
      classificationId: Number(req.body?.classificationId) || null,
      mode: req.body?.mode === 'troubleshooting' ? 'troubleshooting' : 'direct',
      runId: req.body?.runId || null,
      description: req.body?.description || '',
      descriptionEn: req.body?.descriptionEn || '',
      subject: req.body?.subject || '',
      prepared: req.body?.prepared || null,
    });
    res.json(result);
  })
);

/** Look up a previous submission, so a refresh mid-submit can recover. */
router.get('/ticket/submission/:key', (req, res) => {
  const row = db.prepare('SELECT * FROM submissions WHERE id = ?').get(req.params.key);
  if (!row) return res.status(404).json({ error: 'No such submission.' });
  res.json({
    status: row.status,
    ticketNumber: row.ticket_number,
    ticketId: row.ticket_id,
    ticketUrl: row.ticket_url,
    subject: row.subject,
    team: row.team_name,
    classification: row.classification,
    account: row.account_name,
    noteStatus: row.note_status,
    linkStatus: row.link_status,
  });
});

module.exports = router;
