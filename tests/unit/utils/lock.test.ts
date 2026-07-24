import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, utimesSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { acquireLock, releaseLock, touchLock } from '../../../src/utils/lock';

describe('mkdir-based locking', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'cortextos-lock-test-'));
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('acquires lock on empty directory', () => {
    expect(acquireLock(testDir)).toBe(true);
    releaseLock(testDir);
  });

  it('prevents double acquire', () => {
    expect(acquireLock(testDir)).toBe(true);
    // Same process, same PID - should fail since lock.d already exists
    // (but our PID check will see it's our own process and succeed)
    // Actually, mkdir will fail because it already exists, then we check PID
    // Since it's our own PID, it sees process alive and returns false
    expect(acquireLock(testDir)).toBe(false);
    releaseLock(testDir);
  });

  it('releases lock correctly', () => {
    expect(acquireLock(testDir)).toBe(true);
    releaseLock(testDir);
    expect(acquireLock(testDir)).toBe(true);
    releaseLock(testDir);
  });

  describe('staleAfterMs heartbeat reclaim', () => {
    it('reclaims a lock whose PID is alive but heartbeat is stale', () => {
      expect(acquireLock(testDir)).toBe(true);
      // Backdate the pid file's mtime to simulate a holder whose PID got
      // reused by an unrelated process (our own PID passes the liveness
      // check, but a real holder would have touched it recently).
      const pidFile = join(testDir, '.lock.d', 'pid');
      const old = new Date(Date.now() - 200_000);
      utimesSync(pidFile, old, old);

      expect(acquireLock(testDir, { staleAfterMs: 90_000 })).toBe(true);
      releaseLock(testDir);
    });

    it('does not reclaim a lock whose heartbeat is fresh', () => {
      expect(acquireLock(testDir)).toBe(true);
      touchLock(testDir);
      expect(acquireLock(testDir, { staleAfterMs: 90_000 })).toBe(false);
      releaseLock(testDir);
    });

    it('leaves default (no staleAfterMs) behavior unaffected by an old mtime', () => {
      expect(acquireLock(testDir)).toBe(true);
      const pidFile = join(testDir, '.lock.d', 'pid');
      const old = new Date(Date.now() - 200_000);
      utimesSync(pidFile, old, old);

      expect(acquireLock(testDir)).toBe(false);
      releaseLock(testDir);
    });
  });
});
