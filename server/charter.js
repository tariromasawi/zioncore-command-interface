/**
 * Genesis-led operational charter loader.
 */
const fs = require('fs');
const path = require('path');

const CHARTER_PATH = path.join(__dirname, '..', 'config', 'operational-charter.json');
const GENESIS_PATH = path.join(__dirname, '..', 'Genesis seed.ts');

let cachedCharter = null;

function loadCharter() {
  if (cachedCharter) return cachedCharter;
  try {
    const raw = fs.readFileSync(CHARTER_PATH, 'utf8');
    cachedCharter = JSON.parse(raw);
    console.log(`[charter] Loaded operational charter ${cachedCharter.charterVersion} (genesis ${cachedCharter.genesisVersion})`);
    return cachedCharter;
  } catch (err) {
    cachedCharter = {
      charterVersion: 'fallback-0.0.0',
      genesisVersion: null,
      creed: 'Mwari ndi Mwari',
      loadError: err.message
    };
    return cachedCharter;
  }
}

function getCharterVersion() {
  return loadCharter().charterVersion || null;
}

function getGenesisVersion() {
  return loadCharter().genesisVersion || null;
}

module.exports = { loadCharter, getCharterVersion, getGenesisVersion, CHARTER_PATH };
