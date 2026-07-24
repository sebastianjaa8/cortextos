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
  attempts = PROCESS_IDENTITY_PROBE_ATTEMPTS,
): ProcessIdentity | null {
  const maxAttempts = Math.max(1, Math.floor(attempts));
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const probe = probeProcessIdentity(pid);
    if (probe.status === 'present') return probe.identity;
    if (probe.status === 'absent') return null;
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
  const processIdentity = inspectProcessIdentityWithRetry(input.pid);
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
  } else {
    try { process.kill(-pid, 'SIGKILL'); } catch {
      try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
    }
  }
  return probeProcessIdentity(pid).status === 'absent';
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
