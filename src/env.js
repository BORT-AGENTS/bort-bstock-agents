// Environment for every script: .env, then any files ENV_FILE names (comma-separated), so a key is
// read where it already lives (e.g. an existing project's .env) instead of being copied. Values
// already set win: the shell, then .env, then ENV_FILE in order.
'use strict';

function loadEnv() {
  for (const file of ['.env', ...(process.env.ENV_FILE || '').split(',').map((f) => f.trim()).filter(Boolean)]) {
    try {
      process.loadEnvFile(file);
    } catch {
      // a missing file is fine: tests need none of it
    }
  }
}

/** The deploy key: DEPLOYER_KEY, or BORT's DEPLOYER_PRIVATE_KEY. */
const deployerKey = () => process.env.DEPLOYER_KEY || process.env.DEPLOYER_PRIVATE_KEY || null;

/** The relayer's key: RELAYER_KEY, or BORT's RUNTIME_PRIVATE_KEY (the runtime signer). */
const relayerKey = () => process.env.RELAYER_KEY || process.env.RUNTIME_PRIVATE_KEY || null;

module.exports = { loadEnv, deployerKey, relayerKey };
