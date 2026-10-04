// Admin-only Google Docs sync + knowledge-base status (Spec §6, §15, §54).
//
// POST /api/admin/sync {action:'start'}                         -> {run_id, documents}
// POST /api/admin/sync {action:'step', run_id, document_id, force?} -> step result
// POST /api/admin/sync {action:'finish', run_id}                -> final run row
// GET  /api/admin/sync-status                                   -> dashboard data

import { getConfig } from '../config.js';
import { json, error, readJson } from '../utils/http.js';
import { requireInt, oneOf } from '../security/validation.js';
import { startSyncRun, runStep, finishRun, parseDocumentConfig } from '../google/sync.js';
import { listDocuments, listSyncRuns, knowledgeStats } from '../db/documents.js';
import { getDailyAiUsage } from '../security/rateLimit.js';
import { countUsers } from '../db/users.js';

export async function handleAdminSync(request, env) {
  const body = await readJson(request, 2048);
  const action = oneOf(body.action || 'start', ['start', 'step', 'finish'], 'action');
  try {
    if (action === 'start') {
      const { runId, documents } = await startSyncRun(env, 'manual');
      return json({ run_id: runId, documents });
    }
    const runId = requireInt(body.run_id, 'run_id');
    if (action === 'step') {
      const docId = typeof body.document_id === 'string' ? body.document_id : '';
      const result = await runStep(env, runId, docId, { force: body.force === true });
      return json({ document_id: docId, ...result });
    }
    return json({ run: await finishRun(env, runId) });
  } catch (err) {
    // Admin-facing message only; never includes credentials.
    return error(400, String(err?.message || err).slice(0, 500));
  }
}

export async function handleSyncStatus(request, env) {
  const cfg = getConfig(env);
  const [stats, documents, runs, aiToday, users] = await Promise.all([
    knowledgeStats(env.DB), listDocuments(env.DB), listSyncRuns(env.DB, 10),
    getDailyAiUsage(env.DB), countUsers(env.DB),
  ]);
  let configured = [];
  let configError = null;
  try { configured = parseDocumentConfig(env.GOOGLE_DOCUMENT_IDS); } catch (e) { configError = e.message; }

  return json({
    knowledge: stats,
    documents: documents.map((d) => ({ ...d, content_hash: d.content_hash ? d.content_hash.slice(0, 12) : null })),
    runs,
    last_sync: runs.find((r) => r.status !== 'running') || null,
    config: {
      configured_documents: configured.length,
      config_error: configError,
      google_credentials: Boolean(env.GOOGLE_SERVICE_ACCOUNT_EMAIL && env.GOOGLE_PRIVATE_KEY),
      service_account_email: env.GOOGLE_SERVICE_ACCOUNT_EMAIL || null, // the email is not secret; the key is never returned
      ai_model: cfg.aiModel,
      embedding_model: cfg.embeddingModel,
      top_k: cfg.topK,
      min_similarity: cfg.minSimilarity,
      bootstrap_secrets_present: Boolean(env.ADMIN_INITIAL_USERNAME || env.ADMIN_INITIAL_PASSWORD),
    },
    usage: { ai_today: aiToday, daily_ai_limit: cfg.dailyAiLimit, users },
  });
}
