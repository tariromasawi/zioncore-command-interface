const { runEngine, runAllEngines } = require('./engines/jobs');
const { runArchiveMission } = require('./missions/archive-continuity');
const { loadCanonicalSeed, getSeedMeta } = require('./ai/modelGateway');
async function main() {
  const arg = process.argv[2] || 'high-freq-purification';
  loadCanonicalSeed();
  const meta = getSeedMeta();
  console.log(JSON.stringify({ event: 'job_start', arg, seed: meta, at: new Date().toISOString() }));
  let result;
  if (arg === 'all') result = runAllEngines();
  else if (arg === 'archive-incident') result = runArchiveMission({ forceDamage: true });
  else result = runEngine(arg);
  const ok = result && (result.ok === true || (typeof result === 'object' && !result.error));
  console.log(JSON.stringify({ event: 'job_end', ok, arg, at: new Date().toISOString() }));
  process.exit(ok ? 0 : 1);
}
main().catch(function(err) {
  console.error(JSON.stringify({ event: 'job_error', error: err.message }));
  process.exit(1);
});
