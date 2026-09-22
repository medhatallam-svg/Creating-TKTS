/* Azeer Ticketing - employee interface.
 *
 * No credentials of any kind live here. Everything goes through the backend,
 * which holds the Zoho and AI credentials and renders the ticket body itself.
 */
'use strict';

const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, children = []) => {
  const node = Object.assign(document.createElement(tag), props);
  for (const child of [].concat(children)) {
    if (child != null) node.append(child.nodeType ? child : document.createTextNode(child));
  }
  return node;
};
const escapeHtml = (v) =>
  String(v ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

// ------------------------------------------------------------------ state

const state = {
  me: null,
  config: { teams: [], classifications: [], cases: [], features: {} },
  form: { crmUrl: '', account: null, teamId: null, classificationId: null, mode: null, description: '' },
  ts: { runId: null, view: null, caseId: null },
  preview: null,
  submitKey: null,
  submitting: false,
};

const SCREENS = ['screenSignin', 'screenForm', 'screenCases', 'screenWizard', 'screenPreview', 'screenDone'];
function show(screen) {
  for (const id of SCREENS) $(id).classList.toggle('hidden', id !== screen);
  window.scrollTo({ top: 0, behavior: 'instant' in window ? 'instant' : 'auto' });
}

// -------------------------------------------------------------- transport

async function api(path, options = {}) {
  const response = await fetch(path, {
    credentials: 'same-origin',
    headers: options.body ? { 'content-type': 'application/json' } : {},
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  if (!response.ok) {
    const error = new Error(payload?.error || 'Something went wrong. Please try again.');
    error.code = payload?.code;
    error.ref = payload?.ref;
    error.status = response.status;
    throw error;
  }
  return payload;
}

/** Render a notice block into a container. */
function notice(container, kind, title, detail) {
  const icons = { ok: '✓', warn: '!', err: '!', info: 'i' };
  container.innerHTML =
    `<div class="notice ${kind}"><span class="ico">${icons[kind] || 'i'}</span><div>` +
    `<strong>${escapeHtml(title)}</strong>` +
    (detail ? `<div style="margin-top:3px">${detail}</div>` : '') +
    `</div></div>`;
}
const clear = (container) => { container.innerHTML = ''; };

function errorNotice(container, error) {
  const ref = error.ref ? ` <span class="tag">ref ${escapeHtml(error.ref)}</span>` : '';
  notice(container, 'err', error.message, ref || null);
  if (error.code === 'signin' || error.code === 'reauth') {
    container.querySelector('.notice > div')?.append(
      el('div', { style: 'margin-top:8px' }, [
        el('a', { className: 'btn', href: '/api/auth/zoho/start', textContent: 'Sign in with Zoho again' }),
      ])
    );
  }
}

// ------------------------------------------------------- searchable picker

/**
 * A small combobox: a button that opens a filtered list. Used for Team and
 * Classification so neither becomes a long scrolling dropdown.
 */
function createPicker(container, { placeholder, onSelect, itemLabel, itemMeta, itemBlocked }) {
  let items = [];
  let selected = null;
  let open = false;
  let activeIndex = 0;

  const chosen = el('button', { type: 'button', className: 'chosen' });
  const panel = el('div', { className: 'panel hidden' });
  const search = el('input', { type: 'text', placeholder: 'Type to search…', autocomplete: 'off' });
  const list = el('div', { className: 'opts' });
  panel.append(search, list);
  container.append(chosen, panel);

  function paintChosen() {
    chosen.innerHTML = '';
    chosen.append(
      selected
        ? el('span', { textContent: itemLabel(selected) })
        : el('span', { className: 'placeholder', textContent: placeholder }),
      el('span', { className: 'caret', textContent: '▾' })
    );
  }

  function paintList() {
    const query = search.value.trim().toLowerCase();
    const matches = items.filter((item) => {
      if (!query) return true;
      return `${itemLabel(item)} ${itemMeta ? itemMeta(item) || '' : ''}`.toLowerCase().includes(query);
    });
    list.innerHTML = '';
    if (!matches.length) {
      list.append(el('div', { className: 'empty', textContent: 'Nothing matches that search.' }));
      return;
    }
    activeIndex = Math.min(activeIndex, matches.length - 1);
    matches.forEach((item, index) => {
      const blocked = itemBlocked ? itemBlocked(item) : false;
      const option = el('button', {
        type: 'button',
        className: `opt${index === activeIndex ? ' active' : ''}${blocked ? ' blocked' : ''}`,
      });
      option.append(el('span', { textContent: itemLabel(item) }));
      const meta = itemMeta ? itemMeta(item) : null;
      if (meta) option.append(el('span', { className: 'meta', textContent: meta }));
      option.addEventListener('click', () => choose(item));
      option.addEventListener('mousemove', () => {
        activeIndex = index;
        list.querySelectorAll('.opt').forEach((n, i) => n.classList.toggle('active', i === index));
      });
      list.append(option);
    });
  }

  function choose(item) {
    selected = item;
    paintChosen();
    toggle(false);
    onSelect(item);
  }

  function toggle(next) {
    open = next;
    panel.classList.toggle('hidden', !open);
    if (open) {
      search.value = '';
      activeIndex = 0;
      paintList();
      search.focus();
    }
  }

  chosen.addEventListener('click', () => toggle(!open));
  search.addEventListener('input', () => { activeIndex = 0; paintList(); });
  search.addEventListener('keydown', (event) => {
    const options = [...list.querySelectorAll('.opt')];
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      activeIndex = Math.max(0, Math.min(options.length - 1, activeIndex + (event.key === 'ArrowDown' ? 1 : -1)));
      options.forEach((n, i) => n.classList.toggle('active', i === activeIndex));
      options[activeIndex]?.scrollIntoView({ block: 'nearest' });
    } else if (event.key === 'Enter') {
      event.preventDefault();
      options[activeIndex]?.click();
    } else if (event.key === 'Escape') {
      toggle(false);
    }
  });
  document.addEventListener('click', (event) => {
    if (open && !container.contains(event.target)) toggle(false);
  });

  paintChosen();

  return {
    setItems(next) { items = next; if (open) paintList(); },
    set(item) { selected = item; paintChosen(); },
    clear() { selected = null; paintChosen(); },
    get value() { return selected; },
  };
}

// ---------------------------------------------------------------- bootstrap

let teamPicker;
let classPicker;

async function boot() {
  const me = await api('/api/auth/me');
  if (!me.signedIn) return show('screenSignin');

  state.me = me.employee;
  $('whoami').classList.remove('hidden');
  $('whoamiName').textContent = me.employee.name;
  $('avatar').textContent = me.employee.name.split(/\s+/).slice(0, 2).map((p) => p[0]).join('').toUpperCase();
  if (me.employee.isAdmin) {
    $('adminLink').style.display = '';
    $('adminLink').addEventListener('click', () => { window.location.href = '/admin.html'; });
  }

  state.config = await api('/api/config');
  teamPicker.setItems(state.config.teams);
  classPicker.setItems(state.config.classifications);

  if (!state.config.features.aiEnabled) {
    $('descriptionHint').textContent =
      'Automatic English rewriting is currently unavailable, so your text is used as written. Check it on the review screen.';
  }
  show('screenForm');
  restorePendingSubmission();
}

// ------------------------------------------------------------------- form

function setupForm() {
  teamPicker = createPicker($('teamPicker'), {
    placeholder: 'Search team…',
    itemLabel: (t) => t.name,
    itemMeta: (t) => (t.configured ? t.name_ar || '' : 'Not configured in Zoho Desk yet'),
    itemBlocked: (t) => !t.configured,
    onSelect: (team) => { state.form.teamId = team.id; validateForm(); },
  });

  classPicker = createPicker($('classPicker'), {
    placeholder: 'Search classification…',
    itemLabel: (c) => c.name,
    itemMeta: (c) =>
      c.needs_review ? 'No owning team confirmed — cannot be used yet' : c.team_name || c.name_ar || '',
    itemBlocked: (c) => c.needs_review,
    onSelect: (classification) => {
      state.form.classificationId = classification.id;
      // Selecting a classification suggests its team, unless one was chosen.
      if (classification.team_id && !state.form.teamId) {
        const team = state.config.teams.find((t) => t.id === classification.team_id);
        if (team) { teamPicker.set(team); state.form.teamId = team.id; }
      }
      $('classHint').textContent = classification.needs_review
        ? 'This classification has no confirmed owning team, so a ticket cannot be raised with it yet. Ask an administrator to set its team.'
        : '';
      validateForm();
    },
  });

  let resolveTimer = null;
  $('crmUrl').addEventListener('input', (event) => {
    state.form.crmUrl = event.target.value.trim();
    state.form.account = null;
    clear($('accountState'));
    validateForm();
    clearTimeout(resolveTimer);
    if (state.form.crmUrl.length > 25) resolveTimer = setTimeout(resolveAccount, 550);
  });
  $('crmUrl').addEventListener('blur', () => {
    if (state.form.crmUrl && !state.form.account) resolveAccount();
  });

  for (const button of $('modeChoices').querySelectorAll('.choice')) {
    button.addEventListener('click', () => {
      state.form.mode = button.dataset.mode;
      for (const other of $('modeChoices').querySelectorAll('.choice')) {
        other.classList.toggle('selected', other === button);
      }
      // In troubleshooting mode the description is optional and comes later.
      $('descriptionCard').classList.toggle('hidden', state.form.mode !== 'direct');
      $('continueBtn').textContent =
        state.form.mode === 'troubleshooting' ? 'Start troubleshooting' : 'Continue';
      validateForm();
    });
  }

  $('description').addEventListener('input', (event) => {
    state.form.description = event.target.value;
    validateForm();
  });

  $('continueBtn').addEventListener('click', onContinue);
  $('signOut').addEventListener('click', async () => {
    await api('/api/auth/signout', { method: 'POST' });
    window.location.reload();
  });
}

async function resolveAccount() {
  const container = $('accountState');
  notice(container, 'info', 'Looking up the account…', '<span class="spinner"></span>');
  try {
    const account = await api('/api/account/resolve', { method: 'POST', body: { crmUrl: state.form.crmUrl } });
    state.form.account = account;

    const rows = [
      ['Account Name', account.accountName],
      ['Account ID', account.accountId],
      ['Account Owner', account.accountOwner],
      ['Account Manager', account.accountManager],
      ['Contact', account.contact?.name],
      ['Mobile', account.contact?.mobile],
      ['Platform', account.platformName],
      ['WABA', account.waba],
    ].filter(([, value]) => value);

    container.innerHTML =
      `<div class="notice ok"><span class="ico">✓</span><div><strong>Account found</strong></div></div>` +
      `<dl class="kv">${rows
        .map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd>`)
        .join('')}</dl>`;

    if (account.warnings?.length) {
      container.insertAdjacentHTML(
        'beforeend',
        `<div class="notice warn" style="margin-top:14px"><span class="ico">!</span><div><strong>Check before submitting</strong>` +
          `<ul>${account.warnings.map((w) => `<li>${escapeHtml(w)}</li>`).join('')}</ul></div></div>`
      );
    }
  } catch (error) {
    state.form.account = null;
    errorNotice(container, error);
  }
  validateForm();
}

function validateForm() {
  const { account, teamId, classificationId, mode, description } = state.form;
  const classification = state.config.classifications.find((c) => c.id === classificationId);
  const team = state.config.teams.find((t) => t.id === teamId);

  const ready =
    Boolean(account) &&
    Boolean(team && team.configured) &&
    Boolean(classification && !classification.needs_review) &&
    Boolean(mode) &&
    (mode === 'troubleshooting' || description.trim().length > 2);

  $('continueBtn').disabled = !ready;
}

async function onContinue() {
  clear($('formError'));
  if (state.form.mode === 'troubleshooting') {
    renderCases();
    show('screenCases');
  } else {
    await goToPreview();
  }
}

// ------------------------------------------------------------- ts cases

function renderCases(query = '') {
  const list = $('caseList');
  const needle = query.trim().toLowerCase();
  const cases = state.config.cases.filter(
    (c) => !needle || `${c.name_en} ${c.name_ar} ${c.description_ar || ''}`.toLowerCase().includes(needle)
  );

  list.innerHTML = '';
  clear($('caseEmpty'));

  if (!state.config.cases.length) {
    notice(
      $('caseEmpty'),
      'info',
      'No troubleshooting cases have been set up yet.',
      'An administrator can add them in the admin panel. You can still create the ticket directly.'
    );
    return;
  }
  if (!cases.length) {
    notice($('caseEmpty'), 'info', 'No case matches that search.');
    return;
  }

  for (const kase of cases) {
    const button = el('button', { type: 'button', className: 'choice' });
    button.append(
      el('span', { className: 't', textContent: kase.name_ar, dir: 'rtl' }),
      el('span', { className: 'd', textContent: kase.name_en })
    );
    button.addEventListener('click', () => startCase(kase.id));
    list.append(button);
  }
}

async function startCase(caseId) {
  try {
    const view = await api('/api/ts/start', { method: 'POST', body: { caseId } });
    state.ts = { runId: view.runId, view, caseId };
    renderWizard(view);
    show('screenWizard');
  } catch (error) {
    errorNotice($('caseEmpty'), error);
  }
}

// ------------------------------------------------------------ ts wizard

function renderWizard(view) {
  state.ts.view = view;
  $('wizCase').textContent = view.caseNameAr;
  $('wizCase').dir = 'rtl';

  const done = view.finished;
  $('wizStep').classList.toggle('hidden', done);
  $('wizFinal').classList.toggle('hidden', !done);
  $('wizBack').style.display = view.canGoBack ? '' : 'none';

  const total = Math.max(view.stepTotal || 1, view.stepNumber || 1);
  $('wizCount').textContent = done
    ? `${view.stepsCompleted} step${view.stepsCompleted === 1 ? '' : 's'} completed`
    : `Step ${view.stepNumber} of ${total}`;
  $('wizProgress').style.width = `${done ? 100 : Math.round(((view.stepNumber - 1) / total) * 100)}%`;

  if (!done) {
    $('wizInstruction').textContent = view.step.instruction_ar;
    $('wizHint').textContent = view.step.hint_ar || '';
    $('wizHint').classList.toggle('hidden', !view.step.hint_ar);

    const answers = $('wizAnswers');
    answers.innerHTML = '';
    for (const option of view.step.options) {
      const button = el('button', { type: 'button', className: 'answer' });
      if (option.terminal) button.append(el('span', { className: 'end-tag', textContent: 'ENDS FLOW' }));
      button.append(document.createTextNode(option.label_ar));
      button.addEventListener('click', () => answer(option.id, button));
      answers.append(button);
    }
  } else {
    $('wizOutcome').textContent = `${view.outcomeLabel} — ${view.outcomeSentence}`;
    // The banner reflects the actual outcome: finishing the flow is not the
    // same as fixing the problem.
    const kind = { RESOLVED: 'ok', PARTIAL: 'warn', PERSISTS: 'warn', UNKNOWN: 'info' }[view.outcome] || 'info';
    const banner = $('wizFinal').querySelector('.notice');
    banner.className = `notice ${kind}`;
    banner.querySelector('.ico').textContent = kind === 'ok' ? '✓' : kind === 'warn' ? '!' : 'i';
  }

  const history = $('wizHistory');
  history.innerHTML = '';
  for (const entry of view.history) {
    history.append(el('li', { textContent: `${entry.record_en}` }));
  }
  if (!done) history.append(el('li', { className: 'current', textContent: 'Current step' }));
  $('wizHistoryWrap').classList.toggle('hidden', !view.history.length);
}

async function answer(optionId, button) {
  for (const b of $('wizAnswers').querySelectorAll('button')) b.disabled = true;
  button.innerHTML = '<span class="spinner"></span>';
  try {
    renderWizard(await api('/api/ts/answer', { method: 'POST', body: { runId: state.ts.runId, optionId } }));
  } catch (error) {
    renderWizard(state.ts.view);
    errorNotice($('formError'), error);
  }
}

function setupWizard() {
  $('caseSearch').addEventListener('input', (event) => renderCases(event.target.value));
  $('casesBack').addEventListener('click', () => show('screenForm'));

  $('wizBack').addEventListener('click', async () => {
    try {
      renderWizard(await api('/api/ts/back', { method: 'POST', body: { runId: state.ts.runId } }));
    } catch (error) { errorNotice($('formError'), error); }
  });
  $('wizRestart').addEventListener('click', async () => {
    try {
      renderWizard(await api('/api/ts/restart', { method: 'POST', body: { runId: state.ts.runId } }));
    } catch (error) { errorNotice($('formError'), error); }
  });
  $('wizExit').addEventListener('click', () => {
    state.ts = { runId: null, view: null, caseId: null };
    show('screenForm');
  });
  $('wizContinue').addEventListener('click', async () => {
    state.form.description = $('wizDescription').value;
    await goToPreview();
  });
}

// -------------------------------------------------------------- preview

async function goToPreview(useEdits = false) {
  const target = $('screenPreview').classList.contains('hidden') ? $('formError') : $('submitError');
  notice(target, 'info', 'Preparing the ticket…', '<span class="spinner"></span>');
  $('continueBtn').disabled = true;
  $('wizContinue').disabled = true;

  try {
    const preview = await api('/api/ticket/preview', {
      method: 'POST',
      body: {
        crmUrl: state.form.crmUrl,
        teamId: state.form.teamId,
        classificationId: state.form.classificationId,
        mode: state.form.mode,
        runId: state.ts.runId,
        description: state.form.description,
        descriptionEn: useEdits ? $('previewDescription').value : '',
        subject: useEdits ? $('previewSubject').value : '',
        prepared: useEdits ? state.preview?.prepared : null,
      },
    });
    state.preview = preview;
    state.submitKey = state.submitKey || newSubmitKey();
    renderPreview(preview);
    clear(target);
    show('screenPreview');
  } catch (error) {
    errorNotice(target, error);
  } finally {
    $('continueBtn').disabled = false;
    $('wizContinue').disabled = false;
    validateForm();
  }
}

function renderPreview(preview) {
  clear($('previewWarnings'));
  if (preview.warnings?.length) {
    $('previewWarnings').innerHTML =
      `<div class="notice warn"><span class="ico">!</span><div><strong>Check these before submitting</strong>` +
      `<ul>${preview.warnings.map((w) => `<li>${escapeHtml(w)}</li>`).join('')}</ul></div></div>`;
  }
  if (!preview.routing.deskClassificationKnown) {
    $('previewWarnings').insertAdjacentHTML(
      'beforeend',
      `<div class="notice info"><span class="ico">i</span><div>The Zoho Desk Classification value is not mapped for ` +
        `<strong>${escapeHtml(preview.routing.classification)}</strong>, so that field will be left unset. ` +
        `Routing to the team is unaffected.</div></div>`
    );
  }

  const rows = [
    ['Employee', state.me.name],
    ['Account', preview.account.azeerName || preview.account.accountsName],
    ['Contact', preview.account.contact?.name],
    ['Team', preview.routing.team],
    ['Classification', preview.routing.classification],
    ['Mode', state.form.mode === 'troubleshooting' ? 'Troubleshooting' : 'Direct ticket'],
    ['Priority', preview.routing.priority],
  ].filter(([, value]) => value);
  $('previewMeta').innerHTML = rows
    .map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd>`)
    .join('');

  $('previewSubject').value = preview.subject;
  $('previewDescription').value = preview.prepared.descriptionEn;
  $('previewBody').textContent = preview.bodyText;
  $('previewTemplate').textContent = preview.routing.templateKey;

  const hasTs = Boolean(preview.troubleshooting);
  $('previewTsCard').classList.toggle('hidden', !hasTs);
  if (hasTs) {
    $('previewTs').innerHTML = preview.troubleshooting.steps
      .map((s) => `<li>${escapeHtml(s.record_en)}</li>`)
      .join('');
    $('previewTsOutcome').textContent = `Result: ${preview.troubleshooting.outcomeLabel}`;
  }
}

function setupPreview() {
  $('previewBack').addEventListener('click', () => {
    show(state.form.mode === 'troubleshooting' ? 'screenWizard' : 'screenForm');
  });
  $('rerenderBtn').addEventListener('click', () => goToPreview(true));
  $('submitBtn').addEventListener('click', submit);
}

// --------------------------------------------------------------- submit

/** One key per ticket attempt, kept across a refresh so a reload cannot duplicate. */
function newSubmitKey() {
  const key = `${Date.now().toString(36)}-${crypto.randomUUID()}`;
  try { sessionStorage.setItem('azeer.submitKey', key); } catch { /* private mode */ }
  return key;
}

async function restorePendingSubmission() {
  let key = null;
  try { key = sessionStorage.getItem('azeer.submitKey'); } catch { key = null; }
  if (!key) return;
  try {
    const row = await api(`/api/ticket/submission/${encodeURIComponent(key)}`);
    if (row.ticketNumber) {
      renderDone({ ...row, duplicate: true });
      show('screenDone');
    }
  } catch { /* nothing pending */ }
}

async function submit() {
  if (state.submitting) return;
  state.submitting = true;

  const button = $('submitBtn');
  const original = button.textContent;
  button.disabled = true;
  button.innerHTML = '<span class="spinner"></span> Creating ticket…';
  clear($('submitError'));

  try {
    const result = await api('/api/ticket/create', {
      method: 'POST',
      body: {
        idempotencyKey: state.submitKey,
        crmUrl: state.form.crmUrl,
        teamId: state.form.teamId,
        classificationId: state.form.classificationId,
        mode: state.form.mode,
        runId: state.ts.runId,
        description: state.form.description,
        descriptionEn: $('previewDescription').value,
        subject: $('previewSubject').value,
        prepared: state.preview?.prepared,
      },
    });
    renderDone(result);
    show('screenDone');
  } catch (error) {
    errorNotice($('submitError'), error);
    // A key is only burned on success. A failed attempt may be retried safely.
    button.disabled = false;
    button.textContent = original;
  } finally {
    state.submitting = false;
    if ($('screenDone').classList.contains('hidden')) {
      button.disabled = false;
      button.textContent = original;
    }
  }
}

function renderDone(result) {
  const partial = result.status === 'partial';
  $('doneMark').textContent = partial ? '!' : '✓';
  $('doneMark').style.background = partial ? 'var(--warn-soft)' : 'var(--ok-soft)';
  $('doneMark').style.color = partial ? 'var(--warn)' : 'var(--ok)';
  $('doneTitle').textContent = partial
    ? 'Ticket created — some follow-up needs attention'
    : 'Ticket created successfully';
  $('doneNumber').textContent = `#${result.ticketNumber}`;
  $('doneSubject').textContent = result.subject || '';

  const status = (value, okValue, okText, badText) =>
    value === okValue ? `<span class="tag ok">${okText}</span>` : `<span class="tag warn">${badText}</span>`;

  $('doneMeta').innerHTML = [
    ['Team', escapeHtml(result.team || '')],
    ['Classification', escapeHtml(result.classification || '')],
    ['Account', escapeHtml(result.account || '')],
    ['Zoho Desk', '<span class="tag ok">Ticket created</span>'],
    ['CRM note', status(result.noteStatus, 'ok', 'Added under your name', 'Not added')],
    ['CRM link', status(result.linkStatus, 'linked', 'Linked to the CRM account', 'Needs checking')],
    ['Ticket Creator field', status(result.cfStatus, 'ok', 'Set', 'Not set')],
  ]
    .filter(([, value]) => value)
    .map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`)
    .join('');

  const notices = $('doneNotices');
  notices.innerHTML = '';
  if (result.duplicate) {
    notice(notices, 'info', 'This ticket was already created.', 'It was not created a second time.');
  } else if (partial) {
    const problems = [];
    if (result.noteStatus !== 'ok') problems.push(result.noteMessage || 'The CRM note could not be added.');
    if (result.linkStatus !== 'linked') problems.push('The ticket may not appear under the CRM account. Check the Desk/CRM account link.');
    if (result.cfStatus !== 'ok') problems.push('The Ticket Creator field could not be set on the ticket.');
    notices.innerHTML =
      `<div class="notice warn"><span class="ico">!</span><div><strong>The ticket exists and was not duplicated.</strong>` +
      `<ul>${problems.map((p) => `<li>${escapeHtml(p)}</li>`).join('')}</ul></div></div>`;
  }
  if (result.deskIdentity === 'service') {
    notices.insertAdjacentHTML(
      'beforeend',
      `<div class="notice info"><span class="ico">i</span><div>You have no Zoho Desk agent seat, so the ticket was raised by the ` +
        `service account with your name in the Ticket Creator field. The CRM note is still under your own identity.</div></div>`
    );
  }

  $('doneOpen').href = result.ticketUrl || '#';
}

function setupDone() {
  $('doneAnother').addEventListener('click', () => {
    try { sessionStorage.removeItem('azeer.submitKey'); } catch { /* ignore */ }
    state.form = { crmUrl: '', account: null, teamId: null, classificationId: null, mode: null, description: '' };
    state.ts = { runId: null, view: null, caseId: null };
    state.preview = null;
    state.submitKey = null;

    $('crmUrl').value = '';
    $('description').value = '';
    $('wizDescription').value = '';
    clear($('accountState'));
    clear($('formError'));
    clear($('submitError'));
    teamPicker.clear();
    classPicker.clear();
    $('classHint').textContent = '';
    for (const choice of $('modeChoices').querySelectorAll('.choice')) choice.classList.remove('selected');
    $('descriptionCard').classList.add('hidden');
    $('continueBtn').textContent = 'Continue';
    validateForm();
    show('screenForm');
  });
}

// ------------------------------------------------------------------ start

setupForm();
setupWizard();
setupPreview();
setupDone();

boot().catch((error) => {
  show('screenSignin');
  console.error(error);
});
