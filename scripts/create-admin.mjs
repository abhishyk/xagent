#!/usr/bin/env node
// One-time admin setup (Spec §44). Hashes the password LOCALLY with the exact
// same PBKDF2 routine the Worker uses, then inserts only the hash into D1.
// The plaintext password never touches D1, the Worker, logs, or shell history.
//
//   node scripts/create-admin.mjs --local  --username admin
//   node scripts/create-admin.mjs --remote --username admin
//
// Re-running for an existing username resets its password and re-enables it as admin.

import { writeFileSync, unlinkSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import readline from 'node:readline';
import { hashPassword, validatePasswordStrength } from '../src/auth/password.js';
import { validateUsername } from '../src/security/validation.js';

const args = process.argv.slice(2);
const target = args.includes('--remote') ? '--remote' : args.includes('--local') ? '--local' : null;
const uIdx = args.indexOf('--username');
let username = uIdx >= 0 ? args[uIdx + 1] : null;

if (!target) {
  console.error('Specify --local or --remote');
  process.exit(1);
}

function ask(question, { hidden = false } = {}) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) {
      rl._writeToOutput = (s) => { if (s.includes(question)) rl.output.write(s); else rl.output.write(''); };
    }
    rl.question(question, (answer) => { rl.close(); if (hidden) process.stdout.write('\n'); resolve(answer); });
  });
}

if (!username) username = (await ask('Admin username: ')).trim();
const uErr = validateUsername(username);
if (uErr) { console.error(uErr); process.exit(1); }

let password = process.env.ADMIN_PASSWORD; // optional non-interactive use (CI)
if (!password) {
  password = await ask('Admin password (min 10 chars): ', { hidden: true });
  const again = await ask('Repeat password: ', { hidden: true });
  if (password !== again) { console.error('Passwords do not match'); process.exit(1); }
}
const pErr = validatePasswordStrength(password);
if (pErr) { console.error(pErr); process.exit(1); }

const hash = await hashPassword(password, 100000);
// username is validated to [A-Za-z0-9._-]; hash is base64 + '$' — both SQL-safe literals.
const sql = `INSERT INTO users (username, password_hash, role, status) VALUES ('${username}', '${hash}', 'admin', 'active')
ON CONFLICT(username) DO UPDATE SET password_hash = excluded.password_hash, role = 'admin', status = 'active',
updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now');
DELETE FROM sessions WHERE user_id = (SELECT id FROM users WHERE username = '${username}');`;

const dir = mkdtempSync(path.join(tmpdir(), 'xagent-'));
const file = path.join(dir, 'admin.sql');
writeFileSync(file, sql, { mode: 0o600 });
try {
  const res = spawnSync('npx', ['wrangler', 'd1', 'execute', 'DB', target, `--file=${file}`, '--yes'], { stdio: 'inherit', shell: process.platform === 'win32' });
  if (res.status !== 0) { console.error('wrangler d1 execute failed'); process.exit(res.status || 1); }
  console.log(`\n✔ Admin "${username}" is ready (${target.slice(2)} database). Sign in at /login.`);
} finally {
  try { unlinkSync(file); } catch { /* ignore */ }
}
