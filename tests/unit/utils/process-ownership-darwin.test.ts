import { beforeEach, describe, expect, it, vi } from 'vitest';

const { spawnSyncMock } = vi.hoisted(() => ({
  spawnSyncMock: vi.fn(),
}));

vi.mock('child_process', async (importOriginal) => ({
  ...await importOriginal<typeof import('child_process')>(),
  spawnSync: spawnSyncMock,
}));

vi.mock('os', async (importOriginal) => ({
  ...await importOriginal<typeof import('os')>(),
  platform: () => 'darwin',
}));

import {
  inspectProcessIdentityWithRetry,
  probeProcessIdentity,
  processIdentityMatches,
} from '../../../src/utils/process-ownership.js';

const BOOT = { status: 0, stdout: '{ sec = 1790387360, usec = 582702 } Fri Sep 25 18:49:20 2026\n' };

function psResult(stdout: string, status = 0) {
  return { status, stdout };
}

describe('macOS process identity inspection', () => {
  beforeEach(() => {
    spawnSyncMock.mockReset();
    spawnSyncMock.mockImplementation((cmd: string) =>
      cmd === '/usr/sbin/sysctl' ? BOOT : psResult('Sat Sep 26 12:14:33 2026\n'));
  });

  it('proves identity from boot time plus process start time', () => {
    expect(probeProcessIdentity(4242)).toEqual({
      status: 'present',
      identity: { pid: 4242, startIdentity: '1790387360:Sat Sep 26 12:14:33 2026', executablePath: '' },
    });
    expect(spawnSyncMock).toHaveBeenCalledWith(
      '/bin/ps',
      ['-o', 'lstart=', '-p', '4242'],
      expect.objectContaining({ env: expect.objectContaining({ LC_ALL: 'C' }) }),
    );
  });

  it('pads single-digit days the way ps does', () => {
    spawnSyncMock.mockImplementation((cmd: string) =>
      cmd === '/usr/sbin/sysctl' ? BOOT : psResult('Fri Oct  2 09:05:01 2026\n'));
    expect(probeProcessIdentity(7).status).toBe('present');
  });

  it('reports a missing PID as absent, not unknown', () => {
    spawnSyncMock.mockImplementation((cmd: string) =>
      cmd === '/usr/sbin/sysctl' ? BOOT : psResult('', 1));
    expect(probeProcessIdentity(4242)).toEqual({ status: 'absent' });
  });

  it.each([
    undefined,
    { status: 0, stdout: Buffer.from('Sat Sep 26 12:14:33 2026') },
    { status: 0, stdout: 'not a date' },
    { status: 2, stdout: 'Sat Sep 26 12:14:33 2026' },
  ])('treats a malformed ps result as unknown %#', (result) => {
    spawnSyncMock.mockImplementation((cmd: string) => (cmd === '/usr/sbin/sysctl' ? BOOT : result));
    expect(probeProcessIdentity(4242)).toEqual({ status: 'unknown' });
  });

  it('matches a record written from the same probe, and not one from a different start', () => {
    const identity = inspectProcessIdentityWithRetry(4242);
    expect(identity).not.toBeNull();
    const record = { pid: 4242, processStartIdentity: identity!.startIdentity, executablePath: '' };
    expect(processIdentityMatches(record, identity)).toBe(true);
    expect(processIdentityMatches({ ...record, processStartIdentity: '1790387360:Sat Sep 26 11:00:00 2026' }, identity))
      .toBe(false);
  });
});
