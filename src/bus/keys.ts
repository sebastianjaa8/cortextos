import { readFileSync, writeFileSync, existsSync, readdirSync, chmodSync } from 'fs';
import { join } from 'path';
import { randomBytes } from 'crypto';
import { resolveEnv } from '../utils/env.js';
import { ensureDir } from '../utils/atomic.js';
import { validateAgentName } from '../utils/validate.js';

// ---------------------------------------------------------------------------
// Per-agent HMAC signing keys — cryptographic sender attribution on the bus.
//
// Each agent gets its own 32-byte key at
//   <frameworkRoot>/orgs/<org>/agents/<name>/bus-signing-key
// so a message's signature can be verified against the CLAIMED sender's key,
// not the fleet-wide shared key.
//
// Residual-risk ceiling: all keys live on the same OS user's filesystem, so
// this gives attribution + accidental-spoof detection (e.g. the 'cortextos'
// unregistered-sender incident), NOT protection against a malicious local
// process that can read the key files. Asymmetric (Ed25519) keys would be
// needed for that — deliberately out of scope.
// ---------------------------------------------------------------------------

const KEY_FILENAME = 'bus-signing-key';

// ponytail: per-process cache — checkInbox polls every cycle for 14 agents;
// negative results are cached too, so a key provisioned mid-process needs a
// process restart (or clearAgentKeyCache) to be picked up.
const keyCache = new Map<string, string | null>();

/**
 * Generate (write-if-missing) an agent's signing key in its agent directory.
 * Idempotent by key-file existence: returns the existing key if present.
 */
export function generateAgentKey(agentDir: string): string {
  const keyPath = join(agentDir, KEY_FILENAME);
  if (existsSync(keyPath)) {
    return readFileSync(keyPath, 'utf-8').trim();
  }
  ensureDir(agentDir);
  const key = randomBytes(32).toString('hex');
  writeFileSync(keyPath, key, 'utf-8');
  try { chmodSync(keyPath, 0o600); } catch { /* best-effort — no-op on Windows */ }
  return key;
}

/**
 * Load the signing key for the named agent by scanning
 * <frameworkRoot>/orgs/<org>/agents/<name>/bus-signing-key across orgs.
 * Returns null when the framework root is unresolvable, the agent name is
 * invalid, or no key file exists (callers fall through to legacy handling).
 * Results (including misses) are cached per-process.
 */
export function loadAgentKey(agentName: string): string | null {
  const cached = keyCache.get(agentName);
  if (cached !== undefined) return cached;

  let key: string | null = null;
  try {
    validateAgentName(agentName);
    const { frameworkRoot } = resolveEnv();
    if (frameworkRoot) {
      const orgsDir = join(frameworkRoot, 'orgs');
      if (existsSync(orgsDir)) {
        for (const org of readdirSync(orgsDir)) {
          const keyPath = join(orgsDir, org, 'agents', agentName, KEY_FILENAME);
          if (existsSync(keyPath)) {
            const content = readFileSync(keyPath, 'utf-8').trim();
            if (content) {
              key = content;
              break;
            }
          }
        }
      }
    }
  } catch {
    key = null;
  }

  keyCache.set(agentName, key);
  return key;
}

/** Clear the per-process key cache (tests / re-provisioning). */
export function clearAgentKeyCache(): void {
  keyCache.clear();
}
