'use strict';
/**
 * Admin API: employees, teams, classifications, templates, troubleshooting
 * cases, the audit log, and a live sync that pulls the real Zoho departments,
 * teams, agents and Classification picklist values.
 *
 * Nothing here invents a Zoho identifier. The sync shows what Zoho actually has
 * so the mapping can be made from real values.
 */

const express = require('express');
const config = require('../config');
const { db, meta } = require('../db');
const zoho = require('../zoho');
const troubleshoot = require('../troubleshoot');
const log = require('../log');
const { requireAdmin } = require('./auth');

const router = express.Router();
router.use(requireAdmin);

const asyncRoute = (handler) => (req, res) =>
  Promise.resolve(handler(req, res)).catch((error) => {
    log.error('admin.failed', { message: error.message, status: error.status, body: error.body });
    res.status(error.status === 400 ? 400 : 500).json({
      error: error.publicMessage || 'The action could not be completed.',
      detail: config.NODE_ENV === 'production' ? undefined : error.message,
    });
  });

const bad = (res, message) => res.status(400).json({ error: message });
const bool = (value) => (value ? 1 : 0);
const str = (value) => (value === undefined || value === null || value === '' ? null : String(value).trim());

/** Build an UPDATE from a whitelist of columns present in the body. */
function patch(table, id, body, allowed) {
  const fields = allowed.filter((c) => Object.prototype.hasOwnProperty.call(body, c));
  if (!fields.length) return false;
  const assignments = fields.map((c) => `${c} = ?`).join(', ');
  const values = fields.map((c) => {
    const value = body[c];
    if (['active', 'needs_review', 'is_admin'].includes(c)) return bool(value);
    if (['sort', 'team_id', 'classification_id', 'start_step_id', 'next_step_id', 'step_id', 'case_id'].includes(c)) {
      return value === null || value === '' ? null : Number(value);
    }
    return str(value);
  });
  db.prepare(`UPDATE ${table} SET ${assignments} WHERE id = ?`).run(...values, id);
  return true;
}

// ------------------------------------------------------------- employees

router.get('/employees', (req, res) => {
  res.json({
    employees: db
      .prepare(
        `SELECT e.id, e.full_name, e.email, e.zoho_user_id, e.desk_agent_id, e.is_admin, e.active,
                e.last_seen_at, e.created_at,
                (t.employee_id IS NOT NULL) AS connected,
                COALESCE(t.has_desk_seat, 0) AS has_desk_seat
           FROM employees e
           LEFT JOIN employee_tokens t ON t.employee_id = e.id
          ORDER BY e.active DESC, e.full_name`
      )
      .all()
      .map((e) => ({ ...e, connected: Boolean(e.connected), has_desk_seat: Boolean(e.has_desk_seat) })),
  });
});

/**
 * Pre-create an employee. They still have to sign in with Zoho themselves
 * before they can raise a ticket - that is what makes the CRM note theirs.
 */
router.post('/employees', (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const name = String(req.body?.full_name || '').trim();
  if (!email || !name) return bad(res, 'Name and email are required.');
  if (db.prepare('SELECT id FROM employees WHERE lower(email) = ?').get(email)) {
    return bad(res, 'An employee with that email already exists.');
  }
  const id = db
    .prepare('INSERT INTO employees (full_name, email, zoho_user_id, is_admin) VALUES (?, ?, ?, ?)')
    .run(name, email, str(req.body?.zoho_user_id), bool(req.body?.is_admin)).lastInsertRowid;
  log.audit('admin.employee.create', { employee: req.employee, entity: email });
  res.json({ id });
});

router.patch('/employees/:id', (req, res) => {
  patch('employees', Number(req.params.id), req.body, ['full_name', 'email', 'zoho_user_id', 'is_admin', 'active']);
  if (req.body?.active === false) {
    db.prepare('DELETE FROM sessions WHERE employee_id = ?').run(Number(req.params.id));
  }
  log.audit('admin.employee.update', { employee: req.employee, entity: req.params.id, detail: req.body });
  res.json({ ok: true });
});

/** Forget an employee's Zoho token without deleting their history. */
router.post('/employees/:id/disconnect', (req, res) => {
  zoho.revokeEmployeeToken(Number(req.params.id));
  db.prepare('DELETE FROM sessions WHERE employee_id = ?').run(Number(req.params.id));
  log.audit('admin.employee.disconnect', { employee: req.employee, entity: req.params.id });
  res.json({ ok: true });
});

// ------------------------------------------------------------------ teams

router.get('/teams', (req, res) => {
  res.json({ teams: db.prepare('SELECT * FROM teams ORDER BY sort, name').all() });
});

router.post('/teams', (req, res) => {
  const name = String(req.body?.name || '').trim();
  if (!name) return bad(res, 'Team name is required.');
  if (db.prepare('SELECT id FROM teams WHERE name = ?').get(name)) return bad(res, 'That team already exists.');
  const id = db
    .prepare('INSERT INTO teams (name, name_ar, desk_team_id, template_key, sort) VALUES (?, ?, ?, ?, ?)')
    .run(name, str(req.body?.name_ar), str(req.body?.desk_team_id), str(req.body?.template_key) || 'GENERAL', Number(req.body?.sort) || 100)
    .lastInsertRowid;
  log.audit('admin.team.create', { employee: req.employee, entity: name });
  res.json({ id });
});

router.patch('/teams/:id', (req, res) => {
  patch('teams', Number(req.params.id), req.body, ['name', 'name_ar', 'desk_team_id', 'template_key', 'active', 'sort']);
  log.audit('admin.team.update', { employee: req.employee, entity: req.params.id, detail: req.body });
  res.json({ ok: true });
});

router.delete('/teams/:id', (req, res) => {
  // Deactivate rather than delete, so existing tickets keep their reference.
  db.prepare('UPDATE teams SET active = 0 WHERE id = ?').run(Number(req.params.id));
  log.audit('admin.team.deactivate', { employee: req.employee, entity: req.params.id });
  res.json({ ok: true });
});

// -------------------------------------------------------- classifications

router.get('/classifications', (req, res) => {
  res.json({
    classifications: db
      .prepare(
        `SELECT c.*, t.name AS team_name FROM classifications c
           LEFT JOIN teams t ON t.id = c.team_id ORDER BY c.sort, c.name`
      )
      .all(),
  });
});

router.post('/classifications', (req, res) => {
  const name = String(req.body?.name || '').trim();
  if (!name) return bad(res, 'Classification name is required.');
  if (db.prepare('SELECT id FROM classifications WHERE name = ?').get(name)) {
    return bad(res, 'That classification already exists.');
  }
  const id = db
    .prepare(
      `INSERT INTO classifications (name, name_ar, desk_value, team_id, template_key, priority, ticket_type, needs_review, sort)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      name,
      str(req.body?.name_ar),
      str(req.body?.desk_value),
      req.body?.team_id ? Number(req.body.team_id) : null,
      str(req.body?.template_key),
      str(req.body?.priority),
      str(req.body?.ticket_type),
      bool(req.body?.needs_review),
      Number(req.body?.sort) || 100
    ).lastInsertRowid;
  log.audit('admin.classification.create', { employee: req.employee, entity: name });
  res.json({ id });
});

router.patch('/classifications/:id', (req, res) => {
  patch('classifications', Number(req.params.id), req.body, [
    'name', 'name_ar', 'desk_value', 'team_id', 'template_key', 'priority', 'ticket_type', 'needs_review', 'active', 'sort',
  ]);
  log.audit('admin.classification.update', { employee: req.employee, entity: req.params.id, detail: req.body });
  res.json({ ok: true });
});

router.delete('/classifications/:id', (req, res) => {
  db.prepare('UPDATE classifications SET active = 0 WHERE id = ?').run(Number(req.params.id));
  log.audit('admin.classification.deactivate', { employee: req.employee, entity: req.params.id });
  res.json({ ok: true });
});

// -------------------------------------------------------------- templates

router.get('/templates', (req, res) => {
  res.json({ templates: db.prepare('SELECT * FROM templates ORDER BY key').all() });
});

router.put('/templates/:key', (req, res) => {
  const key = String(req.params.key).trim().toUpperCase();
  const body = String(req.body?.body || '');
  if (!body.trim()) return bad(res, 'The template body cannot be empty.');
  db.prepare(
    `INSERT INTO templates (key, name, body, notes, updated_at)
     VALUES (?, ?, ?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET
       name = excluded.name, body = excluded.body, notes = excluded.notes, updated_at = datetime('now')`
  ).run(key, String(req.body?.name || key), body, str(req.body?.notes));
  log.audit('admin.template.update', { employee: req.employee, entity: key });
  res.json({ ok: true });
});

// ------------------------------------------------------- troubleshooting

const caseWithSteps = (caseId) => {
  const kase = db.prepare('SELECT * FROM ts_cases WHERE id = ?').get(caseId);
  if (!kase) return null;
  const steps = db.prepare('SELECT * FROM ts_steps WHERE case_id = ? ORDER BY sort, id').all(caseId);
  const options = db
    .prepare(
      `SELECT o.*, s2.step_key AS next_step_key FROM ts_options o
         LEFT JOIN ts_steps s2 ON s2.id = o.next_step_id
        WHERE o.step_id IN (SELECT id FROM ts_steps WHERE case_id = ?)
        ORDER BY o.sort, o.id`
    )
    .all(caseId);
  return {
    ...kase,
    steps: steps.map((s) => ({ ...s, options: options.filter((o) => o.step_id === s.id) })),
    problems: troubleshoot.validateCase(caseId),
  };
};

router.get('/ts/cases', (req, res) => {
  const cases = db.prepare('SELECT * FROM ts_cases ORDER BY sort, name_en').all();
  res.json({
    cases: cases.map((c) => ({
      ...c,
      step_count: db.prepare('SELECT COUNT(*) AS n FROM ts_steps WHERE case_id = ?').get(c.id).n,
      problems: troubleshoot.validateCase(c.id),
    })),
  });
});

router.get('/ts/cases/:id', (req, res) => {
  const kase = caseWithSteps(Number(req.params.id));
  if (!kase) return res.status(404).json({ error: 'Case not found.' });
  res.json({ case: kase });
});

router.post('/ts/cases', (req, res) => {
  const nameEn = String(req.body?.name_en || '').trim();
  const nameAr = String(req.body?.name_ar || '').trim();
  if (!nameEn || !nameAr) return bad(res, 'Both the English and Arabic case names are required.');
  const id = db
    .prepare(
      `INSERT INTO ts_cases (name_en, name_ar, description_ar, team_id, classification_id, sort)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(
      nameEn,
      nameAr,
      str(req.body?.description_ar),
      req.body?.team_id ? Number(req.body.team_id) : null,
      req.body?.classification_id ? Number(req.body.classification_id) : null,
      Number(req.body?.sort) || 100
    ).lastInsertRowid;
  log.audit('admin.ts_case.create', { employee: req.employee, entity: nameEn });
  res.json({ id });
});

router.patch('/ts/cases/:id', (req, res) => {
  patch('ts_cases', Number(req.params.id), req.body, [
    'name_en', 'name_ar', 'description_ar', 'team_id', 'classification_id', 'start_step_id', 'active', 'sort',
  ]);
  log.audit('admin.ts_case.update', { employee: req.employee, entity: req.params.id });
  res.json({ ok: true, problems: troubleshoot.validateCase(Number(req.params.id)) });
});

router.delete('/ts/cases/:id', (req, res) => {
  db.prepare('DELETE FROM ts_cases WHERE id = ?').run(Number(req.params.id));
  log.audit('admin.ts_case.delete', { employee: req.employee, entity: req.params.id });
  res.json({ ok: true });
});

router.post('/ts/cases/:id/steps', (req, res) => {
  const caseId = Number(req.params.id);
  const stepKey = String(req.body?.step_key || '').trim();
  const instruction = String(req.body?.instruction_ar || '').trim();
  if (!stepKey || !instruction) return bad(res, 'A step key and an Arabic instruction are required.');
  if (db.prepare('SELECT id FROM ts_steps WHERE case_id = ? AND step_key = ?').get(caseId, stepKey)) {
    return bad(res, 'That step key is already used in this case.');
  }
  const id = db
    .prepare('INSERT INTO ts_steps (case_id, step_key, instruction_ar, hint_ar, sort) VALUES (?, ?, ?, ?, ?)')
    .run(caseId, stepKey, instruction, str(req.body?.hint_ar), Number(req.body?.sort) || 100).lastInsertRowid;

  // The first step created becomes the entry point unless one is already set.
  const kase = db.prepare('SELECT start_step_id FROM ts_cases WHERE id = ?').get(caseId);
  if (!kase.start_step_id) db.prepare('UPDATE ts_cases SET start_step_id = ? WHERE id = ?').run(id, caseId);

  res.json({ id });
});

router.patch('/ts/steps/:id', (req, res) => {
  patch('ts_steps', Number(req.params.id), req.body, ['step_key', 'instruction_ar', 'hint_ar', 'sort']);
  res.json({ ok: true });
});

router.delete('/ts/steps/:id', (req, res) => {
  db.prepare('DELETE FROM ts_steps WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: true });
});

router.post('/ts/steps/:id/options', (req, res) => {
  const stepId = Number(req.params.id);
  const label = String(req.body?.label_ar || '').trim();
  const record = String(req.body?.record_en || '').trim();
  if (!label) return bad(res, 'The Arabic answer label is required.');
  if (!record) return bad(res, 'The professional English recording is required for every answer.');

  const outcome = str(req.body?.outcome);
  if (outcome && !troubleshoot.OUTCOMES.includes(outcome)) {
    return bad(res, `Outcome must be one of ${troubleshoot.OUTCOMES.join(', ')}.`);
  }
  const nextStepId = req.body?.next_step_id ? Number(req.body.next_step_id) : null;
  if (!outcome && !nextStepId) {
    return bad(res, 'Every answer must lead either to a next step or to a final outcome.');
  }

  const id = db
    .prepare('INSERT INTO ts_options (step_id, label_ar, record_en, next_step_id, outcome, sort) VALUES (?, ?, ?, ?, ?, ?)')
    .run(stepId, label, record, outcome ? null : nextStepId, outcome, Number(req.body?.sort) || 100).lastInsertRowid;
  res.json({ id });
});

router.patch('/ts/options/:id', (req, res) => {
  const outcome = req.body?.outcome;
  if (outcome && !troubleshoot.OUTCOMES.includes(String(outcome))) {
    return bad(res, `Outcome must be one of ${troubleshoot.OUTCOMES.join(', ')}.`);
  }
  if (Object.prototype.hasOwnProperty.call(req.body, 'record_en') && !String(req.body.record_en || '').trim()) {
    return bad(res, 'The professional English recording cannot be empty.');
  }
  // An answer is either a jump or an ending, never both.
  if (outcome) req.body.next_step_id = null;
  patch('ts_options', Number(req.params.id), req.body, ['label_ar', 'record_en', 'next_step_id', 'outcome', 'sort']);
  res.json({ ok: true });
});

router.delete('/ts/options/:id', (req, res) => {
  db.prepare('DELETE FROM ts_options WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: true });
});

// ----------------------------------------------------------- zoho sync

/**
 * Read the live Zoho configuration so mappings are made from real values.
 * Uses the admin's own token, falling back to the service token.
 */
router.post(
  '/sync',
  asyncRoute(async (req, res) => {
    const token = zoho.employeeRefreshToken(req.employee.id) || zoho.serviceRefreshToken();
    if (!token) {
      return res.status(400).json({ error: 'No Zoho credentials are available for the sync.' });
    }
    const desk = zoho.desk(token);
    const result = {};
    const errors = [];

    const save = (kind, data) => {
      db.prepare(
        `INSERT INTO zoho_sync (kind, data_json, synced_at) VALUES (?, ?, datetime('now'))
         ON CONFLICT(kind) DO UPDATE SET data_json = excluded.data_json, synced_at = datetime('now')`
      ).run(kind, JSON.stringify(data));
      result[kind] = data;
    };

    try {
      const body = await desk.get('/departments', { limit: 100 });
      save('departments', (body?.data || []).map((d) => ({ id: d.id, name: d.name, isEnabled: d.isEnabled })));
    } catch (error) {
      errors.push(`Departments: ${error.status || error.message}`);
    }

    try {
      const body = await desk.get('/teams', { departmentId: config.ZOHO.DESK_DEPARTMENT_ID });
      save('teams', (body?.data || []).map((t) => ({ id: t.id, name: t.name })));
    } catch (error) {
      errors.push(`Teams: ${error.status || error.message}`);
    }

    try {
      const body = await desk.get('/agents', { limit: 200, status: 'ACTIVE' });
      save(
        'agents',
        (body?.data || []).map((a) => ({
          id: a.id,
          name: [a.firstName, a.lastName].filter(Boolean).join(' ') || a.emailId,
          email: a.emailId,
        }))
      );
    } catch (error) {
      errors.push(`Agents: ${error.status || error.message}`);
    }

    // The real Classification picklist for the Azeer ticket layout.
    try {
      const body = await desk.get('/ticketsFields', {
        departmentId: config.ZOHO.DESK_DEPARTMENT_ID,
        layoutId: config.ZOHO.DESK_LAYOUT_ID,
      });
      const fields = body?.data || body || [];
      const field = (Array.isArray(fields) ? fields : []).find(
        (f) => f.apiName === 'classification' || /classification/i.test(f.displayLabel || '')
      );
      const values = (field?.allowedValues || [])
        .filter((v) => v.isSystemDefault !== false || true)
        .map((v) => v.value ?? v.name ?? v);
      save('classifications', values);

      const priorityField = (Array.isArray(fields) ? fields : []).find((f) => f.apiName === 'priority');
      if (priorityField?.allowedValues) {
        const priorities = priorityField.allowedValues.map((v) => v.value ?? v.name ?? v);
        save('priorities', priorities);
        meta('priorities', JSON.stringify(priorities));
      }
    } catch (error) {
      errors.push(`Ticket fields: ${error.status || error.message}`);
    }

    log.audit('admin.sync', { employee: req.employee, detail: { kinds: Object.keys(result), errors } });
    res.json({ synced: result, errors, syncedAt: new Date().toISOString() });
  })
);

router.get('/sync', (req, res) => {
  const rows = db.prepare('SELECT kind, data_json, synced_at FROM zoho_sync').all();
  const out = {};
  for (const row of rows) {
    try {
      out[row.kind] = { data: JSON.parse(row.data_json), syncedAt: row.synced_at };
    } catch {
      out[row.kind] = { data: [], syncedAt: row.synced_at };
    }
  }
  res.json({ sync: out });
});

// ------------------------------------------------------- audit and runs

router.get('/audit', (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 200, 1000);
  res.json({
    audit: db.prepare('SELECT * FROM audit_log ORDER BY at DESC LIMIT ?').all(limit),
    submissions: db
      .prepare(
        `SELECT s.*, e.full_name AS employee_name FROM submissions s
           LEFT JOIN employees e ON e.id = s.employee_id
          ORDER BY s.created_at DESC LIMIT ?`
      )
      .all(limit),
  });
});

router.get('/health', (req, res) => {
  res.json({
    config: {
      zohoConfigured: Boolean(config.ZOHO.CLIENT_ID && config.ZOHO.CLIENT_SECRET),
      serviceTokenPresent: Boolean(config.ZOHO.SERVICE_REFRESH_TOKEN),
      aiConfigured: Boolean(config.AI.API_KEY),
      departmentId: config.ZOHO.DESK_DEPARTMENT_ID,
      layoutId: config.ZOHO.DESK_LAYOUT_ID,
      includeCredentials: config.INCLUDE_CREDENTIALS,
    },
    counts: {
      employees: db.prepare('SELECT COUNT(*) AS n FROM employees WHERE active = 1').get().n,
      connected: db.prepare('SELECT COUNT(*) AS n FROM employee_tokens').get().n,
      teams: db.prepare('SELECT COUNT(*) AS n FROM teams WHERE active = 1').get().n,
      classifications: db.prepare('SELECT COUNT(*) AS n FROM classifications WHERE active = 1').get().n,
      unmappedClassifications: db
        .prepare("SELECT COUNT(*) AS n FROM classifications WHERE active = 1 AND (desk_value IS NULL OR desk_value = '')")
        .get().n,
      blockedClassifications: db
        .prepare('SELECT COUNT(*) AS n FROM classifications WHERE active = 1 AND needs_review = 1')
        .get().n,
      cases: db.prepare('SELECT COUNT(*) AS n FROM ts_cases WHERE active = 1').get().n,
      tickets: db.prepare("SELECT COUNT(*) AS n FROM submissions WHERE status IN ('created','partial')").get().n,
    },
  });
});

module.exports = router;
