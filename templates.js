'use strict';
/**
 * Ticket body rendering.
 *
 * The body is always rendered here, on the server, from the template stored in
 * the database. The browser never supplies the body - that is what guarantees
 * template fidelity no matter what the employee edits in the preview.
 */

const { db } = require('./db');

/** Tokens that describe a field with no source in CRM. */
const NOT_AVAILABLE = 'Not Available';
/** Tokens the employee simply did not supply. */
const NOT_PROVIDED = 'Not Provided';

const getTemplate = (key) => db.prepare('SELECT * FROM templates WHERE key = ?').get(key);

const listTemplates = () =>
  db.prepare('SELECT key, name, body, notes, updated_at FROM templates ORDER BY key').all();

function numberedList(items) {
  if (!Array.isArray(items) || !items.length) return null;
  return items.map((item, i) => `${i + 1}. ${item}`).join('\n');
}

function bulletList(items) {
  if (!Array.isArray(items) || !items.length) return null;
  return items.map((item) => `- ${item}`).join('\n');
}

/**
 * Render the troubleshooting section from the path actually walked.
 * `path` entries are { record_en } in the order the employee answered.
 */
function renderTroubleshooting(path, outcome) {
  if (!Array.isArray(path) || !path.length) return null;
  const steps = numberedList(path.map((entry) => entry.record_en));
  const result = OUTCOME_SENTENCE[outcome];
  return result ? `${steps}\n\nTroubleshooting Result\n${result}` : steps;
}

const OUTCOME_SENTENCE = {
  RESOLVED: 'The issue was resolved during troubleshooting.',
  PERSISTS: 'The issue persists after completing the troubleshooting steps.',
  PARTIAL: 'The issue was partially resolved after completing the troubleshooting steps.',
  UNKNOWN: 'The outcome could not be determined from the troubleshooting steps performed.',
};

const OUTCOME_LABEL = {
  RESOLVED: 'Issue Resolved',
  PERSISTS: 'Issue Persists',
  PARTIAL: 'Partially Resolved',
  UNKNOWN: 'Unable to Determine',
};

/**
 * Build the token map a template is rendered against.
 *
 * `account`   - the resolved CRM data from resolve.js
 * `prepared`  - the LLM output
 * `ts`        - { path, outcome } or null
 */
function buildTokens({ account, prepared, ts, evidenceAttached }) {
  const crm = account?.crm || {};
  const troubleshooting = ts ? renderTroubleshooting(ts.path, ts.outcome) : null;

  return {
    azeerName: crm.azeerName || crm.accountsName || NOT_AVAILABLE,
    accountsName: crm.accountsName || NOT_AVAILABLE,
    accountOwner: crm.accountOwner || NOT_AVAILABLE,
    accountManager: crm.accountManager || NOT_AVAILABLE,
    businessId: crm.businessId || NOT_AVAILABLE,
    whatsappBusinessId: crm.whatsappBusinessId || NOT_AVAILABLE,
    waba: crm.waba || NOT_AVAILABLE,
    platformName: crm.platformName || NOT_AVAILABLE,
    storeUrl: crm.storeUrl || NOT_AVAILABLE,
    chatbotName: crm.chatbotName || NOT_AVAILABLE,
    credUser: crm.credUser || NOT_AVAILABLE,
    credPass: crm.credPass || NOT_AVAILABLE,
    crmUrl: crm.crmCanonicalUrl || crm.crmUrl || NOT_AVAILABLE,
    contactName: account?.contact?.name || NOT_AVAILABLE,
    contactMobile: account?.contact?.mobile || NOT_AVAILABLE,
    contactEmail: account?.contact?.email || NOT_AVAILABLE,

    descriptionEn: prepared?.descriptionEn || NOT_PROVIDED,
    shortTitle: prepared?.shortTitle || prepared?.subject || NOT_PROVIDED,
    expectedResult: prepared?.expectedResult || NOT_PROVIDED,
    frequency: prepared?.frequency || 'Unknown',
    stepsToReproduce:
      numberedList(prepared?.stepsToReproduce) || 'Steps to reproduce were not provided.',
    troubleshooting: troubleshooting || 'No troubleshooting steps were provided.',
    evidence: evidenceAttached ? 'Attached.' : 'No evidence was provided.',

    frUseCase: prepared?.fr?.useCase || NOT_PROVIDED,
    frRequestedFeature: prepared?.fr?.requestedFeature || NOT_PROVIDED,
    frExpectedBenefit: prepared?.fr?.expectedBenefit || NOT_PROVIDED,
    frPriority: prepared?.fr?.priority || 'Not Specified',
  };
}

/** Replace {tokens}. Unknown tokens are left visible so a bad edit is obvious. */
function fill(body, tokens) {
  return body.replace(/\{([A-Za-z0-9_]+)\}/g, (match, name) =>
    Object.prototype.hasOwnProperty.call(tokens, name) ? String(tokens[name]) : match
  );
}

/**
 * Render a full ticket body.
 * Returns { text, html, templateKey }.
 */
function render(templateKey, context) {
  const template = getTemplate(templateKey) || getTemplate('GENERAL');
  if (!template) throw new Error(`Template "${templateKey}" not found and no GENERAL fallback exists.`);

  const tokens = buildTokens(context);
  let text = fill(template.body, tokens).replace(/\r\n/g, '\n').trimEnd();

  // Templates other than TECH have no troubleshooting slot. When the employee
  // walked a troubleshooting flow, append it rather than lose it.
  const hasSlot = /\{troubleshooting\}/.test(template.body);
  const walked = context.ts && Array.isArray(context.ts.path) && context.ts.path.length;
  if (!hasSlot && walked) {
    text += `\n\n-------------\nTroubleshooting Already Performed\n${renderTroubleshooting(
      context.ts.path,
      context.ts.outcome
    )}`;
  }

  return { text, html: toHtml(text), templateKey: template.key };
}

const escapeHtml = (value) =>
  String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/** Zoho Desk renders the description as HTML. Preserve the exact line layout. */
const toHtml = (text) =>
  `<div style="font-family:inherit;white-space:pre-wrap">${escapeHtml(text)}</div>`;

module.exports = {
  render,
  renderTroubleshooting,
  getTemplate,
  listTemplates,
  buildTokens,
  toHtml,
  escapeHtml,
  OUTCOME_SENTENCE,
  OUTCOME_LABEL,
  NOT_AVAILABLE,
  NOT_PROVIDED,
};
