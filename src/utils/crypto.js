// Small WebCrypto helpers (available in Workers and Node >= 20).

const enc = new TextEncoder();

export function bytesToHex(bytes) {
  let out = '';
  for (const b of new Uint8Array(bytes)) out += b.toString(16).padStart(2, '0');
  return out;
}

export function bytesToB64(bytes) {
  let bin = '';
  for (const b of new Uint8Array(bytes)) bin += String.fromCharCode(b);
  return btoa(bin);
}

export function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function b64url(input) {
  const bytes = typeof input === 'string' ? enc.encode(input) : input;
  return bytesToB64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function randomBytes(n) {
  return crypto.getRandomValues(new Uint8Array(n));
}

export function randomToken(n = 32) {
  return b64url(randomBytes(n));
}

export async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(text));
  return bytesToHex(digest);
}

// Constant-time comparison of equal-length byte arrays.
export function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}
