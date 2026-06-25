#!/usr/bin/env node
/**
 * OmniRouter — Claude API fallback proxy for the cortextOS SEB_company fleet.
 *
 * Listens on localhost:20128 and transparently proxies Anthropic API traffic.
 * Implements a DIRECT -> FALLBACK -> RECOVERING state machine so that when the
 * primary API key starts returning rate-limit / overload / server errors, the
 * fleet transparently fails over to a secondary (fallback) API key, then
 * probes the primary and recovers automatically.
 *
 * No external npm dependencies — Node.js built-ins only (http, https, fs, url).
 *
 * Config is read from scripts/omni-router/.env (see .env.example). The operator
 * pre-populates that file from Infisical (key: Claude_Daemon_Fallback_APIKEY).
 * This process never makes live Infisical API calls.
 */

'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Config loading (.env parser — no dotenv dependency)
// ---------------------------------------------------------------------------

/**
 * Minimal .env parser. Supports KEY=VALUE lines, # comments, and surrounding
 * single/double quotes. Lines without '=' are ignored.
 * @param {string} filePath
 * @returns {Record<string,string>}
 */
function parseEnvFile(filePath) {
  const out = {};
  if (!fs.existsSync(filePath)) return out;
  const raw = fs.readFileSync(filePath, 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

const ENV_PATH = path.join(__dirname, '.env');
const fileEnv = parseEnvFile(ENV_PATH);

// process.env wins over file (so PM2 / shell overrides are honored), file fills gaps.
function cfg(key, fallback) {
  if (process.env[key] !== undefined && process.env[key] !== '') return process.env[key];
  if (fileEnv[key] !== undefined && fileEnv[key] !== '') return fileEnv[key];
  return fallback;
}

const CONFIG = {
  port: parseInt(cfg('OMNIROUTER_PORT', '20128'), 10),
  host: cfg('OMNIROUTER_HOST', '127.0.0.1'),
  upstreamHost: cfg('UPSTREAM_HOST', 'api.anthropic.com'),
  upstreamPort: parseInt(cfg('UPSTREAM_PORT', '443'), 10),
  primaryKey: cfg('ANTHROPIC_API_KEY', ''),
  fallbackKey: cfg('FALLBACK_API_KEY', ''),
  // Status codes that trigger a DIRECT -> FALLBACK transition.
  triggerCodes: cfg('FALLBACK_TRIGGER_CODES', '429,529,500,502,503,504')
    .split(',')
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => !Number.isNaN(n)),
  // How long to stay in FALLBACK before entering RECOVERING (ms).
  fallbackHoldMs: parseInt(cfg('FALLBACK_HOLD_MS', '60000'), 10),
  // While RECOVERING, probe the primary every N ms.
  recoveryProbeIntervalMs: parseInt(cfg('RECOVERY_PROBE_INTERVAL_MS', '15000'), 10),
  // Probe request timeout (ms).
  recoveryProbeTimeoutMs: parseInt(cfg('RECOVERY_PROBE_TIMEOUT_MS', '10000'), 10),
  // Consecutive trigger responses required before flipping to FALLBACK.
  failuresToTrip: parseInt(cfg('FAILURES_TO_TRIP', '2'), 10),
};

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------

const STATES = Object.freeze({
  DIRECT: 'DIRECT',
  FALLBACK: 'FALLBACK',
  RECOVERING: 'RECOVERING',
});

const state = {
  current: STATES.DIRECT,
  startedAt: Date.now(),
  enteredStateAt: Date.now(),
  consecutiveFailures: 0,
  fallbackTimer: null,
  probeTimer: null,
  transitions: [], // { from, to, reason, ts }
};

function ts() {
  return new Date().toISOString();
}

function log(...args) {
  process.stdout.write(`[${ts()}] [omni-router] ${args.join(' ')}\n`);
}

/**
 * Transition the state machine. Centralizes logging + timer lifecycle.
 * @param {string} to  one of STATES
 * @param {string} reason
 */
function transition(to, reason) {
  if (state.current === to) return;
  const from = state.current;
  state.current = to;
  state.enteredStateAt = Date.now();
  state.transitions.push({ from, to, reason, ts: ts() });
  if (state.transitions.length > 200) state.transitions.shift();
  log(`STATE ${from} -> ${to} (${reason})`);

  // Clear any pending timers; each state sets up its own.
  clearTimers();

  if (to === STATES.FALLBACK) {
    state.consecutiveFailures = 0;
    // After holding in FALLBACK, begin probing the primary.
    state.fallbackTimer = setTimeout(() => {
      transition(STATES.RECOVERING, `held in FALLBACK for ${CONFIG.fallbackHoldMs}ms`);
    }, CONFIG.fallbackHoldMs);
    if (typeof state.fallbackTimer.unref === 'function') state.fallbackTimer.unref();
  } else if (to === STATES.RECOVERING) {
    scheduleProbe();
  } else if (to === STATES.DIRECT) {
    state.consecutiveFailures = 0;
  }
}

function clearTimers() {
  if (state.fallbackTimer) {
    clearTimeout(state.fallbackTimer);
    state.fallbackTimer = null;
  }
  if (state.probeTimer) {
    clearTimeout(state.probeTimer);
    state.probeTimer = null;
  }
}

/**
 * Which API key to use for the active state.
 * @returns {string}
 */
function activeKey() {
  if (state.current === STATES.FALLBACK) return CONFIG.fallbackKey || CONFIG.primaryKey;
  // DIRECT and RECOVERING serve live traffic on the primary key. (RECOVERING
  // means "primary looks healthy again" once a probe succeeds; until then we
  // already flipped to FALLBACK, so RECOVERING continues on fallback key for
  // live traffic while probing primary out-of-band.)
  if (state.current === STATES.RECOVERING) return CONFIG.fallbackKey || CONFIG.primaryKey;
  return CONFIG.primaryKey;
}

function isTriggerCode(statusCode) {
  return CONFIG.triggerCodes.includes(statusCode);
}

// ---------------------------------------------------------------------------
// Recovery probe — pings the primary key against the upstream out-of-band.
// ---------------------------------------------------------------------------

function scheduleProbe() {
  state.probeTimer = setTimeout(runProbe, CONFIG.recoveryProbeIntervalMs);
  if (typeof state.probeTimer.unref === 'function') state.probeTimer.unref();
}

/**
 * Lightweight probe: a minimal /v1/messages POST with the primary key.
 * A 200 means primary is healthy -> recover to DIRECT. A trigger code means
 * still degraded -> keep probing. Any other code (e.g. 400) still proves the
 * endpoint+key reach Anthropic, so we treat non-trigger as healthy.
 */
function runProbe() {
  if (state.current !== STATES.RECOVERING) return;

  const body = JSON.stringify({
    model: 'claude-3-5-haiku-20241022',
    max_tokens: 1,
    messages: [{ role: 'user', content: 'ping' }],
  });

  const req = https.request(
    {
      host: CONFIG.upstreamHost,
      port: CONFIG.upstreamPort,
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
        'x-api-key': CONFIG.primaryKey,
        'anthropic-version': '2023-06-01',
      },
      timeout: CONFIG.recoveryProbeTimeoutMs,
    },
    (res) => {
      // Drain so the socket frees.
      res.on('data', () => {});
      res.on('end', () => {
        if (state.current !== STATES.RECOVERING) return;
        if (!isTriggerCode(res.statusCode)) {
          transition(STATES.DIRECT, `probe healthy (HTTP ${res.statusCode})`);
        } else {
          log(`probe still degraded (HTTP ${res.statusCode}); will retry`);
          scheduleProbe();
        }
      });
    }
  );

  req.on('timeout', () => {
    req.destroy(new Error('probe timeout'));
  });

  req.on('error', (err) => {
    if (state.current !== STATES.RECOVERING) return;
    log(`probe error (${err.message}); will retry`);
    scheduleProbe();
  });

  req.write(body);
  req.end();
}

// ---------------------------------------------------------------------------
// HTTP server — health endpoint + transparent proxy.
// ---------------------------------------------------------------------------

function handleHealth(res) {
  const payload = {
    state: state.current,
    uptime: Math.round((Date.now() - state.startedAt) / 1000),
    inStateMs: Date.now() - state.enteredStateAt,
    consecutiveFailures: state.consecutiveFailures,
    upstream: `${CONFIG.upstreamHost}:${CONFIG.upstreamPort}`,
    primaryKeyConfigured: Boolean(CONFIG.primaryKey),
    fallbackKeyConfigured: Boolean(CONFIG.fallbackKey),
    recentTransitions: state.transitions.slice(-5),
  };
  const json = JSON.stringify(payload);
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(json);
}

/**
 * Proxy a single client request to the Anthropic upstream, injecting the
 * active API key and observing the response status for state transitions.
 * @param {http.IncomingMessage} clientReq
 * @param {http.ServerResponse} clientRes
 */
function handleProxy(clientReq, clientRes) {
  const key = activeKey();

  // Clone headers, then force the active key onto the standard auth headers.
  const headers = Object.assign({}, clientReq.headers);
  // Anthropic uses x-api-key. Some clients send Authorization: Bearer; normalize.
  delete headers['authorization'];
  headers['x-api-key'] = key;
  // host header must point at the real upstream, not localhost:20128.
  headers['host'] = CONFIG.upstreamHost;
  // Hop-by-hop headers should not be forwarded blindly; drop a couple.
  delete headers['connection'];
  delete headers['proxy-connection'];

  const upstreamReq = https.request(
    {
      host: CONFIG.upstreamHost,
      port: CONFIG.upstreamPort,
      path: clientReq.url,
      method: clientReq.method,
      headers,
    },
    (upstreamRes) => {
      const status = upstreamRes.statusCode;

      // Observe status for state machine (only meaningful while live on primary).
      if (state.current === STATES.DIRECT) {
        if (isTriggerCode(status)) {
          state.consecutiveFailures += 1;
          log(`DIRECT saw HTTP ${status} (${state.consecutiveFailures}/${CONFIG.failuresToTrip})`);
          if (state.consecutiveFailures >= CONFIG.failuresToTrip) {
            transition(STATES.FALLBACK, `${state.consecutiveFailures}x trigger code (last HTTP ${status})`);
          }
        } else if (status < 400) {
          state.consecutiveFailures = 0;
        }
      }

      clientRes.writeHead(status, upstreamRes.headers);
      upstreamRes.pipe(clientRes);
    }
  );

  upstreamReq.on('error', (err) => {
    log(`upstream error: ${err.message}`);
    if (state.current === STATES.DIRECT) {
      state.consecutiveFailures += 1;
      if (state.consecutiveFailures >= CONFIG.failuresToTrip) {
        transition(STATES.FALLBACK, `upstream network error: ${err.message}`);
      }
    }
    if (!clientRes.headersSent) {
      clientRes.writeHead(502, { 'content-type': 'application/json' });
    }
    clientRes.end(JSON.stringify({ error: 'omni-router upstream error', detail: err.message }));
  });

  clientReq.pipe(upstreamReq);
}

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && (req.url === '/health' || req.url === '/healthz')) {
    return handleHealth(res);
  }
  return handleProxy(req, res);
});

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

function start() {
  if (!CONFIG.primaryKey) {
    log('WARNING: ANTHROPIC_API_KEY (primary) is empty — proxy will forward requests with an empty key.');
  }
  if (!CONFIG.fallbackKey) {
    log('WARNING: FALLBACK_API_KEY is empty — FALLBACK state will reuse the primary key. Populate .env from Infisical (Claude_Daemon_Fallback_APIKEY).');
  }
  server.listen(CONFIG.port, CONFIG.host, () => {
    log(`listening on http://${CONFIG.host}:${CONFIG.port} -> https://${CONFIG.upstreamHost}:${CONFIG.upstreamPort}`);
    log(`state=${state.current} triggerCodes=[${CONFIG.triggerCodes.join(',')}] failuresToTrip=${CONFIG.failuresToTrip} fallbackHoldMs=${CONFIG.fallbackHoldMs} probeIntervalMs=${CONFIG.recoveryProbeIntervalMs}`);
  });
  return server;
}

function shutdown(signal) {
  log(`received ${signal}, shutting down gracefully`);
  clearTimers();
  server.close(() => {
    log('server closed');
    process.exit(0);
  });
  // Force-exit if connections hang.
  const t = setTimeout(() => {
    log('forced exit after grace period');
    process.exit(0);
  }, 5000);
  if (typeof t.unref === 'function') t.unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Export internals for the test harness; only auto-start when run directly.
module.exports = {
  CONFIG,
  STATES,
  state,
  transition,
  isTriggerCode,
  activeKey,
  parseEnvFile,
  server,
  start,
  shutdown,
};

if (require.main === module) {
  start();
}
