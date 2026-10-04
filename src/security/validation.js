// Input validation helpers. All DB access uses bound parameters, so validation
// here is about shape/size, not SQL escaping.

import { HttpError } from '../utils/http.js';

export function validateUsername(username) {
  if (typeof username !== 'string') return 'Username is required';
  if (!/^[A-Za-z0-9._-]{3,32}$/.test(username)) return 'Username must be 3–32 characters: letters, digits, . _ -';
  return null;
}

export function requireString(value, field, { max = 10000, min = 1 } = {}) {
  if (typeof value !== 'string') throw new HttpError(400, `${field} is required`);
  const v = value.trim();
  if (v.length < min) throw new HttpError(400, `${field} is required`);
  if (v.length > max) throw new HttpError(400, `${field} is too long (max ${max} characters)`);
  return v;
}

export function optionalId(value, field) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !/^[A-Za-z0-9-]{8,64}$/.test(value)) throw new HttpError(400, `Invalid ${field}`);
  return value;
}

export function requireInt(value, field) {
  const n = typeof value === 'number' ? value : parseInt(value, 10);
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, `Invalid ${field}`);
  return n;
}

export function oneOf(value, allowed, field) {
  if (!allowed.includes(value)) throw new HttpError(400, `Invalid ${field}`);
  return value;
}

// Strip ASCII control chars except tab/newline/CR (keeps pasted logs/code intact).
export function cleanText(text) {
  return text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
}
