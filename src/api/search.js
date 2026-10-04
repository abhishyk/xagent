// POST /api/search — "Search Documentation" mode (Spec §53).
// Returns matching sections straight from Vectorize/D1 with no text generation.

import { getConfig, DOCUMENT_TYPES } from '../config.js';
import { json, error, readJson } from '../utils/http.js';
import { requireString, cleanText } from '../security/validation.js';
import { hitUserRateLimit } from '../security/rateLimit.js';
import { retrieve, KnowledgeSearchError } from '../ai/rag.js';

export async function handleSearch(request, env, user) {
  const cfg = getConfig(env);
  const body = await readJson(request, 8192);
  const query = cleanText(requireString(body.query, 'query', { max: 2000 }));
  const types = Array.isArray(body.types) ? body.types.filter((t) => DOCUMENT_TYPES.includes(t)) : null;

  if (await hitUserRateLimit(env.DB, user.id, cfg.chatRatePerMinute * 3, 'search')) {
    return error(429, 'Too many searches. Please wait a moment.');
  }
  try {
    const res = await retrieve(env, {
      question: query, topK: 10, docTypes: types && types.length ? types : null,
      minScore: Math.max(0, cfg.minSimilarity - 0.05),
    });
    return json({
      results: res.chunks.map((c, i) => ({
        ...res.sources[i],
        snippet: c.content.slice(0, 1200),
      })),
      notice: res.noRelevant ? 'No sufficiently relevant documentation found.' : null,
    });
  } catch (err) {
    if (err instanceof KnowledgeSearchError) return error(503, 'Knowledge search is temporarily unavailable.');
    throw err;
  }
}
