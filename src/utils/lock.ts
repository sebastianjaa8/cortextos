import {
  mkdirSync,
  existsSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'fs';
import { randomBytes } from 'crypto';
import { join, resolve } from 'path';
import { inspectProcessIdentity, probeProcessIdentity, processIdentityEquals } from './process-ownership.js';

const METADATA_FILE = 'metadata.json';
const HEARTBEAT_FILE = 'heartbeat';
const PID_FILE = 'pid';
const DEFAULT_METADATA_GRACE_MS = 2_000;
const GUARD_STALE_MS = 30_000;
const RELEASE_WAIT_MS = GUARD_STALE_MS + 1_000;
const SLEEP_SAB = new SharedArrayBuffer(4);
const SLEEP_VIEW = new Int32Array(SLEEP_SAB);

interface LockMetadata {
  version: 1;
  ownerToken: string;
  pid: number;
  createdAt: string;
  processStartedAtMs: number;
  bootId?: string;
  processStartIdentity?: string;
}

export interface AcquireLockOptions {
  /**
   * Heartbeat age after which a lock with an unprovable owner may be
   * reclaimed. A lock whose live PID and process identity still match is
   * never stolen solely because its heartbeat is old.
   */
  staleAfterMs?: number;
  /** Grace for a new lock whose owner has not published valid metadata yet. */
  metadataGraceMs?: number;
}

export type LockMutationResult =
  | { status: 'ok' }
  | { status: 'ownership-lost' }
  | { status: 'not-owned' }
  | { status: 'busy' };

const HELD_LOCKS = new Map<string, string>();
const PROCESS_STARTED_AT_MS = Date.now() - Math.floor(process.uptime() * 1_000);
const BOOT_ID = readBootId();
const PROCESS_IDENTITY = inspectProcessIdentity(process.pid);
const PROCESS_START_IDENTITY = PROCESS_IDENTITY?.startIdentity ?? readProcessStartIdentity(process.pid);

function readBootId(): string | undefined {
  if (process.platform !== 'linux') return undefined;
  try {
    return readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() || undefined;
  } catch {
    return undefined;
  }
}

function readProcessStartIdentity(pid: number): string | undefined {
  if (process.platform !== 'linux') return undefined;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const commandEnd = stat.lastIndexOf(')');
    if (commandEnd < 0) return undefined;
    // Fields after the command begin at field 3; starttime is field 22.
    return stat.slice(commandEnd + 2).trim().split(/\s+/)[19] || undefined;
  } catch {
    return undefined;
  }
}

function ownerKey(dir: string): string {
  return resolve(dir);
}

function newOwnerToken(): string {
  return randomBytes(32).toString('hex');
}

function lockPaths(dir: string) {
  const lockDir = join(dir, '.lock.d');
  return {
    lockDir,
    metadataFile: join(lockDir, METADATA_FILE),
    heartbeatFile: join(lockDir, HEARTBEAT_FILE),
    pidFile: join(lockDir, PID_FILE),
  };
}

function metadataFor(ownerToken: string): LockMetadata {
  return {
    version: 1,
    ownerToken,
    pid: process.pid,
    createdAt: new Date().toISOString(),
    processStartedAtMs: PROCESS_STARTED_AT_MS,
    ...(BOOT_ID ? { bootId: BOOT_ID } : {}),
    ...(PROCESS_START_IDENTITY ? { processStartIdentity: PROCESS_START_IDENTITY } : {}),
  };
}

function isMetadata(value: unknown): value is LockMetadata {
  if (!value || typeof value !== 'object') return false;
  const metadata = value as Partial<LockMetadata>;
  return metadata.version === 1
    && typeof metadata.ownerToken === 'string'
    && /^[a-f0-9]{64}$/.test(metadata.ownerToken)
    && Number.isSafeInteger(metadata.pid)
    && (metadata.pid ?? 0) > 0
    && typeof metadata.createdAt === 'string'
    && typeof metadata.processStartedAtMs === 'number';
}

function readMetadata(metadataFile: string): LockMetadata | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(metadataFile, 'utf8'));
    return isMetadata(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function atomicWrite(file: string, content: string): void {
  const temp = `${file}.${process.pid}.${newOwnerToken()}.tmp`;
  try {
    writeFileSync(temp, content, { encoding: 'utf8', mode: 0o600 });
    renameSync(temp, file);
  } catch (err) {
    try {
      rmSync(temp, { force: true });
    } catch {
      // Preserve the original write error.
    }
    throw err;
  }
}

function publishLock(dir: string, ownerToken: string): void {
  const paths = lockPaths(dir);
  atomicWrite(paths.metadataFile, JSON.stringify(metadataFor(ownerToken)));
  atomicWrite(paths.heartbeatFile, JSON.stringify({
    ownerToken,
    touchedAt: new Date().toISOString(),
  }));
  // Kept for diagnostics and backward-compatible daemon PID reporting.
  atomicWrite(paths.pidFile, String(process.pid));
}

function quarantinePath(dir: string, kind: string): string {
  return join(dir, `.${kind}.${process.pid}.${newOwnerToken()}`);
}

interface GuardLease {
  dir: string;
  token: string;
}

interface GuardOwner {
  pid: number;
  startIdentity?: string;
}

function createGuard(guardDir: string): GuardLease | undefined {
  const token = newOwnerToken();
  let created = false;
  try {
    mkdirSync(guardDir);
    created = true;
    const owner: GuardOwner = {
      pid: process.pid,
      ...(PROCESS_START_IDENTITY ? { startIdentity: PROCESS_START_IDENTITY } : {}),
    };
    writeFileSync(join(guardDir, token), JSON.stringify(owner), { flag: 'wx', mode: 0o600 });
    return { dir: guardDir, token };
  } catch (err) {
    if (created) {
      try {
        rmdirSync(guardDir);
      } catch {
        // A competing guard has already populated or replaced this directory.
      }
    }
    if ((err as NodeJS.ErrnoException).code === 'EEXIST'
      || (err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
}

function guardStillOwned(guard: GuardLease): boolean {
  return existsSync(join(guard.dir, guard.token));
}

function guardOwnerIsLive(guardDir: string): boolean {
  try {
    const marker = readdirSync(guardDir).find(name => /^[a-f0-9]{64}$/.test(name));
    if (!marker) return false;
    const owner = JSON.parse(readFileSync(join(guardDir, marker), 'utf8')) as Partial<GuardOwner>;
    if (!Number.isSafeInteger(owner.pid) || (owner.pid ?? 0) <= 0) return false;
    const current = inspectProcessIdentity(owner.pid!);
    if (owner.startIdentity) {
      if (current) {
        return processIdentityEquals(
          { pid: owner.pid!, startIdentity: owner.startIdentity },
          current,
        );
      }
      // Identity inspection can fail transiently. A still-live PID is not safe
      // to steal from merely because its identity could not be re-read.
      try {
        process.kill(owner.pid!, 0);
        return true;
      } catch (err) {
        return (err as NodeJS.ErrnoException).code === 'EPERM';
      }
    }
    try {
      process.kill(owner.pid!, 0);
      return true;
    } catch (err) {
      return (err as NodeJS.ErrnoException).code === 'EPERM';
    }
  } catch {
    return false;
  }
}

function tryAcquireGuard(dir: string): GuardLease | undefined {
  const guardDir = join(dir, '.lock.guard');
  const fresh = createGuard(guardDir);
  if (fresh) return fresh;

  try {
    if (Date.now() - statSync(guardDir).mtimeMs <= GUARD_STALE_MS) return undefined;
  } catch {
    return undefined;
  }
  if (guardOwnerIsLive(guardDir)) return undefined;

  const quarantine = quarantinePath(dir, 'lock.guard.stale');
  try {
    renameSync(guardDir, quarantine);
  } catch {
    return undefined;
  }

  try {
    rmSync(quarantine, { recursive: true, force: true });
    return createGuard(guardDir);
  } catch {
    return undefined;
  }
}

function releaseGuard(guard: GuardLease): void {
  try {
    // A successor has a different filename, so this cannot remove its marker.
    rmSync(join(guard.dir, guard.token), { force: true });
    rmdirSync(guard.dir);
  } catch {
    // A crashed process leaves a bounded-lifetime guard.
  }
}

function processStatus(
  metadata: LockMetadata,
  verifyStartIdentity: boolean,
): 'live' | 'dead' | 'unknown' {
  try {
    process.kill(metadata.pid, 0);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return 'dead';
    if (code === 'EPERM') return 'live';
    return 'unknown';
  }

  if (metadata.bootId && BOOT_ID && metadata.bootId !== BOOT_ID) return 'dead';
  // Ordinary short-lived file locks do not enable stale reclamation. Once the
  // PID is known live, rejecting acquisition is both safe and avoids launching
  // a synchronous Windows PowerShell identity probe on every retry.
  if (!verifyStartIdentity) return 'live';
  if (metadata.processStartIdentity) {
    const probe = probeProcessIdentity(metadata.pid);
    if (probe.status === 'present') {
      return probe.identity.startIdentity === metadata.processStartIdentity ? 'live' : 'dead';
    }
    if (probe.status === 'absent') return 'dead';
    const currentIdentity = readProcessStartIdentity(metadata.pid);
    if (currentIdentity) return currentIdentity === metadata.processStartIdentity ? 'live' : 'dead';
    // The PID liveness check above succeeded. An unavailable identity probe is
    // not permission to steal a live daemon lock, regardless of heartbeat age.
    return 'live';
  }
  if (metadata.pid === process.pid
    && Math.abs(metadata.processStartedAtMs - PROCESS_STARTED_AT_MS) > 5_000) return 'dead';
  return 'unknown';
}

function lockAgeMs(lockDir: string): number {
  try {
    return Math.max(0, Date.now() - statSync(lockDir).mtimeMs);
  } catch {
    return 0;
  }
}

function heartbeatAgeMs(heartbeatFile: string, lockDir: string): number {
  try {
    return Math.max(0, Date.now() - statSync(heartbeatFile).mtimeMs);
  } catch {
    return lockAgeMs(lockDir);
  }
}

function installFreshLock(
  dir: string,
  staleLockDir: string,
  guard: GuardLease,
  expectedOwnerToken: string | null,
): boolean {
  const paths = lockPaths(dir);
  const ownerToken = newOwnerToken();
  const quarantine = quarantinePath(dir, 'lock.stale');

  try {
    if (!guardStillOwned(guard)) return false;
    const currentOwnerToken = readMetadata(paths.metadataFile)?.ownerToken ?? null;
    if (currentOwnerToken !== expectedOwnerToken) return false;
    renameSync(staleLockDir, quarantine);
    mkdirSync(paths.lockDir);
    publishLock(dir, ownerToken);
    HELD_LOCKS.set(ownerKey(dir), ownerToken);
    try {
      rmSync(quarantine, { recursive: true, force: true });
    } catch {
      // The fresh fenced lock is valid; stale quarantine cleanup is best-effort.
    }
    return true;
  } catch (err) {
    try {
      rmSync(paths.lockDir, { recursive: true, force: true });
      renameSync(quarantine, staleLockDir);
    } catch {
      // Preserve the acquisition error; the guard excludes successors here.
    }
    if ((err as NodeJS.ErrnoException).code === 'EEXIST'
      || (err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}

/** Acquire a token-fenced mutex while retaining the existing boolean API. */
export function acquireLock(dir: string, opts: AcquireLockOptions = {}): boolean {
  const guard = tryAcquireGuard(dir);
  if (!guard) return false;

  try {
    const paths = lockPaths(dir);
    try {
      if (!guardStillOwned(guard)) return false;
      mkdirSync(paths.lockDir);
      const ownerToken = newOwnerToken();
      publishLock(dir, ownerToken);
      HELD_LOCKS.set(ownerKey(dir), ownerToken);
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
        try {
          rmSync(paths.lockDir, { recursive: true, force: true });
        } catch {
          // Preserve the acquisition error.
        }
        throw err;
      }
    }

    const metadata = readMetadata(paths.metadataFile);
    const metadataGraceMs = opts.metadataGraceMs ?? DEFAULT_METADATA_GRACE_MS;
    if (!metadata) {
      return lockAgeMs(paths.lockDir) > metadataGraceMs
        ? installFreshLock(dir, paths.lockDir, guard, null)
        : false;
    }

    const status = processStatus(metadata, opts.staleAfterMs !== undefined);
    if (status === 'live') return false;
    if (status === 'unknown') {
      const staleAfterMs = opts.staleAfterMs;
      if (staleAfterMs === undefined
        || heartbeatAgeMs(paths.heartbeatFile, paths.lockDir) <= staleAfterMs) return false;
    }
    return installFreshLock(dir, paths.lockDir, guard, metadata.ownerToken);
  } finally {
    releaseGuard(guard);
  }
}

/** Refresh the separate heartbeat only while our token still owns the lock. */
export function touchLock(dir: string): LockMutationResult {
  const key = ownerKey(dir);
  const ownerToken = HELD_LOCKS.get(key);
  if (!ownerToken) return { status: 'not-owned' };

  const guard = tryAcquireGuard(dir);
  if (!guard) return { status: 'busy' };
  try {
    const paths = lockPaths(dir);
    if (readMetadata(paths.metadataFile)?.ownerToken !== ownerToken) {
      HELD_LOCKS.delete(key);
      return { status: 'ownership-lost' };
    }
    if (!guardStillOwned(guard)) return { status: 'busy' };
    atomicWrite(paths.heartbeatFile, JSON.stringify({
      ownerToken,
      touchedAt: new Date().toISOString(),
    }));
    return { status: 'ok' };
  } catch {
    if (readMetadata(lockPaths(dir).metadataFile)?.ownerToken !== ownerToken) {
      HELD_LOCKS.delete(key);
      return { status: 'ownership-lost' };
    }
    return { status: 'busy' };
  } finally {
    releaseGuard(guard);
  }
}

/** Release only while immutable metadata still carries our owner token. */
export function releaseLock(dir: string): LockMutationResult {
  const key = ownerKey(dir);
  const ownerToken = HELD_LOCKS.get(key);
  if (!ownerToken) return { status: 'not-owned' };

  const start = process.hrtime.bigint();
  const timeoutNs = BigInt(RELEASE_WAIT_MS) * 1_000_000n;
  let guard = tryAcquireGuard(dir);
  let backoff = 5;
  while (!guard && process.hrtime.bigint() - start <= timeoutNs) {
    Atomics.wait(SLEEP_VIEW, 0, 0, backoff);
    backoff = Math.min(backoff * 2, 100);
    guard = tryAcquireGuard(dir);
  }
  if (!guard) return { status: 'busy' };
  try {
    const paths = lockPaths(dir);
    if (readMetadata(paths.metadataFile)?.ownerToken !== ownerToken) {
      HELD_LOCKS.delete(key);
      return { status: 'ownership-lost' };
    }
    if (!guardStillOwned(guard)) return { status: 'busy' };

    const quarantine = quarantinePath(dir, 'lock.released');
    renameSync(paths.lockDir, quarantine);
    HELD_LOCKS.delete(key);
    try {
      rmSync(quarantine, { recursive: true, force: true });
    } catch {
      // The lock was atomically released; quarantine cleanup is best-effort.
    }
    return { status: 'ok' };
  } catch {
    if (readMetadata(lockPaths(dir).metadataFile)?.ownerToken !== ownerToken) {
      HELD_LOCKS.delete(key);
      return { status: 'ownership-lost' };
    }
    return { status: 'busy' };
  } finally {
    releaseGuard(guard);
  }
}

export interface FileLockOptions {
  /** Total time to wait for the lock before throwing. Default 5000ms. */
  timeoutMs?: number;
  /** First retry delay; doubles up to maxBackoffMs. Default 5ms. */
  initialBackoffMs?: number;
  /** Cap on retry delay. Default 100ms. */
  maxBackoffMs?: number;
}

/** Acquire `dir`'s mutex, run `fn`, then release even if `fn` throws. */
export function withFileLockSync<T>(
  dir: string,
  fn: () => T,
  opts: FileLockOptions = {},
): T {
  const timeoutMs = opts.timeoutMs ?? 5_000;
  const initBackoff = opts.initialBackoffMs ?? 5;
  const maxBackoff = opts.maxBackoffMs ?? 100;
  const start = process.hrtime.bigint();
  const timeoutNs = BigInt(timeoutMs) * 1_000_000n;
  let backoff = initBackoff;

  while (!acquireLock(dir)) {
    if (process.hrtime.bigint() - start > timeoutNs) {
      throw new Error(
        `withFileLockSync: failed to acquire lock on \u0022${dir}\u0022 within ${timeoutMs}ms`,
      );
    }
    Atomics.wait(SLEEP_VIEW, 0, 0, backoff);
    backoff = Math.min(backoff * 2, maxBackoff);
  }

  try {
    return fn();
  } finally {
    const released = releaseLock(dir);
    if (released.status !== 'ok') {
      throw new Error(`withFileLockSync: lock release failed (${released.status}) on \u0022${dir}\u0022`);
    }
  }
}
