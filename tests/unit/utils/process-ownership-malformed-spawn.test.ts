import { beforeEach, describe, expect, it, vi } from 'vitest';

const { execFileSyncMock, spawnSyncMock } = vi.hoisted(() => ({
  execFileSyncMock: vi.fn(),
  spawnSyncMock: vi.fn(),
}));

vi.mock('child_process', async (importOriginal) => ({
  ...await importOriginal<typeof import('child_process')>(),
  execFileSync: execFileSyncMock,
  spawnSync: spawnSyncMock,
}));

vi.mock('os', async (importOriginal) => ({
  ...await importOriginal<typeof import('os')>(),
  platform: () => 'win32',
}));

import {
  inspectProcessIdentity,
  probeProcessIdentity,
  terminateProcessTree,
} from '../../../src/utils/process-ownership.js';
import { exactProcessGenerationIsGone } from '../../../src/cli/restart.js';

describe('Windows process identity inspection failures', () => {
  beforeEach(() => {
    execFileSyncMock.mockReset();
    spawnSyncMock.mockReset();
  });

  it.each([
    undefined,
    {},
    { status: 0, stdout: Buffer.from('{}') },
    { status: 0, stdout: '{broken' },
  ])('returns null for a malformed spawnSync result %#', (result) => {
    spawnSyncMock.mockReturnValueOnce(result);
    expect(inspectProcessIdentity(123)).toBeNull();
  });

  it('distinguishes a confirmed missing PID from an unavailable identity probe', () => {
    spawnSyncMock
      .mockReturnValueOnce({ status: 0, stdout: JSON.stringify({ status: 'absent' }) })
      .mockReturnValueOnce(undefined);

    expect(probeProcessIdentity(123)).toEqual({ status: 'absent' });
    expect(probeProcessIdentity(123)).toEqual({ status: 'unknown' });
  });

  it('does not report termination when taskkill and the post-kill probe are inconclusive', () => {
    spawnSyncMock
      .mockReturnValueOnce({
        status: 0,
        stdout: JSON.stringify({
          status: 'present',
          pid: 123,
          startIdentity: 'start-1',
          executablePath: 'node.exe',
        }),
      })
      .mockReturnValueOnce(undefined);
    execFileSyncMock.mockImplementationOnce(() => { throw new Error('taskkill failed'); });

    expect(terminateProcessTree(123, { pid: 123, startIdentity: 'start-1' })).toBe(false);
  });

  it('does not declare a daemon generation gone when its identity probe is inconclusive', () => {
    spawnSyncMock.mockReturnValueOnce(undefined);

    expect(exactProcessGenerationIsGone({
      pid: 123,
      startIdentity: 'start-1',
      executablePath: 'node.exe',
    })).toBe(false);
  });
});
