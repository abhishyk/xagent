// Incremental Google Docs → Vectorize/D1 synchronisation (Spec §6, §28, §29).
//
// The work is split into small, resumable steps so each Worker invocation stays
// inside free-plan CPU/subrequest limits:
//   start   -> create a sync_runs row, return the configured document list
//   step    -> process ONE document: change check, parse, chunk, embed up to
//              MAX_EMBED_PER_STEP *new* chunks. Returns in_progress until done.
//   finish  -> remove documents no longer configured, close the run.
// Unchanged chunks keep their content-addressed id and are never re-embedded;
// stale chunks are deleted only after every new chunk of that doc is indexed.

import { getConfig, DOCUMENT_TYPES } from '../config.js';
import { sha256Hex } from '../utils/crypto.js';
import { detectVersion } from '../utils/version.js';
import { logEvent } from '../utils/log.js';
import { embedTexts } from '../ai/embeddings.js';
import { fetchDocument, fetchDriveMeta, documentToBlocks, docUrl, parseExcludeTabs } from './docs.js';
import { chunkBlocks } from './chunker.js';
import {
  getDocument, upsertDocumentShell, markDocument, existingChunkIds, insertChunks, deleteChunks,
  listDocuments, deleteDocument, createSyncRun, addToSyncRun, finishSyncRun, getSyncRun,
} from '../db/documents.js';

const now = () => new Date().toISOString();

// GOOGLE_DOCUMENT_IDS: "id1:handbook,id2:source_code" or JSON
// [{"id":"...","type":"source_code","name":"optional override"}]
export function parseDocumentConfig(raw) {
  if (!raw) return [];
  const text = String(raw).trim();
  let items;
  if (text.startsWith('[')) {
    try { items = JSON.parse(text); } catch { throw new Error('GOOGLE_DOCUMENT_IDS is not valid JSON'); }
  } else {
    items = text.split(/[,\n]/).map((s) => s.trim()).filter(Boolean).map((s) => {
      const [id, type] = s.split(':').map((x) => x.trim());
      return { id, type };
    });
  }
  const seen = new Set();
  const out = [];
  for (const it of items) {
    const id = String(it.id || '').trim();
    if (!/^[A-Za-z0-9_-]{10,100}$/.test(id) || seen.has(id)) continue;
    seen.add(id);
    const type = String(it.type || '').toLowerCase();
    out.push({ id, type: DOCUMENT_TYPES.includes(type) ? type : null, name: it.name || null });
  }
  return out;
}

function inferType(name) {
  const n = (name || '').toLowerCase();
  if (/source|code|api|implementation|module/.test(n)) return 'source_code';
  if (/troubleshoot|faq|error|issue/.test(n)) return 'troubleshooting';
  if (/pxe|netboot|ipxe|tftp/.test(n)) return 'pxe';
  if (/install/.test(n)) return 'installation';
  if (/network|dhcp|dns/.test(n)) return 'networking';
  if (/deploy|exam|center|centre|server setup/.test(n)) return 'deployment';
  if (/config/.test(n)) return 'configuration';
  return 'handbook';
}

function vectorMetadata(doc, c) {
  const t = (s, n = 200) => (s ? String(s).slice(0, n) : '');
  return {
    document_id: doc.id,
    document_name: t(doc.name),
    document_type: doc.type,
    source: 'google_docs',
    chunk_id: c.id,
    chunk_type: c.type,
    section: t(c.section, 300),
    heading: t(c.heading),
    version: t(c.version, 40),
    file_name: t(c.fileName),
    language: t(c.language, 40),
    class_name: t(c.className),
    function_name: t(c.functionName, 300),
    module: t(c.module),
    content_hash: c.contentHash,
    updated_at: now(),
  };
}

/**
 * Process one document (one resumable step).
 * @returns {{status:'unchanged'|'updated'|'in_progress'|'failed', added, deleted, remaining, chunks, error?}}
 */
export async function syncDocumentStep(env, docCfg, { force = false } = {}) {
  const cfg = getConfig(env);
  const id = docCfg.id;
  const existing = await getDocument(env.DB, id);
  const resuming = existing?.status === 'syncing';

  try {
    // 1. Cheap change detection via Drive metadata (skips the download entirely).
    let driveMeta = null;
    try { driveMeta = await fetchDriveMeta(env, id); } catch { driveMeta = null; }
    if (driveMeta?.trashed) throw new Error('Document is in the Google Drive trash');
    if (!force && !resuming && existing?.status === 'synced' && driveMeta?.modifiedTime &&
        existing.modified_time === driveMeta.modifiedTime) {
      return { status: 'unchanged', added: 0, deleted: 0, remaining: 0, chunks: existing.chunk_count };
    }

    // 2. Download + parse.
    const gdoc = await fetchDocument(env, id);
    const name = docCfg.name || gdoc.title || driveMeta?.name || id;
    const type = docCfg.type || inferType(name);
    const blocks = documentToBlocks(gdoc, type, { excludeTabs: parseExcludeTabs(env.GOOGLE_EXCLUDE_TABS) });
    const firstHeading = blocks.find((b) => b.type === 'heading')?.text;
    const version = detectVersion(name) || detectVersion(firstHeading) || null;
    const contentHash = await sha256Hex(JSON.stringify([type, cfg.embeddingModel, blocks]));

    await upsertDocumentShell(env.DB, { id, name, type, url: docUrl(id) });

    if (!force && !resuming && existing?.status === 'synced' && existing.content_hash === contentHash) {
      await markDocument(env.DB, id, {
        revision_id: gdoc.revisionId || null, modified_time: driveMeta?.modifiedTime || existing.modified_time,
        last_synced_at: now(), last_error: null,
      });
      return { status: 'unchanged', added: 0, deleted: 0, remaining: 0, chunks: existing.chunk_count };
    }

    // 3. Chunk and diff against what is already indexed.
    const chunks = await chunkBlocks(blocks, {
      documentId: id, documentName: name, documentType: type, documentVersion: version,
      embeddingModel: cfg.embeddingModel, chunkSize: cfg.chunkSize, chunkOverlap: cfg.chunkOverlap,
    });
    const have = await existingChunkIds(env.DB, id);
    const wanted = new Set(chunks.map((c) => c.id));
    const toAdd = chunks.filter((c) => !have.has(c.id));
    const toDelete = [...have].filter((cid) => !wanted.has(cid));

    await markDocument(env.DB, id, { status: 'syncing', last_error: null });

    // 4. Embed + index a bounded batch of NEW chunks only.
    const batch = toAdd.slice(0, cfg.maxEmbedPerStep);
    const meta = { id, name, type };
    for (let i = 0; i < batch.length; i += cfg.embedBatchSize) {
      const group = batch.slice(i, i + cfg.embedBatchSize);
      const vectors = await embedTexts(env, group.map((c) => c.embedText));
      await env.VECTORIZE.upsert(group.map((c, j) => ({ id: c.id, values: vectors[j], metadata: vectorMetadata(meta, c) })));
      await insertChunks(env.DB, id, group);
    }
    const remaining = toAdd.length - batch.length;
    if (remaining > 0) {
      logEvent('SYNC_PROGRESS', { document_id: id, added: batch.length, remaining });
      return { status: 'in_progress', added: batch.length, deleted: 0, remaining, chunks: chunks.length };
    }

    // 5. Every new chunk is indexed: remove stale ones and finalise the document.
    if (toDelete.length) {
      for (let i = 0; i < toDelete.length; i += 500) await env.VECTORIZE.deleteByIds(toDelete.slice(i, i + 500));
      await deleteChunks(env.DB, toDelete);
    }
    await markDocument(env.DB, id, {
      name, document_type: type, content_hash: contentHash, version, revision_id: gdoc.revisionId || null,
      modified_time: driveMeta?.modifiedTime || null, chunk_count: chunks.length, status: 'synced',
      last_error: null, last_synced_at: now(),
    });
    logEvent('SYNC_DOCUMENT', { document_id: id, added: batch.length, deleted: toDelete.length, chunks: chunks.length });
    return { status: 'updated', added: batch.length, deleted: toDelete.length, remaining: 0, chunks: chunks.length };
  } catch (err) {
    const message = String(err?.message || err).slice(0, 500);
    if (existing || (await getDocument(env.DB, id))) {
      await markDocument(env.DB, id, { status: 'failed', last_error: message });
    } else {
      await upsertDocumentShell(env.DB, { id, name: docCfg.name || id, type: docCfg.type || 'handbook', url: docUrl(id) });
      await markDocument(env.DB, id, { status: 'failed', last_error: message });
    }
    logEvent('SYNC_FAILED', { document_id: id, error: message });
    return { status: 'failed', added: 0, deleted: 0, remaining: 0, chunks: 0, error: message };
  }
}

// ---- run orchestration ----------------------------------------------------

export async function startSyncRun(env, trigger = 'manual') {
  const docs = parseDocumentConfig(env.GOOGLE_DOCUMENT_IDS);
  if (!docs.length) throw new Error('No documents configured. Set GOOGLE_DOCUMENT_IDS.');
  if (!env.GOOGLE_SERVICE_ACCOUNT_EMAIL || !env.GOOGLE_PRIVATE_KEY) {
    throw new Error('Google credentials are not configured (GOOGLE_SERVICE_ACCOUNT_EMAIL / GOOGLE_PRIVATE_KEY).');
  }
  const runId = await createSyncRun(env.DB, trigger);
  logEvent('SYNC_STARTED', { run_id: runId, count: docs.length });
  return { runId, documents: docs.map((d) => d.id) };
}

export async function runStep(env, runId, documentId, { force = false } = {}) {
  const run = await getSyncRun(env.DB, runId);
  if (!run || run.status !== 'running') throw new Error('Sync run is not active');
  const docCfg = parseDocumentConfig(env.GOOGLE_DOCUMENT_IDS).find((d) => d.id === documentId);
  if (!docCfg) throw new Error('Document is not in GOOGLE_DOCUMENT_IDS');
  const result = await syncDocumentStep(env, docCfg, { force });
  const finished = result.status !== 'in_progress';
  await addToSyncRun(env.DB, runId, {
    processed: finished && result.status !== 'failed' ? 1 : 0,
    failed: result.status === 'failed' ? 1 : 0,
    chunks: result.added,
    deleted: result.deleted,
    error: result.error ? `${documentId}: ${result.error}` : null,
  });
  return result;
}

export async function finishRun(env, runId) {
  const run = await getSyncRun(env.DB, runId);
  if (!run) throw new Error('Unknown sync run');
  // Remove documents that are no longer configured (and their vectors).
  const configured = new Set(parseDocumentConfig(env.GOOGLE_DOCUMENT_IDS).map((d) => d.id));
  let removed = 0;
  for (const d of await listDocuments(env.DB)) {
    if (configured.has(d.id)) continue;
    const ids = [...(await existingChunkIds(env.DB, d.id))];
    for (let i = 0; i < ids.length; i += 500) await env.VECTORIZE.deleteByIds(ids.slice(i, i + 500));
    await deleteDocument(env.DB, d.id);
    removed += ids.length;
  }
  if (removed) await addToSyncRun(env.DB, runId, { deleted: removed });
  const fresh = await getSyncRun(env.DB, runId);
  const status = fresh.documents_failed === 0 ? 'success' : fresh.documents_processed > 0 ? 'partial' : 'failed';
  await finishSyncRun(env.DB, runId, status);
  logEvent(status === 'failed' ? 'SYNC_FAILED' : 'SYNC_COMPLETED', { run_id: runId, status });
  return { ...(await getSyncRun(env.DB, runId)) };
}

// Used by the optional cron trigger: loops steps within one invocation and
// stops early (leaving the rest for the next run) if a step budget is exceeded.
export async function runFullSync(env, { trigger = 'scheduled', maxSteps = 25 } = {}) {
  const { runId, documents } = await startSyncRun(env, trigger);
  let steps = 0;
  for (const docId of documents) {
    let res;
    do {
      res = await runStep(env, runId, docId);
      steps++;
    } while (res.status === 'in_progress' && steps < maxSteps);
    if (steps >= maxSteps) break;
  }
  return finishRun(env, runId);
}
