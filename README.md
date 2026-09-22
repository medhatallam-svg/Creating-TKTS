# Azeer Ticketing & Troubleshooting System

An internal web application for the support / customer-success team. An employee opens it in a
browser, pastes a CRM account URL, picks a team and classification, either walks a guided
troubleshooting flow or describes the problem directly, reviews the ticket, and submits. The server
does the rest: reads the account from Zoho CRM, rewrites the description into professional English,
generates the subject, renders the team's ticket template, creates the Zoho Desk ticket, routes it to
the team, and adds a note to the CRM account **under that employee's own Zoho identity**.

Employees need nothing installed — no Claude, no MCP, no API tools. Just the URL.

---

## Contents

1. [How it works](#1-how-it-works)
2. [Setup](#2-setup)
3. [Deployment](#3-deployment)
4. [Daily use](#4-daily-use)
5. [The admin panel](#5-the-admin-panel)
6. [The troubleshooting engine](#6-the-troubleshooting-engine)
7. [Zoho limitations and how each is handled](#7-zoho-limitations-and-how-each-is-handled)
8. [What still needs your input](#8-what-still-needs-your-input)
9. [Code map](#9-code-map)
10. [Testing](#10-testing)

---

## 1. How it works

```
Employee browser
      |  HTTPS, session cookie only. No credentials in the page.
      v
This application  (Node.js + Express + SQLite)
      |                    |                        |
      v                    v                        v
 Zoho CRM             Zoho Desk              Anthropic API
 (employee's own      (employee's token,     (description rewrite,
  OAuth token)         or service token)      subject generation)
```

Every secret — Zoho client secret, refresh tokens, the AI key — lives in the server's environment.
Nothing is ever sent to the browser. The ticket body is rendered on the server from the stored
template, so what the employee previews is literally what gets created.

The submission sequence, and what happens when part of it fails:

| Stage | On failure |
|---|---|
| 1. Create the Zoho Desk ticket | Clean failure. Nothing was created; the employee can retry. |
| 2. Set the `Ticket Creator` custom field | Ticket still exists. Reported as "not set". **Never retried by creating a second ticket.** |
| 3. Verify the CRM ↔ Desk association | Ticket still exists. Reported as "needs checking". |
| 4. Add the CRM note | Ticket still exists. Reported as "not added". |

Once a ticket number exists, it is never created twice — see
[idempotency](#duplicate-prevention) below.

---

## 2. Setup

### 2.1 Requirements

- Node.js 20 or newer
- A Linux host reachable by the team (internal server or VPS)
- HTTPS (nginx or any reverse proxy)

### 2.2 Create the Zoho OAuth application

1. Go to <https://api-console.zoho.com> and sign in as a Zoho administrator.
2. **Add Client → Server-based Applications.**
3. Authorised Redirect URI — exactly, with no trailing slash:

   ```
   https://YOUR-DOMAIN/api/auth/zoho/callback
   ```

4. Copy the **Client ID** and **Client Secret**.

This is the application employees will authorise individually. It does *not* need to be a Self
Client.

### 2.3 (Optional but recommended) Create the service Self Client

Used only as a Desk fallback for employees with no Desk agent seat, and for Admin → Sync.

1. api-console.zoho.com → **Add Client → Self Client**.
2. Generate a code with these scopes, validity 10 minutes:

   ```
   Desk.tickets.ALL,Desk.basic.READ,Desk.search.READ,Desk.contacts.READ,Desk.settings.READ
   ```

3. Exchange the code for a refresh token:

   ```bash
   curl -X POST https://accounts.zoho.com/oauth/v2/token \
     -d grant_type=authorization_code \
     -d client_id=SELF_CLIENT_ID \
     -d client_secret=SELF_CLIENT_SECRET \
     -d code=THE_GENERATED_CODE
   ```

4. Put the `refresh_token` in `ZOHO_SERVICE_REFRESH_TOKEN`.

### 2.4 Install

```bash
unzip azeer-ticket-system.zip
cd azeer-ticket-system
npm install --omit=dev
cp .env.example .env
```

Edit `.env`. At minimum:

```ini
APP_BASE_URL=https://tickets.yourdomain.com
APP_SECRET=            # openssl rand -base64 48
ZOHO_CLIENT_ID=
ZOHO_CLIENT_SECRET=
ADMIN_PASSWORD=
ANTHROPIC_API_KEY=     # strongly recommended
```

Then:

```bash
npm start
```

The database is created and seeded on first boot. The server refuses to start if `APP_SECRET`,
the Zoho client credentials or `ADMIN_PASSWORD` are missing — it tells you which.

> **`APP_SECRET` encrypts the stored Zoho refresh tokens.** Changing it logs everyone out *and*
> invalidates every stored token, so all employees must sign in again. Back it up with the database.

---

## 3. Deployment

`deploy/` contains a systemd unit and an nginx server block.

```bash
sudo useradd --system --home /opt/azeer-tickets azeer
sudo mv azeer-ticket-system /opt/azeer-tickets/app
sudo chown -R azeer:azeer /opt/azeer-tickets

sudo cp /opt/azeer-tickets/app/deploy/azeer-tickets.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now azeer-tickets
sudo systemctl status azeer-tickets

sudo cp /opt/azeer-tickets/app/deploy/nginx.conf.example /etc/nginx/sites-available/azeer-tickets
sudo ln -s /etc/nginx/sites-available/azeer-tickets /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d tickets.yourdomain.com
```

Logs: `journalctl -u azeer-tickets -f`. They are one JSON object per line, with anything resembling
a token, key or password redacted.

**Back up `data/azeer-tickets.db`** — it holds the configuration, the troubleshooting flows, the
audit log and the encrypted employee tokens. Because SQLite runs in WAL mode, copy it with
`sqlite3 data/azeer-tickets.db ".backup /backups/azeer-$(date +%F).db"` rather than `cp`.

---

## 4. Daily use

1. The employee opens the URL and clicks **Sign in with Zoho** once. Zoho asks them to authorise
   the app; after that the session lasts 12 hours.
2. Paste the CRM account URL. The account preview appears within a second or two — name, ID, owner,
   contact, mobile, platform, WABA. They never type any of it.
3. Pick a **Team** and a **Classification**. Both fields are search boxes, not long dropdowns.
   Choosing a classification suggests its team automatically.
4. Choose **Troubleshooting / TS** or **Create Ticket Directly**.
5. Troubleshooting: pick a case, then answer one Arabic question at a time until the flow ends.
   Direct: write the problem in Arabic, English or a mix.
6. **Review** — the generated subject, the professional English, the troubleshooting history and the
   exact ticket body. Subject and description are editable; click *Update preview* to re-render.
7. **Submit.** The result screen shows the ticket number, a direct link, and the status of the CRM
   note, the CRM link and the Ticket Creator field.

### Duplicate prevention

Every attempt carries a submission key generated in the browser and kept in `sessionStorage`. The
server claims that key in the database *before* calling Zoho. Consequently:

- Double-clicking Submit creates one ticket; the button also disables itself immediately.
- A refresh mid-submit returns the already-created ticket instead of making another.
- A retry after a genuine failure is allowed, because a failed attempt releases the key.
- A concurrent second request for the same key is refused with "already being created".

---

## 5. The admin panel

`/admin.html`, unlocked with `ADMIN_PASSWORD`. The first person to unlock it is marked as an
administrator and keeps that flag.

| Tab | What you can change |
|---|---|
| **Overview** | Health of the configuration, and **Sync from Zoho** |
| **Employees** | Add, rename, make admin, deactivate, disconnect their Zoho token |
| **Teams** | Name, Arabic name, **Zoho Desk team id**, template, order, active |
| **Classifications** | Name, owning team, template, **Desk value**, priority, needs-review, active |
| **Templates** | The full body of each of the five templates |
| **Troubleshooting** | Cases, steps, answers, English recordings, branching, outcomes |
| **Audit log** | Every submission and every configuration change |

**Sync from Zoho** reads the live departments, teams, active agents and the ticket-layout
Classification and Priority picklists, and shows them. Nothing is auto-written — you map the values
yourself, from real data, so no identifier is ever invented.

Deactivating rather than deleting is the default for teams and classifications, so historical
tickets keep their reference.

---

## 6. The troubleshooting engine

A case is a **directed graph**, not a checklist.

```
CASE
 └─ Step S1   Arabic instruction
     ├─ answer A  → records English sentence A → go to S2
     ├─ answer B  → records English sentence B → go to S5
     └─ answer C  → records English sentence C → END: Issue Persists
```

Each answer carries three things, all set in the admin panel:

| Field | Purpose |
|---|---|
| `label_ar` | The Arabic text on the button the employee clicks |
| `record_en` | The professional English sentence written onto the ticket |
| `next_step_id` **or** `outcome` | Where the flow goes next, or how it ends |

Behaviour guaranteed by the engine:

- **One step on screen at a time.** The employee never chooses which step is next.
- **The English recording is authored, not generated.** It is a fixed sentence you write, so it is
  identical every time and never invented by a model. Button labels and "Yes"/"Option 1" never reach
  a ticket.
- **The path is server-side.** The browser is sent only the Arabic; the recorded English never
  leaves the server until the ticket is built. A tampered request cannot change the history.
- **An answer is validated against the step the run is actually on**, so a replayed or forged option
  id is rejected.
- **Back discards the answer it undoes.** Change your mind and the old sentence is gone — the ticket
  never contains two contradictory records.
- **Only the path actually walked reaches the ticket.** Steps skipped by branching are absent.
- **Progress is computed from the graph** (steps taken + the longest path still ahead) and never
  counts downwards.
- **Four outcomes**: Issue Resolved, Issue Persists, Partially Resolved, Unable to Determine. Each
  renders a fixed English sentence under `Troubleshooting Result`.
- **Broken flows are caught in the admin panel**, not by an employee: unreachable steps, answers with
  no destination, answers with no English recording, and cases that can never end are all listed.

Two worked cases ship as ordinary database rows — *WhatsApp Messages Not Sending* (7 steps) and
*Campaign Messages Not Delivered* (5 steps). Edit them, rename them or delete them freely.

---

## 7. Zoho limitations and how each is handled

### 7.1 A CRM note's author cannot be set by the API — solved by per-employee sign-in

The Notes module field metadata, read live from your org:

```
Created_By : operation_type { api_create: false, api_update: false }   → not writable
Owner      : field_read_only: true                                    → system-managed
```

So no API call can make a note that *says* it was written by someone else. Writing "Created by
Mohamed Medhat" into the note body would be a claim, not authorship — you explicitly ruled that out,
and this build does not do it.

**What this build does instead:** each employee authorises the app against their own Zoho account,
and the note is created with *their* token. The note really is theirs — `Created_By` is them,
because they made the call. This is the only legitimate way to satisfy the requirement, and it needs
no impersonation.

The consequence: **an employee must have a Zoho CRM licence and must sign in once.** Someone with no
CRM licence cannot use the tool. The admin panel shows who is connected.

### 7.2 `createTicket` silently ignores custom fields

Confirmed on ticket #29208: passing `cf` to ticket creation returns success while
`cf_ticket_creator` comes back `null`, with no error raised. The code therefore always follows
creation with a separate `PATCH`, then **reads the ticket back** and only reports the field as set if
the value is actually non-null.

### 7.3 Desk account names mirror CRM *Accounts*, not the Azeer module

Desk accounts sync from the Accounts module, so `Desk.accountName` matches `Accounts.Account_Name`
and not `Azeer.Name`. These often differ — `سالوس -Salus` in Azeer is `salus- سالوس` in Accounts.
Three strategies are tried in order, stopping at the first hit:

1. Search Desk accounts by the **Accounts-module** name.
2. The same search wrapped in wildcards around the first Latin token.
3. Search Desk contacts by `*<email domain>*` and take the account from the returned contact.

If all three miss, the tool **refuses to create the ticket** rather than filing it against no
account, and says so.

### 7.4 The Desk Classification picklist values are not known to this build

The exact strings stored in Desk's Classification field were never captured, and writing a guessed
value onto a real ticket is worse than leaving the field empty. So every classification ships with
its Desk value **blank**: the ticket is created and routed to the correct team, and the
Classification field is simply not set. The preview screen says so explicitly.

Fix it in five minutes: **Admin → Overview → Sync from Zoho**, then paste each real value into
Admin → Classifications → Desk value.

### 7.5 A Zoho Desk agent seat is separate from a CRM licence

If an employee has a Desk seat, the ticket is raised with their own token and is genuinely theirs
there too. If not, the ticket is raised with the service token and their name goes in the Ticket
Creator field — the tool says which happened on the success screen. The CRM note is under their own
identity either way.

### 7.6 No MCP is involved at runtime

MCP was used during development to read your live Zoho configuration. The deployed application talks
to the Zoho REST APIs directly. Nothing about it depends on Claude, Claude Desktop or any MCP server.

---

## 8. What still needs your input

These are carried over from the earlier build and are still open. Each one is visible in the admin
panel rather than hidden in code.

1. **Integrations** and **Other** have no confirmed owning team. Both are flagged *needs review* and
   **cannot be used** until you set a team — deliberately, so nothing is escalated to the wrong
   place. (Admin → Classifications.)
2. **Desk Classification values** are unmapped — see 7.4.
3. **Voice Support, Activation Team and Customer Success** use the provisional `GENERAL` template.
   Send me the real ones, or paste them into Admin → Templates.
4. **Business ID ambiguity**: the templates use `Azeer_ID_number` (the UUID agents paste today).
   `WhatsApp_Business_ID` is the Meta ID and is available as a separate token. Confirm which the
   teams mean.
5. **Assignee**: tickets are created with a team but no individual assignee, matching current
   practice. Say if you want an assignee too.
6. **Test ticket #29208** from the earlier build should still be deleted.

---

## 9. Code map

```
src/config.js        environment, verified Zoho ids, startup validation
src/db.js            SQLite schema, sweeper, lightweight column migrations
src/seed.js          verified teams/templates/classifications + 2 sample TS cases
src/crypto.js        token encryption at rest, safe compare, error references
src/log.js           JSON logging with secret redaction, and the audit trail
src/zoho.js          OAuth (per-employee + service), token cache, CRM/Desk clients
src/resolve.js       CRM URL → Azeer/Accounts → Desk account → primary contact
src/llm.js           Arabic/English → professional English, with no-invention rules
src/templates.js     server-side ticket body rendering from stored templates
src/troubleshoot.js  the branching engine: runs, answers, back, outcomes, validation
src/tickets.js       routing, preview, idempotent creation, cf PATCH, link check, CRM note
src/routes/auth.js   sign-in, sessions, admin elevation
src/routes/api.js    employee API, single place where errors become safe sentences
src/routes/admin.js  configuration CRUD, Zoho sync, audit
src/server.js        wiring, security headers, static files

public/index.html    the employee application
public/app.js        its logic: pickers, wizard, preview, submit
public/admin.html    the admin panel
public/admin.js      its logic
public/styles.css    one stylesheet, light and dark

scripts/selftest.js  25 offline tests
deploy/              systemd unit and nginx example
```

## 10. Testing

```bash
npm run check
```

Runs a syntax check plus 25 offline tests against a temporary database: seed integrity, exact
template wording (including the deliberate odd spacing), token fallbacks, the troubleshooting engine
(branching, back, terminal outcomes, path fidelity, rejection of foreign options, monotonic
progress), routing refusals, subject generation, CRM URL parsing, credential splitting, token
encryption and log redaction.

No live Zoho or Anthropic calls are made, so it is safe to run on production at any time.

**Not yet tested against live Zoho.** That needs the OAuth credentials, which you generate. The
first real check is pasting a CRM URL and confirming the account preview — no ticket is created at
that point.
