'use strict';
/**
 * Server-side logging and the audit trail.
 *
 * Technical detail stays here. What reaches the employee is one of a handful of
 * plain sentences plus a short reference that can be matched to a log line.
 */

const config = require('./config');

/** Keys whose values must never be written to the log. */
const SECRET_KEYS = /(token|secret|password|authorization|credential|api[-_]?key|refresh)/i;

function redact(value, depth = 0) {
  if (depth > 6) return '[deep]';
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return value.length > 500 ? `${value.slice(0, 500)}...` : value;
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.slice(0, 25).map((v) => redact(v, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = SECRET_KEYS.test(k) ? '[redacted]' : redact(v, depth + 1);
  }
  return out;
}

function emit(level, event, detail) {
  const line = {
    at: new Date().toISOString(),
    level,
    event,
    ...(detail ? { detail: redact(detail) } : {}),
  };
  const text = JSON.stringify(line);
  if (level === 'error') console.error(text);
  else console.log(text);
}

const log = {
  info: (event, detail) => emit('info', event, detail),
  warn: (event, detail) => emit('warn', event, detail),
  error: (event, detail) => emit('error', event, detail),
  debug: (event, detail) => {
    if (config.NODE_ENV !== 'production') emit('debug', event, detail);
  },
};

/**
 * Append to the audit table. Deliberately records what happened, not the
 * contents of the customer's problem description.
 */
function audit(action, { employee, entity, detail } = {}) {
  try {
    const { db } = require('./db');
    db.prepare(
      `INSERT INTO audit_log (employee_id, employee, action, entity, detail_json)
       VALUES (?, ?, ?, ?, ?)`
    ).run(
      employee?.id ?? null,
      employee?.full_name ?? null,
      action,
      entity ?? null,
      detail ? JSON.stringify(redact(detail)) : null
    );
  } catch (error) {
    emit('error', 'audit.write_failed', { message: error.message });
  }
}

module.exports = log;
module.exports.audit = audit;
module.exports.redact = redact;
