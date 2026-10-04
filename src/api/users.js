// Admin user management (Spec §14, §15, §43). No public registration exists.

import { getConfig } from '../config.js';
import { json, error, readJson } from '../utils/http.js';
import { logEvent } from '../utils/log.js';
import { validateUsername, requireInt, oneOf } from '../security/validation.js';
import { hashPassword, validatePasswordStrength } from '../auth/password.js';
import { destroyUserSessions } from '../auth/session.js';
import {
  listUsers, createUser, findUserByUsername, findUserById, setUserStatus, setUserPassword, countActiveAdmins,
} from '../db/users.js';

export async function handleListUsers(request, env) {
  return json({ users: await listUsers(env.DB) });
}

// POST /api/admin/users {username, password, role}
export async function handleCreateUser(request, env, admin) {
  const cfg = getConfig(env);
  const body = await readJson(request, 2048);
  const username = typeof body.username === 'string' ? body.username.trim() : '';
  const uErr = validateUsername(username);
  if (uErr) return error(400, uErr);
  const pErr = validatePasswordStrength(body.password);
  if (pErr) return error(400, pErr);
  const role = oneOf(body.role || 'user', ['admin', 'user'], 'role');
  if (await findUserByUsername(env.DB, username)) return error(409, 'Username already exists');

  const id = await createUser(env.DB, { username, passwordHash: await hashPassword(body.password, cfg.passwordIterations), role });
  logEvent('USER_CREATED', { user_id: admin.id, username, role });
  return json({ user: { id, username, role, status: 'active' } }, 201);
}

// POST /api/admin/users/toggle {user_id}  — enable/disable
export async function handleToggleUser(request, env, admin) {
  const body = await readJson(request, 1024);
  const id = requireInt(body.user_id, 'user_id');
  const target = await findUserById(env.DB, id);
  if (!target) return error(404, 'User not found');
  if (target.id === admin.id) return error(400, 'You cannot disable your own account');
  const next = target.status === 'active' ? 'disabled' : 'active';
  if (next === 'disabled' && target.role === 'admin' && (await countActiveAdmins(env.DB)) <= 1) {
    return error(400, 'Cannot disable the last active admin');
  }
  await setUserStatus(env.DB, id, next);
  if (next === 'disabled') await destroyUserSessions(env.DB, id); // immediate lock-out
  logEvent('USER_STATUS_CHANGED', { user_id: admin.id, username: target.username, status: next });
  return json({ user: { id, username: target.username, role: target.role, status: next } });
}

// POST /api/admin/users/reset-password {user_id, password}
export async function handleResetPassword(request, env, admin) {
  const cfg = getConfig(env);
  const body = await readJson(request, 2048);
  const id = requireInt(body.user_id, 'user_id');
  const pErr = validatePasswordStrength(body.password);
  if (pErr) return error(400, pErr);
  const target = await findUserById(env.DB, id);
  if (!target) return error(404, 'User not found');
  await setUserPassword(env.DB, id, await hashPassword(body.password, cfg.passwordIterations));
  await destroyUserSessions(env.DB, id);
  logEvent('USER_PASSWORD_RESET', { user_id: admin.id, username: target.username });
  return json({ ok: true });
}
