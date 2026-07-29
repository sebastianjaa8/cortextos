// v3: split "the network is flaky" from "undici picks a bad path".
//
// v2 established, per fresh process (production's shape):
//   - IPv6 2001:67c:4e8:f004::9 -> ENETUNREACH in 1ms (instant, not a timeout)
//   - 80% of fetches fail with cause ETIMEDOUT under BOTH verbatim and ipv4first
// An instant ENETUNREACH is exactly what happy-eyeballs is built to shrug off, and
// forcing ipv4first changed nothing. So family selection is probably NOT the fault,
// and the remaining candidates are: the IPv4 path itself is unreliable right now, or
// something in undici's connect (TLS, pooling) is.
//
// Four arms, one connection setup each, fresh process per trial:
//   tcp4      raw net.connect to the IPv4 literal    -> pure network reachability
//   fetch     fetch(hostname), today's behaviour     -> production baseline
//   fetch4    fetch(hostname), ipv4first             -> the proposed fix
//   noauto    fetch(hostname), ipv4first AND
//             autoSelectFamily(false)                -> no racing at all
// If tcp4 fails at the same rate as fetch, it is the network and no code change fixes
// it. If tcp4 is clean while fetch fails, it is undici.
import dns from "node:dns";
import net from "node:net";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HOST = "api.telegram.org";
const V4 = process.env.V4 || "149.154.166.110";
const SELF = fileURLToPath(import.meta.url);
const CONNECT_TIMEOUT = 8000;

if (process.argv[2] === "--one") {
  const arm = process.argv[3];
  const say = (s) => { console.log(s); process.exit(0); };
  if (arm === "tcp4") {
    const t0 = Date.now();
    const sock = net.connect({ host: V4, port: 443, family: 4 });
    sock.setTimeout(CONNECT_TIMEOUT, () => say(`FAIL timeout ${Date.now() - t0}ms`));
    sock.once("connect", () => { sock.destroy(); say(`OK ${Date.now() - t0}ms`); });
    sock.once("error", (e) => say(`FAIL ${e.code || e.message} ${Date.now() - t0}ms`));
  } else {
    if (arm === "fetch4" || arm === "noauto") dns.setDefaultResultOrder("ipv4first");
    if (arm === "noauto") net.setDefaultAutoSelectFamily(false);
    const t0 = Date.now();
    try {
      const r = await fetch(`https://${HOST}/`, { signal: AbortSignal.timeout(CONNECT_TIMEOUT) });
      await r.text();
      say(`OK ${Date.now() - t0}ms`);
    } catch (e) {
      say(`FAIL ${e?.cause?.code || e?.name} ${Date.now() - t0}ms`);
    }
  }
} else {
  const TRIALS = Number(process.env.TRIALS || 12);
  const arms = ["tcp4", "fetch", "fetch4", "noauto"];
  const res = {};
  for (const arm of arms) {
    let ok = 0; const tally = {}; const times = [];
    for (let i = 0; i < TRIALS; i++) {
      const r = spawnSync(process.execPath, [SELF, "--one", arm], { encoding: "utf8", timeout: 25000 });
      const line = (r.stdout || "").trim().split("\n").pop() || `SPAWN_ERR`;
      const ms = Number((line.match(/(\d+)ms/) || [])[1] || 0);
      if (line.startsWith("OK")) { ok++; times.push(ms); }
      else tally[line.replace(/\s+\d+ms$/, "")] = (tally[line.replace(/\s+\d+ms$/, "")] || 0) + 1;
    }
    const failed = TRIALS - ok;
    res[arm] = { ok, failed, TRIALS };
    const med = times.length ? times.sort((a, b) => a - b)[Math.floor(times.length / 2)] : null;
    console.log(`${arm.padEnd(8)} ${ok}/${TRIALS} ok  ${String(((failed / TRIALS) * 100).toFixed(0)).padStart(3)}% fail${med !== null ? `   median ok ${med}ms` : ""}`);
    for (const [e, n] of Object.entries(tally)) console.log(`    ${n}x ${e}`);
  }

  console.log("\nVERDICT:");
  const tcpFail = res.tcp4.failed / res.tcp4.TRIALS;
  const fetchFail = res.fetch.failed / res.fetch.TRIALS;
  if (tcpFail > 0.3 && Math.abs(tcpFail - fetchFail) < 0.3) {
    console.log("  NETWORK, not code. Raw TCP to the IPv4 literal fails at a comparable rate,");
    console.log("  so no DNS/undici setting can fix this. Retry is the only code-side mitigation,");
    console.log("  and it must tolerate a high per-attempt failure rate.");
  } else if (tcpFail < 0.1 && fetchFail > 0.3) {
    console.log("  UNDICI/resolution, not the network. Raw TCP is clean while fetch fails.");
    const best = ["fetch4", "noauto"].filter((a) => res[a].failed === 0);
    console.log(best.length ? `  Clean arm(s): ${best.join(", ")} -> that is the fix.` : "  No arm was clean; retry needed on top.");
  } else {
    console.log("  Mixed/low signal. Rates: " + arms.map((a) => `${a} ${(res[a].failed / res[a].TRIALS * 100).toFixed(0)}%`).join(", "));
  }
}
