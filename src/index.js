// xagent — single Cloudflare Worker: static GUI + auth + API + RAG + sync.

import { getConfig } from './config.js';
import { json, error, redirect, withSecurity, HttpError } from './utils/http.js';
import { logEvent } from './utils/log.js';
import { getSessionUser } from './auth/session.js';
import { handleLogin } from './auth/login.js';
import { handleLogout } from './auth/logout.js';
import { requireUser, requireAdmin, checkCsrf } from './security/authMiddleware.js';
import { pruneCounters } from './security/rateLimit.js';
import { handleChat } from './api/chat.js';
import { handleSearch } from './api/search.js';
import { handleAdminSync, handleSyncStatus } from './api/sync.js';
import { handleListUsers, handleCreateUser, handleToggleUser, handleResetPassword } from './api/users.js';
import { runFullSync } from './google/sync.js';
import { newUsageStats, trackDb, flushUsage } from './utils/usage.js';

// Per-request env with a usage-tracking D1 wrapper.
function withUsage(env) {
  const stats = newUsageStats();
  return { env: { ...env, DB: trackDb(env.DB, stats), __usage: stats }, stats };
}

// Static files anyone may load (the login page needs them). Everything else
// in /public is only served to authenticated users.
const PUBLIC_ASSETS = new Set(['/login.js', '/style.css', '/favicon.svg']);
const PRIVATE_ASSETS = new Set(['/app.js', '/admin.js', '/markdown.js', '/common.js']);

async function serveAsset(env, request, path) {
  const url = new URL(request.url);
  url.pathname = path;
  const res = await env.ASSETS.fetch(new Request(url.toString(), { method: 'GET' }));
  if (!res.ok) return error(404, 'Not found');
  const isHtml = path.endsWith('.html');
  return withSecurity(res, { noStore: isHtml || PRIVATE_ASSETS.has(path) });
}

const API_ROUTES = {
  'POST /api/login': { auth: 'none', handler: (r, e) => handleLogin(r, e) },
  'POST /api/logout': { auth: 'optional', handler: (r, e, c, u) => handleLogout(r, e, u) },
  'GET /api/me': { auth: 'user', handler: (r, e, c, u) => json({ user: { username: u.username, role: u.role }, app: getConfig(e).appName }) },

  'POST /api/chat': { auth: 'user', handler: (r, e, c, u) => handleChat(r, e, c, u) },
  'POST /api/search': { auth: 'user', handler: (r, e, c, u) => handleSearch(r, e, u) },

  'POST /api/admin/sync': { auth: 'admin', handler: (r, e) => handleAdminSync(r, e) },
  'POST /api/sync': { auth: 'admin', handler: (r, e) => handleAdminSync(r, e) }, // alias (§12)
  'GET /api/admin/sync-status': { auth: 'admin', handler: (r, e) => handleSyncStatus(r, e) },
  'GET /api/admin/users': { auth: 'admin', handler: (r, e) => handleListUsers(r, e) },
  'POST /api/admin/users': { auth: 'admin', handler: (r, e, c, u) => handleCreateUser(r, e, u) },
  'POST /api/admin/users/toggle': { auth: 'admin', handler: (r, e, c, u) => handleToggleUser(r, e, u) },
  'POST /api/admin/users/reset-password': { auth: 'admin', handler: (r, e, c, u) => handleResetPassword(r, e, u) },
};

async function handleApi(request, env, ctx, path) {
  const route = API_ROUTES[`${request.method} ${path}`];
  if (!route) {
    // Unknown method/path under /api: still require auth first so the API
    // surface is not discoverable by anonymous callers.
    const user = await getSessionUser(request, env.DB);
    if (!user) return error(401, 'Unauthorized');
    const known = Object.keys(API_ROUTES).some((k) => k.endsWith(` ${path}`));
    return error(known ? 405 : 404, known ? 'Method not allowed' : 'Not found');
  }
  checkCsrf(request);
  let user = null;
  if (route.auth === 'user') user = await requireUser(request, env);
  else if (route.auth === 'admin') user = await requireAdmin(request, env);
  else if (route.auth === 'optional') user = await getSessionUser(request, env.DB);
  return route.handler(request, env, ctx, user);
}

async function handlePage(request, env, path) {
  if (request.method !== 'GET' && request.method !== 'HEAD') return error(405, 'Method not allowed');
  if (PUBLIC_ASSETS.has(path)) return serveAsset(env, request, path);

  const user = await getSessionUser(request, env.DB);

  if (path === '/login' || path === '/login.html') {
    return user ? redirect('/') : serveAsset(env, request, '/login.html');
  }
  if (!user) {
    // Never expose the chat UI or its scripts without a session.
    if (PRIVATE_ASSETS.has(path)) return error(401, 'Unauthorized');
    return redirect('/login');
  }
  if (path === '/' || path === '/index.html') return serveAsset(env, request, '/index.html');
  if (path === '/admin' || path === '/admin.html') {
    if (user.role !== 'admin') return serveAsset(env, request, '/403.html').then((r) => new Response(r.body, { status: 403, headers: r.headers }));
    return serveAsset(env, request, '/admin.html');
  }
  if (PRIVATE_ASSETS.has(path)) {
    if (path === '/admin.js' && user.role !== 'admin') return error(403, 'Forbidden');
    return serveAsset(env, request, path);
  }
  return error(404, 'Not found');
}

export default {
  async fetch(request, rawEnv, ctx) {
    const path = new URL(request.url).pathname;
    const { env, stats } = withUsage(rawEnv);
    // Flush once the response (and any streamed AI answer) has finished.
    const finish = (p) => ctx.waitUntil(Promise.resolve(p).then(() => flushUsage(rawEnv.DB, stats)));
    const pending = [];
    const trackedCtx = { ...ctx, waitUntil: (p) => { pending.push(p); ctx.waitUntil(p); } };
    try {
      const res = path.startsWith('/api/') ? await handleApi(request, env, trackedCtx, path) : await handlePage(request, env, path);
      if (path.startsWith('/api/')) finish(Promise.allSettled(pending)); // static pages aren't counted
      return res;
    } catch (err) {
      if (path.startsWith('/api/')) finish(Promise.allSettled(pending));
      if (err instanceof HttpError) return error(err.status, err.message);
      // Never leak stack traces or internals to the client (§46).
      logEvent('UNHANDLED_ERROR', { path, method: request.method, error: String(err?.message || err) });
      return error(500, 'Internal error. Please try again.');
    }
  },

  // Optional scheduled sync (enable via "triggers.crons" in wrangler.jsonc).
  async scheduled(event, rawEnv, ctx) {
    const { env, stats } = withUsage(rawEnv);
    ctx.waitUntil((async () => {
      try {
        await pruneCounters(env.DB);
        await runFullSync(env, { trigger: 'scheduled' });
      } catch (err) {
        logEvent('SYNC_FAILED', { error: String(err?.message || err) });
      }
      await flushUsage(rawEnv.DB, stats);
    })());
  },
};
