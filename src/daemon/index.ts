import { AgentManager } from './agent-manager.js';
import { IPCServer } from './ipc-server.js';
import { readdirSync, readFileSync, writeFileSync, existsSync, chmodSync } from 'fs';
import { spawnSync } from 'child_process';
import { join } from 'path';
import { homedir } from 'os';
import { ensureDir } from '../utils/atomic.js';
import { acquireLock, releaseLock, touchLock, type LockMutationResult } from '../utils/lock.js';
import { stripBom } from '../utils/strip-bom.js';
import { reconcileRuntimeProcesses } from '../utils/process-ownership.js';

// Each fast-checker registers a process-level SIGUSR1 handler (see
// fast-checker.ts:102). With >10 active agents the default Node listener cap
// trips MaxListenersExceededWarning. Bump for the full fleet.
process.setMaxListeners(20);

// ---------------------------------------------------------------------------
// Crash handling: turn silent daemon deaths into attributable, observable
// events. Three responsibilities:
//   1. Write a .daemon-crashed marker per agent — hook-crash-alert.ts uses
//      this on the next session boot to emit "🚨 daemon crashed" instead of
//      the misleading "🚨 agent crashed" default.
//   2. Maintain a small crash-history JSON so we can detect crash-loops.
//   3. On ≥3 crashes in 15 min, send ONE Telegram alert to the operator chat
//      (with a 30-min cooldown). PM2's max_restarts: 10 is the final
//      circuit breaker; our alert fires before the fleet goes fully dead.
// Context: root cause of 2026-04-22 restart storm was unguarded this.pty!
// in worker-process.ts:93 — PR #196 fixed 3 sister sites but missed this
// one. The inject.ts try/catch + worker-process ?. land the structural fix;
// this module is the visibility layer.
// ---------------------------------------------------------------------------

export interface CrashEvent { ts: string; err: string; }
export interface CrashHistory { crashes: CrashEvent[]; lastAlertAt?: string; }

export const CRASH_HISTORY_MAX = 20;
export const CRASH_LOOP_WINDOW_MS = 15 * 60 * 1000;    // 15 min detection window
export const CRASH_LOOP_THRESHOLD = 3;                  // 3 crashes trips the alert
export const CRASH_LOOP_COOLDOWN_MS = 30 * 60 * 1000;   // 30 min between alerts
const TELEGRAM_SEND_TIMEOUT_MS = 3000;           // bounded — we're crashing

export function crashHistoryPath(ctxRoot: string): string {
  return join(ctxRoot, 'state', '.daemon-crash-history.json');
}

export function readCrashHistory(ctxRoot: string): CrashHistory {
  const p = crashHistoryPath(ctxRoot);
  if (!existsSync(p)) return { crashes: [] };
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf-8')) as CrashHistory;
    return { crashes: parsed.crashes ?? [], lastAlertAt: parsed.lastAlertAt };
  } catch {
    return { crashes: [] };
  }
}

export function writeCrashHistory(ctxRoot: string, history: CrashHistory): void {
  try {
    ensureDir(join(ctxRoot, 'state'));
    writeFileSync(crashHistoryPath(ctxRoot), JSON.stringify(history, null, 2), 'utf-8');
  } catch {
    // disk full / permission issue — don't block exit
    console.error('[daemon] Failed to persist crash history (non-fatal)');
  }
}

export function recordCrash(ctxRoot: string, errStr: string): CrashHistory {
  const history = readCrashHistory(ctxRoot);
  history.crashes.push({ ts: new Date().toISOString(), err: errStr.slice(0, 2000) });
  if (history.crashes.length > CRASH_HISTORY_MAX) {
    history.crashes = history.crashes.slice(-CRASH_HISTORY_MAX);
  }
  writeCrashHistory(ctxRoot, history);
  return history;
}

export function shouldSendCrashLoopAlert(history: CrashHistory): boolean {
  const now = Date.now();
  const windowStart = now - CRASH_LOOP_WINDOW_MS;
  const recent = history.crashes.filter(c => Date.parse(c.ts) >= windowStart).length;
  if (recent < CRASH_LOOP_THRESHOLD) return false;
  if (history.lastAlertAt) {
    const cooldownEnd = Date.parse(history.lastAlertAt) + CRASH_LOOP_COOLDOWN_MS;
    if (now < cooldownEnd) return false;
  }
  return true;
}

export function countRecentCrashes(history: CrashHistory): number {
  const windowStart = Date.now() - CRASH_LOOP_WINDOW_MS;
  return history.crashes.filter(c => Date.parse(c.ts) >= windowStart).length;
}

export function writeDaemonCrashedMarkers(ctxRoot: string): void {
  // Scan state/ for per-agent dirs (each agent has state/<name>/ created
  // by AgentProcess). Writing here parallels the .daemon-stop marker path
  // in agent-manager.ts:stopAll — lets hook-crash-alert.ts distinguish
  // crash from planned stop. Each write is independently try/catch'd so
  // a single bad agent dir can't block the exit path.
  const stateDir = join(ctxRoot, 'state');
  if (!existsSync(stateDir)) return;
  let names: string[];
  try {
    names = readdirSync(stateDir, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name);
  } catch { return; }
  const ts = new Date().toISOString();
  for (const name of names) {
    try {
      writeFileSync(join(stateDir, name, '.daemon-crashed'), ts, 'utf-8');
    } catch { /* swallow per-agent */ }
  }
}

function getOperatorChatCreds(frameworkRoot: string): { chatId: string; botToken: string } | null {
  // Priority 1: explicit operator env (recommended for production).
  const envChat = process.env.CTX_OPERATOR_CHAT_ID;
  const envToken = process.env.CTX_OPERATOR_BOT_TOKEN;
  if (envChat && envToken && /^\d+:[A-Za-z0-9_-]+$/.test(envToken)) {
    return { chatId: envChat, botToken: envToken };
  }
  // Priority 2: fall back to the first agent's .env. Good enough for
  // small single-operator installs — alert still lands SOMEWHERE visible.
  try {
    const orgsRoot = join(frameworkRoot, 'orgs');
    if (!existsSync(orgsRoot)) return null;
    const orgs = readdirSync(orgsRoot, { withFileTypes: true }).filter(d => d.isDirectory());
    for (const org of orgs) {
      const agentsRoot = join(orgsRoot, org.name, 'agents');
      if (!existsSync(agentsRoot)) continue;
      const agents = readdirSync(agentsRoot, { withFileTypes: true }).filter(d => d.isDirectory());
      for (const a of agents) {
        const envFile = join(agentsRoot, a.name, '.env');
        if (!existsSync(envFile)) continue;
        try {
          // stripBom: a BOM'd .env with BOT_TOKEN on line 1 (seb_boss today)
          // fails /^KEY=/m and silently disqualifies the operator's own bot,
          // routing the crash-loop alert to the wrong agent's bot or nowhere.
          const content = stripBom(readFileSync(envFile, 'utf-8'));
          const tokenMatch = content.match(/^BOT_TOKEN=(.+)$/m);
          const chatMatch = content.match(/^CHAT_ID=(.+)$/m);
          if (!tokenMatch || !chatMatch) continue;
          const botToken = tokenMatch[1].trim();
          const chatId = envChat || chatMatch[1].trim();
          if (/^\d+:[A-Za-z0-9_-]+$/.test(botToken)) {
            return { chatId, botToken };
          }
        } catch { /* skip this agent */ }
      }
    }
  } catch { /* fall through */ }
  return null;
}

function sendCrashLoopAlertBestEffort(
  frameworkRoot: string,
  crashCount: number,
  errStr: string,
): boolean {
  const creds = getOperatorChatCreds(frameworkRoot);
  if (!creds) {
    console.error('[daemon] Crash-loop alert: no operator chat configured ' +
      '(set CTX_OPERATOR_CHAT_ID + CTX_OPERATOR_BOT_TOKEN, or ensure at least one agent .env exists)');
    return false;
  }
  const message =
    `🚨 CRITICAL: cortextos daemon is crash-looping\n` +
    `${crashCount} crashes in 15 minutes\n` +
    `Last error: ${errStr.slice(0, 500)}\n` +
    `Next alert in 30 min if the pattern continues.`;
  try {
    // Secrets are passed over stdin, never argv. Command lines are readable by
    // same-host process inventory and were previously exposing the bot token.
    // The tuning below is duplicated as source text rather than imported, because
    // this snippet runs in a SEPARATE node process (`node -e`) with Node defaults —
    // no module-level fix in the daemon can reach it. Without it, this send races
    // IPv4 against an unreachable IPv6 and the wedged connect blows the 3s timeout
    // below. Measured 50-75% failure on 2026-07-29; see src/telegram/net-tuning.ts,
    // which is the canonical copy and carries the measurements.
    // Of every sender in the system this is the one that must not be flaky: it is
    // the daemon telling the operator it is crash-looping.
    const sender = `
const https = require('https');
if ((process.env.CORTEXTOS_TELEGRAM_NET_TUNING || '').toLowerCase() !== 'off') {
  try {
    require('dns').setDefaultResultOrder('ipv4first');
    require('net').setDefaultAutoSelectFamily(false);
  } catch {}
}
let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { raw += chunk; });
process.stdin.on('end', () => {
  const input = JSON.parse(raw);
  const body = new URLSearchParams({ chat_id: input.chatId, text: input.message }).toString();
  const req = https.request({
    hostname: 'api.telegram.org',
    path: '/bot' + input.botToken + '/sendMessage',
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'content-length': Buffer.byteLength(body) },
  }, response => {
    response.resume();
    response.on('end', () => process.exit(response.statusCode >= 200 && response.statusCode < 300 ? 0 : 1));
  });
  req.setTimeout(3000, () => req.destroy(new Error('timeout')));
  req.on('error', () => process.exit(1));
  req.end(body);
});`;
    const r = spawnSync(process.execPath, ['-e', sender], {
      input: JSON.stringify({ ...creds, message }),
      timeout: TELEGRAM_SEND_TIMEOUT_MS,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    if (r.status === 0) {
      console.error('[daemon] Crash-loop alert sent to operator chat');
      return true;
    }
    console.error('[daemon] Crash-loop alert send failed (non-fatal)');
    return false;
  } catch {
    return false;
  }
}

/**
 * Shared fatal-error handler for both uncaughtException and
 * unhandledRejection. Performs marker writes + crash recording + optional
 * telegram alert, then optionally exits. Stays fully synchronous so it
 * finishes before Node's default crash behavior triggers.
 */
function handleFatal(
  tag: 'uncaughtException' | 'unhandledRejection',
  err: unknown,
  ctxRoot: string,
  frameworkRoot: string,
  doExit: boolean,
): void {
  const errStr = err instanceof Error ? (err.stack || err.message) : String(err);
  console.error(`[daemon] FATAL ${tag} — exiting for PM2 respawn`);
  console.error(errStr);

  writeDaemonCrashedMarkers(ctxRoot);
  const history = recordCrash(ctxRoot, errStr);

  if (shouldSendCrashLoopAlert(history)) {
    const recent = countRecentCrashes(history);
    if (sendCrashLoopAlertBestEffort(frameworkRoot, recent, errStr)) {
      history.lastAlertAt = new Date().toISOString();
      writeCrashHistory(ctxRoot, history);
    }
  }

  if (doExit) process.exit(1);
}

/**
 * cortextOS Daemon - single process managing all agents.
 * Run via `pm2 start ecosystem.config.js` or `cortextos ecosystem && pm2 start`.
 */
// Heartbeat cadence for the daemon-instance lock (see AcquireLockOptions.
// staleAfterMs in lock.ts for why this exists). 3x margin between touch and
// stale threshold tolerates a slow tick without a live daemon losing its own
// lock.
const DAEMON_LOCK_HEARTBEAT_MS = 30_000;
const DAEMON_LOCK_STALE_MS = 90_000;
export const PM2_SUPERVISOR_FENCE_INTERVAL_MS = 2_000;
export const PM2_SUPERVISOR_FENCE_FAILURE_THRESHOLD = 3;

export function acquireDaemonInstanceLock(ctxRoot: string): boolean {
  const lockRoot = join(ctxRoot, '.daemon-instance');
  ensureDir(lockRoot);
  return acquireLock(lockRoot, { staleAfterMs: DAEMON_LOCK_STALE_MS });
}

export function releaseDaemonInstanceLock(ctxRoot: string): LockMutationResult {
  return releaseLock(join(ctxRoot, '.daemon-instance'));
}

export function isPm2ShutdownMessage(message: unknown): boolean {
  return message === 'shutdown';
}

export function pm2SupervisorOwnsCurrentProcess(
  env: NodeJS.ProcessEnv = process.env,
  pid: number = process.pid,
): boolean | undefined {
  const pidPath = env.pm_pid_path;
  if (!pidPath) return undefined;
  try {
    const rawPid = readFileSync(pidPath, 'utf-8').trim();
    if (!/^[1-9]\d*$/.test(rawPid)) return false;
    return Number(rawPid) === pid;
  } catch {
    return false;
  }
}

class Daemon {
  private agentManager: AgentManager | null = null;
  private ipcServer: IPCServer | null = null;
  private instanceId: string;
  private ctxRoot: string;
  private lockHeld = false;
  private lockHeartbeat: NodeJS.Timeout | null = null;
  private supervisorFence: NodeJS.Timeout | null = null;
  private skipOwnedProcessCleanup = false;

  constructor() {
    this.instanceId = process.env.CTX_INSTANCE_ID || 'default';
    // Always derive ctxRoot from instanceId to avoid inheriting a parent cortextOS's CTX_ROOT
    this.ctxRoot = join(homedir(), '.cortextos', this.instanceId);
  }

  async start(): Promise<void> {
    // Force restrictive default permissions for everything the daemon writes:
    // 0700 dirs, 0600 files. Belt-and-suspenders for explicit chmod calls.
    if (process.platform !== 'win32') {
      process.umask(0o077);
    }

    console.log(`[daemon] Starting cortextOS daemon (instance: ${this.instanceId})`);

    const frameworkRoot = process.env.CTX_FRAMEWORK_ROOT || '';
    const org = process.env.CTX_ORG || '';

    if (!frameworkRoot) {
      console.error('[daemon] CTX_FRAMEWORK_ROOT not set');
      process.exit(1);
    }

    ensureDir(this.ctxRoot);
    if (!acquireDaemonInstanceLock(this.ctxRoot)) {
      throw new Error(`Another cortextOS daemon is already running for instance "${this.instanceId}"`);
    }
    this.lockHeld = true;
    let fenceFailureHandled = false;
    this.lockHeartbeat = setInterval(() => {
      const result = touchLock(join(this.ctxRoot, '.daemon-instance'));
      if (result.status === 'busy') {
        console.warn('[daemon] Lock heartbeat deferred because the lock guard is busy');
      } else if (result.status !== 'ok') {
        if (fenceFailureHandled) return;
        fenceFailureHandled = true;
        this.lockHeld = false;
        handleFatal(
          'uncaughtException',
          new Error(`Daemon instance-lock ownership lost (${result.status}); terminating to prevent split-brain`),
          this.ctxRoot,
          frameworkRoot,
          true,
        );
        return;
      }

    }, DAEMON_LOCK_HEARTBEAT_MS);
    this.lockHeartbeat.unref();

    let supervisorFenceFailures = 0;
    this.supervisorFence = setInterval(() => {
      if (pm2SupervisorOwnsCurrentProcess() !== false) {
        supervisorFenceFailures = 0;
        return;
      }
      supervisorFenceFailures += 1;
      if (supervisorFenceFailures < PM2_SUPERVISOR_FENCE_FAILURE_THRESHOLD) return;
      if (fenceFailureHandled) return;
      fenceFailureHandled = true;
      this.skipOwnedProcessCleanup = true;
      handleFatal(
        'uncaughtException',
        new Error(
          `PM2 supervisor ownership lost: ${process.env.pm_pid_path} no longer names daemon pid ${process.pid}; ` +
          'terminating orphaned generation',
        ),
        this.ctxRoot,
        frameworkRoot,
        false,
      );
      process.exit(1);
    }, PM2_SUPERVISOR_FENCE_INTERVAL_MS);
    this.supervisorFence.unref();
    const pidFile = join(this.ctxRoot, 'daemon.pid');
    let exitCleanupRan = false;
    const cleanupForExit = () => {
      if (exitCleanupRan) return;
      exitCleanupRan = true;
      if (this.lockHeartbeat) {
        clearInterval(this.lockHeartbeat);
        this.lockHeartbeat = null;
      }
      if (this.supervisorFence) {
        clearInterval(this.supervisorFence);
        this.supervisorFence = null;
      }
      try {
        if (this.ipcServer) this.ipcServer.stop();
      } catch (err) {
        console.error('[daemon] Failed to stop IPC during exit cleanup:', err);
      }
      if (!this.skipOwnedProcessCleanup) {
        try {
          this.agentManager?.forceStopAll();
        } catch (err) {
          console.error('[daemon] Failed to stop owned processes during exit cleanup:', err);
        }
      }
      try {
        const { unlinkSync } = require('fs');
        unlinkSync(pidFile);
      } catch { /* ignore */ }
      // The instance lock is the lifecycle fence. Supervisor-loss exits skip
      // synchronous PTY teardown so PM2 receives the exit promptly; the next
      // daemon reconciles the old generation's PID-safe runtime records.
      if (this.lockHeld) {
        releaseDaemonInstanceLock(this.ctxRoot);
        this.lockHeld = false;
      }
    };
    // Registered immediately after acquisition so startup failures reconcile
    // through the same ordered path as fatal runtime exits.
    process.once('exit', cleanupForExit);

    const reconciliation = reconcileRuntimeProcesses(this.ctxRoot, this.instanceId);
    for (const outcome of reconciliation) {
      const pid = outcome.pid ? ` pid=${outcome.pid}` : '';
      console.log(`[daemon] Process reconciliation ${outcome.status}: agent=${outcome.agentName}${pid} ${outcome.detail}`);
    }
    const failedReconciliation = reconciliation.filter(outcome => outcome.status === 'failed');
    if (failedReconciliation.length > 0) {
      throw new Error(
        `Refusing to start: ${failedReconciliation.length} prior agent process tree(s) could not be terminated`,
      );
    }

    // Write PID file
    writeFileSync(pidFile, String(process.pid), 'utf-8');
    if (process.platform !== 'win32') {
      try {
        chmodSync(pidFile, 0o600);
      } catch { /* best effort */ }
    }

    // Create agent manager
    this.agentManager = new AgentManager(this.instanceId, this.ctxRoot, frameworkRoot, org);

    // Start IPC server
    this.ipcServer = new IPCServer(this.agentManager, this.instanceId, this.ctxRoot);
    await this.ipcServer.start();

    // Discover and start agents
    await this.agentManager.discoverAndStart();

    // PM2 wait_ready contract: IPC is bound and discovery has completed.
    process.send?.('ready');

    console.log(`[daemon] Running (pid: ${process.pid})`);

    // Handle shutdown signals
    const shutdown = async () => {
      console.log('[daemon] Shutting down...');
      // Quiesce the control plane before the manager sets its shutdown latch;
      // no new lifecycle or injection request may enter during teardown.
      if (this.ipcServer) {
        this.ipcServer.stop();
      }
      try {
        if (this.agentManager) {
          await this.agentManager.stopAll();
        }
      } catch (err) {
        console.error('[daemon] Error during shutdown:', err);
      }
      cleanupForExit();
      process.exit(0);
    };

    // BUG-003 fix: re-entrancy guard. A second SIGTERM arriving while
    // shutdown() is in flight would start a parallel stopAll(), causing
    // unpredictable signal cascades across child PTY processes.
    let shuttingDown = false;
    const handleSignal = () => {
      if (shuttingDown) {
        console.log('[daemon] Shutdown already in progress, ignoring signal');
        return;
      }
      shuttingDown = true;
      shutdown().catch((err) => {
        console.error('[daemon] Fatal shutdown error:', err);
        process.exit(1);
      });
    };

    process.on('SIGINT', handleSignal);
    process.on('SIGTERM', handleSignal);
    process.on('message', (message) => {
      if (!isPm2ShutdownMessage(message)) return;
      console.log('[daemon] PM2 requested graceful shutdown');
      handleSignal();
    });

    // Global fatal-error handlers. uncaughtException exits for PM2 respawn.
    // Both paths exit through PM2 recovery. Continuing after an unhandled
    // rejection can leave registry, poller, and PTY state partially mutated.
    // The synchronous exit hook below force-stops every owned process tree.
    const ctxRootForHandler = this.ctxRoot;
    const frameworkRootForHandler = frameworkRoot;
    process.on('uncaughtException', (err) => {
      handleFatal('uncaughtException', err, ctxRootForHandler, frameworkRootForHandler, true);
    });
    process.on('unhandledRejection', (reason) => {
      handleFatal('unhandledRejection', reason, ctxRootForHandler, frameworkRootForHandler, true);
    });
    console.log('[daemon] Fatal-error handlers registered (uncaughtException + unhandledRejection)');

    // Debug-only: SIGUSR2 induces a controlled uncaughtException for
    // live crash-path verification. Off in production unless
    // CTX_DEBUG_ALLOW_CRASH_TRIGGER=1 is explicitly set. See docs/debugging.md.
    if (process.env.CTX_DEBUG_ALLOW_CRASH_TRIGGER === '1') {
      process.on('SIGUSR2', () => {
        console.error('[daemon] SIGUSR2 received — inducing test crash (CTX_DEBUG_ALLOW_CRASH_TRIGGER=1)');
        throw new Error('Simulated daemon crash via SIGUSR2 (test harness)');
      });
      console.log('[daemon] SIGUSR2 crash trigger ENABLED (debug mode)');
    }

  }
}

// Only auto-start when run directly (e.g. `node dist/daemon.js` or via PM2).
// Guarding with require.main prevents accidental daemon spawn when the module
// is require()'d for testing or class imports — which would start a full daemon
// with TelegramPollers, IPC server, and Claude PTY processes as a side effect.
// See: https://github.com/grandamenium/cortextos/issues/44
if (require.main === module) {
  const daemon = new Daemon();
  daemon.start().catch(err => {
    console.error('[daemon] Fatal error:', err);

    // Startup failures must feed the same crash-history + operator-alert
    // machinery as runtime crashes. Before this, a duplicate-daemon lock
    // conflict under PM2 autorestart looped "Fatal error → exit → respawn"
    // silently — 17k+ restarts over a day with zero operator pages
    // (2026-07-01 incident). The alert helper self-throttles via
    // history.lastAlertAt (30-min cooldown), so the loop can't spam.
    //
    // Deliberately NOT handleFatal(): that writes .daemon-crashed markers
    // for every agent, which would be false alarms here — on a lock
    // conflict the fleet is alive and healthy under the daemon that holds
    // the lock.
    try {
      const instanceId = process.env.CTX_INSTANCE_ID || 'default';
      const ctxRoot = join(homedir(), '.cortextos', instanceId);
      const frameworkRoot = process.env.CTX_FRAMEWORK_ROOT || '';
      const errStr = err instanceof Error ? err.message : String(err);
      const isLockConflict = /already running/i.test(errStr);
      const history = recordCrash(ctxRoot, errStr);
      if (shouldSendCrashLoopAlert(history)) {
        const recent = countRecentCrashes(history);
        const detail = isLockConflict
          ? `Duplicate-daemon lock conflict: PM2 keeps respawning a daemon that dies against the instance lock held by pid ${readPidBestEffort(ctxRoot)}. ` +
            `The fleet may still be running under that orphaned daemon, but PM2 no longer manages it. ` +
            `Run the health script, stop the PM2 competitor loop, drain the orphan with cortextos stop --all, ` +
            `terminate only the exact daemon.pid owner, then run cortextos start --instance ${instanceId}.`
          : errStr;
        if (sendCrashLoopAlertBestEffort(frameworkRoot, recent, detail)) {
          history.lastAlertAt = new Date().toISOString();
          writeCrashHistory(ctxRoot, history);
        }
      }
    } catch { /* alerting is best-effort — never mask the original failure */ }

    process.exit(1);
  });
}

function readPidBestEffort(ctxRoot: string): string {
  try {
    return readFileSync(join(ctxRoot, 'daemon.pid'), 'utf-8').trim() || 'unknown';
  } catch {
    return 'unknown';
  }
}
