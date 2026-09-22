'use strict';
/**
 * First-run seed.
 *
 * Everything here is either (a) verified live against the Azeer Zoho portal and
 * recorded in the project docs, or (b) clearly marked as needing review. Nothing
 * is invented: where the real Zoho value is not known, the field is left empty
 * and the classification is flagged so that ticket creation stops rather than
 * routing to the wrong team.
 *
 * All of it is editable from the admin panel afterwards. Re-running the seed
 * does not overwrite anything that already exists.
 */

const { db, meta } = require('./db');

// ---------------------------------------------------------------- templates
// Wording confirmed by Medhat on 2026-09-10. Label text, punctuation, spacing
// and separators below are authoritative - reproduce them character for
// character. Every label sits on its own line with the value beneath it.
const TEMPLATES = [
  {
    key: 'TECH',
    name: 'TECH - Engineering Team',
    notes: 'Preserve the space before the colon in "-Account :" and "Credentials :", the lowercase "explanation of the issue :", and the missing colon on the frequency line.',
    body: `1️⃣ Ticket Summary
-Short Title:
{shortTitle}

-Account :
{azeerName}

Credentials :
{credUser}
{credPass}

---

2️⃣ Problem Description
explanation of the issue :
{descriptionEn}

-Expected Result:
{expectedResult}

- the issue is consistent or intermittent
{frequency}

---

3️⃣ Steps to Reproduce
{stepsToReproduce}

---

4️⃣ Troubleshooting Already Performed
{troubleshooting}

---

5️⃣ Evidence
{evidence}`,
  },
  {
    key: 'CB_AI',
    name: 'CB_AI - Chatbot and Ai',
    notes: 'Separator is exactly 21 hyphens.',
    body: `Account name on the platform:
{azeerName}

Username:
{credUser}

Password:
{credPass}

Business ID:
{businessId}

CRM URL:
{crmUrl}

---------------------
The Case:
{descriptionEn}`,
  },
  {
    key: 'FEATURE_REQUEST',
    name: 'FEATURE_REQUEST - Product Team',
    notes: 'The three numbered prose sections are split from the employee\'s own words only. Anything they did not cover stays "Not Provided".',
    body: `1-Account :
{azeerName}

CRM URL:
{crmUrl}

2-Use Case / Problem to Solve:
{frUseCase}

3-Requested Feature:
{frRequestedFeature}

4-Expected Benefit / Business Impact:
{frExpectedBenefit}

5-Priority: (Nice to Have / Important / Critical)
{frPriority}`,
  },
  {
    key: 'FINANCE',
    name: 'FINANCE - Finance team',
    notes: 'Separator is exactly 13 hyphens.',
    body: `Azeer Account Name:
{azeerName}

WABA:
{waba}

CRM Link:
{crmUrl}

Business ID:
{businessId}

Platform Name:
{platformName}

Platform Login Credentials:

User:
{credUser}

Pass:
{credPass}

-------------
Request in details:
{descriptionEn}`,
  },
  {
    key: 'GENERAL',
    name: 'GENERAL - provisional',
    notes: 'Provisional. Used by Voice Support, Activation Team and Customer Success until real templates are supplied. Structured like the others so it can be swapped cleanly.',
    body: `Account:
{azeerName}

WABA:
{waba}

CRM Link:
{crmUrl}

Platform Name:
{platformName}

Business ID:
{businessId}

-------------
Request in details:
{descriptionEn}`,
  },
];

// -------------------------------------------------------------------- teams
// Team ids read live from the Azeer department on 2026-09-10.
const TEAMS = [
  { name: 'Engineering Team',      name_ar: 'فريق الهندسة',        desk_team_id: '527933000064576048', template_key: 'TECH',            sort: 10 },
  { name: 'Chatbot and Ai',        name_ar: 'فريق الشات بوت',      desk_team_id: '527933000060729127', template_key: 'CB_AI',           sort: 20 },
  { name: 'Product Team',          name_ar: 'فريق المنتج',          desk_team_id: '527933000064576128', template_key: 'FEATURE_REQUEST', sort: 30 },
  { name: 'Finance team',          name_ar: 'الفريق المالي',        desk_team_id: '527933000064576179', template_key: 'FINANCE',         sort: 40 },
  { name: 'Activation Team',       name_ar: 'فريق التفعيل',         desk_team_id: '527933000064576151', template_key: 'GENERAL',         sort: 50 },
  { name: 'Voice Support',         name_ar: 'الدعم الصوتي',         desk_team_id: '527933000066469025', template_key: 'GENERAL',         sort: 60 },
  { name: 'Customer  Success Team', name_ar: 'فريق نجاح العملاء',   desk_team_id: '527933000064576068', template_key: 'GENERAL',         sort: 70 },
];

// ----------------------------------------------------------- classifications
// desk_value is deliberately empty. The exact strings stored in the Desk
// Classification picklist are not known to this build, and guessing one would
// write a bad value onto real tickets. Use Admin -> Sync from Zoho to pull the
// live picklist, then map each classification. Until a classification has a
// desk_value the ticket is still created and routed correctly by team - the
// Classification field is simply left unset.
const CLASSIFICATIONS = [
  { name: 'Technical',       name_ar: 'فني',                team: 'Engineering Team', sort: 10 },
  { name: 'Bug',             name_ar: 'خلل برمجي',           team: 'Engineering Team', sort: 20 },
  { name: 'Messages',        name_ar: 'الرسائل',             team: 'Engineering Team', sort: 30 },
  { name: 'Templates',       name_ar: 'القوالب',             team: 'Engineering Team', sort: 40 },
  { name: 'Chatbot and AI',  name_ar: 'الشات بوت والذكاء الاصطناعي', team: 'Chatbot and Ai', sort: 50 },
  { name: 'Campaigns',       name_ar: 'الحملات',             team: 'Engineering Team', sort: 60 },
  { name: 'Lists',           name_ar: 'القوائم',             team: 'Engineering Team', sort: 70 },
  { name: 'Billing',         name_ar: 'الفوترة',             team: 'Finance team',     sort: 80 },
  { name: 'Feature Request', name_ar: 'طلب ميزة',            team: 'Product Team',     sort: 90 },
  // Owning team never confirmed - these two stop before ticket creation.
  { name: 'Integrations',    name_ar: 'التكاملات',           team: null, needs_review: 1, sort: 100 },
  { name: 'Other',           name_ar: 'أخرى',                team: null, needs_review: 1, sort: 110 },
];

// Exact priority strings from the Azeer Desk layout.
const PRIORITIES = [
  'P1 - Single Customer / Can Wait',
  'P2- Multiple Customer /  Can Wait',
  'P3- Single Customer / Immediate',
  'P4- Multiple Customer  / Immediate',
];

// ------------------------------------------------- sample troubleshooting
// Two worked examples so the engine is usable on day one. They are ordinary
// database rows: edit them, rename them or delete them in Admin -> Troubleshooting.
const SAMPLE_CASES = [
  {
    name_en: 'WhatsApp Messages Not Sending',
    name_ar: 'رسائل الواتساب لا تُرسل',
    description_ar: 'العميل لا يستطيع إرسال رسائل من المنصة.',
    team: 'Engineering Team',
    classification: 'Messages',
    steps: [
      {
        key: 'S1',
        instruction_ar: 'افتح الـ Dashboard الخاص بالعميل، ثم ادخل على إعدادات الـ WhatsApp وتأكد أن الرقم ظاهر بشكل صحيح.',
        options: [
          { label_ar: 'نعم، الرقم ظاهر بشكل صحيح', record_en: 'Verified the WhatsApp number configuration from the dashboard and confirmed that the number is displayed correctly.', next: 'S2' },
          { label_ar: 'لا، الرقم غير ظاهر', record_en: 'Verified the WhatsApp number configuration from the dashboard and found that the number is not displayed.', next: 'S5' },
          { label_ar: 'لم أجد هذا الإعداد', record_en: 'Attempted to verify the WhatsApp number configuration but the setting could not be located in the dashboard.', next: 'S6' },
        ],
      },
      {
        key: 'S2',
        instruction_ar: 'من نفس الشاشة، تحقق من حالة الرقم. هل حالة الرقم Active؟',
        options: [
          { label_ar: 'نعم، الرقم Active', record_en: 'Checked the WhatsApp number status and confirmed that the number is active.', next: 'S3' },
          { label_ar: 'لا، الرقم غير Active', record_en: 'Checked the WhatsApp number status and confirmed that the number is not active.', next: 'S6' },
          { label_ar: 'الحالة غير واضحة', record_en: 'Checked the WhatsApp number status; the status could not be determined from the dashboard.', next: 'S6' },
        ],
      },
      {
        key: 'S3',
        instruction_ar: 'جرّب إرسال رسالة اختبارية من المنصة إلى رقم معروف. ماذا حدث؟',
        options: [
          { label_ar: 'الرسالة وصلت بنجاح', record_en: 'Sent a test message from the platform to a known number; the message was delivered successfully.', next: 'S4' },
          { label_ar: 'الرسالة تظهر في المحادثة ولكن لم تصل', record_en: 'Sent a test message from the platform; the message appeared in the conversation but was not delivered to the recipient.', next: 'S7' },
          { label_ar: 'الرسالة لم تُرسل من الأساس', record_en: 'Sent a test message from the platform; the message was not sent at all.', next: 'S7' },
        ],
      },
      {
        key: 'S4',
        instruction_ar: 'الرسالة الاختبارية وصلت. اطلب من العميل إعادة المحاولة الآن وتأكد من النتيجة معه.',
        options: [
          { label_ar: 'المشكلة انتهت مع العميل', record_en: 'Asked the customer to retry after the successful test; the customer confirmed that messages are now being sent.', outcome: 'RESOLVED' },
          { label_ar: 'المشكلة ما زالت موجودة عند العميل', record_en: 'Asked the customer to retry after the successful test; the customer confirmed that the issue still occurs on their side.', outcome: 'PARTIAL' },
        ],
      },
      {
        key: 'S5',
        instruction_ar: 'الرقم غير ظاهر. تحقق من ربط الرقم بالـ Business Manager الخاص بالعميل.',
        options: [
          { label_ar: 'الرقم مربوط بشكل صحيح', record_en: 'Checked the number linkage in the Business Manager and confirmed that the number is correctly linked.', next: 'S7' },
          { label_ar: 'الرقم غير مربوط', record_en: 'Checked the number linkage in the Business Manager and found that the number is not linked.', outcome: 'PERSISTS' },
          { label_ar: 'لا أملك صلاحية الوصول للـ Business Manager', record_en: 'Could not verify the number linkage because access to the Business Manager was not available.', outcome: 'UNKNOWN' },
        ],
      },
      {
        key: 'S6',
        instruction_ar: 'جرّب تسجيل الخروج ثم الدخول مرة أخرى، وامسح الـ cache الخاص بالمتصفح، ثم أعد فتح الإعدادات.',
        options: [
          { label_ar: 'الإعداد ظهر بعد إعادة الدخول', record_en: 'Signed out, cleared the browser cache and signed back in; the setting became visible afterwards.', next: 'S2' },
          { label_ar: 'لم يتغير شيء', record_en: 'Signed out, cleared the browser cache and signed back in; there was no change.', outcome: 'PERSISTS' },
        ],
      },
      {
        key: 'S7',
        instruction_ar: 'جرّب نفس الإجراء من حساب آخر أو متصفح آخر لتحديد ما إذا كانت المشكلة خاصة بالحساب.',
        options: [
          { label_ar: 'المشكلة تكررت في الحساب/المتصفح الآخر', record_en: 'Repeated the test from another account and browser; the issue was reproduced.', outcome: 'PERSISTS' },
          { label_ar: 'المشكلة لم تتكرر', record_en: 'Repeated the test from another account and browser; the issue was not reproduced.', outcome: 'PARTIAL' },
          { label_ar: 'لم أتمكن من الاختبار', record_en: 'Could not repeat the test from another account or browser.', outcome: 'UNKNOWN' },
        ],
      },
    ],
  },
  {
    name_en: 'Campaign Messages Not Delivered',
    name_ar: 'رسائل الحملة لا تصل للعملاء',
    description_ar: 'الحملة تظهر أنها شغالة ولكن الرسائل لا تصل للعملاء.',
    team: 'Engineering Team',
    classification: 'Campaigns',
    steps: [
      {
        key: 'S1',
        instruction_ar: 'افتح الحملة من لوحة التحكم وتحقق من حالتها. ما هي حالة الحملة الآن؟',
        options: [
          { label_ar: 'الحملة تعمل (Running)', record_en: 'Opened the campaign from the dashboard and confirmed that its status is running.', next: 'S2' },
          { label_ar: 'الحملة متوقفة (Paused/Stopped)', record_en: 'Opened the campaign from the dashboard and found that the campaign is paused or stopped.', outcome: 'RESOLVED' },
          { label_ar: 'الحملة مكتملة (Completed)', record_en: 'Opened the campaign from the dashboard and found that the campaign is already completed.', next: 'S2' },
        ],
      },
      {
        key: 'S2',
        instruction_ar: 'افتح تقرير الحملة وتحقق من عدد الرسائل المرسلة مقابل عدد جهات الاتصال في القائمة.',
        options: [
          { label_ar: 'عدد الرسائل المرسلة = 0', record_en: 'Reviewed the campaign report and found that no messages were sent.', next: 'S4' },
          { label_ar: 'الرسائل أُرسلت ولكن لم تصل', record_en: 'Reviewed the campaign report and confirmed that messages were sent but not delivered to recipients.', next: 'S3' },
          { label_ar: 'الرسائل أُرسلت ووصلت لجزء من العملاء فقط', record_en: 'Reviewed the campaign report and confirmed that messages were delivered to only part of the audience.', next: 'S3' },
        ],
      },
      {
        key: 'S3',
        instruction_ar: 'تحقق من حالة القالب المستخدم في الحملة. هل القالب معتمد (Approved)؟',
        options: [
          { label_ar: 'نعم، القالب معتمد', record_en: 'Checked the template used by the campaign and confirmed that it is approved.', next: 'S5' },
          { label_ar: 'لا، القالب مرفوض أو قيد المراجعة', record_en: 'Checked the template used by the campaign and found that it is rejected or still under review.', outcome: 'RESOLVED' },
          { label_ar: 'لم أستطع تحديد حالة القالب', record_en: 'Attempted to check the template status but it could not be determined.', outcome: 'UNKNOWN' },
        ],
      },
      {
        key: 'S4',
        instruction_ar: 'تحقق من القائمة المرتبطة بالحملة. هل تحتوي على جهات اتصال صالحة؟',
        options: [
          { label_ar: 'نعم، القائمة تحتوي على أرقام صالحة', record_en: 'Checked the list attached to the campaign and confirmed that it contains valid contacts.', next: 'S5' },
          { label_ar: 'القائمة فارغة أو الأرقام غير صالحة', record_en: 'Checked the list attached to the campaign and found that it is empty or contains invalid numbers.', outcome: 'RESOLVED' },
        ],
      },
      {
        key: 'S5',
        instruction_ar: 'جرّب إرسال رسالة مباشرة بنفس القالب إلى رقم اختباري واحد. ماذا حدث؟',
        options: [
          { label_ar: 'الرسالة وصلت للرقم الاختباري', record_en: 'Sent a direct message using the same template to a single test number; the message was delivered.', outcome: 'PARTIAL' },
          { label_ar: 'الرسالة لم تصل للرقم الاختباري', record_en: 'Sent a direct message using the same template to a single test number; the message was not delivered.', outcome: 'PERSISTS' },
          { label_ar: 'لم أتمكن من الإرسال', record_en: 'Could not send a direct test message using the same template.', outcome: 'UNKNOWN' },
        ],
      },
    ],
  },
];

// ---------------------------------------------------------------------------

function seed() {
  if (meta('seeded') === '2') return { skipped: true };

  const run = db.transaction(() => {
    for (const t of TEMPLATES) {
      db.prepare(
        `INSERT INTO templates (key, name, body, notes) VALUES (?, ?, ?, ?)
         ON CONFLICT(key) DO NOTHING`
      ).run(t.key, t.name, t.body, t.notes);
    }

    for (const t of TEAMS) {
      db.prepare(
        `INSERT INTO teams (name, name_ar, desk_team_id, template_key, sort) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(name) DO NOTHING`
      ).run(t.name, t.name_ar, t.desk_team_id, t.template_key, t.sort);
    }

    const teamId = (name) => {
      if (!name) return null;
      const row = db.prepare('SELECT id FROM teams WHERE name = ?').get(name);
      return row ? row.id : null;
    };

    for (const c of CLASSIFICATIONS) {
      const tid = teamId(c.team);
      const tpl = c.team
        ? db.prepare('SELECT template_key FROM teams WHERE id = ?').get(tid)?.template_key
        : null;
      db.prepare(
        `INSERT INTO classifications (name, name_ar, desk_value, team_id, template_key, needs_review, sort)
         VALUES (?, ?, NULL, ?, ?, ?, ?)
         ON CONFLICT(name) DO NOTHING`
      ).run(c.name, c.name_ar, tid, tpl || null, c.needs_review || 0, c.sort);
    }

    meta('priorities', JSON.stringify(PRIORITIES));

    for (const c of SAMPLE_CASES) {
      const exists = db.prepare('SELECT id FROM ts_cases WHERE name_en = ?').get(c.name_en);
      if (exists) continue;

      const clsRow = c.classification
        ? db.prepare('SELECT id FROM classifications WHERE name = ?').get(c.classification)
        : null;

      const caseId = db
        .prepare(
          `INSERT INTO ts_cases (name_en, name_ar, description_ar, team_id, classification_id, sort)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(c.name_en, c.name_ar, c.description_ar, teamId(c.team), clsRow ? clsRow.id : null, 100)
        .lastInsertRowid;

      // Insert steps first so options can point at them by key.
      const stepIds = {};
      c.steps.forEach((s, i) => {
        stepIds[s.key] = db
          .prepare(
            `INSERT INTO ts_steps (case_id, step_key, instruction_ar, sort) VALUES (?, ?, ?, ?)`
          )
          .run(caseId, s.key, s.instruction_ar, (i + 1) * 10).lastInsertRowid;
      });

      for (const s of c.steps) {
        s.options.forEach((o, i) => {
          db.prepare(
            `INSERT INTO ts_options (step_id, label_ar, record_en, next_step_id, outcome, sort)
             VALUES (?, ?, ?, ?, ?, ?)`
          ).run(
            stepIds[s.key],
            o.label_ar,
            o.record_en,
            o.next ? stepIds[o.next] : null,
            o.outcome || null,
            (i + 1) * 10
          );
        });
      }

      db.prepare('UPDATE ts_cases SET start_step_id = ? WHERE id = ?').run(
        stepIds[c.steps[0].key],
        caseId
      );
    }

    meta('seeded', '2');
    meta('seeded_at', new Date().toISOString());
  });

  run();
  return { skipped: false };
}

module.exports = { seed, PRIORITIES };

if (require.main === module) {
  const result = seed();
  console.log(result.skipped ? 'Already seeded - nothing to do.' : 'Seed complete.');
}
