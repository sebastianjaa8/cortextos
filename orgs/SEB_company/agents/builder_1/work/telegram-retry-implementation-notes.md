# Implementation notes — Telegram send reliability (task_1785365343285_01098635)

Branch `fix/telegram-ipv6-race-and-retry`. builder_1, 2026-07-29.
Assigned as "add retry for transient fetch failures". Root-caused first, because retry
alone would have masked a majority-failure path rather than fixed it.

## Timeline

- 22:47Z — decision: get the real error string before designing anything. Journal shows
  `TypeError: fetch failed`, 5 failures in ~5 min across seb_boss AND atlas. Connection-level,
  not a timeout, and not one agent — a box-level condition.
- 22:52Z — gotcha: my first probe made 40 sequential fetches in ONE process and reported
  1/40 failures (2.5%). undici keeps the socket alive, so that measured roughly ONE
  connection setup. The fault is entirely in connection establishment and production pays
  a fresh one per send (every `cortextos bus send-telegram` is a new process). Fresh-process
  trials moved it to 75%. Nearly quoted the 2.5% figure.
- 22:56Z — change: seb_boss prescribed `dns.setDefaultResultOrder('ipv4first')` as the real
  fix. Measured it: 75% → 58%. An improvement, not a fix. Corrected it upstream before the
  framing reached Sebastian.
- 22:58Z — decision: probe arms that separate network from library. Raw TCP to the IPv4
  literal is 12/12 at ~250ms, so the network is healthy; `autoSelectFamily(false)` +
  ipv4first is 12/12. The race is the bug, not the ordering and not connectivity.
- 23:01Z — gotcha: the failure named `149.154.167.99`, an address the resolver had not
  handed me. Enumerated all three IPv4 addresses Telegram rotates and probed each 3x —
  all reachable, 3/3. So nothing is unreachable except IPv6, which fails instantly with
  ENETUNREACH. An instant unreachable is the easy case for happy-eyeballs, and it still
  wedges the connect until ETIMEDOUT. That is a Node/undici bug on this platform.
- 23:03Z — decision: the retry discriminator is `syscall === 'connect'` on every leg of the
  AggregateError, captured from a live failure. A connect-phase failure proves no request
  bytes were written, which is what makes retrying a **sendMessage** safe here. A bare
  ETIMEDOUT with no syscall stays ambiguous.
- 23:05Z — decision: retry lives in `post()`, never around `sendMessage`. sendMessage chunks
  at 4096 and sends sequentially, so retrying the whole call after a chunk-3 failure
  re-delivers chunks 1 and 2. One post = one chunk.
- 23:06Z — change: journal now records real attempt counts, summed across chunks. It
  previously hardcoded `attempts: 1`; that record is already success-biased and an
  understated attempt count would hide exactly the flakiness this change is about.
- 23:07Z — gotcha: my own script asserted 5 replacements when there were 4 and refused to
  write. Working as intended — a replace that silently matches nothing is indistinguishable
  from a no-op.
- 23:08Z — change: 3 unhandled-rejection warnings in an otherwise-green run. Cause was
  attaching the rejection handler AFTER draining fake timers. Fixed rather than tolerated;
  noisy output is how a real error gets missed later.
- 23:09Z — **existing tests caught two real defects in my change**, not test brittleness:
  1. `throws a timeout error when fetch hangs indefinitely` went to 20023ms. My classifier
     called our own 15s AbortSignal timeout "ambiguous", and since getUpdates is idempotent
     it was retried — turning a 15s stall into 45s+. Fixed in source: a `timed out after Ns`
     error is now `fatal` for retry purposes. The poller recovers next tick, which is cheaper
     than blocking. **The pre-existing test was right and my change was wrong.**
  2. `network_error: fetch throws` lost its ENOTFOUND detail because the mock queued one
     response and retry consumed it. Fixed the TEST (queue the same failure for all three
     attempts, the production shape) while keeping both original assertions, and added
     `expect(callLog).toHaveLength(3)` so retry is asserted rather than implicit.

## Tradeoffs

- `dns.setDefaultResultOrder` and `net.setDefaultAutoSelectFamily` are process-GLOBAL, and
  setting globals from a library module is rude. Chose it anyway over rewriting `post()` onto
  `node:https` with a scoped `lookup`: no new dependency (repo rule), one call site covers CLI
  + daemon + hooks so no entry point can forget, and `CORTEXTOS_TELEGRAM_NET_TUNING=off` gives
  an escape hatch without a source edit. Documented at the definition, not in the commit
  message, because the artifact is what the next person reads.
- Not IPv4-only, deliberately. `autoSelectFamily(false)` makes net.connect walk the resolved
  addresses in ORDER with fallback; `ipv4first` only orders the list. A host with only AAAA
  records still connects.
- Retry is 3 attempts, 300ms then 1200ms + jitter. Short because the failure fails fast;
  jitter so a fleet of agents does not retry in lockstep.
- `lastAttemptCount` is per-instance mutable state, which assumes sends on one client are
  awaited sequentially. True today (rateLimit serialises per chat). Noted at the field.

## Measurements

Fresh process per trial — the only shape that measures connection setup honestly.

| arm | result |
|---|---|
| raw TCP to each of 3 Telegram IPv4 addrs | 3/3 each, ~250ms — network healthy |
| IPv6 `2001:67c:4e8:f004::9` | 0/3, ENETUNREACH in ~1ms |
| plain fetch (as shipped before) | 75% fail, later 50% fail — bursty, ETIMEDOUT |
| fetch + ipv4first only | 58% fail, later 67% fail — **not a fix** |
| fetch + ipv4first + no race | 0% then 8% fail (1x ECONNRESET, a genuine transient) |
| real `src/telegram/api.ts`, tuning off + retry | 12/12 connected |
| real `src/telegram/api.ts`, as shipped | 12/12 connected |

Before/after on the real code path used `getMe` with a dummy token: Telegram answers 401,
and that answer proves the connection succeeded. No messages sent, no real token, no build.

**Honest reading:** retry alone also reached 12/12 in its window, so that pair alone does not
prove the tuning was needed. The no-retry control run at the same time is what settles it —
50% per-attempt baseline vs 8% with tuning. Tuning makes the first attempt usually work;
retry covers the residue (the 8% included a real ECONNRESET that tuning cannot help).
Together the expected residual is ~0.05%. Each mechanism is doing a different job.

## Verification

- `npx tsc --noEmit` clean.
- 13 new tests + all 128 telegram-related tests green (12 files).
- **Sabotage pass, all three mutations confirmed the tests are load-bearing:**
  - `MAX_ATTEMPTS = 1` → 3 failures
  - `allSafe = true || …` (every failure looks never_sent) → 3 failures, including the
    duplicate-message guard
  - net tuning body removed → 1 failure
  - A 4th mutation matched 0 times and its "13 passed" was therefore meaningless; the assert
    caught it and it was redone with a verified anchor. A mutation that does not apply looks
    exactly like a test gap.
- Source files backed up OUTSIDE the repo before mutating, and byte-compared after restore.

## Not done / open

- **NOT BUILT.** `dist` is symlinked into the global npm install, so `npm run build` publishes
  the working tree fleet-wide the moment it runs. That is a deploy, and it is not mine to make
  unilaterally — flagged to seb_boss for the go-ahead. Everything above was measured against
  source, so the fix is verified but NOT yet live for any agent.
- Only `sendMessage` journals attempts. `sendPhoto`/`sendDocument` still bypass both the
  journal and `post()` (they call `fetch` directly), so they get neither retry nor the attempt
  record. Pre-existing gap, deliberately not widened in this change — stated rather than fixed.
- Whether IPv6 to Telegram is blocked by this network permanently or transiently is unknown
  and not diagnosed. The fix does not depend on the answer.
