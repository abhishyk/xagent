// Embedding wrapper. Model-independent: model id and dimensions come from config,
// and the response parser accepts the shapes Workers AI embedding models return.

import { getConfig } from '../config.js';
import { addNeurons, estimateTokens } from '../utils/usage.js';

export function extractVectors(result) {
  if (!result) return [];
  if (Array.isArray(result.data)) {
    // {data: [[...], ...]}  or OpenAI-style {data: [{embedding: [...]}, ...]}
    return result.data.map((d) => (Array.isArray(d) ? d : d?.embedding)).filter(Array.isArray);
  }
  if (Array.isArray(result.response)) return result.response; // some models
  if (Array.isArray(result.embeddings)) return result.embeddings;
  return [];
}

export async function embedTexts(env, texts) {
  const cfg = getConfig(env);
  if (!texts.length) return [];
  const result = await env.AI.run(cfg.embeddingModel, { text: texts });
  addNeurons(env.__usage, estimateTokens(texts.reduce((n, t) => n + t.length, 0)), cfg.neuronsPerMEmbedding);
  const vectors = extractVectors(result);
  if (vectors.length !== texts.length) {
    throw new Error(`Embedding model returned ${vectors.length} vectors for ${texts.length} inputs`);
  }
  for (const v of vectors) {
    if (v.length !== cfg.embeddingDimensions) {
      throw new Error(`Embedding dimension ${v.length} does not match EMBEDDING_DIMENSIONS=${cfg.embeddingDimensions}`);
    }
  }
  return vectors;
}

export async function embedQuery(env, text) {
  const [v] = await embedTexts(env, [text]);
  return v;
}
