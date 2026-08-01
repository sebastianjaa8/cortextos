// PM2 ecosystem config for cortextOS daemon.
// Portable: paths resolve at load time relative to this file and the user's home.
// Override any value with environment variables before `pm2 start`.

const path = require('path');
const os = require('os');

const FRAMEWORK_ROOT = process.env.CTX_FRAMEWORK_ROOT || __dirname;
const INSTANCE_ID = process.env.CTX_INSTANCE_ID || 'default';
const CTX_ROOT = process.env.CTX_ROOT || path.join(os.homedir(), '.cortextos', INSTANCE_ID);
const CTX_ORG = process.env.CTX_ORG || '';
const DAEMON_APP_NAME = `cortextos-daemon-${INSTANCE_ID}`;
const FILTER_ENV = ['GITHUB_', 'GH_', 'TOKEN', 'SECRET', 'API_KEY', 'ACCESS_KEY', 'PRIVATE_KEY', 'PASSWORD', 'CREDENTIAL'];

module.exports = {
  apps: [
    {
      name: DAEMON_APP_NAME,
      script: path.join(FRAMEWORK_ROOT, 'dist', 'daemon.js'),
      args: `--instance ${INSTANCE_ID}`,
      cwd: FRAMEWORK_ROOT,
      env: {
        CTX_INSTANCE_ID: INSTANCE_ID,
        CTX_ROOT: CTX_ROOT,
        CTX_FRAMEWORK_ROOT: FRAMEWORK_ROOT,
        CTX_PROJECT_ROOT: FRAMEWORK_ROOT,
        CTX_ORG: CTX_ORG,
        PATH: process.env.PATH,
        PATHEXT: process.env.PATHEXT,
        // Debug-only: set to '1' to enable SIGUSR2 signal → controlled
        // uncaughtException for testing the crash-visibility path
        // (.daemon-crashed markers + crash-loop operator Telegram alert).
        // Leave '0' in production; enable temporarily to reproduce crash
        // paths during development. `kill -SIGUSR2 $(pm2 pid cortextos-daemon)`
        // then watch the operator chat for "🚨 CRITICAL: daemon crash-looping"
        // after 3 crashes in 15 min.
        CTX_DEBUG_ALLOW_CRASH_TRIGGER: '0',
      },
      // max_restarts + exponential backoff is the ultimate crash-storm circuit
      // breaker. If the daemon dies 10 times faster than 5s apart, PM2
      // gives up — the fleet goes fully dead, requiring a manual
      // `cortextos restart --daemon --instance <id>`. That is intentional: storm
      // protection > fleet uptime during a pathological crash loop.
      // The daemon's uncaughtException handler (src/daemon/index.ts)
      // fires a Telegram alert to the operator at 3+ crashes in 15 min —
      // well before this circuit trips. Do NOT raise these values without
      // also strengthening the upstream fix; the 2026-04-22 storm is a
      // reminder that unchecked auto-restart amplifies one bug into a
      // fleet-wide outage.
      // Shutdown plus PID-identity cleanup can take about 41s in the worst case.
      // PM2 gets a 19s margin before force-killing the daemon.
      kill_timeout: 60000,
      listen_timeout: 120000,
      wait_ready: true,
      filter_env: FILTER_ENV,
      min_uptime: 10000,
      max_restarts: 10,
      // Exponential backoff (5s → PM2's 15s cap) instead of a fixed delay.
      // With a fixed delay, a startup failure that exits "cleanly enough"
      // to dodge max_restarts (e.g. the duplicate-daemon lock conflict of
      // 2026-07-01) respawns ~10x/min forever — 17k restarts in a day.
      // max_restarts remains the crash-storm circuit breaker; backoff reduces
      // churn while still recovering quickly from a one-off crash.
      exp_backoff_restart_delay: 5000,
      // Exit code 2 = duplicate-daemon lock conflict (DAEMON_EXIT_LOCK_CONFLICT
      // in src/daemon/index.ts). PM2 stops instead of respawning. The backoff
      // and max_restarts above do NOT contain this case: startup reaches the
      // lock check well after min_uptime, so PM2 counts every attempt as a
      // stable run and unstable_restarts stays 0 forever. Measured 2026-08-01:
      // 20 restarts in 15 min, ~45s apart, breaker never tripped, cumulative
      // counter 1168. Retrying is also pointless — a live daemon holds the
      // lock and keeps heartbeating it (a dead holder's lock goes stale after
      // DAEMON_LOCK_STALE_MS and is taken normally). The operator Telegram
      // alert fires from the same path with the recovery steps.
      stop_exit_codes: [2],
      // PM2's supported Windows graceful-stop path. SIGINT-based restarts can
      // detach a still-live daemon from PM2 and spawn a competing generation.
      shutdown_with_message: true,
      autorestart: true,
    },
  ],
};
