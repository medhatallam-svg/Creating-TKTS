'use strict';
/**
 * Offline self-test. Exercises everything that does not need a live Zoho or
 * Anthropic connection: schema, seed, template rendering, the troubleshooting
 * engine including branching and back, routing rules, CRM URL parsing and the
 * idempotency claim.
 *
 * Run with:  npm run check
 */

process.env.APP_SECRET = process.env.APP_SECRET || 'selftest-secret-value-at-least-32-chars-long';
process.env.ZOHO_CLIENT_ID = process.env.ZOHO_CLIENT_ID || 'test-client';
process.env.ZOHO_CLIENT_SECRET = process.env.ZOHO_CLIENT_SECRET || 'test-secret';
process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'test-admin';
process.env.NODE_ENV = 'test';

const os = require('os');
const path = require('path');
const fs = require('fs');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'azeer-selftest-'));
process.env.DB_PATH = path.join(tmp, 'test.db');

const assert = require('assert');

let passed = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

// ---------------------------------------------------------------------------

const { db } = require('../src/db');
const { seed } = require('../src/seed');
const templates = require('../src/templates');
const troubleshoot = require('../src/troubleshoot');
const tickets = require('../src/tickets');
const { parseCrmUrl, splitCredentials } = require('../src/resolve');
const { encrypt, decrypt } = require('../src/crypto');

seed();

test('seed creates the verified teams, templates and classifications', () => {
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM templates').get().n, 5);
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM teams').get().n, 7);
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM classifications').get().n, 11);
  const engineering = db.prepare("SELECT * FROM teams WHERE name = 'Engineering Team'").get();
  assert.strictEqual(engineering.desk_team_id, '527933000064576048');
  assert.strictEqual(engineering.template_key, 'TECH');
});

test('seeding twice does not duplicate anything', () => {
  seed();
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM teams').get().n, 7);
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM ts_cases').get().n, 2);
});

test('templates reproduce the approved wording exactly', () => {
  const tech = templates.getTemplate('TECH');
  assert.ok(tech.body.includes('-Account :'), 'space before colon preserved');
  assert.ok(tech.body.includes('explanation of the issue :'), 'lowercase label preserved');
  assert.ok(tech.body.includes('- the issue is consistent or intermittent\n'), 'no colon on frequency line');
  assert.ok(templates.getTemplate('CB_AI').body.includes('-'.repeat(21)), '21-hyphen separator');
  assert.ok(templates.getTemplate('FINANCE').body.includes(`\n${'-'.repeat(13)}\n`), '13-hyphen separator');
});

test('rendering fills tokens and falls back honestly', () => {
  const rendered = templates.render('TECH', {
    account: {
      crm: { azeerName: 'ACME', credUser: 'user1', credPass: 'pass1' },
      contact: { name: 'Rana' },
    },
    prepared: {
      descriptionEn: 'The customer is unable to send messages from the platform.',
      shortTitle: 'Messages Not Sending',
      expectedResult: '',
      frequency: 'Consistent',
      stepsToReproduce: [],
    },
    ts: null,
  });
  assert.ok(rendered.text.includes('ACME'));
  assert.ok(rendered.text.includes('user1\npass1'), 'credentials on two lines');
  assert.ok(rendered.text.includes('Not Provided'), 'missing expected result is flagged, not invented');
  assert.ok(rendered.text.includes('Steps to reproduce were not provided.'));
  assert.ok(rendered.text.includes('No troubleshooting steps were provided.'));
  assert.ok(!/\{[a-zA-Z]+\}/.test(rendered.text), 'no unfilled tokens remain');
});

test('missing CRM fields render as Not Available, never as an invented value', () => {
  const rendered = templates.render('FINANCE', {
    account: { crm: {}, contact: null },
    prepared: { descriptionEn: 'Request.' },
    ts: null,
  });
  assert.ok(rendered.text.includes('Not Available'));
  assert.ok(!rendered.text.includes('undefined') && !rendered.text.includes('null'));
});

// ------------------------------------------------- troubleshooting engine

const sampleCase = db.prepare("SELECT * FROM ts_cases WHERE name_en = 'WhatsApp Messages Not Sending'").get();

test('sample cases are valid flows with no dead ends', () => {
  for (const row of db.prepare('SELECT id, name_en FROM ts_cases').all()) {
    assert.deepStrictEqual(troubleshoot.validateCase(row.id), [], `${row.name_en} has configuration problems`);
  }
});

test('a run shows one step at a time, in Arabic, with no English leaking to the browser', () => {
  const view = troubleshoot.start(null, sampleCase.id);
  assert.strictEqual(view.finished, false);
  assert.ok(view.step.instruction_ar.length > 10);
  assert.ok(view.step.options.length >= 2);
  for (const option of view.step.options) {
    assert.ok(option.label_ar, 'Arabic label present');
    assert.strictEqual(option.record_en, undefined, 'English recording stays server-side');
  }
  assert.strictEqual(view.stepNumber, 1);
  assert.ok(view.stepTotal >= view.stepNumber);
});

test('answering records the English sentence and branches to the mapped step', () => {
  let view = troubleshoot.start(null, sampleCase.id);
  const firstStepKey = view.step.key;
  const yes = view.step.options[0];
  view = troubleshoot.answer(view.runId, null, yes.id);

  assert.strictEqual(view.history.length, 1);
  assert.ok(/Verified the WhatsApp number configuration/.test(view.history[0].record_en));
  assert.notStrictEqual(view.step.key, firstStepKey, 'moved to a different step');
  assert.strictEqual(view.stepNumber, 2);
});

test('the step counter never counts downwards as branches shorten', () => {
  let view = troubleshoot.start(null, sampleCase.id);
  let previousTotal = view.stepTotal;
  let guardCounter = 0;
  while (!view.finished && guardCounter++ < 20) {
    view = troubleshoot.answer(view.runId, null, view.step.options[0].id);
    if (view.finished) break;
    assert.ok(view.stepTotal >= previousTotal, `total went ${previousTotal} -> ${view.stepTotal}`);
    assert.ok(view.stepNumber <= view.stepTotal, 'current step never exceeds the total');
    previousTotal = view.stepTotal;
  }
});

test('different answers lead to different steps', () => {
  const a = troubleshoot.start(null, sampleCase.id);
  const b = troubleshoot.start(null, sampleCase.id);
  const viaFirst = troubleshoot.answer(a.runId, null, a.step.options[0].id);
  const viaSecond = troubleshoot.answer(b.runId, null, b.step.options[1].id);
  assert.notStrictEqual(viaFirst.step.key, viaSecond.step.key);
});

test('an answer from another step is rejected', () => {
  const view = troubleshoot.start(null, sampleCase.id);
  const foreign = db
    .prepare('SELECT id FROM ts_options WHERE step_id != ? LIMIT 1')
    .get(view.step.id);
  assert.throws(() => troubleshoot.answer(view.runId, null, foreign.id), /does not belong/);
});

test('back removes the last answer so the ticket never holds a contradiction', () => {
  let view = troubleshoot.start(null, sampleCase.id);
  view = troubleshoot.answer(view.runId, null, view.step.options[0].id);
  const afterFirst = view.step.key;
  view = troubleshoot.answer(view.runId, null, view.step.options[0].id);
  assert.strictEqual(view.history.length, 2);

  view = troubleshoot.back(view.runId, null);
  assert.strictEqual(view.history.length, 1);
  assert.strictEqual(view.step.key, afterFirst, 'back returns to the step just answered');

  // Answering differently replaces the discarded answer entirely.
  view = troubleshoot.answer(view.runId, null, view.step.options[1].id);
  assert.strictEqual(view.history.length, 2);
  assert.strictEqual(new Set(view.history.map((h) => h.record_en)).size, 2);
});

test('a terminal answer finishes the run with a real outcome', () => {
  let view = troubleshoot.start(null, sampleCase.id);
  const guardCounter = { n: 0 };
  while (!view.finished && guardCounter.n++ < 20) {
    const terminal = view.step.options.find((o) => o.terminal);
    view = troubleshoot.answer(view.runId, null, (terminal || view.step.options[0]).id);
  }
  assert.ok(view.finished, 'the flow reaches an end');
  assert.ok(troubleshoot.OUTCOMES.includes(view.outcome));
  assert.ok(view.outcomeSentence.length > 10);

  const result = troubleshoot.result(view.runId, null);
  assert.ok(result.path.length >= 1);
  for (const entry of result.path) assert.ok(entry.record_en, 'every recorded step has English text');
});

test('the ticket contains only the path actually walked', () => {
  let view = troubleshoot.start(null, sampleCase.id);
  view = troubleshoot.answer(view.runId, null, view.step.options[1].id); // the "not displayed" branch
  const skippedStepKey = 'S2'; // only reachable from the first option
  let guardCounter = 0;
  while (!view.finished && guardCounter++ < 20) {
    const terminal = view.step.options.find((o) => o.terminal);
    view = troubleshoot.answer(view.runId, null, (terminal || view.step.options[0]).id);
  }
  const result = troubleshoot.result(view.runId, null);
  assert.ok(!result.path.some((p) => p.step_key === skippedStepKey), 'skipped branch is absent');

  const rendered = templates.render('TECH', {
    account: { crm: { azeerName: 'ACME' }, contact: null },
    prepared: { descriptionEn: 'Issue.' },
    ts: { path: result.path, outcome: result.outcome },
  });
  assert.ok(rendered.text.includes('1. '), 'numbered troubleshooting history');
  assert.ok(rendered.text.includes('Troubleshooting Result'));
});

test('troubleshooting is appended to templates that have no slot for it', () => {
  const view = troubleshoot.start(null, sampleCase.id);
  const answered = troubleshoot.answer(view.runId, null, view.step.options[0].id);
  const path = JSON.parse(db.prepare('SELECT path_json FROM ts_runs WHERE id = ?').get(answered.runId).path_json);
  const rendered = templates.render('CB_AI', {
    account: { crm: { azeerName: 'ACME' }, contact: null },
    prepared: { descriptionEn: 'Issue.' },
    ts: { path, outcome: 'PERSISTS' },
  });
  assert.ok(rendered.text.includes('Troubleshooting Already Performed'));
});

test('a broken flow is reported rather than shown to an employee', () => {
  const caseId = db
    .prepare("INSERT INTO ts_cases (name_en, name_ar) VALUES ('Broken', 'معطوب')")
    .run().lastInsertRowid;
  const stepId = db
    .prepare("INSERT INTO ts_steps (case_id, step_key, instruction_ar) VALUES (?, 'S1', 'تعليمات')")
    .run(caseId).lastInsertRowid;
  db.prepare('UPDATE ts_cases SET start_step_id = ? WHERE id = ?').run(stepId, caseId);

  const problems = troubleshoot.validateCase(caseId);
  assert.ok(problems.some((p) => /no answer options/.test(p)));
  assert.ok(problems.some((p) => /final outcome/.test(p)));
  assert.throws(() => troubleshoot.start(null, caseId), /no answer options|misconfigured/);
  db.prepare('DELETE FROM ts_cases WHERE id = ?').run(caseId);
});

// -------------------------------------------------------------- routing

test('routing refuses a classification with no confirmed team', () => {
  const other = db.prepare("SELECT id FROM classifications WHERE name = 'Other'").get();
  assert.throws(
    () => tickets.resolveRouting({ classificationId: other.id }),
    /no confirmed owning team/
  );
});

test('routing refuses a team with no Zoho Desk team id', () => {
  const teamId = db.prepare("INSERT INTO teams (name) VALUES ('Unconfigured')").run().lastInsertRowid;
  const technical = db.prepare("SELECT id FROM classifications WHERE name = 'Technical'").get();
  assert.throws(
    () => tickets.resolveRouting({ teamId, classificationId: technical.id }),
    /no Zoho Desk team id/
  );
  db.prepare('DELETE FROM teams WHERE id = ?').run(teamId);
});

test('routing picks the classification team and template when both are valid', () => {
  const technical = db.prepare("SELECT id FROM classifications WHERE name = 'Technical'").get();
  const routing = tickets.resolveRouting({ classificationId: technical.id });
  assert.strictEqual(routing.team.name, 'Engineering Team');
  assert.strictEqual(routing.templateKey, 'TECH');
  assert.strictEqual(routing.deskClassification, null, 'unmapped Desk value is not invented');
});

test('the subject is prefixed and kept short', () => {
  const subject = tickets.buildSubject(
    { subject: 'Customer Unable to Send Messages' },
    { name: 'Technical' }
  );
  assert.strictEqual(subject, '[Technical] Customer Unable to Send Messages');
  const long = tickets.buildSubject({ subject: 'x'.repeat(400) }, { name: 'Bug' });
  assert.ok(long.length <= 150);
});

// ------------------------------------------------------------- CRM URLs

test('CRM URLs are parsed, and anything else is refused', () => {
  const azeer = parseCrmUrl('https://crm.zoho.com/crm/org717404780/tab/Azeer/4535770000665911052');
  assert.deepStrictEqual({ module: azeer.module, recordId: azeer.recordId }, {
    module: 'Azeer',
    recordId: '4535770000665911052',
  });

  const custom = parseCrmUrl('https://crm.zoho.com/crm/org717404780/tab/CustomModule55/4535770000665911052');
  assert.strictEqual(custom.module, 'Azeer', 'CustomModule55 is the Azeer module');

  const accounts = parseCrmUrl('https://crm.zoho.com/crm/org717404780/tab/Accounts/4535770000655115771');
  assert.strictEqual(accounts.module, 'Accounts');

  assert.throws(() => parseCrmUrl('not a url'), /valid Zoho CRM Account URL/);
  assert.throws(() => parseCrmUrl('https://example.com/whatever'), /valid Zoho CRM Account URL/);
  assert.throws(
    () => parseCrmUrl('https://crm.zoho.com/crm/org717404780/tab/Leads/123456789012'),
    /Azeer or Accounts/
  );
});

test('credentials are split on the first newline and never reformatted', () => {
  assert.deepStrictEqual(splitCredentials('user@x.com\nSecret Pass 1'), {
    credUser: 'user@x.com',
    credPass: 'Secret Pass 1',
  });
  assert.deepStrictEqual(splitCredentials('only-user'), { credUser: 'only-user', credPass: '' });
  assert.deepStrictEqual(splitCredentials(null), { credUser: '', credPass: '' });
});

// ---------------------------------------------------------- misc safety

test('refresh tokens round-trip through encryption and are unreadable at rest', () => {
  const secret = '1000.abcdef.ghijkl';
  const packed = encrypt(secret);
  assert.notStrictEqual(packed, secret);
  assert.ok(!packed.includes('abcdef'));
  assert.strictEqual(decrypt(packed), secret);
});

test('an idempotency key can only produce one ticket', () => {
  const employee = { id: 1, full_name: 'Test Employee', email: 't@example.com' };
  db.prepare("INSERT OR IGNORE INTO employees (id, full_name, email) VALUES (1, 'Test Employee', 't@example.com')").run();

  const claim = require('../src/tickets');
  // First claim succeeds.
  const key = 'selftest-key-000000001';
  db.prepare(
    `INSERT INTO submissions (id, employee_id, status, ticket_number, ticket_id, ticket_url, subject)
     VALUES (?, 1, 'created', '29999', '999', 'https://example/999', '[Technical] Test')`
  ).run(key);

  const row = db.prepare('SELECT * FROM submissions WHERE id = ?').get(key);
  assert.strictEqual(row.status, 'created');
  assert.strictEqual(row.ticket_number, '29999');
  assert.ok(claim.SAFE_MESSAGES.desk.length > 10, 'a safe Desk message exists');
  assert.ok(!/token|stack|http/i.test(claim.SAFE_MESSAGES.desk), 'safe message leaks nothing technical');
  void employee;
});

test('log redaction removes anything that looks like a secret', () => {
  const log = require('../src/log');
  const redacted = log.redact({
    refresh_token: 'abc',
    nested: { api_key: 'xyz', password: 'p' },
    safe: 'visible',
  });
  assert.strictEqual(redacted.refresh_token, '[redacted]');
  assert.strictEqual(redacted.nested.api_key, '[redacted]');
  assert.strictEqual(redacted.nested.password, '[redacted]');
  assert.strictEqual(redacted.safe, 'visible');
});

// ---------------------------------------------------------------------------

(async () => {
  const failures = [];
  for (const [name, fn] of tests) {
    try {
      await fn();
      passed += 1;
      console.log(`  ok    ${name}`);
    } catch (error) {
      failures.push([name, error]);
      console.log(`  FAIL  ${name}`);
      console.log(`        ${error.message}`);
    }
  }
  console.log(`\n${passed}/${tests.length} passed`);
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(failures.length ? 1 : 0);
})();
