#!/usr/bin/env node
/**
 * OmniRouter test harness — no test framework, run with: node test.js
 *
 * Spins up a mock "Anthropic" upstream HTTP server whose responses we control,
 * points the proxy at it (via env overrides), and asserts:
 *   1. proxy starts and /health returns 200 JSON {state, uptime}
 *   2. DIRECT forwards to upstream and uses the primary key
 *   3. repeated trigger codes flip DIRECT -> FALLBACK and switch to fallback key
 *   4. FALLBACK -> RECOVERING after the hold window, then -> DIRECT when probe is healthy
 *   5. graceful shutdown on shutdown()
 *
 * The mock upstream is plain http (the proxy is pointed at it via UPSTREAM_HOST/
 * UPSTREAM_PORT and we monkeypatch https->http for the test), so no real network
 * calls to api.anthropic.com are made.
 */

'use strict';

const http = require('http');
const https = require('https');
const assert = require('assert');

// ---------------------------------------------------------------------------
// Test config — set BEFORE requiring proxy.js so its CONFIG picks these up.
// ---------------------------------------------------------------------------

const MOCK_PORT = 20991;
const PROXY_PORT = 20992;

process.env.OMNIROUTER_PORT = String(PROXY_PORT);
process.env.OMNIROUTER_HOST = '127.0.0.1';
process.env.UPSTREAM_HOST = '127.0.0.1';
process.env.UPSTREAM_PORT = String(MOCK_PORT);
process.env.ANTHROPIC_API_KEY = 'sk-ant-PRIMARY-TEST';
process.env.FALLBACK_API_KEY = 'sk-ant-FALLBACK-TEST';
process.env.FALLBACK_TRIGGER_CODES = '429,529,503';
process.env.FAILURES_TO_TRIP = '2';
process.env.FALLBACK_HOLD_MS = '300'; // short so the test runs fast
process.env.RECOVERY_PROBE_INTERVAL_MS = '100';
process.env.RECOVERY_PROBE_TIMEOUT_MS = '2000';

// Monkeypatch https.request -> http.request so the proxy talks to our mock
// upstream over plain HTTP (the mock has no TLS cert). proxy.js uses https for
// both proxying and probing; this redirect keeps everything local + cleartext.
const originalHttpsRequest = https.request.bind(https);
https.request = function patched(options, cb) {
  // Force the http module against our mock; preserve options.
  return http.request(options, cb);
};

const proxy = require('./proxy');
const { STATES, state } = proxy;

// ---------------------------------------------------------------------------
// Mock upstream — behavior driven by `upstream.mode`.
// ---------------------------------------------------------------------------

const upstream = {
  mode: 'ok', // 'ok' | 'trigger' | 'probe-then-ok'
  lastApiKey: null,
  requestCount: 0,
};

const mockServer = http.createServer((req, res) => {
  upstream.requestCount += 1;
  upstream.lastApiKey = req.headers['x-api-key'] || null;

  // Drain body.
  req.on('data', () => {});
  req.on('end', () => {
    let status;
    if (upstream.mode === 'trigger') {
      status = 503;
    } else {
      status = 200;
    }
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: status === 200, via: 'mock-upstream' }));
  });
});

// ---------------------------------------------------------------------------
// Tiny test runner
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;

function ok(name) {
  passed += 1;
  console.log(`  PASS  ${name}`);
}
function bad(name, err) {
  failed += 1;
  console.log(`  FAIL  ${name}`);
  console.log(`        ${err && err.stack ? err.stack : err}`);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Make a request THROUGH the proxy to the (mock) upstream.
function proxyRequest(pathName = '/v1/messages', method = 'POST') {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: PROXY_PORT,
        path: pathName,
        method,
        headers: { 'content-type': 'application/json', 'x-api-key': 'client-sent-key' },
      },
      (res) => {
        let buf = '';
        res.on('data', (c) => (buf += c));
        res.on('end', () => resolve({ status: res.statusCode, body: buf }));
      }
    );
    req.on('error', reject);
    if (method !== 'GET') req.write(JSON.stringify({ model: 'x', messages: [] }));
    req.end();
  });
}

function getHealth() {
  return new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port: PROXY_PORT, path: '/health' }, (res) => {
        let buf = '';
        res.on('data', (c) => (buf += c));
        res.on('end', () => resolve({ status: res.statusCode, body: buf }));
      })
      .on('error', reject);
  });
}

// Wait until predicate true or timeout.
async function waitFor(predicate, timeoutMs = 3000, intervalMs = 50) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(intervalMs);
  }
  return false;
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

async function run() {
  console.log('OmniRouter tests\n');

  await new Promise((r) => mockServer.listen(MOCK_PORT, '127.0.0.1', r));
  proxy.start();
  await sleep(150);

  // Test 1: health endpoint
  try {
    const h = await getHealth();
    assert.strictEqual(h.status, 200, 'health status');
    const j = JSON.parse(h.body);
    assert.strictEqual(j.state, STATES.DIRECT, 'initial state DIRECT');
    assert.ok(typeof j.uptime === 'number', 'uptime is number');
    ok('health endpoint returns 200 JSON {state, uptime}');
  } catch (e) {
    bad('health endpoint returns 200 JSON {state, uptime}', e);
  }

  // Test 2: DIRECT forwards + uses primary key
  try {
    upstream.mode = 'ok';
    const r = await proxyRequest();
    assert.strictEqual(r.status, 200, 'forwarded 200');
    assert.strictEqual(upstream.lastApiKey, 'sk-ant-PRIMARY-TEST', 'primary key injected in DIRECT');
    assert.strictEqual(state.current, STATES.DIRECT, 'still DIRECT after success');
    ok('DIRECT forwards to upstream using primary key');
  } catch (e) {
    bad('DIRECT forwards to upstream using primary key', e);
  }

  // Test 3: trigger codes flip to FALLBACK + switch to fallback key
  try {
    upstream.mode = 'trigger'; // returns 503
    await proxyRequest(); // failure 1
    assert.strictEqual(state.current, STATES.DIRECT, 'one failure does not trip (failuresToTrip=2)');
    await proxyRequest(); // failure 2 -> trip
    const tripped = await waitFor(() => state.current === STATES.FALLBACK, 1000);
    assert.ok(tripped, 'flipped to FALLBACK after 2 trigger codes');

    // Next request should now carry the fallback key.
    upstream.mode = 'ok';
    await proxyRequest();
    assert.strictEqual(upstream.lastApiKey, 'sk-ant-FALLBACK-TEST', 'fallback key injected in FALLBACK');
    ok('repeated trigger codes flip DIRECT -> FALLBACK and switch key');
  } catch (e) {
    bad('repeated trigger codes flip DIRECT -> FALLBACK and switch key', e);
  }

  // Test 4: FALLBACK -> RECOVERING -> DIRECT (probe healthy)
  try {
    // Hold window is 300ms; wait for RECOVERING.
    const recovering = await waitFor(() => state.current === STATES.RECOVERING, 2000);
    assert.ok(recovering, 'entered RECOVERING after hold window');

    // Mock upstream healthy -> probe returns 200 -> recover to DIRECT.
    upstream.mode = 'ok';
    const recovered = await waitFor(() => state.current === STATES.DIRECT, 3000);
    assert.ok(recovered, 'recovered to DIRECT after healthy probe');
    ok('FALLBACK -> RECOVERING -> DIRECT on healthy probe');
  } catch (e) {
    bad('FALLBACK -> RECOVERING -> DIRECT on healthy probe', e);
  }

  // Test 5: transitions are logged with timestamps
  try {
    assert.ok(state.transitions.length >= 3, 'recorded multiple transitions');
    for (const t of state.transitions) {
      assert.ok(t.ts && !Number.isNaN(Date.parse(t.ts)), 'transition has ISO timestamp');
      assert.ok(t.from && t.to && t.reason, 'transition has from/to/reason');
    }
    ok('all state transitions recorded with timestamps + reasons');
  } catch (e) {
    bad('all state transitions recorded with timestamps + reasons', e);
  }

  // Test 6: graceful shutdown closes the server
  try {
    await new Promise((resolve, reject) => {
      proxy.server.close((err) => (err ? reject(err) : resolve()));
      // proxy.shutdown calls process.exit, so we close the server directly here
      // to assert it accepts close without hanging.
    });
    ok('server closes gracefully');
  } catch (e) {
    bad('server closes gracefully', e);
  }

  mockServer.close();
  https.request = originalHttpsRequest;

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

run().catch((e) => {
  console.error('test harness crashed:', e);
  process.exit(1);
});
