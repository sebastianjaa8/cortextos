import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const fsMock = vi.hoisted(() => ({
  writeFileSync: vi.fn(),
}));

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  fsMock.writeFileSync.mockImplementation(actual.writeFileSync);
  return {
    ...actual,
    writeFileSync: fsMock.writeFileSync,
  };
});

import { acquireLock, releaseLock } from '../../../src/utils/lock';

describe('lock acquisition failure cleanup', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'cortextos-lock-enospc-'));
  });

  afterEach(() => {
    vi.clearAllMocks();
    rmSync(testDir, { recursive: true, force: true });
  });

  // Fork layout: the owner is published as metadata.json (then heartbeat, pid)
  // via temp-file + rename, rather than upstream's `pid.<token>.pending`.
  it.each(['metadata.json', 'heartbeat', 'pid'])(
    'removes the partial lock directory when publishing %s fails with ENOSPC',
    file => {
      const enospc = Object.assign(new Error('disk full'), { code: 'ENOSPC' });
      const actualWriteFileSync = fsMock.writeFileSync.getMockImplementation()!;
      const lockDir = join(testDir, '.lock.d');
      let failed = false;
      fsMock.writeFileSync.mockImplementation(((target, ...rest) => {
        const path = String(target);
        if (!failed && path.startsWith(join(lockDir, `${file}.`)) && path.endsWith('.tmp')) {
          failed = true;
          throw enospc;
        }
        return actualWriteFileSync(target, ...rest);
      }) as typeof import('fs').writeFileSync);

      expect(() => acquireLock(testDir)).toThrow(enospc);
      expect(failed).toBe(true);
      expect(existsSync(lockDir)).toBe(false);

      expect(acquireLock(testDir)).toBe(true);
      expect(releaseLock(testDir)).toEqual({ status: 'ok' });
    },
  );
});
