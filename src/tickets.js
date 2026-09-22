'use strict';
/**
 * Ticket construction and creation.
 *
 * Creating a ticket touches three systems in order: Zoho Desk, the CRM/Desk
 * association, and the CRM note. Only the first is allowed to fail the whole
 * operation. Once a ticket number exists it is never created twice, whatever
 * happens afterwards - the submission row is claimed before Zoho is called.
 */

const config = require('./config');
const { db } = require('./db');
const zoho = require('./zoho');
const llm = require('./llm');
const templates = require('./templates');
const troubleshoot = require('./troubleshoot');
const { resolveAccount } = require('./resolve');
const { errorRef } = require('./crypto');
const log = require('./log');

class TicketError extends Error {
  constructor(message, code, extra = {}) {
    super(message);
    this.name = 'TicketError';
    this.code = code;
    Object.assign(this, extra);
  }
}

/** Messages the employee is allowed to see. Nothing technical ever leaks. */
const SAFE_MESSAGES = {
  crm: 'Unable to retrieve the CRM account at the moment. Please try again.',
  desk: 'Unable to create the ticket. Please review the information and try again.',
  llm: 'Unable to prepare the English description at the moment. Please try again.',
  note: 'The ticket was created, but the CRM note could not be added.',
  unknown: 'Something went wrong. Please try again.',
};

// ------------------------------------------------------------- identities

/**
 * Decide which Zoho identity to use for each system.
 *
 * CRM always uses the employee's own token, so the note is genuinely authored by
 * them. Desk prefers the employee's token too, and falls back to the service
 * token when the employee has no Desk agent seat.
 */
function identitiesFor(employee) {
  const employeeToken = zoho.employeeRefreshToken(employee.id);
  if (!employeeToken) {
    throw new TicketError('Your Zoho sign-in has expired. Please sign in again.', 'reauth');
  }
  const seat = db
    .prepare('SELECT has_desk_seat FROM employee_tokens WHERE employee_id = ?')
    .get(employee.id);
  const serviceToken = zoho.serviceRefreshToken();

  return {
    crmToken: employeeToken,
    deskToken: seat && seat.has_desk_seat ? employeeToken : serviceToken || employeeToken,
    deskIsService: !(seat && seat.has_desk_seat) && Boolean(serviceToken),
  };
}

// ---------------------------------------------------------------- routing

const getTeam = (id) => db.prepare('SELECT * FROM teams WHERE id = ?').get(id);
const getClassification = (id) => db.prepare('SELECT * FROM classifications WHERE id = ?').get(id);

/**
 * Work out where the ticket goes. Refuses rather than guessing: a classification
 * flagged for review, or a team with no Desk team id, stops here.
 */
function resolveRouting({ teamId, classificationId }) {
  const classification = getClassification(classificationId);
  if (!classification || !classification.active) {
    throw new TicketError('Please select a Classification before creating the ticket.', 'no_classification');
  }
  if (classification.needs_review) {
    throw new TicketError(
      `The "${classification.name}" classification has no confirmed owning team yet. Set its team in the admin panel before using it.`,
      'needs_review'
    );
  }

  const team = getTeam(teamId || classification.team_id);
  if (!team || !team.active) {
    throw new TicketError('Please select a Team before creating the ticket.', 'no_team');
  }
  if (!team.desk_team_id) {
    throw new TicketError(
      `The team "${team.name}" has no Zoho Desk team id configured. Add it in the admin panel before using it.`,
      'missing_config'
    );
  }

  const templateKey = classification.template_key || team.template_key || 'GENERAL';
  if (!templates.getTemplate(templateKey)) {
    throw new TicketError(`Template "${templateKey}" does not exist.`, 'missing_config');
  }

  return {
    team,
    classification,
    templateKey,
    priority: classification.priority || null,
    ticketType: classification.ticket_type || null,
    // Only send the Classification field when the exact Desk value is known.
    deskClassification: classification.desk_value || null,
  };
}

// ---------------------------------------------------------------- subject

/** "[Technical] Customer Unable to Send Messages", trimmed to something sane. */
function buildSubject(prepared, classification) {
  const core = (prepared.subject || prepared.shortTitle || '').trim().replace(/\s+/g, ' ');
  const fallback = 'Support Request';
  const body = (core || fallback).slice(0, 110).replace(/[\s.]+$/, '');
  return `[${classification.name}] ${body}`.slice(0, 150);
}

// ---------------------------------------------------------------- preview

/**
 * Everything the employee sees before submitting: the resolved account, the
 * professional English, the generated subject and the exact rendered body.
 */
async function buildPreview(employee, input) {
  const identities = identitiesFor(employee);
  const routing = resolveRouting(input);

  const account = await resolveAccount(input.crmUrl, identities);

  let ts = null;
  if (input.mode === 'troubleshooting') {
    if (!input.runId) throw new TicketError('Complete the troubleshooting steps first.', 'no_run');
    const runResult = troubleshoot.result(input.runId, employee.id);
    ts = { path: runResult.path, outcome: runResult.outcome, caseName: runResult.caseName };
  }

  const description = String(input.description || '').trim();
  if (!description && !ts) {
    throw new TicketError('Please enter a problem or request description.', 'no_description');
  }

  // The employee may have corrected the English on a previous preview. Respect
  // that instead of rewriting it again.
  let prepared;
  if (input.descriptionEn && String(input.descriptionEn).trim()) {
    prepared = {
      ...(input.prepared || {}),
      descriptionEn: String(input.descriptionEn).trim(),
      subject: input.subject ? String(input.subject).trim() : input.prepared?.subject || '',
      shortTitle: input.prepared?.shortTitle || '',
      expectedResult: input.prepared?.expectedResult || '',
      frequency: input.prepared?.frequency || 'Unknown',
      stepsToReproduce: input.prepared?.stepsToReproduce || [],
      fr: input.prepared?.fr || { useCase: '', requestedFeature: '', expectedBenefit: '', priority: '' },
      degraded: false,
    };
    if (!prepared.subject) prepared.subject = prepared.descriptionEn.slice(0, 70);
  } else {
    prepared = await llm.prepare(description || ts?.caseName || '', {
      classification: routing.classification.name,
      team: routing.team.name,
      isFeatureRequest: routing.templateKey === 'FEATURE_REQUEST',
    });
  }

  const subject = input.subject ? String(input.subject).trim().slice(0, 150) : buildSubject(prepared, routing.classification);
  const body = templates.render(routing.templateKey, {
    account,
    prepared,
    ts,
    evidenceAttached: false,
  });

  return {
    account: {
      azeerName: account.crm.azeerName,
      accountsName: account.crm.accountsName,
      accountsId: account.crm.accountsId,
      azeerId: account.crm.azeerId,
      accountOwner: account.crm.accountOwner,
      accountManager: account.crm.accountManager,
      platformName: account.crm.platformName,
      waba: account.crm.waba,
      businessId: account.crm.businessId,
      crmUrl: account.crm.crmCanonicalUrl,
      deskAccountId: account.desk.accountId,
      deskAccountName: account.desk.accountName,
      contact: account.contact,
    },
    routing: {
      team: routing.team.name,
      teamId: routing.team.id,
      classification: routing.classification.name,
      classificationId: routing.classification.id,
      templateKey: routing.templateKey,
      priority: routing.priority,
      deskClassificationKnown: Boolean(routing.deskClassification),
    },
    prepared,
    subject,
    bodyText: body.text,
    troubleshooting: ts
      ? {
          caseName: ts.caseName,
          outcome: ts.outcome,
          outcomeLabel: templates.OUTCOME_LABEL[ts.outcome],
          steps: ts.path.map((entry, i) => ({ n: i + 1, record_en: entry.record_en })),
        }
      : null,
    warnings: account.warnings,
    // Carried back on submit so the body is rendered from the same inputs.
    _internal: { account, prepared, ts, routing: { templateKey: routing.templateKey } },
  };
}

// ----------------------------------------------------------- idempotency

/**
 * Claim the submission key before anything is created. Returns
 * { claimed: true } to proceed, or the already-known outcome.
 */
function claimSubmission(key, employee, meta) {
  const existing = db.prepare('SELECT * FROM submissions WHERE id = ?').get(key);

  if (existing) {
    if (existing.status === 'created' || existing.status === 'partial') {
      return { claimed: false, existing };
    }
    if (existing.status === 'claimed') {
      // A concurrent submit, or a crash mid-flight. Anything older than two
      // minutes is assumed dead and may be retried.
      const age = Date.now() - new Date(`${existing.updated_at.replace(' ', 'T')}Z`).getTime();
      if (age < 120_000) return { claimed: false, inFlight: true, existing };
    }
    db.prepare(
      `UPDATE submissions SET status='claimed', error_ref=NULL, error_stage=NULL, updated_at=datetime('now')
        WHERE id = ?`
    ).run(key);
    return { claimed: true, existing };
  }

  db.prepare(
    `INSERT INTO submissions
       (id, employee_id, status, mode, crm_url, account_name, account_id, team_name, classification, subject)
     VALUES (?, ?, 'claimed', ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    key,
    employee.id,
    meta.mode || null,
    meta.crmUrl || null,
    meta.accountName || null,
    meta.accountId || null,
    meta.teamName || null,
    meta.classification || null,
    meta.subject || null
  );
  return { claimed: true };
}

function updateSubmission(key, fields) {
  const columns = Object.keys(fields);
  if (!columns.length) return;
  const assignments = columns.map((c) => `${c} = ?`).join(', ');
  db.prepare(`UPDATE submissions SET ${assignments}, updated_at = datetime('now') WHERE id = ?`).run(
    ...columns.map((c) => fields[c]),
    key
  );
}

const submissionResult = (row) => ({
  ticketNumber: row.ticket_number,
  ticketId: row.ticket_id,
  ticketUrl: row.ticket_url,
  subject: row.subject,
  team: row.team_name,
  classification: row.classification,
  account: row.account_name,
  noteStatus: row.note_status,
  noteAuthor: row.note_author,
  linkStatus: row.link_status,
  cfStatus: row.cf_status,
  status: row.status,
  duplicate: true,
});

// ------------------------------------------------------------- CRM note

/**
 * Add the note to the CRM record under the employee's own Zoho identity.
 *
 * Zoho's Notes API does not accept Created_By, so the only way the note is truly
 * authored by the employee is to call the API with the employee's own token -
 * which is exactly what happens here. No note is ever written with the service
 * token, and the employee's name is never pasted into the body to imply
 * authorship.
 */
async function addCrmNote(crmToken, account, ticket, routing, employee) {
  const parentModule = account.crm.noteParentModule;
  const parentId = account.crm.noteParentId;
  if (!parentId) return { status: 'skipped', reason: 'no CRM record to attach to' };

  const lines = [
    `Ticket Number: ${ticket.ticketNumber}`,
    `Subject: ${ticket.subject}`,
    `Team: ${routing.team.name}`,
    `Classification: ${routing.classification.name}`,
    `Ticket URL: ${ticket.ticketUrl}`,
  ];

  const body = await zoho.crm(crmToken).post('/Notes', {
    data: [
      {
        Note_Title: 'Ticket Created',
        Note_Content: lines.join('\n'),
        Parent_Id: { id: String(parentId), module: { api_name: parentModule } },
      },
    ],
  });

  const detail = body?.data?.[0];
  if (detail?.code !== 'SUCCESS') {
    throw new TicketError(`Note creation returned ${detail?.code || 'no result'}`, 'note_failed');
  }
  log.info('note.created', { module: parentModule, employee: employee.email });
  return { status: 'ok', id: detail.details?.id || null, author: 'employee' };
}

// ------------------------------------------------------------- create

/**
 * Create the ticket. Stages after the Desk call are best-effort and reported
 * individually; none of them ever causes a second ticket.
 */
async function createTicket(employee, input) {
  const key = String(input.idempotencyKey || '').trim();
  if (!key || key.length < 12) {
    throw new TicketError('Missing submission key. Please reload the page and try again.', 'bad_key');
  }

  const identities = identitiesFor(employee);
  const routing = resolveRouting(input);

  // Re-resolve and re-render server-side. Nothing structural comes from the browser.
  const preview = await buildPreview(employee, input);
  const { account, prepared, ts } = preview._internal;

  const claim = claimSubmission(key, employee, {
    mode: input.mode,
    crmUrl: input.crmUrl,
    accountName: preview.account.azeerName || preview.account.accountsName,
    accountId: preview.account.accountsId,
    teamName: routing.team.name,
    classification: routing.classification.name,
    subject: preview.subject,
  });

  if (!claim.claimed) {
    if (claim.inFlight) {
      throw new TicketError('This ticket is already being created. Please wait a moment.', 'in_flight');
    }
    log.info('ticket.duplicate_suppressed', { key, ticket: claim.existing.ticket_number });
    return submissionResult(claim.existing);
  }

  // A contact is required for the ticket to land under the right CRM account.
  if (!account.desk.accountId) {
    updateSubmission(key, { status: 'failed', error_stage: 'resolve' });
    throw new TicketError(
      'No matching Zoho Desk account was found for this customer, so the ticket cannot be linked. Check the CRM URL.',
      'no_desk_account'
    );
  }

  const body = templates.render(routing.templateKey, {
    account,
    prepared,
    ts,
    evidenceAttached: false,
  });

  const desk = zoho.desk(identities.deskToken);
  let ticket;

  // ---- stage 1: the ticket itself. A failure here is a clean failure.
  try {
    const payload = {
      departmentId: config.ZOHO.DESK_DEPARTMENT_ID,
      layoutId: config.ZOHO.DESK_LAYOUT_ID,
      accountId: account.desk.accountId,
      teamId: routing.team.desk_team_id,
      subject: preview.subject,
      description: body.html,
      status: 'Open',
      channel: 'Web',
    };
    if (account.contact?.id) payload.contactId = account.contact.id;
    if (routing.priority) payload.priority = routing.priority;
    if (routing.ticketType) payload.ticketType = routing.ticketType;
    if (routing.deskClassification) payload.classification = routing.deskClassification;

    const created = await desk.post('/tickets', payload);
    ticket = {
      ticketId: created.id,
      ticketNumber: created.ticketNumber,
      ticketUrl: zoho.ticketUrl(created.id),
      subject: preview.subject,
      raw: created,
    };
  } catch (error) {
    const ref = errorRef();
    log.error('ticket.create_failed', { ref, key, status: error.status, body: error.body });
    updateSubmission(key, { status: 'failed', error_ref: ref, error_stage: 'desk' });
    throw new TicketError(SAFE_MESSAGES.desk, 'desk_failed', { ref });
  }

  updateSubmission(key, {
    status: 'partial',
    ticket_id: ticket.ticketId,
    ticket_number: ticket.ticketNumber,
    ticket_url: ticket.ticketUrl,
  });

  // ---- stage 2: the custom field. createTicket silently ignores `cf`, so it
  // needs its own PATCH, and the value must be read back to be believed.
  let cfStatus = 'failed';
  try {
    await desk.patch(`/tickets/${ticket.ticketId}`, {
      cf: { cf_ticket_creator: employee.full_name },
    });
    const readBack = await desk.get(`/tickets/${ticket.ticketId}`, { include: 'contacts' });
    cfStatus = readBack?.cf?.cf_ticket_creator ? 'ok' : 'failed';
    if (cfStatus !== 'ok') log.warn('ticket.cf_not_persisted', { ticket: ticket.ticketNumber });
  } catch (error) {
    log.warn('ticket.cf_failed', { ticket: ticket.ticketNumber, status: error.status });
  }

  // ---- stage 3: confirm the CRM <-> Desk association actually holds.
  let linkStatus = 'unknown';
  try {
    const deskAccount = await desk.get(`/accounts/${account.desk.accountId}`);
    const linkedCrmId = deskAccount?.zohoCRMAccount?.id || null;
    linkStatus =
      linkedCrmId && account.crm.accountsId && String(linkedCrmId) === String(account.crm.accountsId)
        ? 'linked'
        : 'unlinked';
  } catch (error) {
    log.warn('ticket.link_check_failed', { ticket: ticket.ticketNumber, status: error.status });
  }

  // ---- stage 4: the CRM note, under the employee's own identity.
  let note = { status: 'failed', author: 'employee' };
  try {
    note = await addCrmNote(identities.crmToken, account, ticket, routing, employee);
  } catch (error) {
    const ref = errorRef();
    log.error('note.failed', { ref, ticket: ticket.ticketNumber, status: error.status, body: error.body });
    note = { status: 'failed', author: 'employee', ref };
  }

  const finalStatus =
    note.status === 'ok' && linkStatus === 'linked' && cfStatus === 'ok' ? 'created' : 'partial';

  updateSubmission(key, {
    status: finalStatus,
    note_id: note.id || null,
    note_status: note.status,
    note_author: note.author || null,
    link_status: linkStatus,
    cf_status: cfStatus,
  });

  log.audit('ticket.created', {
    employee,
    entity: ticket.ticketNumber,
    detail: {
      account: preview.account.azeerName,
      team: routing.team.name,
      classification: routing.classification.name,
      mode: input.mode,
      note: note.status,
      link: linkStatus,
      cf: cfStatus,
    },
  });

  if (input.mode === 'troubleshooting' && input.runId) {
    db.prepare("UPDATE ts_runs SET status='finished', updated_at=datetime('now') WHERE id = ?").run(input.runId);
  }

  return {
    ticketNumber: ticket.ticketNumber,
    ticketId: ticket.ticketId,
    ticketUrl: ticket.ticketUrl,
    subject: preview.subject,
    team: routing.team.name,
    classification: routing.classification.name,
    account: preview.account.azeerName || preview.account.accountsName,
    noteStatus: note.status,
    noteAuthor: note.author || 'employee',
    noteMessage:
      note.status === 'ok'
        ? null
        : note.status === 'skipped'
          ? 'No CRM record was available to attach a note to.'
          : SAFE_MESSAGES.note,
    linkStatus,
    cfStatus,
    status: finalStatus,
    deskIdentity: identities.deskIsService ? 'service' : 'employee',
    duplicate: false,
  };
}

module.exports = {
  buildPreview,
  createTicket,
  resolveRouting,
  buildSubject,
  TicketError,
  SAFE_MESSAGES,
};
