// POST /api/chat — RAG + streaming answer (Spec §4, §9, §31, §45, §46, §48, §49).
//
// No chat history is stored on the server. The browser keeps the current
// conversation in memory and sends the last few turns with each question, so
// follow-up questions still work; refreshing the page or "New Chat" clears it.

import { getConfig } from '../config.js';
import { json, error, readJson, securityHeaders, HttpError } from '../utils/http.js';
import { logEvent } from '../utils/log.js';
import { requireString, cleanText } from '../security/validation.js';
import { hitUserRateLimit, reserveDailyAi, releaseDailyAi } from '../security/rateLimit.js';
import { retrieve, KnowledgeSearchError } from '../ai/rag.js';
import { buildContextBlock, buildMessages } from '../ai/prompts.js';
import { generateStream } from '../ai/model.js';
import { readUsageToday } from '../utils/usage.js';

export const LIMIT_MESSAGE = "Today's AI usage limit has been reached. Please try again later.";
const MAX_HISTORY_ITEM_CHARS = 6000;

// Validate the client-supplied recent turns: correct roles, string content,
// bounded size, and only the most recent MAX_HISTORY_MESSAGES are kept.
export function sanitizeHistory(raw, maxMessages) {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new HttpError(400, 'history must be an array');
  const out = [];
  for (const m of raw.slice(-Math.max(0, maxMessages))) {
    if (!m || (m.role !== 'user' && m.role !== 'assistant') || typeof m.content !== 'string') {
      throw new HttpError(400, 'Invalid history item');
    }
    const content = cleanText(m.content).trim().slice(0, MAX_HISTORY_ITEM_CHARS);
    if (content) out.push({ role: m.role, content });
  }
  return maxMessages > 0 ? out : [];
}

// Models sometimes cite as 【S1】 or 【S1†L3-L5】 instead of [S1].
export function normalizeCitations(text) {
  return String(text).replace(/【\s*(S\d{1,2})[^】]*】/g, '[$1]');
}

function sse(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export async function handleChat(request, env, ctx, user) {
  const cfg = getConfig(env);
  const maxBody = (cfg.maxMessageLength + cfg.maxHistoryMessages * MAX_HISTORY_ITEM_CHARS) * 3 + 4096;
  const body = await readJson(request, maxBody);
  const question = cleanText(requireString(body.message, 'message', { max: cfg.maxMessageLength }));
  const history = sanitizeHistory(body.history, cfg.maxHistoryMessages);

  if (await hitUserRateLimit(env.DB, user.id, cfg.chatRatePerMinute, 'chat')) {
    return error(429, 'You are sending messages too quickly. Please wait a moment.');
  }

  // Free-tier safety: reserve one generation from the daily budget BEFORE any AI call.
  // Use the whole free Workers AI allowance: stop only when today's neurons
  // (+ one typical answer) would exceed it. FREE_NEURONS_PER_DAY=0 disables this.
  if (cfg.freeNeuronsPerDay > 0) {
    const today = await readUsageToday(env.DB);
    const perAnswer = today.aiAnswers > 0 && today.aiNeurons > 0 ? today.aiNeurons / today.aiAnswers : 150;
    if (today.aiNeurons + perAnswer > cfg.freeNeuronsPerDay) {
      logEvent('AI_LIMIT_REACHED', { user_id: user.id, reason: 'neurons' });
      return json({ error: LIMIT_MESSAGE, code: 'daily_limit' }, 429);
    }
  }
  // Optional extra cap on the number of answers per day (DAILY_AI_LIMIT, 0 = off).
  if (!(await reserveDailyAi(env.DB, cfg.dailyAiLimit))) {
    logEvent('AI_LIMIT_REACHED', { user_id: user.id });
    return json({ error: LIMIT_MESSAGE, code: 'daily_limit' }, 429);
  }

  logEvent('CHAT_REQUEST', { user_id: user.id, count: history.length });

  let rag;
  try {
    rag = await retrieve(env, { question, history });
  } catch (err) {
    await releaseDailyAi(env.DB); // nothing was answered
    if (err instanceof KnowledgeSearchError) return error(503, 'Knowledge search is temporarily unavailable.');
    throw err;
  }

  const messages = buildMessages({ history, question, contextBlock: buildContextBlock(rag.chunks) });

  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  const write = (event, data) => writer.write(encoder.encode(sse(event, data)));

  const pump = (async () => {
    let answer = '';
    const started = Date.now();
    try {
      await write('meta', {
        sources: rag.sources,
        no_relevant_docs: rag.noRelevant,
        notice: rag.noRelevant ? 'No sufficiently relevant documentation found.' : null,
      });
      logEvent('AI_REQUEST', { user_id: user.id, model: cfg.aiModel });
      for await (const delta of generateStream(env, messages)) {
        answer += delta;
        await write('delta', { t: delta });
      }
      if (!answer.trim()) throw new Error('empty model response');
      // Only keep sources the answer actually cites; if none cited, keep all retrieved.
      const normalized = normalizeCitations(answer);
      const cited = rag.sources.filter((s) => normalized.includes(`[${s.label}]`));
      await write('done', { sources: cited.length ? cited : rag.sources });
      logEvent('AI_RESPONSE', { user_id: user.id, duration_ms: Date.now() - started, status: 'ok' });
    } catch (err) {
      logEvent('AI_ERROR', { user_id: user.id, error: String(err?.message || err) });
      if (!answer.trim()) await releaseDailyAi(env.DB).catch(() => {});
      // Cloudflare refuses requests once the free daily neurons are used up.
      const quota = /neuron|allocation|quota|limit|429/i.test(String(err?.message || err));
      await write('error', { message: quota ? LIMIT_MESSAGE : 'AI service temporarily unavailable.' }).catch(() => {});
    } finally {
      await writer.close().catch(() => {});
    }
  })();
  ctx.waitUntil(pump);

  const headers = securityHeaders(new Headers({
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store, no-transform',
    'X-Accel-Buffering': 'no',
  }));
  return new Response(readable, { status: 200, headers });
}
