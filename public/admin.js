/* Azeer Ticketing - admin panel.
 *
 * Everything the support team needs to add or change without touching code:
 * employees, teams, classifications, templates and troubleshooting flows.
 */
'use strict';

const $ = (id) => document.getElementById(id);
const esc = (v) =>
  String(v ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

let cache = { teams: [], classifications: [], templates: [] };

async function api(path, options = {}) {
  const response = await fetch(path, {
    credentials: 'same-origin',
    headers: options.body ? { 'content-type': 'application/json' } : {},
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  let payload = null;
  try { payload = await response.json(); } catch { payload = null; }
  if (!response.ok) {
    const error = new Error(payload?.error || 'The action could not be completed.');
    error.code = payload?.code;
    error.status = response.status;
    throw error;
  }
  return payload;
}

function toast(kind, message) {
  $('toast').innerHTML = `<div class="notice ${kind}"><span class="ico'>${kind === 'ok' ? '✓' : '!'}</span><div>${esc(message)}</div></div>`;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { $('toast').innerHTML = ''; }, 5000);
}
const guard = (fn) => (...args) => Promise.resolve(fn(...args)).catch((e) => toast('err', e.message));

// ------------------------------------------------------------------- gate

async function boot() {
  const me = await api('/api/auth/me');
  if (!me.signedIn) { window.location.href = '/'; return; }
  try {
    await api('/api/admin/health');
    openPanel();
  } catch (error) {
    if (error.status === 403) { $('gate').classList.remove('hidden'); return; }
    throw error;
  }
}

$('gateBtn').addEventListener('click', guard(async () => {
  try {
    await api('/api/auth/admin', { method: 'POST', body: { password: $('adminPassword').value } });
    $('gate').classList.add('hidden');
    openPanel();
  } catch (error) {
    $('gateError').innerHTML = `<div class="notice err"><span class="ico">!</span><div>${esc(error.message)}</div></div>`;
  }
}));
$('adminPassword').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('gateBtn').click(); });

async function openPanel() {
  $('panel').classList.remove('hidden');
  await Promise.all([loadHealth(), loadEmployees(), loadTeams(), loadClasses(), loadTemplates(), loadCases()]);
}

for (const tab of $('tabs').querySelectorAll('.tab')) {
  tab.addEventListener('click', () => {
    for (const other of $('tabs').querySelectorAll('.tab')) other.classList.toggle('active', other === tab);
    for (const section of document.querySelectorAll('[data-panel]')) {
      section.classList.toggle('hidden', section.dataset.panel !== tab.dataset.tab);
    }
    if (tab.dataset.tab === 'audit') loadAudit();
  });
}

// --------------------------------------------------------------- overview

async function loadHealth() {
  const { config, counts } = await api('/api/admin/health');
  const flag = (ok, yes, no) => `<span class="tag ${ok ? 'ok' : 'warn'}">${ok ? yes : no}</span>`;
  const rows = [
    ['Zoho app credentials', flag(config.zohoConfigured, 'Configured', 'Missing')],
    ['Service refresh token', flag(config.serviceTokenPresent, 'Present', 'Not set — employees without a Desk seat cannot raise tickets')],
    ['AI rewriting', flag(config.aiConfigured, 'Enabled', 'Disabled — descriptions pass through unchanged')],
    ['Desk department', `<code>${esc(config.departmentId)}</code>`],
    ['Ticket layout', `<code>${esc(config.layoutId)}</code>`],
    ['Credentials in ticket bodies', flag(config.includeCredentials, 'Included', 'Omitted')],
    ['Employees connected', `${counts.connected} of ${counts.employees}`],
    ['Teams', String(counts.teams)],
    ['Classifications', `${counts.classifications} active, ${counts.unmappedClassifications} with no Desk value, ${counts.blockedClassifications} blocked`],
    ['Troubleshooting cases', String(counts.cases)],
    ['Tickets raised through this tool', String(counts.tickets)],
  ];
  $('health').innerHTML = `<dl class="kv">${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join('')}</dl>`;
}

$('syncBtn').addEventListener('click', guard(async () => {
  $('syncBtn').disabled = true;
  $('syncBtn').innerHTML = '<span class="spinner"></span> Syncing…';
  try {
    const result = await api('/api/admin/sync', { method: 'POST' });
    const blocks = [];
    for (const [kind, data] of Object.entries(result.synced)) {
      const items = Array.isArray(data) ? data : [];
      blocks.push(
        `<h4 style="margin:16px 0 6px;font-size:13px">${esc(kind)} <span class="tag">${items.length}</span></h4>` +
          `<pre class="body" style="max-height:220px">${esc(
            items.map((i) => (typeof i === 'string' ? i : `${i.name || i.value || ''}  ${i.id || ''}`.trim())).join('\n')
          )}</pre>`
      );
    }
    if (result.errors?.length) {
      blocks.unshift(
        `<div class="notice warn"><span class="ico'>!</span><div><strong>Some reads failed</strong><ul>` +
          result.errors.map((e) => `<li>${esc(e)}</li>`).join('') + `</ul></div></div>`
      );
    }
    $('syncResult').innerHTML = blocks.join('');
    toast('ok', 'Sync complete.');
    loadHealth();
  } finally {
    $('syncBtn').disabled = false;
    $('syncBtn').textContent = 'Sync now';
  }
}));

// -------------------------------------------------------------- employees

async function loadEmployees() {
  const { employees } = await api('/api/admin/employees');
  $('employeesTable').innerHTML =
    `<thead><tr><th>Name</th><th>Email</th><th>Zoho</th><th>Desk seat</th><th>Admin</th><th>Active</th><th></th></tr></thead><tbody>` +
    employees
      .map(
        (e) => `<tr class="${e.active ? '' : 'inactive'}" data-id="${e.id}">
        <td>${esc(e.full_name)}</td>
        <td>${esc(e.email)}</td>
        <td>${e.connected ? '<span class="tag ok">Connected</span>' : '<span class="tag warn">Not signed in</span>'}</td>
        <td>${e.has_desk_seat ? '<span class="tag ok">Yes</span>' : '<span class="tag">No</span>'}</td>
        <td><input type="checkbox" data-field="is_admin" ${e.is_admin ? 'checked' : ''}></td>
        <td><input type="checkbox" data-field="active" ${e.active ? 'checked' : ''}></td>
        <td><button class="btn ghost" data-act="disconnect" ${e.connected ? '' : 'disabled'}>Disconnect</button></td>
      </tr>`
      )
      .join('') +
    `</tbody>`;

  $('employeesTable').querySelectorAll('input[type=checkbox]').forEach((input) => {
    input.addEventListener('change', guard(async () => {
      const id = input.closest('tr').dataset.id;
      await api(`/api/admin/employees/${id}`, { method: 'PATCH', body: { [input.dataset.field]: input.checked } });
      toast('ok', 'Employee updated.');
      loadEmployees();
    }));
  });
  $('employeesTable').querySelectorAll('[data-act=disconnect]').forEach((button) => {
    button.addEventListener('click', guard(async () => {
      const id = button.closest('tr').dataset.id;
      await api(`/api/admin/employees/${id}/disconnect`, { method: 'POST' });
      toast('ok', 'Zoho connection removed. They will be asked to sign in again.');
      loadEmployees();
    }));
  });
}

$('addEmployee').addEventListener('click', guard(async () => {
  await api('/api/admin/employees', {
    method: 'POST',
    body: { full_name: $('newEmployeeName').value, email: $('newEmployeeEmail').value },
  });
  $('newEmployeeName').value = '';
  $('newEmployeeEmail').value = '';
  toast('ok', 'Employee added. They still need to sign in with Zoho.');
  loadEmployees();
}));

// ------------------------------------------------------------------ teams

async function loadTeams() {
  const { teams } = await api('/api/admin/teams');
  cache.teams = teams;
  const templateOptions = (selected) =>
    cache.templates.map((t) => `<option value="${esc(t.key)}"${t.key === selected ? ' selected' : ''}>${esc(t.key)}</option>`).join('');

  $('teamsTable').innerHTML =
    `<thead><tr><th>Name</th><th>Arabic</th><th>Desk team id</th><th>Template</th><th>Sort</th><th>Active</th></tr></thead><tbody>` +
    teams
      .map(
        (t) => `<tr class="${t.active ? '' : 'inactive'}" data-id="${t.id}">
        <td><input type="text" data-field="name" value="${esc(t.name)}"></td>
        <td><input type="text" data-field="name_ar" dir="rtl" value="${esc(t.name_ar || '')}"></td>
        <td><input type="text" data-field="desk_team_id" value="${esc(t.desk_team_id || '')}" placeholder="required"></td>
        <td><select data-field="template_key">${templateOptions(t.template_key)}</select></td>
        <td><input type="number" data-field="sort" value="${t.sort}" style="width:70px"></td>
        <td><input type="checkbox" data-field="active" ${t.active ? 'checked' : ''}></td>
      </tr>`
      )
      .join('') +
    `</tbody>`;
  wireInlineEdit('teamsTable', 'teams', loadTeams);
}

$('addTeam').addEventListener('click', guard(async () => {
  await api('/api/admin/teams', {
    method: 'POST',
    body: { name: $('newTeamName').value, desk_team_id: $('newTeamDeskId').value },
  });
  $('newTeamName').value = '';
  $('newTeamDeskId').value = '';
  toast('ok', 'Team added.');
  loadTeams();
}));

// -------------------------------------------------------- classifications

async function loadClasses() {
  const { classifications } = await api('/api/admin/classifications');
  cache.classifications = classifications;
  const teamOptions = (selected) =>
    `<option value="">— none —</option>` +
    cache.teams.map((t) => `<option value="${t.id}"${t.id === selected ? ' selected' : ''}>${esc(t.name)}</option>`).join('');
  const templateOptions = (selected) =>
    `<option value="">— from team —</option>` +
    cache.templates.map((t) => `<option value="${esc(t.key)}"${t.key === selected ? ' selected' : ''}>${esc(t.key)}</option>`).join('');

  $('classesTable').innerHTML =
    `<thead><tr><th>Name</th><th>Team</th><th>Template</th><th>Desk value</th><th>Priority</th><th>Review</th><th>Active</th></tr></thead><tbody>` +
    classifications
      .map(
        (c) => `<tr class="${c.active ? '' : 'inactive'}" data-id="${c.id}">
        <td><input type="text" data-field="name" value="${esc(c.name)}"></td>
        <td><select data-field="team_id">${teamOptions(c.team_id)}</select></td>
        <td><select data-field="template_key">${templateOptions(c.template_key)}</select></td>
        <td><input type="text" data-field="desk_value" value="${esc(c.desk_value || '')}" placeholder="exact Desk string"></td>
        <td><input type="text" data-field="priority" value="${esc(c.priority || '')}" placeholder="optional"></td>
        <td><input type="checkbox" data-field="needs_review" ${c.needs_review ? 'checked' : ''}></td>
        <td><input type="checkbox" data-field="active" ${c.active ? 'checked' : ''}></td>
      </tr>`
      )
      .join('') +
    `</tbody>`;
  wireInlineEdit('classesTable', 'classifications', loadClasses);
}

$('addClass').addEventListener('click', guard(async () => {
  await api('/api/admin/classifications', {
    method: 'POST',
    body: { name: $('newClassName').value, name_ar: $('newClassAr').value, needs_review: true },
  });
  $('newClassName').value = '';
  $('newClassAr').value = '';
  toast('ok', 'Classification added. Set its team, then clear "Review" to allow use.');
  loadClasses();
}));

/** Save an inline table cell on change/blur. */
function wireInlineEdit(tableId, resource, reload) {
  for (const input of $(tableId).querySelectorAll('[data-field]')) {
    const event = input.type === 'checkbox' || input.tagName === 'SELECT' ? 'change' : 'blur';
    input.addEventListener(event, guard(async () => {
      const id = input.closest('tr').dataset.id;
      const value =
        input.type === 'checkbox' ? input.checked
        : input.type === 'number' ? Number(input.value)
        : input.value;
      await api(`/api/admin/${resource}/${id}`, { method: 'PATCH', body: { [input.dataset.field]: value } });
      toast('ok', 'Saved.');
      if (input.type === 'checkbox' || input.tagName === 'SELECT') reload();
    }));
  }
}

// -------------------------------------------------------------- templates

async function loadTemplates() {
  const { templates } = await api('/api/admin/templates');
  cache.templates = templates;
  $('templatesList').innerHTML = templates
    .map(
      (t) => `<div class="step-card" data-key="${esc(t.key)}">
      <h4>${esc(t.key)} — ${esc(t.name)}</h4>
      ${t.notes ? `<p class="sub" style="margin:-4px 0 10px">${esc(t.notes)}</p>` : ''}
      <textarea data-field="body" style="min-height:260px;font-family:var(--mono);font-size:13px">${esc(t.body)}</textarea>
      <div class="row end" style="margin-top:10px">
        <button class="btn" data-act="save">Save template</button>
      </div>
    </div>`
    )
    .join('');

  $('templatesList').querySelectorAll('[data-act=save]').forEach((button) => {
    button.addEventListener('click', guard(async () => {
      const card = button.closest('.step-card');
      const key = card.dataset.key;
      const template = cache.templates.find((t) => t.key === key);
      await api(`/api/admin/templates/${encodeURIComponent(key)}`, {
        method: 'PUT',
        body: { name: template.name, notes: template.notes, body: card.querySelector('[data-field=body]').value },
      });
      toast('ok', `Template ${key} saved.`);
    }));
  });
}

// -------------------------------------------------------- troubleshooting

const OUTCOMES = { RESOLVED: 'Issue Resolved', PERSISTS: 'Issue Persists', PARTIAL: 'Partially Resolved', UNKNOWN: 'Unable to Determine' };

async function loadCases() {
  const { cases } = await api('/api/admin/ts/cases');
  $('casesList').innerHTML = cases.length
    ? `<div style="overflow-x:auto"><table>
        <thead><tr><th>Case</th><th>Arabic</th><th>Steps</th><th>Status</th><th>Active</th><th></th></tr></thead>
        <tbody>${cases
          .map(
            (c) => `<tr class="${c.active ? '' : 'inactive'}" data-id="${c.id}">
            <td>${esc(c.name_en)}</td>
            <td dir="rtl">${esc(c.name_ar)}</td>
            <td>${c.step_count}</td>
            <td>${c.problems.length ? `<span class="tag warn">${c.problems.length} issue${c.problems.length === 1 ? '' : 's'}</span>` : '<span class="tag ok">Ready</span>'}</td>
            <td><input type="checkbox" data-field="active" ${c.active ? 'checked' : ''}></td>
            <td><button class="btn ghost" data-act="edit">Edit flow</button>
                <button class="btn ghost danger" data-act="delete">Delete</button></td>
          </tr>`
          )
          .join('')}</tbody></table></div>`
    : `<div class="notice info"><span class="ico">i</span><div>No troubleshooting cases yet.</div></div>`;

  $('casesList').querySelectorAll('[data-field=active]').forEach((input) => {
    input.addEventListener('change', guard(async () => {
      await api(`/api/admin/ts/cases/${input.closest('tr').dataset.id}`, { method: 'PATCH', body: { active: input.checked } });
      loadCases();
    }));
  });
  $('casesList').querySelectorAll('[data-act=edit]').forEach((button) => {
    button.addEventListener('click', guard(() => editCase(button.closest('tr').dataset.id)));
  });
  $('casesList').querySelectorAll('[data-act=delete]').forEach((button) => {
    button.addEventListener('click', guard(async () => {
      if (!confirm('Delete this case and all of its steps? This cannot be undone.')) return;
      await api(`/api/admin/ts/cases/${button.closest('tr').dataset.id}`, { method: 'DELETE' });
      $('caseEditor').classList.add('hidden');
      toast('ok', 'Case deleted.');
      loadCases();
    }));
  });
}

$('addCase').addEventListener('click', guard(async () => {
  const { id } = await api('/api/admin/ts/cases', {
    method: 'POST',
    body: { name_en: $('newCaseEn').value, name_ar: $('newCaseAr').value },
  });
  $('newCaseEn').value = '';
  $('newCaseAr').value = '';
  await loadCases();
  editCase(id);
}));

async function editCase(caseId) {
  const { case: kase } = await api(`/api/admin/ts/cases/${caseId}`);
  const editor = $('caseEditor');
  editor.classList.remove('hidden');

  const stepOptions = (selected) =>
    `<option value="">— pick next step —</option>` +
    kase.steps.map((s) => `<option value="${s.id}"${s.id === selected ? ' selected' : ''}>${esc(s.step_key)}</option>`).join('');
  const outcomeOptions = (selected) =>
    `<option value="">— not an ending —</option>` +
    Object.entries(OUTCOMES)
      .map(([key, label]) => `<option value="${key}"${key === selected ? ' selected' : ''}>${esc(label)}</option>`)
      .join('');

  editor.innerHTML = `
    <div class="row between" style="margin-bottom:6px">
      <h2 style="margin:0">${esc(kase.name_en)}</h2>
      <button class="btn ghost" data-act="close">Close</button>
    </div>
    <p class="sub" dir="rtl" style="text-align:right">${esc(kase.name_ar)}</p>

    ${kase.problems.length
      ? `<div class="notice warn"><span class="ico">!</span><div><strong>This flow is not ready yet</strong><ul>${kase.problems
          .map((p) => `<li>${esc(p)}</li>`).join('')}</ul></div></div>`
      : `<div class="notice ok"><span class="ico">✓</span><div>This flow is complete and usable.</div></div>`}

    <div class="grid-2" style="margin:16px 0">
      <label class="lbl">First step
        <select data-case-field="start_step_id">${stepOptions(kase.start_step_id)}</select>
      </label>
      <label class="lbl">Team
        <select data-case-field="team_id"><option value="">— none —</option>${cache.teams
          .map((t) => `<option value="${t.id}"${t.id === kase.team_id ? ' selected' : ''}>${esc(t.name)}</option>`).join('')}</select>
      </label>
    </div>

    <h3 style="font-size:14px;margin:22px 0 10px">Steps</h3>
    ${kase.steps.map((step) => renderStep(step, stepOptions, outcomeOptions)).join('')}

    <div class="step-card" style="background:var(--surface)">
      <h4>Add a step</h4>
      <div class="grid-2">
        <input type="text" data-new-step="step_key" placeholder="Step key, e.g. S8">
        <input type="text" data-new-step="instruction_ar" dir="rtl" placeholder="التعليمات بالعربية">
      </div>
      <div class="row end" style="margin-top:10px"><button class="btn" data-act="add-step">Add step</button></div>
    </div>`;

  editor.dataset.caseId = caseId;
  wireCaseEditor(editor, caseId);
}

function renderStep(step, stepOptions, outcomeOptions) {
  return `<div class="step-card" data-step-id="${step.id}">
    <div class="row between">
      <h4>${esc(step.step_key)}</h4>
      <button class="btn ghost danger" data-act="delete-step">Delete step</button>
    </div>
    <input type="text" data-step-field="instruction_ar" dir="rtl" value="${esc(step.instruction_ar)}">
    <div style="margin-top:12px">
      ${step.options
        .map(
          (option) => `<div class="opt-row" data-option-id="${option.id}">
          <input type="text" data-option-field="label_ar" dir="rtl" value="${esc(option.label_ar)}" placeholder="الإجابة بالعربية">
          <input type="text" data-option-field="record_en" value="${esc(option.record_en)}" placeholder="Professional English recorded on the ticket">
          <div>
            <select data-option-field="next_step_id">${stepOptions(option.next_step_id)}</select>
            <select data-option-field="outcome" style="margin-top:6px">${outcomeOptions(option.outcome)}</select>
          </div>
          <button class="btn ghost danger" data-act="delete-option">×</button>
        </div>`
        )
        .join('')}
      <div class="opt-row" style="opacity:.85">
        <input type="text" data-new-option="label_ar" dir="rtl" placeholder="إجابة جديدة">
        <input type="text" data-new-option="record_en" placeholder="English recording for this answer">
        <div>
          <select data-new-option="next_step_id">${stepOptions(null)}</select>
          <select data-new-option="outcome" style="margin-top:6px">${outcomeOptions(null)}</select>
        </div>
        <button class="btn" data-act="add-option">Add</button>
      </div>
    </div>
  </div>`;
}

function wireCaseEditor(editor, caseId) {
  const reload = () => { loadCases(); editCase(caseId); };

  editor.querySelector('[data-act=close]').addEventListener('click', () => editor.classList.add('hidden'));

  for (const field of editor.querySelectorAll('[data-case-field]')) {
    field.addEventListener('change', guard(async () => {
      await api(`/api/admin/ts/cases/${caseId}`, {
        method: 'PATCH',
        body: { [field.dataset.caseField]: field.value || null },
      });
      toast('ok', 'Case updated.');
      reload();
    }));
  }

  for (const field of editor.querySelectorAll('[data-step-field]')) {
    field.addEventListener('blur', guard(async () => {
      const stepId = field.closest('[data-step-id]').dataset.stepId;
      await api(`/api/admin/ts/steps/${stepId}`, { method: 'PATCH', body: { [field.dataset.stepField]: field.value } });
      toast('ok', 'Step saved.');
    }));
  }

  for (const field of editor.querySelectorAll('[data-option-field]')) {
    const event = field.tagName === 'SELECT' ? 'change' : 'blur';
    field.addEventListener(event, guard(async () => {
      const optionId = field.closest('[data-option-id]').dataset.optionId;
      const name = field.dataset.optionField;
      const body = { [name]: field.value || null };
      // Choosing an outcome clears any next step, and vice versa.
      if (name === 'outcome' && field.value) body.next_step_id = null;
      if (name === 'next_step_id' && field.value) body.outcome = null;
      await api(`/api/admin/ts/options/${optionId}`, { method: 'PATCH', body });
      toast('ok', 'Answer saved.');
      if (field.tagName === 'SELECT') reload();
    }));
  }

  editor.querySelectorAll('[data-act=delete-step]').forEach((button) => {
    button.addEventListener('click', guard(async () => {
      if (!confirm('Delete this step?')) return;
      await api(`/api/admin/ts/steps/${button.closest('[data-step-id]').dataset.stepId}`, { method: 'DELETE' });
      reload();
    }));
  });

  editor.querySelectorAll('[data-act=delete-option]').forEach((button) => {
    button.addEventListener('click', guard(async () => {
      await api(`/api/admin/ts/options/${button.closest('[data-option-id]').dataset.optionId}`, { method: 'DELETE' });
      reload();
    }));
  });

  editor.querySelectorAll('[data-act=add-option]').forEach((button) => {
    button.addEventListener('click', guard(async () => {
      const card = button.closest('[data-step-id]');
      const read = (name) => card.querySelector(`[data-new-option="${name}"]`).value;
      await api(`/api/admin/ts/steps/${card.dataset.stepId}/options`, {
        method: 'POST',
        body: {
          label_ar: read('label_ar'),
          record_en: read('record_en'),
          next_step_id: read('next_step_id') || null,
          outcome: read('outcome') || null,
        },
      });
      toast('ok', 'Answer added.');
      reload();
    }));
  });

  editor.querySelector('[data-act=add-step]').addEventListener('click', guard(async () => {
    const read = (name) => editor.querySelector(`[data-new-step="${name}"]`).value;
    await api(`/api/admin/ts/cases/${caseId}/steps`, {
      method: 'POST',
      body: { step_key: read('step_key'), instruction_ar: read('instruction_ar') },
    });
    toast('ok', 'Step added.');
    reload();
  }));
}

// ------------------------------------------------------------------ audit

async function loadAudit() {
  const { audit, submissions } = await api('/api/admin/audit');

  $('submissionsTable').innerHTML =
    `<thead><tr><th>When</th><th>Employee</th><th>Account</th><th>Team</th><th>Mode</th><th>Ticket</th><th>Status</th><th>Note</th><th>Link</th><th>Ref</th></tr></thead><tbody>` +
    submissions
      .map(
        (s) => `<tr>
        <td style="white-space:nowrap">${esc(s.created_at)}</td>
        <td>${esc(s.employee_name || '')}</td>
        <td>${esc(s.account_name || '')}</td>
        <td>${esc(s.team_name || '')}</td>
        <td>${esc(s.mode || '')}</td>
        <td>${s.ticket_number ? `<a href="${esc(s.ticket_url)}" target="_blank" rel="noopener">#${esc(s.ticket_number)}</a>` : '—'}</td>
        <td><span class="tag ${s.status === 'created' ? 'ok' : s.status === 'failed' ? 'err' : 'warn'}">${esc(s.status)}</span></td>
        <td>${esc(s.note_status || '—')}</td>
        <td>${esc(s.link_status || '—')}</td>
        <td><code>${esc(s.error_ref || '')}</code></td>
      </tr>`
      )
      .join('') +
    `</tbody>`;

  $('auditTable').innerHTML =
    `<thead><tr><th>When</th><th>Who</th><th>Action</th><th>Entity</th><th>Detail</th></tr></thead><tbody>` +
    audit
      .map(
        (a) => `<tr>
        <td style="white-space:nowrap">${esc(a.at)}</td>
        <td>${esc(a.employee || '')}</td>
        <td>${esc(a.action)}</td>
        <td>${esc(a.entity || '')}</td>
        <td><code style="font-size:12px">${esc(a.detail_json || '')}</code></td>
      </tr>`
      )
      .join('') +
    `</tbody>`;
}

boot().catch((error) => toast('err', error.message));
