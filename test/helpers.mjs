// Test harness: runs the real Worker code in Node with faithful local fakes for
// D1 (node:sqlite), Workers AI, Vectorize, static assets and the Google APIs.

import { DatabaseSync } from 'node:sqlite';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import worker from '../src/index.js';
import { hashPassword } from '../src/auth/password.js';
import { _resetTokenCache } from '../src/google/auth.js';

// Capture Worker logs instead of printing them (set SHOW_LOGS=1 to see them).
export const LOGS = [];
const origLog = console.log;
console.log = (...a) => { LOGS.push(a.join(' ')); if (process.env.SHOW_LOGS) origLog(...a); };

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const ORIGIN = 'https://ai.example.com';

// ---------------- D1 ----------------
class Stmt {
  constructor(db, sql, params = []) { this.db = db; this.sql = sql; this.params = params; }
  bind(...p) { return new Stmt(this.db, this.sql, p.map((v) => (v === undefined ? null : typeof v === 'boolean' ? Number(v) : v))); }
  async first(col) {
    const row = this.db.prepare(this.sql).get(...this.params);
    if (!row) return null;
    const plain = { ...row };
    return col ? plain[col] : plain;
  }
  async all() { return { success: true, results: this.db.prepare(this.sql).all(...this.params).map((r) => ({ ...r })), meta: {} }; }
  async run() {
    const r = this.db.prepare(this.sql).run(...this.params);
    return { success: true, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
  }
}
export function createD1() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(readFileSync(path.join(root, 'migrations/0001_initial.sql'), 'utf8'));
  return {
    raw: db,
    prepare: (sql) => new Stmt(db, sql),
    async batch(stmts) {
      db.exec('BEGIN');
      try { const out = []; for (const s of stmts) out.push(await s.run()); db.exec('COMMIT'); return out; }
      catch (e) { db.exec('ROLLBACK'); throw e; }
    },
    async exec(sql) { db.exec(sql); },
  };
}

// ---------------- Workers AI ----------------
const DIM = 1024;
function hashWord(w) { let h = 2166136261; for (const c of w) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; }
export function fakeEmbed(text) {
  const v = new Array(DIM).fill(0);
  const words = String(text).toLowerCase().match(/[a-z0-9_]{3,}/g) || [];
  for (const w of words) v[hashWord(w) % DIM] += 1;
  const n = Math.hypot(...v) || 1;
  return v.map((x) => x / n);
}
export function createAI({ chatChunks = ['According to the documentation, ', 'PXE validation happens in `validateClient()` [S1].'] } = {}) {
  const ai = {
    calls: [], embedCalls: 0, embeddedTexts: 0, failChat: false, failEmbed: false, chatChunks,
    async run(model, input) {
      ai.calls.push({ model, input });
      if (input.text) {
        if (ai.failEmbed) throw new Error('embed failure');
        ai.embedCalls++; ai.embeddedTexts += input.text.length;
        return { shape: [input.text.length, DIM], data: input.text.map(fakeEmbed) };
      }
      if (ai.failChat) throw new Error('model overloaded');
      if (input.stream) {
        const enc = new TextEncoder();
        const events = [
          // reasoning delta must be ignored
          { choices: [{ delta: { reasoning_content: 'thinking...' } }] },
          ...ai.chatChunks.map((c) => ({ choices: [{ delta: { content: c } }] })),
        ];
        return new ReadableStream({
          start(ctrl) {
            for (const e of events) ctrl.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`));
            ctrl.enqueue(enc.encode('data: [DONE]\n\n'));
            ctrl.close();
          },
        });
      }
      return { choices: [{ message: { content: ai.chatChunks.join('') } }] };
    },
    lastChatMessages() {
      const c = [...ai.calls].reverse().find((x) => x.input.messages);
      return c ? c.input.messages : null;
    },
  };
  return ai;
}

// ---------------- Vectorize ----------------
export function createVectorize() {
  const store = new Map();
  const v = {
    store, fail: false,
    async upsert(vectors) { for (const x of vectors) store.set(x.id, x); return { mutationId: 'm' }; },
    async deleteByIds(ids) { for (const id of ids) store.delete(id); return { mutationId: 'm' }; },
    async query(vec, { topK = 5 } = {}) {
      if (v.fail) throw new Error('vectorize down');
      const matches = [...store.values()].map((x) => ({
        id: x.id, score: x.values.reduce((s, val, i) => s + val * vec[i], 0),
      })).sort((a, b) => b.score - a.score).slice(0, topK);
      return { count: matches.length, matches };
    },
  };
  return v;
}

// ---------------- static assets ----------------
export const ASSETS = {
  async fetch(req) {
    const p = new URL(typeof req === 'string' ? req : req.url).pathname;
    const file = path.join(root, 'public', p);
    if (!file.startsWith(path.join(root, 'public')) || !existsSync(file)) return new Response('nf', { status: 404 });
    const type = p.endsWith('.html') ? 'text/html' : p.endsWith('.css') ? 'text/css' : p.endsWith('.svg') ? 'image/svg+xml' : 'application/javascript';
    return new Response(readFileSync(file), { headers: { 'Content-Type': type } });
  },
};

// ---------------- Google APIs ----------------
export async function makeServiceAccountKey() {
  const kp = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
  const pkcs8 = Buffer.from(await crypto.subtle.exportKey('pkcs8', kp.privateKey)).toString('base64');
  const pem = `-----BEGIN PRIVATE KEY-----\\n${pkcs8.match(/.{1,64}/g).join('\\n')}\\n-----END PRIVATE KEY-----\\n`;
  return { pem, publicKey: kp.publicKey };
}

export function para(text, { style = 'NORMAL_TEXT', mono = false, headingId, bullet, link } = {}) {
  return {
    paragraph: {
      paragraphStyle: { namedStyleType: style, ...(headingId ? { headingId } : {}) },
      ...(bullet ? { bullet: { nestingLevel: 0 } } : {}),
      elements: [{ textRun: { content: `${text}\n`, textStyle: { ...(mono ? { weightedFontFamily: { fontFamily: 'Courier New' } } : {}), ...(link ? { link: { url: link } } : {}) } } }],
    },
  };
}

export function installGoogleMock({ publicKey, docs }) {
  const state = { docs, tokenRequests: 0, docFetches: 0, driveFetches: 0, forbidden: new Set(), lastJwtValid: null };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(typeof url === 'string' ? url : url.url);
    if (u.host === 'oauth2.googleapis.com') {
      state.tokenRequests++;
      const assertion = new URLSearchParams(init.body).get('assertion');
      const [h, c, s] = assertion.split('.');
      const sig = Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
      state.lastJwtValid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', publicKey, sig, new TextEncoder().encode(`${h}.${c}`));
      if (!state.lastJwtValid) return new Response('{"error":"invalid_grant"}', { status: 400 });
      return Response.json({ access_token: 'ya29.test', expires_in: 3600 });
    }
    const auth = (init.headers || {}).Authorization;
    if (auth !== 'Bearer ya29.test') return new Response('unauth', { status: 401 });
    let m = u.pathname.match(/^\/drive\/v3\/files\/([^/]+)$/);
    if (u.host === 'www.googleapis.com' && m) {
      state.driveFetches++;
      const d = state.docs[decodeURIComponent(m[1])];
      if (!d || state.forbidden.has(m[1])) return new Response('{}', { status: d ? 403 : 404 });
      return Response.json({ id: m[1], name: d.title, modifiedTime: d.modifiedTime, version: '1' });
    }
    m = u.pathname.match(/^\/v1\/documents\/([^/]+)$/);
    if (u.host === 'docs.googleapis.com' && m) {
      state.docFetches++;
      const d = state.docs[decodeURIComponent(m[1])];
      if (!d || state.forbidden.has(m[1])) return new Response('{"error":{"message":"forbidden"}}', { status: d ? 403 : 404 });
      if (d.tabs) return Response.json({ documentId: m[1], title: d.title, revisionId: d.revisionId, tabs: d.tabs });
      return Response.json({ documentId: m[1], title: d.title, revisionId: d.revisionId, body: { content: d.content } });
    }
    return realFetch(url, init);
  };
  state.restore = () => { globalThis.fetch = realFetch; _resetTokenCache(); };
  return state;
}

// ---------------- env + requests ----------------
export function createEnv(overrides = {}) {
  return {
    DB: createD1(),
    AI: createAI(),
    VECTORIZE: createVectorize(),
    ASSETS,
    AI_MODEL: '@cf/openai/gpt-oss-20b',
    EMBEDDING_MODEL: '@cf/baai/bge-m3',
    EMBEDDING_DIMENSIONS: '1024',
    MIN_SIMILARITY: '0.2',
    TOP_K: '6',
    DAILY_AI_LIMIT: '50',
    CHAT_RATE_LIMIT_PER_MINUTE: '100',
    PASSWORD_ITERATIONS: '1000', // fast tests; production uses 100000
    MAX_MESSAGE_LENGTH: '12000',
    ...overrides,
  };
}

export function createCtx() {
  const pending = [];
  return { waitUntil: (p) => pending.push(p), passThroughOnException() {}, flush: () => Promise.all(pending) };
}

export async function call(env, method, p, { body, cookie, headers = {}, origin = ORIGIN, csrf = true } = {}) {
  const h = new Headers(headers);
  if (body !== undefined) h.set('Content-Type', 'application/json');
  if (cookie) h.set('Cookie', cookie);
  if (method !== 'GET' && origin) h.set('Origin', origin);
  if (csrf && method !== 'GET') h.set('X-Requested-With', 'xagent');
  const req = new Request(`${ORIGIN}${p}`, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined });
  const ctx = createCtx();
  const res = await worker.fetch(req, env, ctx);
  res.ctx = ctx;
  return res;
}

export async function addUser(env, username, password, role = 'user', status = 'active') {
  const hash = await hashPassword(password, 1000);
  await env.DB.prepare('INSERT INTO users (username, password_hash, role, status) VALUES (?, ?, ?, ?)').bind(username, hash, role, status).run();
}

export async function login(env, username, password) {
  const res = await call(env, 'POST', '/api/login', { body: { username, password } });
  const set = res.headers.get('Set-Cookie') || '';
  return { res, cookie: set.split(';')[0] };
}

export async function readSse(res) {
  const text = await res.text();
  await res.ctx?.flush();
  const events = [];
  for (const block of text.split('\n\n')) {
    const ev = block.match(/^event: (.+)$/m);
    const data = block.match(/^data: (.+)$/m);
    if (ev && data) events.push({ event: ev[1], data: JSON.parse(data[1]) });
  }
  return events;
}

export async function syncAll(env, cookie, { force = false } = {}) {
  const start = await (await call(env, 'POST', '/api/admin/sync', { cookie, body: { action: 'start' } })).json();
  const results = {};
  for (const id of start.documents) {
    let r;
    let n = 0;
    do {
      r = await (await call(env, 'POST', '/api/admin/sync', { cookie, body: { action: 'step', run_id: start.run_id, document_id: id, force: force && n === 0 } })).json();
      n++;
    } while (r.status === 'in_progress' && n < 100);
    results[id] = { ...r, steps: n };
  }
  const fin = await (await call(env, 'POST', '/api/admin/sync', { cookie, body: { action: 'finish', run_id: start.run_id } })).json();
  return { start, results, run: fin.run };
}
