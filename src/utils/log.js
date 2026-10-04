// Structured, safe operational logging (Spec §47).
// Only whitelisted, non-sensitive fields are ever written.

const SAFE_FIELDS = new Set([
  'user_id', 'username', 'role', 'status', 'reason', 'ip',
  'document_id', 'run_id', 'chunks', 'added', 'deleted', 'matches', 'kept',
  'top_score', 'model', 'duration_ms', 'remaining', 'path', 'method', 'count', 'error',
]);

export function logEvent(event, fields = {}) {
  const entry = { event, ts: new Date().toISOString() };
  for (const [k, v] of Object.entries(fields)) {
    if (!SAFE_FIELDS.has(k) || v === undefined) continue;
    entry[k] = typeof v === 'string' ? v.slice(0, 300) : v;
  }
  console.log(JSON.stringify(entry));
}
