'use strict';
/**
 * CRM URL -> everything the ticket needs.
 *
 * The chain is: pasted URL -> CRM record (Azeer or Accounts) -> the Accounts
 * record -> the matching Zoho Desk account -> that account's primary contact.
 *
 * The bridge to Desk is the awkward part and is handled exactly as documented in
 * the runbook: Desk accounts sync from the CRM *Accounts* module, so the Desk
 * account name mirrors Accounts.Account_Name and not Azeer.Name. Those two
 * frequently differ, so three strategies are tried in order.
 */

const config = require('./config');
const zoho = require('./zoho');
const log = require('./log');

/** Modules the tool accepts a URL for. */
const AZEER = config.ZOHO.CRM_AZEER_MODULE; // "Azeer"
const ACCOUNTS = 'Accounts';

/** CustomModule55 is the internal name of the Azeer module in this org. */
const MODULE_ALIASES = { CustomModule55: AZEER, Accounts: ACCOUNTS, [AZEER]: AZEER };

class ResolveError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'ResolveError';
    this.code = code; // bad_url | wrong_module | not_found
  }
}

/**
 * Pull the module and record id out of a pasted Zoho CRM URL.
 * Handles /tab/<Module>/<id>, #/<Module>/<id> and ...tab=<Module>&id=<id> shapes.
 */
function parseCrmUrl(input) {
  const raw = String(input || '').trim();
  if (!raw) throw new ResolveError('Please enter a Zoho CRM Account URL.', 'bad_url');

  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new ResolveError('Please enter a valid Zoho CRM Account URL.', 'bad_url');
  }
  if (!/(^|\.)zoho\./i.test(url.hostname) || !/crm/i.test(url.hostname + url.pathname)) {
    throw new ResolveError('Please enter a valid Zoho CRM Account URL.', 'bad_url');
  }

  const haystack = `${url.pathname}/${url.hash.replace(/^#\/?/, '')}`;
  const segments = haystack.split('/').filter(Boolean);

  let moduleName = null;
  let recordId = null;

  const tabIndex = segments.findIndex((s) => s.toLowerCase() === 'tab');
  if (tabIndex !== -1 && segments[tabIndex + 1]) {
    moduleName = segments[tabIndex + 1];
    recordId = segments[tabIndex + 2] || null;
  }
  if (!recordId) {
    // Fall back to the last two path-like segments, then to query parameters.
    const ids = segments.filter((s) => /^\d{8,}$/.test(s));
    recordId = ids.length ? ids[ids.length - 1] : url.searchParams.get('id');
    if (!moduleName) {
      const idx = segments.findIndex((s) => s === recordId);
      moduleName = idx > 0 ? segments[idx - 1] : url.searchParams.get('module');
    }
  }

  if (!recordId || !/^\d{8,}$/.test(recordId)) {
    throw new ResolveError('Please enter a valid Zoho CRM Account URL.', 'bad_url');
  }

  const resolved = MODULE_ALIASES[moduleName];
  if (!resolved) {
    throw new ResolveError(
      `This URL points at "${moduleName || 'an unknown module'}". Paste a URL from the Azeer or Accounts module.`,
      'wrong_module'
    );
  }
  return { module: resolved, recordId, url: raw };
}

const pick = (record, ...names) => {
  for (const name of names) {
    const value = record?.[name];
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return null;
};

const lookupName = (value) =>
  value && typeof value === 'object' ? value.name || null : value || null;
const lookupId = (value) => (value && typeof value === 'object' ? value.id || null : null);

/** Split the WABA_Login_Credentials textarea on the first newline. Verbatim. */
function splitCredentials(raw) {
  if (!raw || typeof raw !== 'string') return { credUser: '', credPass: '' };
  const index = raw.search(/\r?\n/);
  if (index === -1) return { credUser: raw.trim(), credPass: '' };
  return {
    credUser: raw.slice(0, index).trim(),
    credPass: raw.slice(index).replace(/^\r?\n/, '').trim(),
  };
}

function firstEmailDomain(...candidates) {
  for (const candidate of candidates) {
    const match = String(candidate || '').match(/@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/);
    if (match) return match[1];
  }
  return null;
}

// --------------------------------------------------------------- CRM stage

async function fetchCrmRecord(crm, moduleName, recordId) {
  const body = await crm.get(`/${moduleName}/${encodeURIComponent(recordId)}`);
  const record = body?.data?.[0];
  if (!record) {
    throw new ResolveError('Unable to retrieve this CRM account. Please verify the Account URL.', 'not_found');
  }
  return record;
}

async function findAzeerForAccount(crm, accountsId) {
  try {
    const body = await crm.get(`/${AZEER}/search`, {
      criteria: `(Account_Name:equals:${accountsId})`,
    });
    return Array.isArray(body?.data) ? body.data : [];
  } catch (error) {
    if (error.status === 204 || error.status === 404) return [];
    throw error;
  }
}

// -------------------------------------------------------------- Desk stage

async function searchDeskAccount(desk, accountName) {
  if (!accountName) return null;
  try {
    const body = await desk.get('/accounts/search', {
      accountName,
      limit: 5,
    });
    const rows = body?.data || [];
    return rows.length ? rows[0] : null;
  } catch (error) {
    if (error.status === 204 || error.status === 404) return null;
    throw error;
  }
}

async function searchDeskContactByDomain(desk, domain) {
  if (!domain) return null;
  try {
    const body = await desk.get('/contacts/search', { email: `*${domain}*`, limit: 5 });
    const rows = body?.data || [];
    return rows.length ? rows[0] : null;
  } catch (error) {
    if (error.status === 204 || error.status === 404) return null;
    throw error;
  }
}

async function primaryContact(desk, deskAccountId) {
  try {
    const body = await desk.get(`/accounts/${deskAccountId}/contacts`, { limit: 50 });
    const rows = body?.data || [];
    if (!rows.length) return null;
    const primary = rows.find((c) => c?.mappingInfo?.mappingType === 'PRIMARY');
    return primary || rows[rows.length - 1];
  } catch (error) {
    if (error.status === 204 || error.status === 404) return null;
    throw error;
  }
}

// ------------------------------------------------------------------ public

/**
 * Resolve a pasted CRM URL into the full account picture.
 * Returns { crm, contact, desk, warnings }. Warnings are shown to the employee
 * but do not by themselves block ticket creation, except where noted in
 * tickets.js.
 */
async function resolveAccount(crmUrl, { crmToken, deskToken }) {
  const parsed = parseCrmUrl(crmUrl);
  const crm = zoho.crm(crmToken);
  const desk = zoho.desk(deskToken);
  const warnings = [];

  // 1. The CRM record, and the Azeer record behind it.
  let azeer = null;
  let accounts = null;

  if (parsed.module === AZEER) {
    azeer = await fetchCrmRecord(crm, AZEER, parsed.recordId);
    const accountsId = lookupId(azeer.Account_Name);
    if (accountsId) {
      try {
        accounts = await fetchCrmRecord(crm, ACCOUNTS, accountsId);
      } catch {
        warnings.push('The linked Accounts record could not be read.');
      }
    } else {
      warnings.push('This Azeer record has no linked company account.');
    }
  } else {
    accounts = await fetchCrmRecord(crm, ACCOUNTS, parsed.recordId);
    const matches = await findAzeerForAccount(crm, parsed.recordId);
    if (matches.length === 1) {
      azeer = matches[0];
    } else if (matches.length > 1) {
      azeer = matches[0];
      warnings.push(
        `${matches.length} Azeer records are linked to this company account. Using "${
          pick(matches[0], 'Name') || 'the first one'
        }" - check this is the right platform account.`
      );
    } else {
      warnings.push('No Azeer platform record is linked to this company account. Platform fields will be unavailable.');
    }
  }

  const azeerName = azeer ? pick(azeer, 'Name') : null;
  const accountsName = accounts ? pick(accounts, 'Account_Name') : null;
  const { credUser, credPass } = splitCredentials(azeer ? pick(azeer, 'WABA_Login_Credentials') : null);

  // 2. Bridge to Desk. Search by the Accounts name, never the Azeer name.
  let deskAccount = null;
  let deskContact = null;

  deskAccount = await searchDeskAccount(desk, accountsName);
  if (!deskAccount && accountsName) {
    const latinToken = (accountsName.match(/[A-Za-z][A-Za-z0-9&._-]{2,}/) || [])[0];
    if (latinToken) deskAccount = await searchDeskAccount(desk, `*${latinToken}*`);
  }
  if (!deskAccount) {
    const domain = firstEmailDomain(
      azeer && pick(azeer, 'Store_Contact_Email', 'Voice_Contact_Email'),
      accounts && pick(accounts, 'Email'),
      accounts && lookupName(accounts.Primary_Contact)
    );
    const contact = await searchDeskContactByDomain(desk, domain);
    if (contact) {
      deskContact = contact;
      if (contact.accountId) {
        try {
          deskAccount = await desk.get(`/accounts/${contact.accountId}`);
        } catch {
          deskAccount = contact.account || null;
        }
      } else {
        deskAccount = contact.account || null;
      }
    }
  }

  if (!deskAccount) {
    warnings.push('No matching Zoho Desk account was found for this customer.');
  } else {
    // Confirm the Desk account really mirrors this Accounts record.
    const linkedCrmId = deskAccount?.zohoCRMAccount?.id || deskAccount?.zohoCRMAccountId || null;
    const accountsId = accounts ? accounts.id : null;
    if (linkedCrmId && accountsId && String(linkedCrmId) !== String(accountsId)) {
      warnings.push(
        'The Zoho Desk account found does not appear to be linked to this CRM account. Check the customer before submitting.'
      );
    } else if (!linkedCrmId) {
      warnings.push('The Zoho Desk account is not linked to a CRM account, so the ticket may not appear under the CRM record.');
    }

    if (!deskContact) deskContact = await primaryContact(desk, deskAccount.id);
    if (!deskContact) warnings.push('No contact was found under the Zoho Desk account.');
  }

  const crmModuleForUrl = azeer ? AZEER : ACCOUNTS;
  const crmRecordIdForUrl = azeer ? azeer.id : accounts?.id;

  const result = {
    input: parsed,
    crm: {
      azeerId: azeer ? azeer.id : null,
      azeerName,
      accountsId: accounts ? accounts.id : null,
      accountsName,
      accountOwner: lookupName(accounts?.Owner) || lookupName(azeer?.Owner),
      accountManager: lookupName(azeer?.Account_Manager),
      businessId: azeer ? pick(azeer, 'Azeer_ID_number') : null,
      whatsappBusinessId: azeer ? pick(azeer, 'WhatsApp_Business_ID') : null,
      waba: azeer ? pick(azeer, 'WABA_Requested_Phone_Number') : null,
      platformName: azeer ? pick(azeer, 'Platform_Name') : null,
      storeUrl: azeer ? pick(azeer, 'Store_URL') : null,
      chatbotName: azeer ? pick(azeer, 'Chatbot_Name') : null,
      credUser: config.INCLUDE_CREDENTIALS ? credUser : '',
      credPass: config.INCLUDE_CREDENTIALS ? credPass : '',
      crmUrl: parsed.url,
      crmCanonicalUrl:
        crmRecordIdForUrl ? zoho.crmRecordUrl(crmModuleForUrl, crmRecordIdForUrl) : parsed.url,
      noteParentModule: crmModuleForUrl,
      noteParentId: crmRecordIdForUrl,
    },
    desk: {
      accountId: deskAccount ? deskAccount.id : null,
      accountName: deskAccount ? deskAccount.accountName : null,
    },
    contact: deskContact
      ? {
          id: deskContact.id,
          name:
            [deskContact.firstName, deskContact.lastName].filter(Boolean).join(' ') ||
            deskContact.email ||
            null,
          email: deskContact.email || null,
          mobile: deskContact.mobile || deskContact.phone || null,
        }
      : null,
    warnings,
  };

  log.info('resolve.ok', {
    module: parsed.module,
    azeer: Boolean(azeer),
    deskAccount: Boolean(deskAccount),
    contact: Boolean(deskContact),
    warnings: warnings.length,
  });
  return result;
}

module.exports = { resolveAccount, parseCrmUrl, splitCredentials, ResolveError };
