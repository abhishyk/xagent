// Google service-account OAuth (JWT bearer grant, RS256) using WebCrypto.
// Credentials come only from Worker secrets and never leave the Worker.

import { b64url, b64ToBytes } from '../utils/crypto.js';

export const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/documents.readonly',
  'https://www.googleapis.com/auth/drive.metadata.readonly',
].join(' ');

let cached = null; // { token, exp, email } — per isolate, never persisted

function pemToPkcs8(pem) {
  const normalized = String(pem).replace(/\\n/g, '\n').trim();
  const body = normalized
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----/, '')
    .replace(/-----END [A-Z ]*PRIVATE KEY-----/, '')
    .replace(/\s+/g, '');
  if (!body) throw new Error('GOOGLE_PRIVATE_KEY is empty or malformed');
  return b64ToBytes(body);
}

export async function signJwt(email, privateKeyPem, scope, nowSec = Math.floor(Date.now() / 1000)) {
  const header = { alg: 'RS256', typ: 'JWT' };
  const claims = {
    iss: email,
    scope,
    aud: 'https://oauth2.googleapis.com/token',
    iat: nowSec,
    exp: nowSec + 3600,
  };
  const unsigned = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
  const key = await crypto.subtle.importKey(
    'pkcs8', pemToPkcs8(privateKeyPem), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(unsigned));
  return `${unsigned}.${b64url(new Uint8Array(sig))}`;
}

export async function getAccessToken(env) {
  const email = env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const pem = env.GOOGLE_PRIVATE_KEY;
  if (!email || !pem) {
    throw new Error('Google credentials are not configured (GOOGLE_SERVICE_ACCOUNT_EMAIL / GOOGLE_PRIVATE_KEY secrets).');
  }
  const now = Math.floor(Date.now() / 1000);
  if (cached && cached.email === email && cached.exp - 120 > now) return cached.token;

  const assertion = await signJwt(email, pem, GOOGLE_SCOPES, now);
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    // Google's error text never contains the key; still keep it short.
    throw new Error(`Google token request failed (${res.status}): ${detail.slice(0, 200)}`);
  }
  const data = await res.json();
  cached = { token: data.access_token, exp: now + (data.expires_in || 3600), email };
  return cached.token;
}

export function _resetTokenCache() {
  cached = null;
}
