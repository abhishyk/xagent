// D1-backed counters for login throttling, per-user chat rate limits and the
// global daily Workers AI budget (Spec §31 free-tier safety).

function utcDay(d = new Date()) {
  return d.toISOString().slice(0, 10);
}
function minuteBucket(d = new Date()) {
  return d.toISOString().slice(0, 16);
}
function windowBucket(minutes, d = new Date()) {
  return String(Math.floor(d.getTime() / (minutes * 60000)));
}

async function increment(db, scope, bucket, by = 1) {
  const row = await db.prepare(
    `INSERT INTO usage_counters (scope, bucket, count, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(scope, bucket) DO UPDATE SET count = count + excluded.count, updated_at = excluded.updated_at
     RETURNING count`
  ).bind(scope, bucket, by, new Date().toISOString()).first();
  return row ? row.count : by;
}

async function read(db, scope, bucket) {
  const row = await db.prepare('SELECT count FROM usage_counters WHERE scope = ? AND bucket = ?').bind(scope, bucket).first();
  return row ? row.count : 0;
}

// ---- login --------------------------------------------------------------
export async function checkLoginAllowed(db, ip, username, cfg) {
  const b = windowBucket(cfg.loginWindowMinutes);
  const [byIp, byUser] = await Promise.all([
    read(db, `login:ip:${ip}`, b),
    read(db, `login:user:${username.toLowerCase()}`, b),
  ]);
  return { allowed: byIp < cfg.loginMaxFailures * 3 && byUser < cfg.loginMaxFailures };
}

export async function recordLoginFailure(db, ip, username, cfg) {
  const b = windowBucket(cfg.loginWindowMinutes);
  await increment(db, `login:ip:${ip}`, b);
  await increment(db, `login:user:${username.toLowerCase()}`, b);
}

// ---- chat / search per-user rate limit ------------------------------------
export async function hitUserRateLimit(db, userId, perMinute, kind = 'chat') {
  const count = await increment(db, `${kind}:user:${userId}`, minuteBucket());
  return count > perMinute;
}

// ---- global daily AI budget ----------------------------------------------
export async function getDailyAiUsage(db) {
  return read(db, 'ai:daily', utcDay());
}

// Atomically reserves one AI generation. Returns false when over budget.
export async function reserveDailyAi(db, limit) {
  if (limit <= 0) return true; // 0 = unlimited (not recommended on free tier)
  const count = await increment(db, 'ai:daily', utcDay());
  if (count > limit) {
    await increment(db, 'ai:daily', utcDay(), -1); // give back the reservation
    return false;
  }
  return true;
}

export async function pruneCounters(db) {
  const cutoff = new Date(Date.now() - 3 * 86400000).toISOString();
  await db.prepare('DELETE FROM usage_counters WHERE updated_at < ?').bind(cutoff).run();
}
