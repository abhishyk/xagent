// Central, typed access to configuration. Every tunable comes from wrangler.jsonc
// "vars" (or secrets) so models/limits can change without code changes.

const int = (v, d) => {
  const n = parseInt(v ?? '', 10);
  return Number.isFinite(n) ? n : d;
};
const num = (v, d) => {
  const n = parseFloat(v ?? '');
  return Number.isFinite(n) ? n : d;
};

export function getConfig(env) {
  return {
    appName: env.APP_NAME || 'xagent',
    aiModel: env.AI_MODEL || '@cf/openai/gpt-oss-20b',
    embeddingModel: env.EMBEDDING_MODEL || '@cf/baai/bge-m3',
    embeddingDimensions: int(env.EMBEDDING_DIMENSIONS, 1024),
    reasoningEffort: (env.REASONING_EFFORT || '').trim(), // '', 'low', 'medium', 'high'
    maxOutputTokens: int(env.MAX_OUTPUT_TOKENS, 2048),
    temperature: num(env.TEMPERATURE, 0.3),

    topK: Math.min(Math.max(int(env.TOP_K, 6), 1), 20),
    minSimilarity: num(env.MIN_SIMILARITY, 0.40),
    maxContextChars: int(env.MAX_CONTEXT_CHARS ?? env.MAX_CONTEXT_SIZE, 14000),
    maxContextTokens: int(env.MAX_CONTEXT_TOKENS, 4000),

    maxMessageLength: int(env.MAX_MESSAGE_LENGTH, 12000),
    maxHistoryMessages: int(env.MAX_HISTORY_MESSAGES, 8),
    dailyAiLimit: int(env.DAILY_AI_LIMIT, 50),
    chatRatePerMinute: int(env.CHAT_RATE_LIMIT_PER_MINUTE, 8),

    sessionHours: num(env.SESSION_DURATION, 12),
    passwordIterations: Math.min(int(env.PASSWORD_ITERATIONS, 100000), 100000),

    chunkSize: int(env.CHUNK_SIZE, 1800),
    chunkOverlap: int(env.CHUNK_OVERLAP, 200),
    embedBatchSize: Math.max(1, int(env.EMBED_BATCH_SIZE, 20)),
    maxEmbedPerStep: Math.max(1, int(env.MAX_EMBED_PER_STEP, 60)),

    // Free-tier limits shown on the admin dashboard (Cloudflare Workers Free plan;
    // all reset daily at 00:00 UTC). Override via vars if Cloudflare changes them.
    freeNeuronsPerDay: int(env.FREE_NEURONS_PER_DAY, 10000),
    freeD1RowsReadPerDay: int(env.FREE_D1_ROWS_READ_PER_DAY, 5000000),
    freeD1RowsWrittenPerDay: int(env.FREE_D1_ROWS_WRITTEN_PER_DAY, 100000),
    freeD1StorageBytes: int(env.FREE_D1_STORAGE_BYTES, 5 * 1024 ** 3),
    // Neurons per 1M tokens (Cloudflare pricing page): gpt-oss-20b in/out, bge-m3.
    neuronsPerMInput: num(env.AI_NEURONS_PER_M_INPUT, 18182),
    neuronsPerMOutput: num(env.AI_NEURONS_PER_M_OUTPUT, 27273),
    neuronsPerMEmbedding: num(env.EMBEDDING_NEURONS_PER_M, 1075),

    loginMaxFailures: 5,
    loginWindowMinutes: 15,
    maxBodyBytes: 64 * 1024,
  };
}

export const DOCUMENT_TYPES = [
  'handbook',
  'source_code',
  'configuration',
  'troubleshooting',
  'installation',
  'networking',
  'pxe',
  'os',
  'deployment',
];

// Spec §51: current source code > specific technical docs > general handbook.
// Small additive boosts applied to the similarity score during ranking.
export const TYPE_PRIORITY_BOOST = {
  source_code: 0.04,
  configuration: 0.025,
  troubleshooting: 0.02,
  installation: 0.02,
  networking: 0.02,
  pxe: 0.02,
  deployment: 0.02,
  os: 0.015,
  handbook: 0,
};
