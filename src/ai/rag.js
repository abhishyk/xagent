// Retrieval-Augmented Generation: embed → Vectorize → D1 join → relevance
// filtering / ranking → context budget (Spec §4, §22, §24, §50, §51, §52).

import { getConfig, TYPE_PRIORITY_BOOST } from '../config.js';
import { embedQuery } from './embeddings.js';
import { getChunksByIds, ftsSearch } from '../db/documents.js';
import { detectVersion, versionsCompatible } from '../utils/version.js';
import { logEvent } from '../utils/log.js';

export class KnowledgeSearchError extends Error {}

// Hinglish (Hindi in Latin script) filler words. They carry no meaning for
// document search but drag similarity scores down, e.g.
// "america ka president kon hai" -> "america president".
// Only used for the SEARCH query; the model still receives the full question.
// English technical words that look similar ("main", "set", "do", "in") are
// deliberately NOT listed.
const HINGLISH_STOPWORDS = new Set((
  'ka ki ke ko se me mein mei mai mujhe mujhko mera meri mere hum humko hume humein hamara apna apni apne ' +
  'hai hain h ha hu hoon hun tha thi the ho hota hoti hote hua hui hue hoga hogi honge ' +
  'raha rahi rahe rha rhi rhe rahaa ' +
  'kya kyu kyun kyon kaise kese kaisa kaisi kaise kon kaun konsa kaunsa kab kaha kahan kahaan kidhar kitna kitne kitni ' +
  'nahi nhi nahin na mat bhi toh to aur ya par pe ek koi kuch sab sabhi ' +
  'bata batao btao bataye batayein bataiye samjhao samjha ' +
  'krna karna kru karu kare karein kre kro karo kar kiya kiye krke karke karte krte karta krta ' +
  'chahiye chaiye chahie sakta sakte sakti skta skte ' +
  'ye yeh wo woh vo is us iss uss isko usko iska uska iski uski isme usme ' +
  'abhi please plz pls bhai sir ji yaar wala wali wale jab tab agar lekin kyunki ' +
  'kaun-sa kon-sa'
).split(/\s+/));

export function cleanQueryText(text) {
  if (!text || text.length > 400) return text; // leave pasted logs/code untouched
  const words = text.split(/\s+/).filter(Boolean);
  const kept = words.filter((w) => !HINGLISH_STOPWORDS.has(w.toLowerCase().replace(/[?.!,;:]+$/, '')));
  const out = kept.join(' ').replace(/[?!.]+$/, '').trim();
  return out.length >= 2 ? out : text;
}

// Follow-up questions ("why does it fail after reboot?") embed poorly on their
// own, so the retrieval query includes the previous user turn (no extra AI call).
export function buildRetrievalQuery(question, history) {
  const lastUser = [...history].reverse().find((m) => m.role === 'user');
  const q = cleanQueryText(question.slice(0, 2000));
  if (!lastUser || question.length > 400) return q;
  return `${cleanQueryText(lastUser.content.slice(0, 600))}\n${q}`;
}

// What users see about a source: which tab/section it came from — never a link
// to the Google Doc (users must not be able to open the doc itself).
export function toSource(c) {
  return {
    label: c.label,
    section: c.section || null,
    document: c.section ? null : c.document_name, // shown only when there is no tab/section name
    file: c.file_name || null,
    function: c.function_name || null,
    version: c.version || null,
    score: Math.round(c.score * 1000) / 1000,
    chunk_type: c.chunk_type,
  };
}

// ---- keyword (FTS5) side of the hybrid search ------------------------------
const EN_STOPWORDS = new Set((
  'a an the is are was were be been am do does did how what why when where which who whom whose can could ' +
  'should would will shall may might must to of in on at for from by with about into over under and or not ' +
  'no yes i me my we our you your it its this that these those there here please tell explain show give get help'
).split(' '));

// Meaningful search terms (Hinglish + English filler removed), lowercased, deduped.
export function keywordTerms(text, max = 16) {
  const words = String(text || '').toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
  const out = [];
  for (const w of words) {
    if (w.length < 2 || HINGLISH_STOPWORDS.has(w) || EN_STOPWORDS.has(w) || out.includes(w)) continue;
    out.push(w);
    if (out.length >= max) break;
  }
  return out;
}

export function buildFtsQuery(terms) {
  return terms.map((t) => `"${t.replace(/"/g, '')}"`).join(' OR ');
}

// Share of the question's terms that appear in a chunk (rough stem match).
export function keywordCoverage(terms, content) {
  if (!terms.length) return 0;
  const text = String(content || '').toLowerCase();
  let hit = 0;
  for (const t of terms) {
    if (text.includes(t) || (t.length > 5 && text.includes(t.slice(0, t.length - 2)))) hit++;
  }
  return hit / terms.length;
}

// Hybrid retrieval: semantic (Vectorize) + keyword (D1 FTS5).
// Semantic search understands meaning; keyword search guarantees that a chunk
// containing the exact words of the question (e.g. "america", "president",
// "cpanel", "dnsmasq") is found even when the doc and question are in
// different languages (English / Hinglish) and the semantic score is low.
export async function retrieve(env, { question, history = [], topK, minScore, docTypes = null }) {
  const cfg = getConfig(env);
  const k = topK || cfg.topK;
  const threshold = minScore ?? cfg.minSimilarity;
  const query = buildRetrievalQuery(question, history);
  const askedVersion = detectVersion(question);

  const questionTerms = keywordTerms(question);
  const queryTerms = keywordTerms(query, 20);

  let matches = [];
  let vectorFailed = false;
  try {
    const vector = await embedQuery(env, query);
    // returnMetadata 'none' allows a larger topK; full metadata comes from D1.
    const res = await env.VECTORIZE.query(vector, { topK: Math.min(k * 3, 50), returnMetadata: 'none' });
    matches = res?.matches || [];
  } catch (err) {
    vectorFailed = true;
    logEvent('RAG_SEARCH', { status: 'vector_error', error: String(err?.message || err) });
  }
  const keywordHits = await ftsSearch(env.DB, buildFtsQuery(queryTerms), 20);
  if (vectorFailed && !keywordHits.length) {
    throw new KnowledgeSearchError('Knowledge search is temporarily unavailable.');
  }

  const vecScore = new Map(matches.filter((m) => typeof m.score === 'number').map((m) => [m.id, m.score]));
  const ids = new Set([
    ...matches.filter((m) => m.score >= threshold).map((m) => m.id),
    ...keywordHits.map((h) => h.chunk_id),
  ]);
  const rows = await getChunksByIds(env.DB, [...ids]);

  let ranked = [];
  for (const row of rows) {
    if (docTypes && !docTypes.includes(row.document_type)) continue;
    // Version awareness: drop chunks explicitly labelled with a different version.
    if (askedVersion && row.version && !versionsCompatible(askedVersion, row.version)) continue;

    const v = vecScore.get(row.id) ?? 0;
    const vectorOk = v >= threshold;
    const cov = keywordCoverage(questionTerms, `${row.section || ''} ${row.content}`);
    // Keyword hit counts when it covers most of the question's meaningful words.
    const keywordOk = questionTerms.length > 0 && (questionTerms.length === 1 ? cov === 1 : cov >= 0.5);
    if (!vectorOk && !keywordOk) continue;

    const keywordScore = keywordOk ? threshold + 0.25 * cov : 0;
    const score = Math.max(vectorOk ? v : 0, keywordScore);
    let rank = score + (TYPE_PRIORITY_BOOST[row.document_type] ?? 0.01);
    if (vectorOk && keywordOk) rank += 0.05;
    if (row.chunk_type === 'code') rank += 0.01;
    if (askedVersion && row.version && versionsCompatible(askedVersion, row.version)) rank += 0.03;
    ranked.push({ ...row, score, rank });
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
    matches: matches.length + keywordHits.length,
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
