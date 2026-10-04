// Server-side sessions stored in D1.
// Cookie holds a random 256-bit token; D1 stores only SHA-256(token).

import { randomToken, sha256Hex } from '../utils/crypto.js';

const COOKIE_SECURE = '__Host-xagent_sid'; // https: Secure + Path=/ + no Domain
const COOKIE_DEV = 'xagent_sid';            // plain http://localhost during wrangler dev

function isHttps(request) {
  return new URL(request.url).protocol === 'https:';
}

export function readSessionToken(request) {
  const header = request.headers.get('Cookie') || '';
  const wanted = isHttps(request) ? COOKIE_SECURE : COOKIE_DEV;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    if (part.slice(0, idx).trim() === wanted) {
      const value = part.slice(idx + 1).trim();
      return /^[A-Za-z0-9_-]{20,128}$/.test(value) ? value : null;
    }
  }
  return null;
}

export function sessionCookie(request, token, maxAgeSeconds) {
  const secure = isHttps(request);
  const name = secure ? COOKIE_SECURE : COOKIE_DEV;
  return [
    `${name}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    secure ? 'Secure' : null,
    `Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`,
  ].filter(Boolean).join('; ');
}

export function clearSessionCookie(request) {
  return sessionCookie(request, 'deleted', 0);
}

export async function createSession(db, userId, hours) {
  const token = randomToken(32);
  const id = await sha256Hex(token);
  const expires = new Date(Date.now() + hours * 3600 * 1000).toISOString();
  await db.prepare('INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)').bind(id, userId, expires).run();
  // Opportunistic cleanup of expired sessions (cheap, indexed).
  await db.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(new Date().toISOString()).run();
  return { token, expiresAt: expires, maxAge: hours * 3600 };
}

// Returns the authenticated user (from D1 — never from client input) or null.
export async function getSessionUser(request, db) {
  const token = readSessionToken(request);
  if (!token) return null;
  const id = await sha256Hex(token);
  const row = await db.prepare(
    `SELECT s.id AS session_id, s.expires_at, u.id, u.username, u.role, u.status
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.id = ?`
  ).bind(id).first();
  if (!row) return null;
  if (row.expires_at < new Date().toISOString() || row.status !== 'active') {
    await db.prepare('DELETE FROM sessions WHERE id = ?').bind(id).run();
    return null;
  }
  return { id: row.id, username: row.username, role: row.role, sessionId: row.session_id };
}

export async function destroySession(request, db) {
  const token = readSessionToken(request);
  if (!token) return;
  await db.prepare('DELETE FROM sessions WHERE id = ?').bind(await sha256Hex(token)).run();
}

export async function destroyUserSessions(db, userId) {
  await db.prepare('DELETE FROM sessions WHERE user_id = ?').bind(userId).run();
}
