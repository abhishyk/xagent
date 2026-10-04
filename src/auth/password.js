// PBKDF2-SHA256 password hashing via WebCrypto (natively supported by Workers).
// Format: pbkdf2$sha256$<iterations>$<salt_b64>$<hash_b64>
// Workers caps PBKDF2 at 100,000 iterations; the iteration count is stored per
// hash so it can be changed later without invalidating existing passwords.

import { b64ToBytes, bytesToB64, randomBytes, timingSafeEqual } from '../utils/crypto.js';

const KEY_BITS = 256;

async function derive(password, salt, iterations) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, KEY_BITS);
  return new Uint8Array(bits);
}

export async function hashPassword(password, iterations = 100000) {
  const salt = randomBytes(16);
  const hash = await derive(password, salt, iterations);
  return `pbkdf2$sha256$${iterations}$${bytesToB64(salt)}$${bytesToB64(hash)}`;
}

export async function verifyPassword(password, stored) {
  try {
    const [scheme, algo, iterStr, saltB64, hashB64] = String(stored).split('$');
    if (scheme !== 'pbkdf2' || algo !== 'sha256') return false;
    const iterations = parseInt(iterStr, 10);
    if (!(iterations > 0 && iterations <= 100000)) return false;
    const expected = b64ToBytes(hashB64);
    const actual = await derive(password, b64ToBytes(saltB64), iterations);
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

// Used when the username does not exist so that response timing does not reveal
// which usernames are valid.
export const DUMMY_HASH = 'pbkdf2$sha256$100000$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

export function validatePasswordStrength(password) {
  if (typeof password !== 'string') return 'Password is required';
  if (password.length < 10) return 'Password must be at least 10 characters';
  if (password.length > 256) return 'Password is too long';
  return null;
}
