// Workers AI text generation (GPT-OSS-20B by default, configurable via AI_MODEL).
// Handles both streaming (SSE) and non-streaming responses, and tolerates the
// different payload shapes Workers AI models emit (classic {response},
// OpenAI chat-completions chunks, and Responses-API style output items).

import { getConfig } from '../config.js';
import { addNeurons, estimateTokens } from '../utils/usage.js';

// Token usage reported by the model ({prompt_tokens, completion_tokens} or
// {input_tokens, output_tokens}); null when absent.
export function extractUsage(obj) {
  const u = obj?.usage || obj?.response?.usage;
  if (!u || typeof u !== 'object') return null;
  const input = Number(u.prompt_tokens ?? u.input_tokens ?? 0);
  const output = Number(u.completion_tokens ?? u.output_tokens ?? 0);
  return input || output ? { input, output } : null;
}

function buildParams(cfg, messages, stream) {
  const params = {
    messages,
    stream,
    max_tokens: cfg.maxOutputTokens,
    temperature: cfg.temperature,
  };
  if (cfg.reasoningEffort) params.reasoning = { effort: cfg.reasoningEffort };
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
function recordGeneration(env, cfg, messages, usage, outputChars) {
  const input = usage?.input || estimateTokens(JSON.stringify(messages).length);
  const output = usage?.output || estimateTokens(outputChars) * 2;
  addNeurons(env.__usage, input, cfg.neuronsPerMInput);
  addNeurons(env.__usage, output, cfg.neuronsPerMOutput);
}

export async function* generateStream(env, messages) {
  const cfg = getConfig(env);
  const result = await env.AI.run(cfg.aiModel, buildParams(cfg, messages, true));
  let usage = null;
  let chars = 0;
  if (result && typeof result.getReader === 'function') {
    let any = false;
    for await (const d of iterateSse(result, (u) => { usage = u; })) { any = true; chars += d.length; yield d; }
    recordGeneration(env, cfg, messages, usage, chars);
    if (any) return;
    // Stream produced no visible text (e.g. unknown event format): retry once non-streaming.
  } else {
    const text = extractText(result);
    recordGeneration(env, cfg, messages, extractUsage(result), text.length);
    if (text) { yield text; return; }
  }
  const fallback = await env.AI.run(cfg.aiModel, buildParams(cfg, messages, false));
  const text = extractText(fallback);
  recordGeneration(env, cfg, messages, extractUsage(fallback), text.length);
  if (text) yield text;
}

export async function generate(env, messages) {
  const cfg = getConfig(env);
  const result = await env.AI.run(cfg.aiModel, buildParams(cfg, messages, false));
  return extractText(result);
}
