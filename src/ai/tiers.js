// Model tiers by how much of today's free Workers AI budget is left:
//   more than MID_AT_REMAINING_PCT (30%) left  -> main  (GPT-OSS-20B, best answers)
//   30% … 10% left                             -> mid   (Qwen3-30B, ~2.5x cheaper, still good)
//   10% or less left                           -> saver (Granite 4.0 Micro, ~7x cheaper)
// Set MID_AI_MODEL / SAVER_AI_MODEL to "off" to skip a tier.

const enabled = (m) => Boolean(m) && m !== 'off';

export function tierInfo(cfg, tier) {
  if (tier === 'saver' && enabled(cfg.saverModel)) {
    return { tier, model: cfg.saverModel, inRate: cfg.saverNeuronsPerMInput, outRate: cfg.saverNeuronsPerMOutput, outMultiplier: 1, typical: 25 };
  }
  if (tier === 'mid' && enabled(cfg.midModel)) {
    return { tier, model: cfg.midModel, inRate: cfg.midNeuronsPerMInput, outRate: cfg.midNeuronsPerMOutput, outMultiplier: 1.5, typical: 70 };
  }
  return { tier: 'main', model: cfg.aiModel, inRate: cfg.neuronsPerMInput, outRate: cfg.neuronsPerMOutput, outMultiplier: 2, typical: 150 };
}

export function chooseTier(cfg, neuronsUsed) {
  if (!(cfg.freeNeuronsPerDay > 0)) return 'main';
  const leftPct = ((cfg.freeNeuronsPerDay - neuronsUsed) / cfg.freeNeuronsPerDay) * 100;
  if (enabled(cfg.saverModel) && leftPct <= cfg.saverAtRemainingPct) return 'saver';
  if (enabled(cfg.midModel) && leftPct <= cfg.midAtRemainingPct) return 'mid';
  return 'main';
}
