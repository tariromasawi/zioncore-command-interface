const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const SEED_PATH = path.join(__dirname, '..', '..', 'Genesis seed.ts');
let canonicalSeed = null;
let seedMeta = null;
function loadCanonicalSeed() {
  if (canonicalSeed !== null) return seedMeta;
  const text = fs.readFileSync(SEED_PATH, 'utf8');
  const sha256 = crypto.createHash('sha256').update(text, 'utf8').digest('hex');
  const versionMatch = text.match(/ZIONCORE_GENESIS_VERSION\s*=\s*['"]([^'"]+)['"]/);
  canonicalSeed = text;
  seedMeta = { version: versionMatch ? versionMatch[1] : 'unknown', sha256, bytes: Buffer.byteLength(text, 'utf8'), path: 'Genesis seed.ts' };
  return seedMeta;
}
function getFullSeedText() { loadCanonicalSeed(); return canonicalSeed; }
function getSeedMeta() { return loadCanonicalSeed(); }
function buildMessages(opts) {
  opts = opts || {};
  const seed = getFullSeedText();
  const meta = getSeedMeta();
  const system = seed + (opts.systemExtra ? '\n\n' + opts.systemExtra : '');
  return {
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: [opts.userTask || '', opts.taskInput || ''].filter(Boolean).join('\n\n') }
    ],
    seedVersion: meta.version,
    seedSha256: meta.sha256,
    seedBytes: meta.bytes
  };
}
const AI_POLICY = {
  defaultSpendCapGBP: 0,
  paidRoutingEnabled: false,
  freeAllowlist: [],
  paidAllowlist: [],
  secretName: 'zioncore-command-ai-provider-key',
  note: 'Paid AI disabled until key + spend limit configured. Deterministic engines continue without models.'
};
async function dispatchModelRequest(opts) {
  const built = buildMessages(opts || {});
  const seed = getFullSeedText();
  const sys = built.messages[0].content;
  if (!sys.startsWith(seed.slice(0, 64)) || !sys.includes(seed.slice(-64))) {
    throw new Error('Genesis Seed inclusion check failed');
  }
  if (sys.length < seed.length) throw new Error('Genesis Seed was truncated');
  return {
    blocked: true,
    record: {
      at: new Date().toISOString(),
      seedVersion: built.seedVersion,
      seedSha256: built.seedSha256,
      seedBytes: built.seedBytes,
      fullSeedAttached: true,
      seedExactLength: sys.length,
      route: 'blocked',
      reason: 'Paid routing disabled; free allowlist empty until capacity verified',
      estimatedMaxCostGBP: 0
    }
  };
}
module.exports = { loadCanonicalSeed, getFullSeedText, getSeedMeta, buildMessages, dispatchModelRequest, AI_POLICY };
