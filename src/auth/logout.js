import { json } from '../utils/http.js';
import { logEvent } from '../utils/log.js';
import { destroySession, clearSessionCookie } from './session.js';

// Invalidates the server-side session (Spec §36) and clears the cookie.
export async function handleLogout(request, env, user) {
  await destroySession(request, env.DB);
  if (user) logEvent('LOGOUT', { user_id: user.id });
  return json({ ok: true }, 200, { 'Set-Cookie': clearSessionCookie(request) });
}
