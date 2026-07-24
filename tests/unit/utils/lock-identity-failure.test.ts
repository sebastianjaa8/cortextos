import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { inspectProcessIdentityMock, probeProcessIdentityMock } = vi.hoisted(() => ({
  inspectProcessIdentityMock: vi.fn(() => null),
  probeProcessIdentityMock: vi.fn(() => ({ status: 'unknown' as const })),
}));

vi.mock('../../../src/utils/process-ownership.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../src/utils/process-ownership.js')>(),
  inspectProcessIdentity: inspectProcessIdentityMock,
  probeProcessIdentity: probeProcessIdentityMock,
}));

import { acquireLock } from '../../../src/utils/lock.js';

describe('lock identity inspection failure handling', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'cortextos-lock-identity-failure-'));
    inspectProcessIdentityMock.mockClear();
    probeProcessIdentityMock.mockClear();
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('does not steal an old guard while its PID is live but identity inspection is unavailable', () => {
    const guardDir = join(testDir, '.lock.guard');
    const token = 'a'.repeat(64);
    mkdirSync(guardDir);
    writeFileSync(join(guardDir, token), JSON.stringify({
      pid: process.pid,
      startIdentity: 'unavailable-to-inspector',
    }));
    const old = new Date(Date.now() - 60_000);
    utimesSync(guardDir, old, old);

    expect(acquireLock(testDir)).toBe(false);
    expect(existsSync(join(guardDir, token))).toBe(true);
  });

  it('does not launch identity inspection while waiting on an ordinary live file lock', () => {
    const lockDir = join(testDir, '.lock.d');
    mkdirSync(lockDir);
    const ownerToken = 'b'.repeat(64);
    writeFileSync(join(lockDir, 'metadata.json'), JSON.stringify({
      version: 1,
      ownerToken,
      pid: process.pid,
      createdAt: new Date().toISOString(),
      processStartedAtMs: Date.now(),
      processStartIdentity: 'not-needed-without-stale-reclamation',
    }));
    writeFileSync(join(lockDir, 'heartbeat'), JSON.stringify({ ownerToken }));

    expect(acquireLock(testDir)).toBe(false);
    expect(inspectProcessIdentityMock).not.toHaveBeenCalled();
    expect(probeProcessIdentityMock).not.toHaveBeenCalled();
  });

  it('does not steal a stale-heartbeat lock when its live PID identity probe is unavailable', () => {
    const lockDir = join(testDir, '.lock.d');
    mkdirSync(lockDir);
    const ownerToken = 'c'.repeat(64);
    writeFileSync(join(lockDir, 'metadata.json'), JSON.stringify({
      version: 1,
      ownerToken,
      pid: process.pid,
      createdAt: new Date().toISOString(),
      processStartedAtMs: Date.now(),
      processStartIdentity: 'temporarily-unavailable',
    }));
    const heartbeat = join(lockDir, 'heartbeat');
    writeFileSync(heartbeat, JSON.stringify({ ownerToken }));
    const old = new Date(Date.now() - 60_000);
    utimesSync(heartbeat, old, old);

    expect(acquireLock(testDir, { staleAfterMs: 1 })).toBe(false);
    expect(probeProcessIdentityMock).toHaveBeenCalledWith(process.pid);
    expect(existsSync(join(lockDir, 'metadata.json'))).toBe(true);
  });
});
