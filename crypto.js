'use strict';
/**
 * Small crypto helpers. Refresh tokens are encrypted at rest so that a stolen
 * database file is not by itself a set of live Zoho credentials.
 */

const crypto = require('crypto');
const config = require('./config');

/** Derive a stable 32-byte key from APP_SECRET. */
function key(salt) {
  return crypto.scryptSync(config.APP_SECRET, salt, 32);
}

function encrypt(plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key('token'), iv);
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64url')}.${tag.toString('base64url')}.${enc.toString('base64url')}`;
}

function decrypt(packed) {
  const [ivB64, tagB64, dataB64] = String(packed).split('.');
  if (!ivB64 || !tagB64 || !dataB64) throw new Error('malformed ciphertext');
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    key('token'),
    Buffer.from(ivB64, 'base64url')
  );
  decipher.setAuthTag(Buffer.from(tagB64, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(dataB64, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}

const randomId = (bytes = 24) => crypto.randomBytes(bytes).toString('base64url');

/** Constant-time string comparison, for passwords. */
function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/** Short reference printed to the employee and written to the log on failure. */
const errorRef = () => crypto.randomBytes(4).toString('hex').toUpperCase();

module.exports = { encrypt, decrypt, randomId, safeEqual, errorRef };
