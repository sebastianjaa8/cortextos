// Upstream (7d26aab) introduced these scenarios against its handle-based,
// pid-file lock. The fork keeps its guard-serialized, token-fenced lock
// (metadata.json + heartbeat + process identity) because the daemon-instance
// lock depends on touchLock/staleAfterMs. Each upstream safety property is
// re-asserted here against the fork's API and on-disk layout: exactly one
// winner under interleaved reclaimers, no reclaim on ambiguous reads or
// ambiguous liveness, corrupt/partial state stays recoverable, and a failed
// or pre-empted publisher never deletes someone else's lock.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const fsMock = vi.hoisted(() => ({
  readFileSync: vi.fn(),
  renameSync: vi.fn(),
  writeFileSync: vi.fn(),
  actualReadFileSync: undefined as typeof import('fs').readFileSync | undefined,
  actualRenameSync: undefined as typeof import('fs').renameSync | undefined,
  actualWriteFileSync: undefined as typeof import('fs').writeFileSync | undefined,
}));

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  fsMock.actualReadFileSync = actual.readFileSync;
  fsMock.actualRenameSync = actual.renameSync;
  fsMock.actualWriteFileSync = actual.writeFileSync;
  fsMock.readFileSync.mockImplementation(actual.readFileSync);
  fsMock.renameSync.mockImplementation(actual.renameSync);
  fsMock.writeFileSync.mockImplementation(actual.writeFileSync);
  return {
    ...actual,
    readFileSync: fsMock.readFileSync,
    renameSync: fsMock.renameSync,
    writeFileSync: fsMock.writeFileSync,
  };
});

import { acquireLock, releaseLock, touchLock } from '../../../src/utils/lock';

const STALE = new Date(Date.now() - 60_000);

function writeMetadata(lockDir: string, content: string): void {
  mkdirSync(lockDir, { recursive: true });
  writeFileSync(join(lockDir, 'metadata.json'), content);
}

function deadOwnerMetadata(): string {
  return JSON.stringify({
    version: 1,
    ownerToken: 'd'.repeat(64),
    pid: 99_999_999,
    createdAt: new Date(0).toISOString(),
    processStartedAtMs: 0,
  });
}

function ownerPid(lockDir: string): number {
  return JSON.parse(readFileSync(join(lockDir, 'metadata.json'), 'utf-8')).pid;
}

describe('lock recovery concurrency and ambiguity', () => {
  let testDir: string;
  let lockDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'cortextos-lock-recovery-'));
    lockDir = join(testDir, '.lock.d');
    fsMock.readFileSync.mockImplementation(fsMock.actualReadFileSync!);
    fsMock.renameSync.mockImplementation(fsMock.actualRenameSync!);
    fsMock.writeFileSync.mockImplementation(fsMock.actualWriteFileSync!);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fsMock.readFileSync.mockImplementation(fsMock.actualReadFileSync!);
    fsMock.renameSync.mockImplementation(fsMock.actualRenameSync!);
    fsMock.writeFileSync.mockImplementation(fsMock.actualWriteFileSync!);
    releaseLock(testDir);
    rmSync(testDir, { recursive: true, force: true });
  });

  it('allows exactly one winner when a second reclaimer arrives while the first is deciding liveness', () => {
    writeMetadata(lockDir, deadOwnerMetadata());
    utimesSync(lockDir, STALE, STALE);

    const actualKill = process.kill.bind(process);
    const killSpy = vi.spyOn(process, 'kill');
    let contender: boolean | undefined;
    killSpy.mockImplementationOnce(((..._args: Parameters<typeof process.kill>) => {
      killSpy.mockImplementation(actualKill);
      contender = acquireLock(testDir);
      throw Object.assign(new Error('process gone'), { code: 'ESRCH' });
    }) as typeof process.kill);

    const first = acquireLock(testDir);

    expect(contender).toBe(false);
    expect(first).toBe(true);
    expect(ownerPid(lockDir)).toBe(process.pid);
    expect(readFileSync(join(lockDir, 'pid'), 'utf-8')).toBe(String(process.pid));
    expect(releaseLock(testDir)).toEqual({ status: 'ok' });
    expect(acquireLock(testDir)).toBe(true);
    expect(releaseLock(testDir)).toEqual({ status: 'ok' });
  });

  it.each(['dead-owner', 'absent', 'empty'])(
    'allows one winner when two reclaimers interleave at generation quarantine (%s metadata)',
    shape => {
      mkdirSync(lockDir);
      if (shape === 'dead-owner') writeMetadata(lockDir, deadOwnerMetadata());
      if (shape === 'empty') writeMetadata(lockDir, '');
      utimesSync(lockDir, STALE, STALE);

      let interleaved = false;
      let contender: boolean | undefined;
      fsMock.renameSync.mockImplementation(((source, destination) => {
        if (!interleaved && source === lockDir) {
          interleaved = true;
          contender = acquireLock(testDir);
        }
        return fsMock.actualRenameSync!(source, destination);
      }) as typeof renameSync);

      const first = acquireLock(testDir);

      expect(interleaved).toBe(true);
      expect([first, contender].filter(Boolean)).toHaveLength(1);
      expect(ownerPid(lockDir)).toBe(process.pid);
      expect(readFileSync(join(lockDir, 'pid'), 'utf-8')).toBe(String(process.pid));
      expect(releaseLock(testDir)).toEqual({ status: 'ok' });
    },
  );

  it('does not age-steal a reclaim guard owned by a live operation', () => {
    // The lock itself is reclaimable (dead owner); only the live guard blocks.
    writeMetadata(lockDir, deadOwnerMetadata());
    utimesSync(lockDir, STALE, STALE);
    const guardDir = join(testDir, '.lock.guard');
    const marker = join(guardDir, 'e'.repeat(64));
    mkdirSync(guardDir);
    writeFileSync(marker, JSON.stringify({ pid: process.pid }));
    utimesSync(guardDir, STALE, STALE);

    expect(acquireLock(testDir, { staleAfterMs: 1, metadataGraceMs: 0 })).toBe(false);
    expect(existsSync(marker)).toBe(true);
    expect(ownerPid(lockDir)).toBe(99_999_999);

    rmSync(guardDir, { recursive: true, force: true });
    expect(acquireLock(testDir)).toBe(true);
  });

  it.each([
    ['without an owner marker', null],
    ['whose owner is dead', JSON.stringify({ pid: 99_999_999 })],
  ])('recovers an old reclaim guard %s', (_label, owner) => {
    const guardDir = join(testDir, '.lock.guard');
    mkdirSync(guardDir);
    if (owner) writeFileSync(join(guardDir, 'f'.repeat(64)), owner);
    utimesSync(guardDir, STALE, STALE);

    expect(acquireLock(testDir)).toBe(true);
    expect(ownerPid(lockDir)).toBe(process.pid);
  });

  it.each(['EACCES', 'EIO', 'EMFILE'])(
    'does not reap a valid live lock when metadata reading fails with %s',
    code => {
      expect(acquireLock(testDir)).toBe(true);
      utimesSync(lockDir, STALE, STALE);
      utimesSync(join(lockDir, 'heartbeat'), STALE, STALE);
      const metadataFile = join(lockDir, 'metadata.json');
      fsMock.readFileSync.mockImplementation(((target, ...rest) => {
        if (target === metadataFile) {
          throw Object.assign(new Error(`transient ${code}`), { code });
        }
        return fsMock.actualReadFileSync!(target, ...rest);
      }) as typeof readFileSync);

      // The most permissive reclaim settings: an unreadable owner must still
      // never be treated as a missing one.
      expect(acquireLock(testDir, { staleAfterMs: 1, metadataGraceMs: 0 })).toBe(false);
      // Ambiguity is retryable, never proof of lost ownership.
      expect(touchLock(testDir)).toEqual({ status: 'busy' });
      expect(releaseLock(testDir)).toEqual({ status: 'busy' });

      fsMock.readFileSync.mockImplementation(fsMock.actualReadFileSync!);
      expect(ownerPid(lockDir)).toBe(process.pid);
      expect(releaseLock(testDir)).toEqual({ status: 'ok' });
    },
  );

  it('does not reap when owner liveness is ambiguous rather than ESRCH', () => {
    writeMetadata(lockDir, deadOwnerMetadata());
    utimesSync(lockDir, STALE, STALE);
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
    });

    expect(acquireLock(testDir, { staleAfterMs: 1 })).toBe(false);
    expect(ownerPid(lockDir)).toBe(99_999_999);
  });

  it('treats a numeric-prefix pid as corrupt rather than a live holder', () => {
    writeMetadata(lockDir, JSON.stringify({
      version: 1,
      ownerToken: 'a'.repeat(64),
      pid: `${process.pid}garbage`,
      createdAt: new Date().toISOString(),
      processStartedAtMs: Date.now(),
    }));
    writeFileSync(join(lockDir, 'pid'), `${process.pid}garbage`);
    utimesSync(lockDir, STALE, STALE);

    expect(acquireLock(testDir)).toBe(true);
    expect(ownerPid(lockDir)).toBe(process.pid);
    expect(readFileSync(join(lockDir, 'pid'), 'utf-8')).toBe(String(process.pid));
  });

  it.each([false, true])(
    'allows exactly one winner when a second acquirer arrives mid-publication (partial generation aged: %s)',
    agePartial => {
      let contender: boolean | undefined;
      let paused = false;
      fsMock.writeFileSync.mockImplementation(((target, ...rest) => {
        if (!paused && String(target).startsWith(lockDir) && String(target).endsWith('.tmp')) {
          paused = true;
          if (agePartial) utimesSync(lockDir, STALE, STALE);
          contender = acquireLock(testDir, { metadataGraceMs: 0 });
        }
        return fsMock.actualWriteFileSync!(target, ...rest);
      }) as typeof writeFileSync);

      const owner = acquireLock(testDir);

      expect(paused).toBe(true);
      expect(contender).toBe(false);
      expect(owner).toBe(true);
      expect(ownerPid(lockDir)).toBe(process.pid);
      expect(releaseLock(testDir)).toEqual({ status: 'ok' });
    },
  );

  it('does not delete a successor, or leave a partial lock, when a publisher fails during publication', () => {
    const publicationFailure = Object.assign(new Error('publication failed'), { code: 'EIO' });
    let contender: boolean | undefined;
    let interrupted = false;
    fsMock.renameSync.mockImplementation(((source, destination) => {
      if (!interrupted && String(source).startsWith(lockDir) && String(source).endsWith('.tmp')) {
        interrupted = true;
        utimesSync(lockDir, STALE, STALE);
        contender = acquireLock(testDir, { metadataGraceMs: 0 });
        throw publicationFailure;
      }
      return fsMock.actualRenameSync!(source, destination);
    }) as typeof renameSync);

    expect(() => acquireLock(testDir)).toThrow(publicationFailure);
    expect(contender).toBe(false);
    expect(existsSync(lockDir)).toBe(false);

    expect(acquireLock(testDir)).toBe(true);
    expect(ownerPid(lockDir)).toBe(process.pid);
    expect(releaseLock(testDir)).toEqual({ status: 'ok' });
  });
});
