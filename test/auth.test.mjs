import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createEnv, addUser, login, call } from './helpers.mjs';
import { hashPassword, verifyPassword, DUMMY_HASH } from '../src/auth/password.js';
import { b64ToBytes } from '../src/utils/crypto.js';

describe('password hashing', () => {
  test('hash + verify round trip, wrong password fails', async () => {
    const h = await hashPassword('correct horse battery', 1000);
    assert.match(h, /^pbkdf2\$sha256\$1000\$/);
    assert.equal(await verifyPassword('correct horse battery', h), true);
    assert.equal(await verifyPassword('wrong', h), false);
  });
  test('dummy hash is well-formed (keeps timing constant for unknown users)', () => {
    const [, , , salt, hash] = DUMMY_HASH.split('$');
    assert.equal(b64ToBytes(salt).length, 16);
    assert.equal(b64ToBytes(hash).length, 32);
  });
});

describe('authentication', () => {
  let env;
  beforeEach(async () => {
    env = createEnv();
    await addUser(env, 'admin', 'admin-password-123', 'admin');
    await addUser(env, 'alice', 'alice-password-123', 'user');
    await addUser(env, 'bob', 'bob-password-1234', 'user', 'disabled');
  });

  test('valid login sets a hardened session cookie', async () => {
    const { res } = await login(env, 'alice', 'alice-password-123');
    assert.equal(res.status, 200);
    const cookie = res.headers.get('Set-Cookie');
    assert.match(cookie, /^__Host-xagent_sid=/);
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /Secure/);
    assert.match(cookie, /SameSite=Strict/);
    const body = await res.json();
    assert.deepEqual(body.user, { username: 'alice', role: 'user' });
    assert.ok(!JSON.stringify(body).includes('password'));
    // Only the hash of the token is stored server-side.
    const token = cookie.split(';')[0].split('=')[1];
    const row = await env.DB.prepare('SELECT id FROM sessions').first();
    assert.notEqual(row.id, token);
  });

  test('invalid login', async () => {
    const { res } = await login(env, 'alice', 'nope-nope-nope');
    assert.equal(res.status, 401);
    assert.equal((await res.json()).error, 'Invalid username or password');
    const { res: r2 } = await login(env, 'ghost', 'whatever-123');
    assert.equal(r2.status, 401);
  });

  test('disabled user cannot log in', async () => {
    const { res } = await login(env, 'bob', 'bob-password-1234');
    assert.equal(res.status, 403);
  });

  test('SQL injection in username does not authenticate', async () => {
    const { res } = await login(env, "admin' OR '1'='1' --", 'x-any-password');
    assert.equal(res.status, 401);
    const users = await env.DB.prepare('SELECT COUNT(*) AS n FROM users').first();
    assert.equal(users.n, 3);
  });

  test('login brute force is rate limited', async () => {
    for (let i = 0; i < 5; i++) await login(env, 'alice', `wrong-${i}-password`);
    const { res } = await login(env, 'alice', 'alice-password-123');
    assert.equal(res.status, 429);
  });

  test('expired session is rejected and removed', async () => {
    const { cookie } = await login(env, 'alice', 'alice-password-123');
    await env.DB.prepare("UPDATE sessions SET expires_at = '2000-01-01T00:00:00.000Z'").run();
    const res = await call(env, 'GET', '/api/me', { cookie });
    assert.equal(res.status, 401);
    const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM sessions').first();
    assert.equal(n.n, 0);
  });

  test('logout invalidates the server-side session', async () => {
    const { cookie } = await login(env, 'alice', 'alice-password-123');
    assert.equal((await call(env, 'GET', '/api/me', { cookie })).status, 200);
    const out = await call(env, 'POST', '/api/logout', { cookie, body: {} });
    assert.equal(out.status, 200);
    assert.match(out.headers.get('Set-Cookie'), /Max-Age=0/);
    // Re-using the old cookie no longer works.
    assert.equal((await call(env, 'GET', '/api/me', { cookie })).status, 401);
  });

  test('session manipulation: forged or random cookies are rejected', async () => {
    for (const c of ['__Host-xagent_sid=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', '__Host-xagent_sid=../../etc', '__Host-xagent_sid=']) {
      assert.equal((await call(env, 'GET', '/api/me', { cookie: c })).status, 401);
    }
  });

  test('disabling a user immediately kills their sessions', async () => {
    const { cookie: adminC } = await login(env, 'admin', 'admin-password-123');
    const { cookie: aliceC } = await login(env, 'alice', 'alice-password-123');
    const alice = await env.DB.prepare("SELECT id FROM users WHERE username='alice'").first();
    const r = await call(env, 'POST', '/api/admin/users/toggle', { cookie: adminC, body: { user_id: alice.id } });
    assert.equal(r.status, 200);
    assert.equal((await call(env, 'GET', '/api/me', { cookie: aliceC })).status, 401);
  });

  test('first admin bootstrap from secrets only when no users exist', async () => {
    const fresh = createEnv({ ADMIN_INITIAL_USERNAME: 'root', ADMIN_INITIAL_PASSWORD: 'bootstrap-pass-123' });
    const { res } = await login(fresh, 'root', 'bootstrap-pass-123');
    assert.equal(res.status, 200);
    const row = await fresh.DB.prepare("SELECT role, password_hash FROM users WHERE username='root'").first();
    assert.equal(row.role, 'admin');
    assert.ok(!row.password_hash.includes('bootstrap-pass-123'));
    // Existing deployment: the env vars are ignored.
    env.ADMIN_INITIAL_USERNAME = 'evil'; env.ADMIN_INITIAL_PASSWORD = 'evil-password-123';
    assert.equal((await login(env, 'evil', 'evil-password-123')).res.status, 401);
  });
});

describe('authorization & direct API access', () => {
  let env; let userC; let adminC;
  beforeEach(async () => {
    env = createEnv();
    await addUser(env, 'admin', 'admin-password-123', 'admin');
    await addUser(env, 'alice', 'alice-password-123', 'user');
    adminC = (await login(env, 'admin', 'admin-password-123')).cookie;
    userC = (await login(env, 'alice', 'alice-password-123')).cookie;
  });

  test('unauthenticated API calls get 401', async () => {
    for (const [m, p] of [['POST', '/api/chat'], ['POST', '/api/search'], ['POST', '/api/sync'], ['POST', '/api/admin/sync'],
      ['GET', '/api/admin/users'], ['GET', '/api/admin/sync-status'], ['GET', '/api/me'], ['GET', '/api/nonexistent']]) {
      const res = await call(env, m, p, { body: m === 'POST' ? { message: 'hi' } : undefined });
      assert.equal(res.status, 401, `${m} ${p}`);
    }
  });

  test('normal user gets 403 on every admin API', async () => {
    for (const [m, p] of [['POST', '/api/admin/sync'], ['POST', '/api/sync'], ['GET', '/api/admin/sync-status'], ['GET', '/api/admin/users'],
      ['POST', '/api/admin/users'], ['POST', '/api/admin/users/toggle'], ['POST', '/api/admin/users/reset-password']]) {
      const res = await call(env, m, p, { cookie: userC, body: m === 'POST' ? { action: 'start', role: 'admin' } : undefined });
      assert.equal(res.status, 403, `${m} ${p}`);
    }
  });

  test('client-supplied role is ignored', async () => {
    const res = await call(env, 'GET', '/api/admin/users', { cookie: userC, headers: { 'X-Role': 'admin' } });
    assert.equal(res.status, 403);
  });

  test('pages: login wall, admin page restricted, private scripts protected', async () => {
    let r = await call(env, 'GET', '/');
    assert.equal(r.status, 302);
    assert.equal(r.headers.get('Location'), '/login');
    r = await call(env, 'GET', '/admin');
    assert.equal(r.headers.get('Location'), '/login');
    r = await call(env, 'GET', '/app.js');
    assert.equal(r.status, 401);
    r = await call(env, 'GET', '/login');
    assert.equal(r.status, 200);
    assert.match(await r.text(), /<form id="login-form"/);
    assert.match(r.headers.get('Content-Security-Policy'), /default-src 'self'/);
    r = await call(env, 'GET', '/', { cookie: userC });
    assert.equal(r.status, 200);
    assert.match(await r.text(), /xagent/);
    r = await call(env, 'GET', '/admin', { cookie: userC });
    assert.equal(r.status, 403);
    r = await call(env, 'GET', '/admin.js', { cookie: userC });
    assert.equal(r.status, 403);
    r = await call(env, 'GET', '/admin', { cookie: adminC });
    assert.equal(r.status, 200);
    r = await call(env, 'GET', '/login', { cookie: userC });
    assert.equal(r.headers.get('Location'), '/');
  });

  test('CSRF: missing header or foreign Origin is blocked', async () => {
    const body = { query: 'pxe boot' };
    let r = await call(env, 'POST', '/api/search', { cookie: userC, body, csrf: false });
    assert.equal(r.status, 403);
    r = await call(env, 'POST', '/api/search', { cookie: userC, body, origin: 'https://evil.example' });
    assert.equal(r.status, 403);
    r = await call(env, 'POST', '/api/search', { cookie: userC, body });
    assert.equal(r.status, 200);
  });

  test('request size and content-type limits', async () => {
    const big = 'x'.repeat(70000);
    let r = await call(env, 'POST', '/api/chat', { cookie: userC, body: { message: big } });
    assert.ok([400, 413].includes(r.status));
    r = await call(env, 'POST', '/api/login', { headers: { 'Content-Type': 'text/plain' } });
    assert.equal(r.status, 415);
  });

  test('admin can create users; no public registration route', async () => {
    let r = await call(env, 'POST', '/api/admin/users', { cookie: adminC, body: { username: 'carol', password: 'carol-password-1', role: 'user' } });
    assert.equal(r.status, 201);
    r = await call(env, 'POST', '/api/admin/users', { cookie: adminC, body: { username: 'dave', password: 'short', role: 'user' } });
    assert.equal(r.status, 400);
    r = await call(env, 'POST', '/api/register', { body: { username: 'x', password: 'y' } });
    assert.equal(r.status, 401);
    const list = await (await call(env, 'GET', '/api/admin/users', { cookie: adminC })).json();
    assert.ok(list.users.every((u) => !('password_hash' in u)));
  });

  test('cannot disable the last admin / yourself', async () => {
    const me = await env.DB.prepare("SELECT id FROM users WHERE username='admin'").first();
    const r = await call(env, 'POST', '/api/admin/users/toggle', { cookie: adminC, body: { user_id: me.id } });
    assert.equal(r.status, 400);
  });
});
