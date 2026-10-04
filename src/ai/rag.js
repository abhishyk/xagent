// Retrieval-Augmented Generation: embed → Vectorize → D1 join → relevance
// filtering / ranking → context budget (Spec §4, §22, §24, §50, §51, §52).

import { getConfig, TYPE_PRIORITY_BOOST } from '../config.js';
import { embedQuery } from './embeddings.js';
import { getChunksByIds } from '../db/documents.js';
import { detectVersion, versionsCompatible } from '../utils/version.js';
import { logEvent } from '../utils/log.js';

export class KnowledgeSearchError extends Error {}

// Follow-up questions ("why does it fail after reboot?") embed poorly on their
// own, so the retrieval query includes the previous user turn (no extra AI call).
export function buildRetrievalQuery(question, history) {
  const lastUser = [...history].reverse().find((m) => m.role === 'user');
  const q = question.slice(0, 2000);
  if (!lastUser || question.length > 400) return q;
  return `${lastUser.content.slice(0, 600)}\n${q}`;
}

// Deep link to the exact tab + heading: .../edit?tab=t.xxx#heading=h.yyy
// heading_id is stored as "tabId|headingId" (older rows: just "headingId").
export function sourceUrl(c) {
  if (!c.document_url) return null;
  if (!c.heading_id) return c.document_url;
  const [tab, heading] = c.heading_id.includes('|') ? c.heading_id.split('|') : ['', c.heading_id];
  let url = c.document_url;
  if (tab) url += `?tab=${encodeURIComponent(tab)}`;
  if (heading) url += `#heading=${encodeURIComponent(heading)}`;
  return url;
}

export function toSource(c) {
  return {
    label: c.label,
    document: c.document_name,
    type: c.document_type,
    section: c.section || null,
    file: c.file_name || null,
    function: c.function_name || null,
    version: c.version || null,
    url: sourceUrl(c),
    score: Math.round(c.score * 1000) / 1000,
    chunk_type: c.chunk_type,
  };
}

export async function retrieve(env, { question, history = [], topK, minScore, docTypes = null }) {
  const cfg = getConfig(env);
  const k = topK || cfg.topK;
  const threshold = minScore ?? cfg.minSimilarity;
  const query = buildRetrievalQuery(question, history);
  const askedVersion = detectVersion(question);

  let matches;
  try {
    const vector = await embedQuery(env, query);
    // returnMetadata 'none' allows a larger topK; full metadata comes from D1.
    const res = await env.VECTORIZE.query(vector, { topK: Math.min(k * 3, 50), returnMetadata: 'none' });
    matches = res?.matches || [];
  } catch (err) {
    logEvent('RAG_SEARCH', { status: 'error', error: String(err?.message || err) });
    throw new KnowledgeSearchError('Knowledge search is temporarily unavailable.');
  }

  const candidates = matches.filter((m) => typeof m.score === 'number' && m.score >= threshold);
  const rows = await getChunksByIds(env.DB, candidates.map((m) => m.id));
  const byId = new Map(rows.map((r) => [r.id, r]));

  let ranked = [];
  for (const m of candidates) {
    const row = byId.get(m.id);
    if (!row) continue; // vector exists but chunk was deleted (eventual consistency)
    if (docTypes && !docTypes.includes(row.document_type)) continue;
    // Version awareness: drop chunks explicitly labelled with a different version.
    if (askedVersion && row.version && !versionsCompatible(askedVersion, row.version)) continue;
    let rank = m.score + (TYPE_PRIORITY_BOOST[row.document_type] ?? 0.01);
    if (row.chunk_type === 'code') rank += 0.01;
    if (askedVersion && row.version && versionsCompatible(askedVersion, row.version)) rank += 0.03;
    ranked.push({ ...row, score: m.score, rank });
  }
  ranked.sort((a, b) => b.rank - a.rank);

  // Budget: TOP_K chunks, MAX_CONTEXT_CHARS, MAX_CONTEXT_TOKENS (≈4 chars/token).
  const charBudget = Math.min(cfg.maxContextChars, cfg.maxContextTokens * 4);
  const selected = [];
  let used = 0;
  for (const c of ranked) {
    if (selected.length >= k) break;
    let content = c.content;
    if (used + content.length > charBudget) {
      const room = charBudget - used;
      if (room < 400) break;
      content = `${content.slice(0, room)}\n…[truncated]`;
    }
    used += content.length;
    selected.push({ ...c, content, label: `S${selected.length + 1}` });
  }

  logEvent('RAG_SEARCH', {
    matches: matches.length,
    kept: selected.length,
    top_score: matches[0]?.score ?? null,
  });

  return {
    chunks: selected,
    sources: selected.map(toSource),
    topScore: matches[0]?.score ?? 0,
    noRelevant: selected.length === 0,
  };
}
