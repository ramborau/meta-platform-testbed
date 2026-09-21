import crypto from 'node:crypto';
import { config } from '../config.js';

// Meta signs every webhook POST body with HMAC-SHA256 over the RAW bytes,
// using the app secret as the key, and sends it as:
//   X-Hub-Signature-256: sha256=<hex>
// The signature must be checked against the raw buffer - re-serialising the
// parsed JSON changes whitespace/key order and the digest will never match.
export function verifySignature(rawBody, headerValue) {
  if (!config.enforceSignature) {
    return { ok: true, reason: 'signature enforcement disabled' };
  }
  if (!config.appSecret) {
    return { ok: false, reason: 'META_APP_SECRET is not set' };
  }
  if (!headerValue) {
    return { ok: false, reason: 'missing X-Hub-Signature-256 header' };
  }

  const [algo, received] = String(headerValue).split('=');
  if (algo !== 'sha256' || !received) {
    return { ok: false, reason: `unexpected signature format: ${headerValue}` };
  }

  const expected = crypto
    .createHmac('sha256', config.appSecret)
    .update(rawBody || Buffer.alloc(0))
    .digest('hex');

  const a = Buffer.from(received, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  // timingSafeEqual throws on length mismatch, so guard first.
  const ok = a.length === b.length && crypto.timingSafeEqual(a, b);

  return ok ? { ok: true } : { ok: false, reason: 'signature mismatch' };
}

// Appproof for Graph calls: HMAC-SHA256 of the access token keyed by the app secret.
// Meta recommends sending this alongside server-side calls.
export function appSecretProof(accessToken) {
  if (!config.appSecret || !accessToken) return undefined;
  return crypto.createHmac('sha256', config.appSecret).update(accessToken).digest('hex');
}
