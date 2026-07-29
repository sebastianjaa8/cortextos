// Before/after for the Telegram connect fix, exercising the REAL src/telegram/api.ts
// code path (not a reimplementation of it), with no build and no messages sent.
//
// WHY NO BUILD: cortextos `dist` is symlinked into the global npm install, so
// `npm run build` publishes the working tree fleet-wide the instant it runs. That is
// a deploy, not a test, so the before/after is measured against source instead.
//
// WHY NO REAL TOKEN: with a dummy token, Telegram answers 401 Unauthorized. That
// response is itself proof the CONNECTION succeeded — which is the only thing this
// fix changes. So:
//     "Telegram API error: Unauthorized"  -> connected  (SUCCESS for our purposes)
//     "Telegram API request failed"       -> never connected (the bug)
// getMe is read-only, so nothing is created or sent anywhere.
//
// Fresh process per trial, because the fault is in connection establishment and each
// `cortextos bus send-telegram` is a fresh process. Measuring in one process reuses a
// keep-alive socket and undercounts by ~30x (learned the hard way earlier tonight).
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const SELF = fileURLToPath(import.meta.url);
const REPO = 'C:/Users/Sebas/cortextos';
const API = path.join(REPO, 'src/telegram/api.ts');

if (process.argv[2] === '--one') {
  const { TelegramAPI } = await import(`file:///${API.replace(/\\/g, '/')}`);
  const api = new TelegramAPI('111111:dummy-token-not-a-real-bot');
  try {
    await api.getMe();
    console.log('CONNECTED_OK_UNEXPECTED');
  } catch (e) {
    const m = e?.message || String(e);
    if (m.startsWith('Telegram API error')) console.log('CONNECTED');
    else console.log(`NOT_CONNECTED ${m.slice(0, 60)}`);
  }
  process.exit(0);
}

const TRIALS = Number(process.env.TRIALS || 12);

function batch(label, env) {
  let connected = 0;
  const tally = {};
  for (let i = 0; i < TRIALS; i++) {
    const r = spawnSync(process.execPath, ['--import', 'tsx', SELF, '--one'], {
      encoding: 'utf8',
      timeout: 60000,
      cwd: REPO,
      env: { ...process.env, ...env },
    });
    const line = (r.stdout || '').trim().split('\n').filter(Boolean).pop()
      || `SPAWN_ERR ${(r.stderr || '').trim().split('\n').pop() || r.error?.message}`;
    if (line === 'CONNECTED') connected++;
    else tally[line] = (tally[line] || 0) + 1;
  }
  const failed = TRIALS - connected;
  console.log(`${label.padEnd(40)} ${connected}/${TRIALS} connected  ${String(((failed / TRIALS) * 100).toFixed(0)).padStart(3)}% fail`);
  for (const [e, n] of Object.entries(tally)) console.log(`    ${n}x ${e}`);
  return { connected, failed, TRIALS };
}

console.log(`real code path: ${API}`);
console.log(`fresh process per trial, TRIALS=${TRIALS}, getMe with a dummy token (no sends)\n`);

// BEFORE: the env opt-out disables the tuning, so this reproduces pre-fix behaviour
// through the very same source file. Retry still applies, which is the honest
// "retry alone" arm.
const before = batch('BEFORE (net tuning off, retry on)', { CORTEXTOS_TELEGRAM_NET_TUNING: 'off' });
// AFTER: tuning + retry, i.e. what ships.
const after = batch('AFTER  (tuning + retry, as shipped)', {});

console.log('\nRESULT:');
console.log(`  before ${before.failed}/${before.TRIALS} failed, after ${after.failed}/${after.TRIALS} failed`);
if (after.failed === 0 && before.failed > 0) {
  console.log('  Fix confirmed on the real code path.');
} else if (after.failed === 0 && before.failed === 0) {
  console.log('  INCONCLUSIVE: retry alone also held this window. Not disproof — the');
  console.log('  underlying race is intermittent — but do not claim the tuning was needed');
  console.log('  from this run alone.');
} else if (after.failed > 0) {
  console.log('  NOT fully fixed. Report the residue rather than the improvement.');
}
