// Document / chunk / sync-run metadata in D1.

const now = () => new Date().toISOString();

export async function getDocument(db, id) {
  return db.prepare('SELECT * FROM documents WHERE id = ?').bind(id).first();
}

export async function upsertDocumentShell(db, { id, name, type, url }) {
  await db.prepare(
    `INSERT INTO documents (id, google_document_id, name, document_type, url, status)
     VALUES (?, ?, ?, ?, ?, 'pending')
     ON CONFLICT(id) DO UPDATE SET name = excluded.name, document_type = excluded.document_type, url = excluded.url`
  ).bind(id, id, name, type, url).run();
}

export async function markDocument(db, id, fields) {
  const keys = Object.keys(fields);
  if (!keys.length) return;
  const allowed = new Set(['name', 'document_type', 'url', 'content_hash', 'version', 'revision_id', 'modified_time',
    'chunk_count', 'status', 'last_error', 'last_synced_at']);
  for (const k of keys) if (!allowed.has(k)) throw new Error(`bad field ${k}`);
  const sets = keys.map((k) => `${k} = ?`).join(', ');
  await db.prepare(`UPDATE documents SET ${sets}, updated_at = ? WHERE id = ?`)
    .bind(...keys.map((k) => fields[k]), now(), id).run();
}

export async function listDocuments(db) {
  const { results } = await db.prepare(
    `SELECT id, name, document_type, url, content_hash, version, revision_id, modified_time, chunk_count,
            status, last_error, updated_at, last_synced_at
       FROM documents ORDER BY name COLLATE NOCASE`
  ).all();
  return results;
}

export async function existingChunkIds(db, documentId) {
  const { results } = await db.prepare('SELECT id FROM document_chunks WHERE document_id = ?').bind(documentId).all();
  return new Set(results.map((r) => r.id));
}

// Keyword index (FTS5, migration 0002). Kept best-effort: if the table does not
// exist yet the app keeps working with vector search only.
async function ftsTry(fn) {
  try { await fn(); return true; } catch { return false; }
}

export async function ftsBackfill(db, documentId) {
  return ftsTry(() => db.prepare(
    `INSERT INTO chunks_fts (chunk_id, document_id, section, content)
     SELECT c.id, c.document_id, COALESCE(c.section, ''), c.content FROM document_chunks c
      WHERE c.document_id = ? AND c.id NOT IN (SELECT chunk_id FROM chunks_fts WHERE document_id = ?)`
  ).bind(documentId, documentId).run());
}

// Keyword search. `ftsQuery` is already sanitised ("term" OR "term" …).
export async function ftsSearch(db, ftsQuery, limit = 20) {
  if (!ftsQuery) return [];
  try {
    const { results } = await db.prepare(
      'SELECT chunk_id, bm25(chunks_fts) AS score FROM chunks_fts WHERE chunks_fts MATCH ? ORDER BY score LIMIT ?'
    ).bind(ftsQuery, limit).all();
    return results;
  } catch {
    return [];
  }
}

export async function insertChunks(db, documentId, chunks) {
  if (!chunks.length) return;
  const stmt = db.prepare(
    `INSERT OR REPLACE INTO document_chunks
      (id, document_id, chunk_index, chunk_type, heading, heading_id, section, content, content_hash,
       version, file_name, language, class_name, function_name, module)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  await db.batch(chunks.map((c) => stmt.bind(
    c.id, documentId, c.index, c.type, c.heading || null, c.headingId || null, c.section || null, c.content,
    c.contentHash, c.version || null, c.fileName || null, c.language || null, c.className || null,
    c.functionName || null, c.module || null
  )));
  const fts = db.prepare('INSERT INTO chunks_fts (chunk_id, document_id, section, content) VALUES (?, ?, ?, ?)');
  await ftsTry(() => db.batch(chunks.map((c) => fts.bind(c.id, documentId, c.section || '', c.content))));
}

export async function deleteChunks(db, ids) {
  for (let i = 0; i < ids.length; i += 90) {
    const slice = ids.slice(i, i + 90);
    await db.prepare(`DELETE FROM document_chunks WHERE id IN (${slice.map(() => '?').join(',')})`).bind(...slice).run();
    await ftsTry(() => db.prepare(`DELETE FROM chunks_fts WHERE chunk_id IN (${slice.map(() => '?').join(',')})`).bind(...slice).run());
  }
}

export async function getChunksByIds(db, ids) {
  if (!ids.length) return [];
  const out = [];
  for (let i = 0; i < ids.length; i += 90) {
    const slice = ids.slice(i, i + 90);
    const { results } = await db.prepare(
      `SELECT c.*, d.name AS document_name, d.document_type, d.url AS document_url
         FROM document_chunks c JOIN documents d ON d.id = c.document_id
        WHERE c.id IN (${slice.map(() => '?').join(',')})`
    ).bind(...slice).all();
    out.push(...results);
  }
  return out;
}

export async function deleteDocument(db, id) {
  await ftsTry(() => db.prepare('DELETE FROM chunks_fts WHERE document_id = ?').bind(id).run());
  await db.prepare('DELETE FROM document_chunks WHERE document_id = ?').bind(id).run();
  await db.prepare('DELETE FROM documents WHERE id = ?').bind(id).run();
}

export async function knowledgeStats(db) {
  return db.prepare(
    `SELECT (SELECT COUNT(*) FROM documents) AS documents,
            (SELECT COUNT(*) FROM documents WHERE status = 'synced') AS synced,
            (SELECT COUNT(*) FROM documents WHERE status = 'failed') AS failed,
            (SELECT COUNT(*) FROM document_chunks) AS chunks`
  ).first();
}

// ---- sync runs ----------------------------------------------------------
export async function createSyncRun(db, trigger) {
  const row = await db.prepare('INSERT INTO sync_runs (trigger_type) VALUES (?) RETURNING id').bind(trigger).first();
  return row.id;
}

export async function getSyncRun(db, id) {
  return db.prepare('SELECT * FROM sync_runs WHERE id = ?').bind(id).first();
}

export async function addToSyncRun(db, id, { processed = 0, failed = 0, chunks = 0, deleted = 0, error = null }) {
  await db.prepare(
    `UPDATE sync_runs SET documents_processed = documents_processed + ?, documents_failed = documents_failed + ?,
            chunks_processed = chunks_processed + ?, chunks_deleted = chunks_deleted + ?,
            error_message = CASE WHEN ? IS NULL THEN error_message
                                 ELSE substr(COALESCE(error_message || char(10), '') || ?, 1, 2000) END
      WHERE id = ?`
  ).bind(processed, failed, chunks, deleted, error, error, id).run();
}

export async function finishSyncRun(db, id, status, errorMessage = null) {
  await db.prepare(
    'UPDATE sync_runs SET status = ?, completed_at = ?, error_message = COALESCE(?, error_message) WHERE id = ?'
  ).bind(status, now(), errorMessage, id).run();
}

export async function listSyncRuns(db, limit = 10) {
  const { results } = await db.prepare('SELECT * FROM sync_runs ORDER BY id DESC LIMIT ?').bind(limit).all();
  return results;
}
