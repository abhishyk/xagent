// Per-request usage tracking for the admin dashboard.
//
// - D1: every query's meta.rows_read / rows_written / size_after is summed by a
//   thin wrapper around the DB binding (first() is served via all() so its meta
//   is visible too).
// - Workers AI: neurons are estimated from token counts using Cloudflare's
//   published per-model rates (exact usage when the model reports it).
// At the end of the request the totals are added to usage_counters with ONE
// upsert, so tracking itself costs ~2 rows written per request.

const DAY = () => new Date().toISOString().slice(0, 10); // UTC day = Cloudflare reset boundary

export function newUsageStats() {
  return { rowsRead: 0, rowsWritten: 0, sizeBytes: null, neuronsMilli: 0 };
}

export function trackDb(db, stats) {
  const add = (meta) => {
    if (!meta) return;
    stats.rowsRead += Number(meta.rows_read || 0);
    stats.rowsWritten += Number(meta.rows_written || 0);
    if (typeof meta.size_after === 'number') stats.sizeBytes = meta.size_after;
  };
  const wrap = (stmt) => ({
    _inner: stmt,
    bind: (...args) => wrap(stmt.bind(...args)),
    async first(col) {
      const r = await stmt.all();
      add(r.meta);
      const row = r.results?.[0] ?? null;
      return row && col ? row[col] : row;
    },
    async all() { const r = await stmt.all(); add(r.meta); return r; },
    async run() { const r = await stmt.run(); add(r.meta); return r; },
  });
  return {
    _inner: db,
    prepare: (sql) => wrap(db.prepare(sql)),
    async batch(stmts) {
      const res = await db.batch(stmts.map((s) => s._inner || s));
      for (const r of res || []) add(r?.meta);
      return res;
    },
    exec: (...a) => db.exec(...a),
  };
}

// Neurons from tokens using per-million rates (see config.js).
export function addNeurons(stats, tokens, neuronsPerMillion) {
  if (!stats || !(tokens > 0)) return;
  stats.neuronsMilli += Math.round((tokens * neuronsPerMillion) / 1000); // milli-neurons
}

export const estimateTokens = (chars) => Math.ceil(Math.max(0, chars) / 4);

// Persist this request's totals (raw, untracked DB binding).
export async function flushUsage(rawDb, stats) {
  if (!stats) return;
  const day = DAY();
  const now = new Date().toISOString();
  const rows = [
    ['d1:rows_read', stats.rowsRead],
    ['d1:rows_written', stats.rowsWritten + 3], // + this flush itself
    ['ai:neurons_milli', stats.neuronsMilli],
  ].filter(([, n]) => n > 0);
  try {
    if (rows.length) {
      const stmt = rawDb.prepare(
        `INSERT INTO usage_counters (scope, bucket, count, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(scope, bucket) DO UPDATE SET count = count + excluded.count, updated_at = excluded.updated_at`
      );
      await rawDb.batch(rows.map(([scope, n]) => stmt.bind(scope, day, Math.round(n), now)));
    }
    if (stats.sizeBytes !== null) {
      await rawDb.prepare(
        `INSERT INTO usage_counters (scope, bucket, count, updated_at) VALUES ('d1:size_bytes', 'latest', ?, ?)
         ON CONFLICT(scope, bucket) DO UPDATE SET count = excluded.count, updated_at = excluded.updated_at`
      ).bind(stats.sizeBytes, now).run();
    }
  } catch { /* usage tracking must never break a request */ }
}

export async function readUsageToday(db) {
  const day = DAY();
  const { results } = await db.prepare(
    `SELECT scope, bucket, count FROM usage_counters
      WHERE (bucket = ? AND scope IN ('d1:rows_read','d1:rows_written','ai:neurons_milli','ai:daily'))
         OR (scope = 'd1:size_bytes' AND bucket = 'latest')`
  ).bind(day).all();
  const get = (s) => results.find((r) => r.scope === s)?.count || 0;
  return {
    day,
    d1RowsRead: get('d1:rows_read'),
    d1RowsWritten: get('d1:rows_written'),
    d1SizeBytes: get('d1:size_bytes'),
    aiNeurons: Math.round(get('ai:neurons_milli') / 1000),
    aiAnswers: get('ai:daily'),
  };
}
