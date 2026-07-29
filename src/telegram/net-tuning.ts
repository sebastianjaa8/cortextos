/**
 * Work around Node's happy-eyeballs connect race on hosts where IPv6 egress is
 * dead, which is the root cause of `TypeError: fetch failed [cause ETIMEDOUT]`
 * against api.telegram.org.
 *
 * MEASURED 2026-07-29 on a host where IPv6 to Telegram is unreachable
 * (12 trials per arm, one fresh process per trial, so each trial pays exactly one
 * connection setup — which is what production pays, since every
 * `cortextos bus send-telegram` is a new process):
 *
 *   raw TCP to the IPv4 literal          12/12 ok    0% fail   median 282ms
 *   fetch(), as shipped                   3/12 ok   75% fail   ETIMEDOUT
 *   fetch() + dns ipv4first only          5/12 ok   58% fail   ETIMEDOUT
 *   fetch() + ipv4first + no family race 12/12 ok    0% fail
 *
 * Two conclusions that are easy to get wrong:
 *
 *  - It is NOT the network. Raw TCP to the IPv4 address is perfectly healthy.
 *  - It is NOT the DNS ORDER. `ipv4first` alone only moves 75% to 58%, because
 *    autoSelectFamily still RACES both families. The IPv6 leg returns ENETUNREACH
 *    in ~1ms — the easy case happy-eyeballs exists to handle — and having it in the
 *    race still wedges the connect until ETIMEDOUT. Removing the race is what fixes
 *    it; reordering the race is not.
 *
 * With autoSelectFamily off, net.connect walks the resolved addresses in order and
 * moves to the next one on failure. Combined with `ipv4first` that means IPv4 is
 * tried first and IPv6 remains reachable as a fallback, so this is NOT "IPv4 only":
 * a host with only AAAA records still connects, because ipv4first merely orders the
 * list it is given.
 *
 * Escape hatch: set CORTEXTOS_TELEGRAM_NET_TUNING=off to leave Node's defaults
 * alone. Provided because these two settings are process-global, so anyone hitting a
 * network where the race is genuinely the better strategy needs a way out that does
 * not involve editing source.
 */
import dns from 'node:dns';
import net from 'node:net';

let applied: 'applied' | 'skipped-env' | 'unsupported' | null = null;

/**
 * Idempotent. Safe to call from module scope of any entry point; the first call
 * wins and later calls are no-ops, so importing this from several places cannot
 * fight with itself.
 */
export function applyTelegramNetTuning(): 'applied' | 'skipped-env' | 'unsupported' {
  if (applied) return applied;

  if ((process.env.CORTEXTOS_TELEGRAM_NET_TUNING || '').toLowerCase() === 'off') {
    return (applied = 'skipped-env');
  }

  // setDefaultAutoSelectFamily landed in Node 18.13/19.4; engines require >=20, so
  // this guard is belt-and-braces for an odd runtime rather than an expected path.
  if (typeof net.setDefaultAutoSelectFamily !== 'function') {
    return (applied = 'unsupported');
  }

  dns.setDefaultResultOrder('ipv4first');
  net.setDefaultAutoSelectFamily(false);
  return (applied = 'applied');
}

/** Test seam: forget that tuning ran so a test can exercise the branches. */
export function resetTelegramNetTuningForTests(): void {
  applied = null;
}
