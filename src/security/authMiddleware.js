// Authentication / authorization / CSRF enforcement (Spec §16, §17, §32).
// The role always comes from D1 via the session, never from the client.

import { getSessionUser } from '../auth/session.js';
import { HttpError } from '../utils/http.js';

export async function requireUser(request, env) {
  const user = await getSessionUser(request, env.DB);
  if (!user) throw new HttpError(401, 'Unauthorized');
  return user;
}

export async function requireAdmin(request, env) {
  const user = await requireUser(request, env);
  if (user.role !== 'admin') throw new HttpError(403, 'Forbidden');
  return user;
}

// CSRF defence for state-changing requests:
//  1. SameSite=Strict session cookie (browser won't send it cross-site)
//  2. Origin (or Referer) must match this site
//  3. Custom header required -> cross-site forms cannot set it, and
//     cross-origin fetch would need a CORS preflight we never approve.
export function checkCsrf(request) {
  const method = request.method.toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return;

  const url = new URL(request.url);
  const origin = request.headers.get('Origin');
  if (origin) {
    if (origin !== url.origin) throw new HttpError(403, 'Cross-site request blocked');
  } else {
    const referer = request.headers.get('Referer');
    if (referer && new URL(referer).origin !== url.origin) throw new HttpError(403, 'Cross-site request blocked');
  }
  if (request.headers.get('X-Requested-With') !== 'xagent') {
    throw new HttpError(403, 'Missing CSRF header');
  }
}
