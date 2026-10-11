// Pins the desk's record to IPFS through Pinata (BORT's account: PINATA_API_KEY and
// PINATA_SECRET_API_KEY), so each agent's record can be fetched from the address its close anchor
// carries on chain, not only from our site. A pin that fails never holds up an anchor: the runner
// then anchors the plain label it always used.
'use strict';

const PIN_JSON_URL = 'https://api.pinata.cloud/pinning/pinJSONToIPFS';
const GATEWAY = 'https://gateway.pinata.cloud/ipfs/';
// A CID as Pinata returns it: v0 (Qm..., base58) or v1 (b..., base32).
const CID_RE = /^(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{50,})$/;

/** Pinata's keys from the environment, or null when either is missing (then nothing is pinned). */
function pinataFromEnv(env = process.env) {
  const key = env.PINATA_API_KEY;
  const secret = env.PINATA_SECRET_API_KEY;
  return key && secret ? { key, secret } : null;
}

/**
 * Pins one JSON document and returns its CID. Throws on any answer that is not a pin, so the caller
 * never anchors an address that points at nothing.
 */
async function pinJSON(keys, content, name, { fetchImpl = fetch, timeoutMs = 30_000 } = {}) {
  const res = await fetchImpl(PIN_JSON_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', pinata_api_key: keys.key, pinata_secret_api_key: keys.secret },
    body: JSON.stringify({ pinataContent: content, pinataMetadata: { name }, pinataOptions: { cidVersion: 1 } }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Pinata answered ${res.status}: ${text.slice(0, 200)}`);
  let cid = null;
  try { cid = JSON.parse(text).IpfsHash; } catch { /* reported below */ }
  if (typeof cid !== 'string' || !CID_RE.test(cid)) throw new Error(`Pinata returned no CID: ${text.slice(0, 200)}`);
  return cid;
}

/** A gateway link for an ipfs:// address (or a bare CID). */
const gatewayUrl = (uri) => `${GATEWAY}${String(uri).replace(/^ipfs:\/\//, '')}`;

module.exports = { pinataFromEnv, pinJSON, gatewayUrl, CID_RE, GATEWAY };
