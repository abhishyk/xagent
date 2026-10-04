// Workers AI text generation (GPT-OSS-20B by default, configurable via AI_MODEL).
// Handles both streaming (SSE) and non-streaming responses, and tolerates the
// different payload shapes Workers AI models emit (classic {response},
// OpenAI chat-completions chunks, and Responses-API style output items).

import { getConfig } from '../config.js';
import { addNeurons, estimateTokens } from '../utils/usage.js';
import { tierInfo } from './tiers.js';

// Token usage reported by the model ({prompt_tokens, completion_tokens} or
// {input_tokens, output_tokens}); null when absent.
export function extractUsage(obj) {
  const u = obj?.usage || obj?.response?.usage;
  if (!u || typeof u !== 'object') return null;
  const input = Number(u.prompt_tokens ?? u.input_tokens ?? 0);
  const output = Number(u.completion_tokens ?? u.output_tokens ?? 0);
  return input || output ? { input, output } : null;
}

function buildParams(cfg, messages, stream, model) {
  const params = {
    messages,
    stream,
    max_tokens: cfg.maxOutputTokens,
    temperature: cfg.temperature,
  };
  // The reasoning option only applies to the gpt-oss family.
  if (cfg.reasoningEffort && /gpt-oss/.test(model)) params.reasoning = { effort: cfg.reasoningEffort };
  return params;
}

// Extract assistant text from a non-streaming result.
export function extractText(result) {
  if (result == null) return '';
  if (typeof result === 'string') return result;
  if (typeof result.response === 'string') return result.response;
  if (Array.isArray(result.choices)) {
    return result.choices.map((c) => c?.message?.content ?? c?.text ?? '').join('');
  }
  if (typeof result.output_text === 'string') return result.output_text;
  if (Array.isArray(result.output)) {
    // Responses API: [{type:'reasoning',...},{type:'message',content:[{type:'output_text',text}]}]
    return result.output
      .filter((o) => o?.type === 'message')
      .flatMap((o) => o.content || [])
      .filter((c) => c?.type === 'output_text' || typeof c?.text === 'string')
      .map((c) => c.text || '')
      .join('');
  }
  return '';
}

// Extract the visible-answer delta from one parsed SSE event. Reasoning tokens
// (chain-of-thought) are deliberately ignored.
export function extractDelta(evt) {
  if (!evt || typeof evt !== 'object') return '';
  if (typeof evt.response === 'string') return evt.response;
  if (Array.isArray(evt.choices)) {
    return evt.choices.map((c) => c?.delta?.content ?? c?.text ?? '').filter((s) => typeof s === 'string').join('');
  }
  if (evt.type === 'response.output_text.delta' && typeof evt.delta === 'string') return evt.delta;
  return '';
}

// Async generator over text deltas from a Workers AI SSE ReadableStream.
export async function* iterateSse(stream, onUsage) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).replace(/\r$/, '');
        buffer = buffer.slice(idx + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        let evt;
        try { evt = JSON.parse(data); } catch { continue; }
        const usage = extractUsage(evt);
        if (usage && onUsage) onUsage(usage);
        const delta = extractDelta(evt);
        if (delta) yield delta;
      }
    }
    const tail = buffer.trim();
    if (tail.startsWith('data:')) {
      try {
        const delta = extractDelta(JSON.parse(tail.slice(5).trim()));
        if (delta) yield delta;
      } catch { /* ignore partial */ }
    }
  } finally {
    reader.releaseLock();
  }
}

// Returns an async iterator of text deltas. Falls back to a single
// non-streaming call if the model/binding does not return a stream.
// Records neurons for one generation: exact token usage when the model reports
// it, otherwise an estimate (output doubled to cover hidden reasoning tokens).
function recordGeneration(env, pick, messages, usage, outputChars) {
  const input = usage?.input || estimateTokens(JSON.stringify(messages).length);
  const output = usage?.output || Math.ceil(estimateTokens(outputChars) * pick.outMultiplier);
  addNeurons(env.__usage, input, pick.inRate);
  addNeurons(env.__usage, output, pick.outRate);
}

// Removes <think>…</think> reasoning blocks that some models (e.g. Qwen3) put in
// the visible text stream. Works across chunk boundaries.
export function createThinkFilter() {
  const OPEN = '<think>';
  const CLOSE = '</think>';
  let inThink = false;
  let buf = '';
  let started = false;
  const partial = (s, tag) => {
    for (let n = Math.min(tag.length - 1, s.length); n > 0; n--) if (tag.startsWith(s.slice(-n))) return n;
    return 0;
  };
  const emit = (t) => {
    if (!started) { t = t.replace(/^\s+/, ''); if (t) started = true; }
    return t;
  };
  return {
    push(chunk) {
      buf += chunk;
      let out = '';
      while (buf) {
        if (inThink) {
          const i = buf.indexOf(CLOSE);
          if (i < 0) { buf = buf.slice(-(CLOSE.length - 1)); break; }
          buf = buf.slice(i + CLOSE.length);
          inThink = false;
          continue;
        }
        // A lone </think> before any visible text: everything before it was reasoning.
        const c = buf.indexOf(CLOSE);
        const o = buf.indexOf(OPEN);
        if (!started && c >= 0 && (o < 0 || c < o)) { buf = buf.slice(c + CLOSE.length); continue; }
        if (o < 0) {
          const keep = Math.max(partial(buf, OPEN), started ? 0 : partial(buf, CLOSE));
          out += emit(buf.slice(0, buf.length - keep));
          buf = buf.slice(buf.length - keep);
          break;
        }
        out += emit(buf.slice(0, o));
        buf = buf.slice(o + OPEN.length);
        inThink = true;
      }
      return out;
    },
    flush() {
      const rest = inThink ? '' : emit(buf);
      buf = '';
      return rest;
    },
  };
}

// Qwen3 supports a "/no_think" switch that skips its reasoning step (cheaper, faster).
function prepareMessages(model, messages) {
  if (!/qwen3/i.test(model) || !messages.length) return messages;
  const out = messages.slice();
  const last = out[out.length - 1];
  out[out.length - 1] = { ...last, content: `${last.content}\n/no_think` };
  return out;
}

export async function* generateStream(env, messages, opts = {}) {
  const cfg = getConfig(env);
  const pick = tierInfo(cfg, opts.tier || 'main');
  messages = prepareMessages(pick.model, messages);
  const filter = createThinkFilter();

  const result = await env.AI.run(pick.model, buildParams(cfg, messages, true, pick.model));
  let usage = null;
  let chars = 0;
  if (result && typeof result.getReader === 'function') {
    let any = false;
    for await (const raw of iterateSse(result, (u) => { usage = u; })) {
      chars += raw.length;
      const d = filter.push(raw);
      if (d) { any = true; yield d; }
    }
    const tail = filter.flush();
    if (tail) { any = true; yield tail; }
    recordGeneration(env, pick, messages, usage, chars);
    if (any) return;
    // Stream produced no visible text (e.g. unknown event format): retry once non-streaming.
  } else {
    const rawText = extractText(result);
    recordGeneration(env, pick, messages, extractUsage(result), rawText.length);
    const f = createThinkFilter();
    const text = f.push(rawText) + f.flush();
    if (text) { yield text; return; }
  }
  const fallback = await env.AI.run(pick.model, buildParams(cfg, messages, false, pick.model));
  const rawText = extractText(fallback);
  recordGeneration(env, pick, messages, extractUsage(fallback), rawText.length);
  const f = createThinkFilter();
  const text = f.push(rawText) + f.flush();
  if (text) yield text;
}

export async function generate(env, messages) {
  const cfg = getConfig(env);
  const result = await env.AI.run(cfg.aiModel, buildParams(cfg, messages, false, cfg.aiModel));
  return extractText(result);
}
