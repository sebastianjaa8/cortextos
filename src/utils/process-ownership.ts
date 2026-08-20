import {
  existsSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  renameSync,
  unlinkSync,
} from 'fs';
import { platform } from 'os';
import { basename, join } from 'path';
import { randomBytes } from 'crypto';
import { execFileSync, spawnSync } from 'child_process';
import { atomicWriteDurableSync } from './atomic.js';

export const AGENT_PROCESS_RECORD = 'agent-process.json';
export const AGENT_PROCESS_RECORDS_DIR = 'agent-processes';

// Synchronous sleep for the post-SIGKILL confirmation poll below. Same pattern
// as lock.ts's own Atomics.wait-based backoff — this file's callers
// (reconcileRuntimeProcesses) are synchronous, so an async setTimeout sleep is
// not usable here.
const SLEEP_SAB = new SharedArrayBuffer(4);
const SLEEP_VIEW = new Int32Array(SLEEP_SAB);
function sleepSync(ms: number): void {
  Atomics.wait(SLEEP_VIEW, 0, 0, ms);
}

/**
 * Linux-only: is this PID gone from the process table, OR a zombie (exited,
 * awaiting reap by its parent)? Used ONLY to confirm a SIGKILL took effect —
 * NOT a general identity check (probeProcessIdentity remains that, unchanged,
 * and correctly still reports a zombie as 'present' for callers that
 * genuinely need to know the PID slot has not been recycled yet).
 *
 * FIX (Codex review, 2026-08-20, task_1787187446702): the original retry poll
 * called probeProcessIdentity() in a loop, but that function ignores procfs'
 * own STATE field (field 3 of /proc/pid/stat) -- a killed-but-not-yet-reaped
 * zombie still reads 'present' there, so the poll could spin for its entire
 * budget even though the kill demonstrably succeeded. Worse, when the target
 * was a child THIS process spawned (as in the regression test), the
 * synchronous Atomics.wait-based poll blocks the JS event loop, which is
 * EXACTLY what Node needs to run to process the child's exit and reap it --
 * a self-inflicted deadlock where our own wait prevents the very reap we are
 * waiting for. Reading the zombie state directly sidesteps both problems: we
 * do not need the process reaped at all to know the kill worked.
 */
function isPidGoneOrZombie(pid: number): boolean {
  // /proc is Linux-only. On macOS (the only other non-Windows platform this
  // file supports) there is no procfs to read at all -- readFileSync would
  // ALWAYS throw ENOENT there regardless of whether the PID is actually
  // still alive, which would make this function report "gone" immediately
  // on the very first poll, defeating the retry entirely. Fall back to the
  // ordinary identity probe there, same as before this fix.
  if (platform() !== 'linux') return probeProcessIdentity(pid).status === 'absent';
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const commandEnd = stat.lastIndexOf(')');
    if (commandEnd < 0) return false;
    const state = stat.slice(commandEnd + 2).trim().split(/\s+/)[0];
    return state === 'Z';
  } catch (err) {
    // ENOENT: the PID is fully gone (reaped, or never existed here).
    return (err as NodeJS.ErrnoException).code === 'ENOENT';
  }
}

export interface ProcessIdentity {
  pid: number;
  startIdentity: string;
  executablePath: string;
}

export type ProcessIdentityProbe =
  | { status: 'present'; identity: ProcessIdentity }
  | { status: 'absent' }
  | { status: 'unknown' };

const PROCESS_IDENTITY_PROBE_ATTEMPTS = 3;
const SPAWNED_PROCESS_IDENTITY_PROBE_ATTEMPTS = 5;
let cachedDaemonIdentity: ProcessIdentity | null = null;

export interface RuntimeProcessRecord {
  version: 1;
  ownerToken: string;
  instanceId: string;
  agentName: string;
  runtime: string;
  pid: number;
  processStartIdentity: string;
  executablePath: string;
  daemonPid: number;
  daemonStartIdentity: string;
  createdAt: string;
}

export interface ReconcileOutcome {
  agentName: string;
  pid?: number;
  status: 'killed-orphan' | 'stale-record' | 'invalid-record' | 'failed';
  detail: string;
}

function powershellPath(): string {
  const root = process.env.SystemRoot;
  return root
    ? join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    : 'powershell.exe';
}

/** Distinguish a missing PID from an identity probe that could not be trusted. */
export function probeProcessIdentity(pid: number): ProcessIdentityProbe {
  if (!Number.isSafeInteger(pid) || pid <= 0) return { status: 'absent' };
  if (platform() === 'win32') {
    const command = [
      `$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue`,
      `if ($null -eq $p) { @{ status = 'absent' } | ConvertTo-Json -Compress; exit 0 }`,
      `$path = try { $p.Path } catch { '' }`,
      `$start = try { $p.StartTime.ToUniversalTime().Ticks.ToString() } catch { exit 2 }`,
      `@{ status = 'present'; pid = $p.Id; startIdentity = $start; executablePath = $path } | ConvertTo-Json -Compress`,
    ].join('; ');
    const result = spawnSync(powershellPath(), ['-NoProfile', '-NonInteractive', '-Command', command], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 5_000,
    }) as ReturnType<typeof spawnSync> | undefined;
    if (!result || result.status !== 0 || typeof result.stdout !== 'string' || !result.stdout) {
      return { status: 'unknown' };
    }
    try {
      const parsed = JSON.parse(result.stdout) as Partial<ProcessIdentity> & { status?: unknown };
      if (parsed.status === 'absent') return { status: 'absent' };
      if (
        parsed.status === 'present'
        && typeof parsed.pid === 'number'
        && typeof parsed.startIdentity === 'string'
        && typeof parsed.executablePath === 'string'
      ) {
        return {
          status: 'present',
          identity: {
            pid: parsed.pid,
            startIdentity: parsed.startIdentity,
            executablePath: parsed.executablePath,
          },
        };
      }
      return { status: 'unknown' };
    } catch {
      return { status: 'unknown' };
    }
  }

  if (platform() !== 'linux') {
    try {
      process.kill(pid, 0);
      return { status: 'unknown' };
    } catch (err) {
      return (err as NodeJS.ErrnoException).code === 'ESRCH'
        ? { status: 'absent' }
        : { status: 'unknown' };
    }
  }

  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const endComm = stat.lastIndexOf(')');
    if (endComm < 0) return { status: 'unknown' };
    const fieldsFromState = stat.slice(endComm + 2).trim().split(/\s+/);
    const startTicks = fieldsFromState[19];
    if (!startTicks) return { status: 'unknown' };
    let bootId = 'unknown-boot';
    try { bootId = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(); } catch { /* non-Linux POSIX */ }
    let executablePath = '';
    try { executablePath = readlinkSync(`/proc/${pid}/exe`); } catch { /* permission or process exit */ }
    return {
      status: 'present',
      identity: { pid, startIdentity: `${bootId}:${startTicks}`, executablePath },
    };
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT'
      ? { status: 'absent' }
      : { status: 'unknown' };
  }
}

/** Compatibility helper for callers that do not make destructive decisions. */
export function inspectProcessIdentity(pid: number): ProcessIdentity | null {
  const probe = probeProcessIdentity(pid);
  return probe.status === 'present' ? probe.identity : null;
}

/** Retry only inconclusive probes; confirmed absence is authoritative. */
export function inspectProcessIdentityWithRetry(
  pid: number,
  options: { attempts?: number; retryAbsent?: boolean } = {},
): ProcessIdentity | null {
  const maxAttempts = Math.max(1, Math.floor(options.attempts ?? PROCESS_IDENTITY_PROBE_ATTEMPTS));
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const probe = probeProcessIdentity(pid);
    if (probe.status === 'present') return probe.identity;
    if (probe.status === 'absent' && !options.retryAbsent) return null;
  }
  return null;
}

export function processIdentityEquals(
  expected: Pick<ProcessIdentity, 'pid' | 'startIdentity'>,
  current: ProcessIdentity | null,
): boolean {
  return current !== null
    && current.pid === expected.pid
    && current.startIdentity === expected.startIdentity;
}

export function processIdentityMatches(
  record: Pick<RuntimeProcessRecord, 'pid' | 'processStartIdentity' | 'executablePath'>,
  current: ProcessIdentity | null,
): boolean {
  if (!current || !processIdentityEquals(
    { pid: record.pid, startIdentity: record.processStartIdentity },
    current,
  )) return false;
  if (!record.executablePath || !current.executablePath) return true;
  return record.executablePath.toLowerCase() === current.executablePath.toLowerCase();
}

export function writeRuntimeProcessRecord(
  stateDir: string,
  input: Pick<RuntimeProcessRecord, 'instanceId' | 'agentName' | 'runtime' | 'pid'>,
): RuntimeProcessRecord {
  const processIdentity = inspectProcessIdentityWithRetry(input.pid, {
    attempts: SPAWNED_PROCESS_IDENTITY_PROBE_ATTEMPTS,
    retryAbsent: true,
  });
  const daemonIdentity = cachedDaemonIdentity
    ?? inspectProcessIdentityWithRetry(process.pid);
  if (!processIdentity || !daemonIdentity) {
    throw new Error(`Cannot prove process identity for agent PID ${input.pid}`);
  }
  cachedDaemonIdentity = daemonIdentity;
  const record: RuntimeProcessRecord = {
    version: 1,
    ownerToken: randomBytes(32).toString('hex'),
    ...input,
    processStartIdentity: processIdentity.startIdentity,
    executablePath: processIdentity.executablePath,
    daemonPid: process.pid,
    daemonStartIdentity: daemonIdentity.startIdentity,
    createdAt: new Date().toISOString(),
  };
  const recordsDir = join(stateDir, AGENT_PROCESS_RECORDS_DIR);
  mkdirSync(recordsDir, { recursive: true });
  atomicWriteDurableSync(join(recordsDir, `${record.ownerToken}.json`), JSON.stringify(record, null, 2));
  return record;
}

export function removeRuntimeProcessRecord(stateDir: string, ownerToken: string | null): boolean {
  if (!ownerToken) return false;
  const candidates = [
    join(stateDir, AGENT_PROCESS_RECORDS_DIR, `${ownerToken}.json`),
    join(stateDir, AGENT_PROCESS_RECORD),
  ];
  for (const path of candidates) {
    try {
      const record = JSON.parse(readFileSync(path, 'utf8')) as RuntimeProcessRecord;
      if (record.ownerToken !== ownerToken) continue;
      unlinkSync(path);
      return true;
    } catch {
      // Try the legacy location before reporting failure.
    }
  }
  return false;
}

function quarantineRecord(path: string, reason: string): void {
  const stem = basename(path, '.json');
  renameSync(path, join(path, '..', `${stem}.${reason}-${Date.now()}-${randomBytes(4).toString('hex')}.json`));
}

function parseRecord(path: string): RuntimeProcessRecord | null {
  try {
    const record = JSON.parse(readFileSync(path, 'utf8')) as Partial<RuntimeProcessRecord>;
    return record.version === 1
      && typeof record.ownerToken === 'string'
      && /^[a-f0-9]{64}$/.test(record.ownerToken)
      && typeof record.instanceId === 'string'
      && typeof record.agentName === 'string'
      && typeof record.runtime === 'string'
      && typeof record.pid === 'number'
      && typeof record.processStartIdentity === 'string'
      && typeof record.executablePath === 'string'
      && typeof record.daemonPid === 'number'
      && typeof record.daemonStartIdentity === 'string'
      && typeof record.createdAt === 'string'
      ? record as RuntimeProcessRecord
      : null;
  } catch {
    return null;
  }
}

export function terminateProcessTree(
  pid: number,
  expected: Pick<ProcessIdentity, 'pid' | 'startIdentity'>,
): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid) return false;
  const before = probeProcessIdentity(pid);
  if (before.status !== 'present' || !processIdentityEquals(expected, before.identity)) return false;
  if (platform() === 'win32') {
    try {
      execFileSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
        timeout: 15_000,
      });
    } catch {
      // taskkill returns non-zero when the process exited between inspection and termination.
    }
    return probeProcessIdentity(pid).status === 'absent';
  }
  // Non-Windows only below this point. taskkill.exe above already blocks
  // synchronously until Windows confirms termination (or its own 15s
  // timeout), so a retry poll there would only add cost (each probe spawns a
  // PowerShell subprocess, per Codex review) with no correctness benefit --
  // gated out entirely, matching the original single-check behavior there.
  try { process.kill(-pid, 'SIGKILL'); } catch {
    try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
  }
  // FIX (2026-08-20, task_1787187446702): SIGKILL delivery is asynchronous at
  // the OS level -- the kernel schedules termination, it does not guarantee
  // the process has been reaped by the time kill() returns. A single
  // immediate check right after sending the signal is a real race: on a
  // loaded/throttled CI runner the reap can take longer than on an idle dev
  // machine, producing a false "survived forced termination" verdict for a
  // kill that in fact succeeded a few milliseconds later. Poll briefly
  // instead, using isPidGoneOrZombie() rather than probeProcessIdentity() --
  // the latter ignores procfs' own zombie state and would keep reporting
  // 'present' for a process the kernel has already killed but not yet
  // reaped, which (per Codex review) can never resolve here: this
  // synchronous Atomics.wait poll blocks the event loop, which is exactly
  // what Node needs free to run in order to reap a child THIS process
  // spawned -- a self-inflicted deadlock. A zombie is "as dead as we need to
  // know" for this function's purpose regardless of who eventually reaps it.
  const deadlineNs = process.hrtime.bigint() + 2_000_000_000n; // monotonic, not wall-clock
  while (process.hrtime.bigint() < deadlineNs) {
    if (isPidGoneOrZombie(pid)) return true;
    sleepSync(50);
  }
  return isPidGoneOrZombie(pid);
}

/**
 * Reconcile records left by a dead daemon before any new agent is spawned.
 * PID start identity and executable path prevent stale-record PID reuse kills.
 */
export function reconcileRuntimeProcesses(ctxRoot: string, instanceId: string): ReconcileOutcome[] {
  const outcomes: ReconcileOutcome[] = [];
  const stateRoot = join(ctxRoot, 'state');
  if (!existsSync(stateRoot)) return outcomes;

  for (const entry of readdirSync(stateRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const stateDir = join(stateRoot, entry.name);
    const paths: string[] = [];
    const legacy = join(stateDir, AGENT_PROCESS_RECORD);
    if (existsSync(legacy)) paths.push(legacy);
    const recordsDir = join(stateDir, AGENT_PROCESS_RECORDS_DIR);
    if (existsSync(recordsDir)) {
      try {
        paths.push(...readdirSync(recordsDir)
          .filter(name => /^[a-f0-9]{64}\.json$/.test(name))
          .map(name => join(recordsDir, name)));
      } catch {
        // A later health pass can report an unreadable records directory.
      }
    }

    for (const path of paths) {
      const record = parseRecord(path);
      if (!record || record.agentName !== entry.name || record.instanceId !== instanceId) {
        try { quarantineRecord(path, 'invalid'); } catch { /* preserve for manual inspection */ }
        outcomes.push({ agentName: entry.name, status: 'invalid-record', detail: 'ownership metadata invalid' });
        continue;
      }

      const daemonProbe = probeProcessIdentity(record.daemonPid);
      if (daemonProbe.status === 'unknown') {
        outcomes.push({
          agentName: entry.name,
          pid: record.pid,
          status: 'failed',
          detail: 'owning daemon identity could not be inspected; record preserved',
        });
        continue;
      }
      if (daemonProbe.status === 'present' && processIdentityEquals({
        pid: record.daemonPid,
        startIdentity: record.daemonStartIdentity,
      }, daemonProbe.identity)) {
        outcomes.push({
          agentName: entry.name,
          pid: record.pid,
          status: 'failed',
          detail: 'owning daemon generation is still live; child preserved',
        });
        continue;
      }

      const currentProbe = probeProcessIdentity(record.pid);
      if (currentProbe.status === 'unknown') {
        outcomes.push({
          agentName: entry.name,
          pid: record.pid,
          status: 'failed',
          detail: 'child identity could not be inspected; record preserved',
        });
        continue;
      }
      if (currentProbe.status === 'absent' || !processIdentityMatches(record, currentProbe.identity)) {
        try { quarantineRecord(path, 'stale'); } catch { /* preserve for manual inspection */ }
        outcomes.push({ agentName: entry.name, pid: record.pid, status: 'stale-record', detail: 'PID is gone or was reused' });
        continue;
      }

      const expected = { pid: record.pid, startIdentity: record.processStartIdentity };
      if (terminateProcessTree(record.pid, expected)) {
        try { unlinkSync(path); } catch { /* health check will flag any residue */ }
        outcomes.push({ agentName: entry.name, pid: record.pid, status: 'killed-orphan', detail: 'terminated prior daemon process tree' });
      } else {
        outcomes.push({ agentName: entry.name, pid: record.pid, status: 'failed', detail: 'owned process tree survived forced termination' });
      }
    }
  }
  return outcomes;
}
