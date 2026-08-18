#!/usr/bin/env node
// Reads a producer-attributed delivery journal and answers "did THIS specific recurring
// send go out on THIS date" with a THREE-WAY verdict, not two.
//
// WHY THIS EXISTS (task_1785722971327). outbound-deliveries.jsonl already records every send
// attempt, but every row carries `source` (the TRANSPORT, e.g. cli:send-telegram) not WHAT
// triggered it -- a regex on message text is the only fallback, and titles vary run to run
// ("Croncheck alert" one day, "Vault log rotation" the next). The morning-brief cron now passes
// --producer morning-brief (src/cli/bus.ts), which lands a `producer` field on the row. This
// script is the reader half.
//
// TWO-VALUED WOULD BE WRONG. Collapsing "the producer field isn't live yet" (UNKNOWN) into "it
// genuinely didn't send" (ABSENT) makes every day before rollout read as a missed brief -- and
// rollout day is exactly when someone decides a new check is broken and stops reading it. This
// exact three-state shape (UNKNOWN distinct from ABSENT distinct from CONFIRMED) has now
// recurred four independent times in this fleet in two days (this task's own history) -- it is
// a design-time question, not a discovery, for every instrument built after this one too.
//
// A CONFIRMED verdict is NOT a success verdict -- it means "the row exists", and the row's own
// `state` field (delivering/accepted/retryable/dead-letter) says whether the send worked. A
// dead-letter row for the target producer must read as CONFIRMED-with-failure, never as ABSENT:
// collapsing "we know it failed" into "we don't know if it ran" throws away the one signal a
// failed send actually left behind.
//
// STATED LIMITATION (Codex review, 2026-08-18): the UNKNOWN check is "does ANY row this date
// carry a producer field", not "does any row for THIS producer". A day that mixes an untagged
// pre-rollout send with a tagged send from a different producer will read ABSENT rather than
// UNKNOWN for a producer that was simply never live that day. This is the task's own originally
// specified heuristic (day-wide, not producer-specific) -- narrower detection would need a
// per-producer rollout watermark, not built here. Rare in practice (rollout is a one-time event
// per producer, not a recurring ambiguity) but real; noted rather than silently left.
//
//   node scripts/check-brief-delivery.mjs <producer> [--date YYYY-MM-DD] [--agent seb_boss]
//   node scripts/check-brief-delivery.mjs --self-test
//
// exit 0 CONFIRMED-accepted · 1 ABSENT or CONFIRMED-failed · 2 UNKNOWN (feature not live that day) · 3 could not run
import { existsSync, readFileSync } from 'node:fs';

const CTX_ROOT = (process.env.CTX_ROOT || `${process.env.HOME}/.cortextos/default`).replace(/\\/g, '/');

/**
 * Pure verdict logic so --self-test can drive it without touching disk.
 * @param {Array<{producer?:string, state:string, message_id?:number, timestamp:string, error?:string}>} rows
 *   every delivery row for the target agent+date (already filtered to the date by the caller)
 * @param {string} producer the logical send we're checking for, e.g. 'morning-brief'
 * @returns {{code:0|1|2, status:string, detail:string}}
 */
export function verdict(rows, producer) {
  const anyProducerField = rows.some((r) => r.producer !== undefined);
  if (!anyProducerField) {
    return {
      code: 2, status: 'UNKNOWN',
      detail: `no row this date carries a producer field at all -- the feature is not live yet ` +
        `for this date, not evidence that '${producer}' failed to send.`,
    };
  }
  const matches = rows.filter((r) => r.producer === producer);
  if (matches.length === 0) {
    return {
      code: 1, status: 'ABSENT',
      detail: `producer field is live this date (other rows carry it) but no row names ` +
        `'${producer}' -- it genuinely did not send.`,
    };
  }
  // Every attempt writes 'delivering' FIRST and its terminal outcome (accepted/retryable/
  // dead-letter) SECOND (src/cli/bus.ts's journal() closure) -- both rows share the same
  // producer. `.find()`-first would return the 'delivering' row and never see the outcome that
  // follows it, misreporting every successful send as a failure. Prefer the terminal row.
  const terminal = matches.filter((r) => r.state !== 'delivering');
  if (terminal.length === 0) {
    // Every matching row is still 'delivering' -- the send is in progress, or the process died
    // between the 'delivering' write and the terminal write. Not a failure (nothing failed yet)
    // and not confirmed success either -- a third, honest "don't know yet" reading.
    return {
      code: 2, status: 'IN-FLIGHT',
      detail: `'${producer}' row(s) exist but never reached a terminal state (still ` +
        `'delivering') -- the send may be in progress, or the process died mid-send.`,
    };
  }
  const match = terminal[terminal.length - 1]; // most recent terminal outcome for this producer
  if (match.state === 'accepted') {
    return {
      code: 0, status: 'CONFIRMED',
      detail: `'${producer}' sent and accepted at ${match.timestamp}` +
        (match.message_id ? `, message_id=${match.message_id}.` : ' (no message_id recorded).'),
    };
  }
  // state is retryable / dead-letter: the row exists, so this is NOT absence -- it is a
  // confirmed, named failure. Reporting this as ABSENT would discard the one thing the failed
  // send actually told us.
  return {
    code: 1, status: 'CONFIRMED-FAILED',
    detail: `'${producer}' row exists at ${match.timestamp} but state='${match.state}'` +
      (match.error ? ` (${match.error})` : '') + ' -- it did not reach Telegram.',
  };
}

function selfTest() {
  const base = { agent: 'seb_boss', chat_id: '1', kind: 'message', attempts: 1, preview: 'x' };
  const otherRow = { ...base, timestamp: '2026-08-18T11:00:00Z', producer: 'daily-hygiene', state: 'accepted' };
  const briefAccepted = { ...base, timestamp: '2026-08-18T11:03:19Z', producer: 'morning-brief', state: 'accepted', message_id: 9820 };
  const briefDeadLetter = { ...base, timestamp: '2026-08-18T11:03:19Z', producer: 'morning-brief', state: 'dead-letter', error: 'Bad Request: chat not found' };
  const noProducerRow = { ...base, timestamp: '2026-08-18T09:00:00Z', state: 'accepted' }; // pre-rollout row, no producer key at all
  // THE REAL LIFECYCLE: every attempt writes 'delivering' first, terminal state second, same
  // producer on both rows (this is what src/cli/bus.ts's journal() closure actually emits).
  const briefDelivering = { ...base, timestamp: '2026-08-18T11:03:18Z', producer: 'morning-brief', state: 'delivering' };
  const briefDeadLetterAfterDelivering = { ...base, timestamp: '2026-08-18T11:03:20Z', producer: 'morning-brief', state: 'dead-letter', error: 'Bad Request: chat not found' };

  const cases = [
    // --- THE THIRD STATE: no producer field anywhere this date reads as UNKNOWN, not ABSENT ---
    ['no producer field on any row this date is UNKNOWN, not ABSENT', () =>
      verdict([noProducerRow], 'morning-brief').status === 'UNKNOWN'],
    ['UNKNOWN carries exit code 2 (distinct from both ABSENT and CONFIRMED)', () =>
      verdict([noProducerRow], 'morning-brief').code === 2],

    // --- CONTROL for the pair above: mixing in ONE producer-bearing row anywhere flips the read ---
    ['ONE other row with a producer field is enough to make the field "live" this date', () =>
      verdict([noProducerRow, otherRow], 'morning-brief').status === 'ABSENT'],

    // --- ABSENT: field is live, this producer just isn't in it ---
    ['producer live, brief missing, is ABSENT', () =>
      verdict([otherRow], 'morning-brief').status === 'ABSENT'],
    ['ABSENT is a real finding (nonzero exit)', () => verdict([otherRow], 'morning-brief').code === 1],

    // --- CONFIRMED: the row is there and it worked ---
    ['an accepted brief row is CONFIRMED', () => verdict([briefAccepted], 'morning-brief').status === 'CONFIRMED'],
    ['CONFIRMED is clean (exit 0)', () => verdict([briefAccepted], 'morning-brief').code === 0],
    ['CONFIRMED detail names the message_id', () => verdict([briefAccepted], 'morning-brief').detail.includes('9820')],

    // --- THE MUST-FAIL CASE: a dead-letter row must not be reported as if it never existed ---
    ['MUST-FAIL CASE: a dead-letter brief row is CONFIRMED-FAILED, not ABSENT', () =>
      verdict([briefDeadLetter], 'morning-brief').status === 'CONFIRMED-FAILED'],
    ['CONFIRMED-FAILED is a real finding (nonzero exit), same as ABSENT but a different status string', () => {
      const v = verdict([briefDeadLetter], 'morning-brief');
      return v.code === 1 && v.status !== 'ABSENT';
    }],
    ['CONFIRMED-FAILED detail carries the transport error', () =>
      verdict([briefDeadLetter], 'morning-brief').detail.includes('chat not found')],

    // --- realistic mixed day: other producers' rows present alongside the brief ---
    ['a real day with other producers plus an accepted brief row still reads CONFIRMED', () =>
      verdict([otherRow, briefAccepted], 'morning-brief').status === 'CONFIRMED'],

    // --- REGRESSION (Codex review, 2026-08-18): the REAL two-row lifecycle, not just an
    // isolated terminal row. `delivering` is always written before the terminal state and
    // shares the same producer -- a naive .find() returns `delivering` first and misreports
    // a real success as a failure. ---
    ['a successful send is [delivering, accepted] in that order -- still CONFIRMED, not CONFIRMED-FAILED', () =>
      verdict([briefDelivering, briefAccepted], 'morning-brief').status === 'CONFIRMED'],
    ['a failed send is [delivering, dead-letter] in that order -- still CONFIRMED-FAILED, error preserved', () => {
      const v = verdict([briefDelivering, briefDeadLetterAfterDelivering], 'morning-brief');
      return v.status === 'CONFIRMED-FAILED' && v.detail.includes('chat not found');
    }],
    ['row order in the file should not matter -- terminal state found even if delivering appears after it in the array', () =>
      verdict([briefAccepted, briefDelivering], 'morning-brief').status === 'CONFIRMED'],

    // --- IN-FLIGHT: only a 'delivering' row exists for this producer (send in progress, or the
    // process died before writing a terminal outcome) -- neither a failure nor a confirmed send. ---
    ['only a delivering row for this producer is IN-FLIGHT, not CONFIRMED-FAILED', () =>
      verdict([briefDelivering], 'morning-brief').status === 'IN-FLIGHT'],
    ['IN-FLIGHT is uncertain (code 2), same class as UNKNOWN, distinct from a real failure', () =>
      verdict([briefDelivering], 'morning-brief').code === 2],
  ];

  let failed = 0;
  for (const [name, fn] of cases) {
    let ok = false;
    try { ok = fn() === true; } catch { ok = false; }
    if (!ok) failed++;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}`);
  }
  console.log(failed === 0 ? `\nself-test PASSED (${cases.length} cases)` : `\nself-test FAILED: ${failed}`);
  process.exit(failed === 0 ? 0 : 2);
}

if (process.argv.includes('--self-test')) selfTest();

function fail(msg) {
  console.log(`VERDICT: COULD-NOT-RUN — ${msg}`);
  process.exit(3);
}

// Flag-aware positional parsing: `args.find(a => !a.startsWith('--'))` alone would pick up a
// flag's OWN value (e.g. `--date 2026-08-18 morning-brief` selects '2026-08-18' as the
// producer) whenever a flag preceded the positional arg. Mark each flag's value index consumed
// before searching for the positional.
const args = process.argv.slice(2);
const consumed = new Set();
function flagValue(name) {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  consumed.add(i);
  consumed.add(i + 1);
  return args[i + 1];
}
const date = flagValue('--date') || new Date().toISOString().slice(0, 10);
const agent = flagValue('--agent') || (process.env.CTX_AGENT_NAME || 'seb_boss');
const producer = args.find((a, idx) => !consumed.has(idx) && !a.startsWith('--'));
if (!producer) fail('usage: check-brief-delivery.mjs <producer> [--date YYYY-MM-DD] [--agent name]');

const journalPath = `${CTX_ROOT}/logs/${agent}/outbound-deliveries.jsonl`;
if (!existsSync(journalPath)) fail(`no journal at ${journalPath} -- ${agent} has never sent a Telegram message`);

// Skip malformed/partial lines rather than aborting the whole read on one bad row -- a torn
// write to an unrelated date must not block a verdict for today (same convention as
// check-brief-health.mjs's reader).
let rows;
try {
  rows = readFileSync(journalPath, 'utf8')
    .trim().split('\n').filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter((r) => r && r.timestamp && r.timestamp.slice(0, 10) === date);
} catch (err) {
  fail(`could not read ${journalPath}: ${err.message}`);
}
if (rows.length === 0) fail(`no delivery rows at all for ${agent} on ${date} -- cannot distinguish UNKNOWN from ABSENT with zero rows to read`);

const v = verdict(rows, producer);
console.log(`VERDICT: ${v.status} — ${v.detail}`);
process.exit(v.code);
