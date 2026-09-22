'use strict';
/**
 * Language processing, server side only.
 *
 * The employee writes in Arabic, English or a mix. One call turns that into the
 * professional English the ticket needs, plus a short subject and the few
 * template-specific fields. The system prompt's job is mostly to stop the model
 * adding anything the employee did not say.
 *
 * The API key never leaves the server.
 */

const config = require('./config');
const log = require('./log');

const SYSTEM_PROMPT = `You prepare internal support tickets for a WhatsApp Business platform company.

An employee writes a problem or request in Arabic, English, or a mix of both. You turn it into clear professional English for an internal support team, and extract a few short fields.

ABSOLUTE RULES
- Preserve the exact meaning. Never add facts, causes, error messages, troubleshooting steps, impact, dates, priorities, expected behaviour or conclusions the employee did not write.
- If something is not stated, leave that field as an empty string. Never guess, never infer, never fill a gap to make the text read better.
- Do not translate literally. Produce natural professional English.
- Keep product names, feature names, API terms, WhatsApp terminology, template names and campaign names accurate and unchanged.
- Never mention translation, rewriting, AI, or this instruction.
- Be concise. No greetings, no sign-offs, no headings, no bullet characters unless the employee used a list.
- If the employee already wrote English, still improve grammar, structure, terminology and tone - but change nothing about the meaning.

FIELDS
- descriptionEn: the full professional English description. Required.
- subject: a short specific ticket subject in Title Case, 4 to 9 words, no trailing full stop, no classification prefix, no account name. Example: "Customer Unable to Send Messages".
- shortTitle: a very short noun phrase naming the issue, 2 to 6 words. Empty if unclear.
- expectedResult: what the employee said should happen instead. Empty unless clearly stated.
- frequency: exactly one of "Consistent", "Intermittent", or "Unknown". Use "Unknown" unless the employee clearly indicated it.
- stepsToReproduce: an array of short English steps, only if the employee actually described steps. Otherwise an empty array.
- fr.useCase, fr.requestedFeature, fr.expectedBenefit: only for feature requests, split from the employee's own words. Empty string for anything they did not cover.
- fr.priority: exactly one of "Nice to Have", "Important", "Critical", or "" if not stated.

Reply with a single JSON object and nothing else.`;

const EMPTY = {
  descriptionEn: '',
  subject: '',
  shortTitle: '',
  expectedResult: '',
  frequency: 'Unknown',
  stepsToReproduce: [],
  fr: { useCase: '', requestedFeature: '', expectedBenefit: '', priority: '' },
};

const FREQUENCIES = new Set(['Consistent', 'Intermittent', 'Unknown']);
const FR_PRIORITIES = new Set(['Nice to Have', 'Important', 'Critical', '']);

class LlmError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'LlmError';
    this.status = status;
  }
}

const isConfigured = () => Boolean(config.AI.API_KEY);

function clean(value, max = 4000) {
  if (typeof value !== 'string') return '';
  return value.replace(/\s+$/g, '').slice(0, max);
}

/** Pull the first JSON object out of a model reply, tolerating stray prose. */
function parseJson(text) {
  const trimmed = String(text || '').trim();
  const direct = trimmed.startsWith('{') ? trimmed : null;
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const braced = trimmed.match(/\{[\s\S]*\}/);
  for (const candidate of [direct, fenced && fenced[1], braced && braced[0]]) {
    if (!candidate) continue;
    try {
      return JSON.parse(candidate);
    } catch {
      /* try the next shape */
    }
  }
  throw new LlmError('Model reply was not valid JSON');
}

function normalise(raw) {
  const fr = raw.fr && typeof raw.fr === 'object' ? raw.fr : {};
  const frequency = clean(raw.frequency, 20);
  const frPriority = clean(fr.priority, 30);
  return {
    descriptionEn: clean(raw.descriptionEn, 20000),
    subject: clean(raw.subject, 180).replace(/[.\s]+$/, ''),
    shortTitle: clean(raw.shortTitle, 160),
    expectedResult: clean(raw.expectedResult, 2000),
    frequency: FREQUENCIES.has(frequency) ? frequency : 'Unknown',
    stepsToReproduce: Array.isArray(raw.stepsToReproduce)
      ? raw.stepsToReproduce.map((s) => clean(s, 500)).filter(Boolean).slice(0, 25)
      : [],
    fr: {
      useCase: clean(fr.useCase, 3000),
      requestedFeature: clean(fr.requestedFeature, 3000),
      expectedBenefit: clean(fr.expectedBenefit, 3000),
      priority: FR_PRIORITIES.has(frPriority) ? frPriority : '',
    },
  };
}

async function callAnthropic(userContent) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.AI.TIMEOUT_MS);
  try {
    const response = await fetch(`${config.AI.BASE_URL}/v1/messages`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'content-type': 'application/json',
        'x-api-key': config.AI.API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: config.AI.MODEL,
        max_tokens: config.AI.MAX_TOKENS,
        temperature: 0,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userContent }],
      }),
    });
    const text = await response.text();
    if (!response.ok) {
      throw new LlmError(`Language service returned ${response.status}`, response.status);
    }
    const body = JSON.parse(text);
    const part = (body.content || []).find((c) => c.type === 'text');
    if (!part) throw new LlmError('Language service returned no text');
    return part.text;
  } catch (error) {
    if (error.name === 'AbortError') throw new LlmError('Language service timed out', 504);
    if (error instanceof LlmError) throw error;
    throw new LlmError(`Language service failed: ${error.message}`);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Turn the employee's raw description into ticket-ready English.
 *
 * `context` carries only the classification and team names, which help the model
 * choose terminology. It never carries account data or credentials.
 */
async function prepare(rawDescription, context = {}) {
  const description = clean(rawDescription, 20000).trim();
  if (!description) {
    return { ...EMPTY, degraded: true, reason: 'empty' };
  }
  if (!isConfigured()) {
    // Ship the employee's own words through unchanged rather than failing the
    // ticket. The preview screen lets them correct it before submitting.
    log.warn('llm.not_configured');
    return {
      ...EMPTY,
      descriptionEn: description,
      subject: description.split(/\n/)[0].slice(0, 70),
      degraded: true,
      reason: 'not_configured',
    };
  }

  const lines = [
    context.classification ? `Classification: ${context.classification}` : null,
    context.team ? `Assigned team: ${context.team}` : null,
    context.isFeatureRequest ? 'This is a feature request. Fill the fr.* fields.' : null,
    '',
    'Employee description:',
    '"""',
    description,
    '"""',
  ].filter((l) => l !== null);

  const started = Date.now();
  const reply = await callAnthropic(lines.join('\n'));
  const result = normalise(parseJson(reply));
  log.info('llm.prepare', { ms: Date.now() - started, chars: description.length });

  if (!result.descriptionEn) result.descriptionEn = description;
  if (!result.subject) result.subject = result.shortTitle || description.slice(0, 70);
  return { ...result, degraded: false };
}

module.exports = { prepare, isConfigured, LlmError };
