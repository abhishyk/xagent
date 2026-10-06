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
import { readUsageToday } from '../utils/usage.js';
import { chooseTier, tierInfo } from '../ai/tiers.js';
import { countUsers } from '../db/users.js';

/**
 * Helper utility to split an array into smaller chunks (batches of max size).
 * Used to ensure delete payloads do not exceed limits (e.g., max 100 IDs per request).
 */
function chunkArray(array, size = 100) {
  const results = [];
  for (let i = 0; i < array.length; i += size) {
    results.push(array.slice(i, i + size));
  }
  return results;
}

/**
 * Example helper function if you need to perform batched deletes across your sync routine.
 * Adjust the API call or database operation inside this function as needed.
 */
export async function batchDeleteDocuments(ids, deleteHandler) {
  const batches = chunkArray(ids, 100);
  const results = [];
  
  for (const batch of batches) {
    const res = await deleteHandler(batch);
    results.push(res);
  }
  
  return results;
}

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
  const [stats, documents, runs, today, users] = await Promise.all([
    knowledgeStats(env.DB), listDocuments(env.DB), listSyncRuns(env.DB, 10),
    readUsageToday(env.DB), countUsers(env.DB),
  ]);
  
  // Average neurons per answer today (fallback ≈ typical RAG answer) → answers left.
  const perAnswer = today.aiAnswers > 0 && today.aiNeurons > 0 ? Math.max(20, Math.round(today.aiNeurons / today.aiAnswers)) : 150;
  const neuronsLeft = Math.max(0, cfg.freeNeuronsPerDay - today.aiNeurons);
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
    usage: {
      day_utc: today.day,
      users,
      ai: {
        answers_today: today.aiAnswers,
        daily_answer_limit: cfg.dailyAiLimit,
        neurons_used: today.aiNeurons,
        neurons_free: cfg.freeNeuronsPerDay,
        neurons_per_answer: perAnswer,
        current_tier: chooseTier(cfg, today.aiNeurons),
        current_model: tierInfo(cfg, chooseTier(cfg, today.aiNeurons)).model,
        tiers: [
          { tier: 'main', model: cfg.aiModel, from_remaining_pct: 100 },
          ...(cfg.midModel && cfg.midModel !== 'off' ? [{ tier: 'mid', model: cfg.midModel, from_remaining_pct: cfg.midAtRemainingPct }] : []),
          ...(cfg.saverModel && cfg.saverModel !== 'off' ? [{ tier: 'saver', model: cfg.saverModel, from_remaining_pct: cfg.saverAtRemainingPct }] : []),
        ],
        saver_active: chooseTier(cfg, today.aiNeurons) === 'saver',
        answers_left_estimate: Math.min(
          Math.floor(neuronsLeft / perAnswer),
          cfg.dailyAiLimit > 0 ? Math.max(0, cfg.dailyAiLimit - today.aiAnswers) : Infinity,
        ),
      },
      d1: {
        rows_read: today.d1RowsRead,
        rows_read_free: cfg.freeD1RowsReadPerDay,
        rows_written: today.d1RowsWritten,
        rows_written_free: cfg.freeD1RowsWrittenPerDay,
        storage_bytes: today.d1SizeBytes,
        storage_free_bytes: cfg.freeD1StorageBytes,
      },
    },
  });
}
