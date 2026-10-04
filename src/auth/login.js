import { getConfig } from '../config.js';
import { json, error, readJson, clientIp } from '../utils/http.js';
import { logEvent } from '../utils/log.js';
import { verifyPassword, DUMMY_HASH, hashPassword } from './password.js';
import { createSession, sessionCookie } from './session.js';
import { checkLoginAllowed, recordLoginFailure } from '../security/rateLimit.js';
import { validateUsername } from '../security/validation.js';
import { findUserByUsername, countUsers, createUser } from '../db/users.js';

// Optional one-time bootstrap (Spec §44): if the users table is empty and the
// ADMIN_INITIAL_* secrets exist, create the first admin with a hashed password.
async function maybeBootstrapAdmin(env, cfg) {
  if (!env.ADMIN_INITIAL_USERNAME || !env.ADMIN_INITIAL_PASSWORD) return;
  if ((await countUsers(env.DB)) > 0) return;
  if (validateUsername(env.ADMIN_INITIAL_USERNAME)) return;
  const hash = await hashPassword(env.ADMIN_INITIAL_PASSWORD, cfg.passwordIterations);
  await createUser(env.DB, { username: env.ADMIN_INITIAL_USERNAME, passwordHash: hash, role: 'admin' });
  logEvent('ADMIN_BOOTSTRAPPED', { username: env.ADMIN_INITIAL_USERNAME });
}

export async function handleLogin(request, env) {
  const cfg = getConfig(env);
  const body = await readJson(request, 4096);
  const username = typeof body.username === 'string' ? body.username.trim() : '';
  const password = typeof body.password === 'string' ? body.password : '';
  const ip = clientIp(request);

  if (!username || !password || username.length > 64 || password.length > 256) {
    return error(400, 'Username and password are required');
  }

  const gate = await checkLoginAllowed(env.DB, ip, username, cfg);
  if (!gate.allowed) {
    logEvent('LOGIN_RATE_LIMITED', { ip });
    return error(429, 'Too many failed attempts. Please wait and try again.');
  }

  await maybeBootstrapAdmin(env, cfg);

  const user = await findUserByUsername(env.DB, username);
  const ok = await verifyPassword(password, user ? user.password_hash : DUMMY_HASH);

  if (!user || !ok) {
    await recordLoginFailure(env.DB, ip, username, cfg);
    logEvent('LOGIN_FAILED', { ip, reason: 'bad_credentials' });
    return error(401, 'Invalid username or password');
  }
  if (user.status !== 'active') {
    logEvent('LOGIN_FAILED', { ip, user_id: user.id, reason: 'disabled' });
    return error(403, 'This account is disabled. Contact your administrator.');
  }

  const session = await createSession(env.DB, user.id, cfg.sessionHours);
  await env.DB.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').bind(new Date().toISOString(), user.id).run();
  logEvent('LOGIN_SUCCESS', { user_id: user.id, role: user.role, ip });

  return json(
    { user: { username: user.username, role: user.role } },
    200,
    { 'Set-Cookie': sessionCookie(request, session.token, session.maxAge) }
  );
}
