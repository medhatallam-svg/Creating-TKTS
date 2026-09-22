'use strict';
/**
 * The troubleshooting engine.
 *
 * A case is a directed graph. Each step shows one Arabic instruction and a set
 * of Arabic answer buttons. Every button carries the professional English
 * sentence that will appear on the ticket, and points either at the next step or
 * at a final outcome. The employee never chooses which step comes next.
 *
 * The walked path lives on the server. The browser is told only what to display,
 * so the ticket is always built from the path the engine recorded - not from
 * anything the browser could send back.
 */

const { db } = require('./db');
const { randomId } = require('./crypto');
const { OUTCOME_LABEL, OUTCOME_SENTENCE } = require('./templates');

const OUTCOMES = Object.keys(OUTCOME_LABEL);

class TsError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'TsError';
    this.code = code;
  }
}

// ------------------------------------------------------------------ reads

const listCases = () =>
  db
    .prepare(
      `SELECT c.id, c.name_en, c.name_ar, c.description_ar, c.sort,
              t.name AS team_name, cl.name AS classification_name,
              (SELECT COUNT(*) FROM ts_steps s WHERE s.case_id = c.id) AS step_count
         FROM ts_cases c
         LEFT JOIN teams t            ON t.id  = c.team_id
         LEFT JOIN classifications cl ON cl.id = c.classification_id
        WHERE c.active = 1 AND c.start_step_id IS NOT NULL
        ORDER BY c.sort, c.name_en`
    )
    .all();

const getCase = (caseId) => db.prepare('SELECT * FROM ts_cases WHERE id = ?').get(caseId);
const getStep = (stepId) => db.prepare('SELECT * FROM ts_steps WHERE id = ?').get(stepId);
const getOptions = (stepId) =>
  db.prepare('SELECT * FROM ts_options WHERE step_id = ? ORDER BY sort, id').all(stepId);

/**
 * Longest number of further steps reachable from `stepId`, so the employee can
 * be told "Step 3 of 7" honestly rather than with a made-up total. Cycles are
 * tolerated: a step already on the stack contributes nothing.
 */
function longestRemaining(stepId, seen = new Set()) {
  if (!stepId || seen.has(stepId)) return 0;
  seen.add(stepId);
  let best = 0;
  for (const option of getOptions(stepId)) {
    if (!option.next_step_id) continue;
    best = Math.max(best, 1 + longestRemaining(option.next_step_id, new Set(seen)));
  }
  return best;
}

// ------------------------------------------------------------------ runs

const parsePath = (run) => {
  try {
    return JSON.parse(run.path_json) || [];
  } catch {
    return [];
  }
};

function saveRun(run, path, { currentStepId, outcome, status, resetPeak }) {
  db.prepare(
    `UPDATE ts_runs
        SET path_json = ?, current_step_id = ?, outcome = ?, status = ?,
            peak_total = ?, updated_at = datetime('now')
      WHERE id = ?`
  ).run(
    JSON.stringify(path),
    currentStepId ?? null,
    outcome ?? null,
    status,
    resetPeak ? 0 : run.peak_total || 0,
    run.id
  );
}

/** What the browser renders. Arabic for the employee, English only in history. */
function view(run) {
  const kase = getCase(run.case_id);
  const path = parsePath(run);
  const history = path.map((entry, index) => ({
    n: index + 1,
    record_en: entry.record_en,
    label_ar: entry.label_ar,
    instruction_ar: entry.instruction_ar,
  }));

  const base = {
    runId: run.id,
    caseId: kase.id,
    caseName: kase.name_en,
    caseNameAr: kase.name_ar,
    stepsCompleted: path.length,
    history,
    canGoBack: path.length > 0,
  };

  if (run.status === 'finished') {
    return {
      ...base,
      finished: true,
      outcome: run.outcome,
      outcomeLabel: OUTCOME_LABEL[run.outcome] || run.outcome,
      outcomeSentence: OUTCOME_SENTENCE[run.outcome] || '',
      stepNumber: path.length,
      stepTotal: path.length,
    };
  }

  const step = getStep(run.current_step_id);
  if (!step) throw new TsError('This troubleshooting case is misconfigured.', 'broken_flow');

  const options = getOptions(step.id);
  if (!options.length) {
    throw new TsError(
      `Step "${step.step_key}" has no answer options. Add at least one in the admin panel.`,
      'broken_flow'
    );
  }

  // The honest estimate is "steps walked so far + the longest path still ahead".
  // Branches differ in length, so that number can shrink; the counter shown to
  // the employee keeps the highest estimate seen, and only drops when they go
  // back. A total that counted downwards would read as a bug.
  const stepNumber = path.length + 1;
  const estimate = stepNumber + longestRemaining(step.id);
  const stepTotal = Math.max(estimate, run.peak_total || 0);
  if (stepTotal !== run.peak_total) {
    db.prepare('UPDATE ts_runs SET peak_total = ? WHERE id = ?').run(stepTotal, run.id);
  }

  return {
    ...base,
    finished: false,
    stepNumber,
    stepTotal,
    step: {
      id: step.id,
      key: step.step_key,
      instruction_ar: step.instruction_ar,
      hint_ar: step.hint_ar || null,
      // Only the Arabic label reaches the browser; the English recording stays
      // on the server so it cannot be tampered with.
      options: options.map((o) => ({
        id: o.id,
        label_ar: o.label_ar,
        terminal: Boolean(o.outcome),
      })),
    },
  };
}

function start(employeeId, caseId) {
  const kase = getCase(caseId);
  if (!kase || !kase.active) throw new TsError('That troubleshooting case is not available.', 'no_case');
  if (!kase.start_step_id) {
    throw new TsError('That troubleshooting case has no first step yet.', 'broken_flow');
  }

  const id = randomId(18);
  db.prepare(
    `INSERT INTO ts_runs (id, employee_id, case_id, current_step_id, path_json, status)
     VALUES (?, ?, ?, ?, '[]', 'active')`
  ).run(id, employeeId, kase.id, kase.start_step_id);
  return view(db.prepare('SELECT * FROM ts_runs WHERE id = ?').get(id));
}

function load(runId, employeeId) {
  const run = db.prepare('SELECT * FROM ts_runs WHERE id = ?').get(runId);
  if (!run) throw new TsError('This troubleshooting session has expired. Please start again.', 'no_run');
  if (employeeId && run.employee_id && run.employee_id !== employeeId) {
    throw new TsError('This troubleshooting session belongs to another employee.', 'forbidden');
  }
  if (run.status === 'abandoned') {
    throw new TsError('This troubleshooting session has expired. Please start again.', 'no_run');
  }
  return run;
}

/** Record an answer and move to whatever that answer points at. */
function answer(runId, employeeId, optionId) {
  const run = load(runId, employeeId);
  if (run.status === 'finished') return view(run);

  const option = db.prepare('SELECT * FROM ts_options WHERE id = ?').get(optionId);
  // The option must belong to the step the run is actually on.
  if (!option || option.step_id !== run.current_step_id) {
    throw new TsError('That answer does not belong to the current step.', 'bad_option');
  }

  const step = getStep(run.current_step_id);
  const path = parsePath(run);
  path.push({
    step_id: step.id,
    step_key: step.step_key,
    instruction_ar: step.instruction_ar,
    option_id: option.id,
    label_ar: option.label_ar,
    record_en: option.record_en,
    at: new Date().toISOString(),
  });

  if (option.outcome && OUTCOMES.includes(option.outcome)) {
    saveRun(run, path, { currentStepId: null, outcome: option.outcome, status: 'finished' });
  } else if (option.next_step_id) {
    saveRun(run, path, { currentStepId: option.next_step_id, outcome: null, status: 'active' });
  } else {
    // An option with neither a next step nor an outcome is a configuration gap.
    // Close the run honestly rather than dead-ending the employee.
    saveRun(run, path, { currentStepId: null, outcome: 'UNKNOWN', status: 'finished' });
  }

  return view(db.prepare('SELECT * FROM ts_runs WHERE id = ?').get(run.id));
}

/**
 * Step back one answer. The popped entry is discarded, so a changed answer never
 * leaves a contradictory record on the ticket.
 */
function back(runId, employeeId) {
  const run = load(runId, employeeId);
  const path = parsePath(run);
  if (!path.length) return view(run);

  const last = path.pop();
  saveRun(run, path, { currentStepId: last.step_id, outcome: null, status: 'active', resetPeak: true });
  return view(db.prepare('SELECT * FROM ts_runs WHERE id = ?').get(run.id));
}

/** Restart the same case from step one, discarding the whole path. */
function restart(runId, employeeId) {
  const run = load(runId, employeeId);
  const kase = getCase(run.case_id);
  saveRun(run, [], { currentStepId: kase.start_step_id, outcome: null, status: 'active', resetPeak: true });
  return view(db.prepare('SELECT * FROM ts_runs WHERE id = ?').get(run.id));
}

/** The authoritative result used to build the ticket. */
function result(runId, employeeId) {
  const run = load(runId, employeeId);
  if (run.status !== 'finished') {
    throw new TsError('Finish the troubleshooting steps before creating the ticket.', 'unfinished');
  }
  const kase = getCase(run.case_id);
  return {
    runId: run.id,
    caseId: kase.id,
    caseName: kase.name_en,
    caseNameAr: kase.name_ar,
    teamId: kase.team_id,
    classificationId: kase.classification_id,
    outcome: run.outcome,
    outcomeLabel: OUTCOME_LABEL[run.outcome] || run.outcome,
    path: parsePath(run),
  };
}

// -------------------------------------------------------- admin-side check

/**
 * Report configuration problems in a case so the admin panel can show them
 * before an employee walks into a dead end.
 */
function validateCase(caseId) {
  const kase = getCase(caseId);
  if (!kase) return ['Case not found.'];
  const problems = [];
  const steps = db.prepare('SELECT * FROM ts_steps WHERE case_id = ? ORDER BY sort, id').all(caseId);

  if (!steps.length) problems.push('The case has no steps.');
  if (!kase.start_step_id) problems.push('No first step is set.');

  const reachable = new Set();
  const walk = (stepId) => {
    if (!stepId || reachable.has(stepId)) return;
    reachable.add(stepId);
    for (const option of getOptions(stepId)) if (option.next_step_id) walk(option.next_step_id);
  };
  walk(kase.start_step_id);

  for (const step of steps) {
    const options = getOptions(step.id);
    if (!options.length) problems.push(`Step ${step.step_key} has no answer options.`);
    for (const option of options) {
      if (!option.next_step_id && !option.outcome) {
        problems.push(`Step ${step.step_key}: the answer "${option.label_ar}" has no next step and no outcome.`);
      }
      if (option.outcome && !OUTCOMES.includes(option.outcome)) {
        problems.push(`Step ${step.step_key}: "${option.outcome}" is not a valid outcome.`);
      }
      if (!String(option.record_en || '').trim()) {
        problems.push(`Step ${step.step_key}: the answer "${option.label_ar}" has no English recording.`);
      }
    }
    if (!reachable.has(step.id)) problems.push(`Step ${step.step_key} cannot be reached from the first step.`);
  }

  // Every case must be able to end.
  const anyOutcome = steps.some((s) => getOptions(s.id).some((o) => o.outcome));
  if (steps.length && !anyOutcome) problems.push('No answer anywhere in this case leads to a final outcome.');

  return problems;
}

module.exports = {
  listCases,
  start,
  answer,
  back,
  restart,
  result,
  view,
  load,
  validateCase,
  longestRemaining,
  OUTCOMES,
  TsError,
};
