import { spawn } from 'child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { pathToFileURL } from 'url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  acquireLock,
  releaseLock,
  touchLock,
  withFileLockSync,
} from '../../../src/utils/lock';
import { inspectProcessIdentity } from '../../../src/utils/process-ownership';

interface TestMetadata {
  version: 1;
  ownerToken: string;
  pid: number;
  createdAt: string;
  processStartedAtMs: number;
  processStartIdentity?: string;
}

function metadata(ownerToken: string, pid = process.pid): TestMetadata {
  return {
    version: 1,
    ownerToken,
    pid,
    createdAt: new Date().toISOString(),
    processStartedAtMs: Date.now() - 1_000,
  };
}

function writeSimulatedLock(testDir: string, value: TestMetadata): void {
  const lockDir = join(testDir, '.lock.d');
  mkdirSync(lockDir, { recursive: true });
  writeFileSync(join(lockDir, 'metadata.json'), JSON.stringify(value));
  writeFileSync(join(lockDir, 'heartbeat'), JSON.stringify({
    ownerToken: value.ownerToken,
    touchedAt: new Date().toISOString(),
  }));
  writeFileSync(join(lockDir, 'pid'), String(value.pid));
}

describe('mkdir-based locking', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'cortextos-lock-test-'));
  });

  afterEach(() => {
    releaseLock(testDir);
    rmSync(testDir, { recursive: true, force: true });
  });

  it('acquires, excludes a second acquire, and releases', () => {
    expect(acquireLock(testDir)).toBe(true);
    expect(acquireLock(testDir)).toBe(false);
    expect(releaseLock(testDir)).toEqual({ status: 'ok' });
    expect(acquireLock(testDir)).toBe(true);
  });

  it('publishes an unguessable token, immutable metadata, and separate heartbeat', () => {
    expect(acquireLock(testDir)).toBe(true);
    const lockDir = join(testDir, '.lock.d');
    const metadataFile = join(lockDir, 'metadata.json');
    const heartbeatFile = join(lockDir, 'heartbeat');
    const before = readFileSync(metadataFile, 'utf8');
    const parsed = JSON.parse(before) as TestMetadata;

    expect(parsed.ownerToken).toMatch(/^[a-f0-9]{64}$/);
    expect(parsed.pid).toBe(process.pid);
    expect(readFileSync(join(lockDir, 'pid'), 'utf8')).toBe(String(process.pid));

    const old = new Date(Date.now() - 200_000);
    utimesSync(heartbeatFile, old, old);
    expect(touchLock(testDir)).toEqual({ status: 'ok' });
    expect(readFileSync(metadataFile, 'utf8')).toBe(before);
    expect(JSON.parse(readFileSync(heartbeatFile, 'utf8')).ownerToken).toBe(parsed.ownerToken);
  });

  it('never steals solely because a live matching owner heartbeat is old', () => {
    expect(acquireLock(testDir)).toBe(true);
    const heartbeat = join(testDir, '.lock.d', 'heartbeat');
    const old = new Date(Date.now() - 200_000);
    utimesSync(heartbeat, old, old);

    expect(acquireLock(testDir, { staleAfterMs: 90_000 })).toBe(false);
  });

  it('reclaims a lock whose recorded process is dead', () => {
    const deadPid = 2_147_483_647;
    writeSimulatedLock(testDir, metadata('a'.repeat(64), deadPid));

    expect(acquireLock(testDir, { staleAfterMs: 90_000 })).toBe(true);
    const current = JSON.parse(
      readFileSync(join(testDir, '.lock.d', 'metadata.json'), 'utf8'),
    ) as TestMetadata;
    expect(current.pid).toBe(process.pid);
    expect(current.ownerToken).not.toBe('a'.repeat(64));
  });

  it('reclaims a reused current PID whose process-start identity does not match', () => {
    const stale = metadata('d'.repeat(64));
    stale.processStartedAtMs = Date.now() - 60_000;
    writeSimulatedLock(testDir, stale);

    expect(acquireLock(testDir, { staleAfterMs: 1 })).toBe(true);
  });

  it('reclaims a live PID only when its exact cross-platform start identity differs', () => {
    const identity = inspectProcessIdentity(process.pid);
    expect(identity).not.toBeNull();
    const stale = metadata('e'.repeat(64));
    stale.processStartIdentity = `${identity!.startIdentity}-reused`;
    writeSimulatedLock(testDir, stale);

    expect(acquireLock(testDir, { staleAfterMs: 1 })).toBe(true);
  });

  it('does not steal an old guard from its live matching process generation', () => {
    const identity = inspectProcessIdentity(process.pid);
    expect(identity).not.toBeNull();
    const guardDir = join(testDir, '.lock.guard');
    const token = 'f'.repeat(64);
    mkdirSync(guardDir);
    writeFileSync(join(guardDir, token), JSON.stringify({
      pid: process.pid,
      startIdentity: identity!.startIdentity,
    }));
    const old = new Date(Date.now() - 60_000);
    utimesSync(guardDir, old, old);

    expect(acquireLock(testDir)).toBe(false);
    expect(existsSync(join(guardDir, token))).toBe(true);
  });

  it('gives missing metadata a bounded grace before reclaim', () => {
    const lockDir = join(testDir, '.lock.d');
    mkdirSync(lockDir);
    expect(acquireLock(testDir, { metadataGraceMs: 50 })).toBe(false);

    const old = new Date(Date.now() - 100);
    utimesSync(lockDir, old, old);
    expect(acquireLock(testDir, { metadataGraceMs: 50 })).toBe(true);
  });

  it('gives corrupt metadata a bounded grace before reclaim', () => {
    const lockDir = join(testDir, '.lock.d');
    mkdirSync(lockDir);
    writeFileSync(join(lockDir, 'metadata.json'), '{broken');
    expect(acquireLock(testDir, { metadataGraceMs: 50 })).toBe(false);

    const old = new Date(Date.now() - 100);
    utimesSync(lockDir, old, old);
    expect(acquireLock(testDir, { metadataGraceMs: 50 })).toBe(true);
  });

  it('touch reports ownership loss and cannot overwrite a successor heartbeat', () => {
    expect(acquireLock(testDir)).toBe(true);
    const lockDir = join(testDir, '.lock.d');
    rmSync(lockDir, { recursive: true, force: true });
    const successorToken = 'b'.repeat(64);
    writeSimulatedLock(testDir, metadata(successorToken));
    const heartbeatFile = join(lockDir, 'heartbeat');
    const successorHeartbeat = readFileSync(heartbeatFile, 'utf8');

    expect(touchLock(testDir)).toEqual({ status: 'ownership-lost' });
    expect(readFileSync(heartbeatFile, 'utf8')).toBe(successorHeartbeat);
    expect(existsSync(lockDir)).toBe(true);
  });

  it('release reports ownership loss and cannot delete a successor lock', () => {
    expect(acquireLock(testDir)).toBe(true);
    const lockDir = join(testDir, '.lock.d');
    rmSync(lockDir, { recursive: true, force: true });
    const successorToken = 'c'.repeat(64);
    writeSimulatedLock(testDir, metadata(successorToken));

    expect(releaseLock(testDir)).toEqual({ status: 'ownership-lost' });
    expect(existsSync(lockDir)).toBe(true);
    expect(JSON.parse(readFileSync(join(lockDir, 'metadata.json'), 'utf8')).ownerToken)
      .toBe(successorToken);
  });

  it('waits through transient guard contention and verifies release', async () => {
    expect(acquireLock(testDir)).toBe(true);
    const ownershipUrl = pathToFileURL(resolve('src/utils/process-ownership.ts')).href;
    const script = `
      import fs from 'fs';
      import path from 'path';
      import ownershipModule from ${JSON.stringify(ownershipUrl)};
      const identity = ownershipModule.inspectProcessIdentity(process.pid);
      const guard = path.join(${JSON.stringify(testDir)}, '.lock.guard');
      fs.mkdirSync(guard);
      fs.writeFileSync(path.join(guard, '${'9'.repeat(64)}'), JSON.stringify({
        pid: process.pid,
        startIdentity: identity.startIdentity,
      }));
      process.stdout.write('ready');
      setTimeout(() => fs.rmSync(guard, { recursive: true, force: true }), 300);
    `;
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
      cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'],
    });
    const childExit = new Promise<void>((done, reject) => {
      child.on('error', reject);
      child.on('exit', code => code === 0 ? done() : reject(new Error(`guard child exited ${code}`)));
    });
    await new Promise<void>((done, reject) => {
      child.on('error', reject);
      child.stdout.once('data', () => done());
    });

    expect(releaseLock(testDir)).toEqual({ status: 'ok' });
    await childExit;
  }, 10_000);

  it('preserves withFileLockSync return and finally-release behavior', () => {
    expect(withFileLockSync(testDir, () => 42)).toBe(42);
    expect(acquireLock(testDir)).toBe(true);
    expect(releaseLock(testDir)).toEqual({ status: 'ok' });

    expect(() => withFileLockSync(testDir, () => { throw new Error('boom'); }))
      .toThrow('boom');
    expect(acquireLock(testDir)).toBe(true);
  });

  it('allows only one concurrent contender to quarantine and replace a stale lock', async () => {
    const lockDir = join(testDir, '.lock.d');
    mkdirSync(lockDir);
    writeFileSync(join(lockDir, 'metadata.json'), '{broken');
    const old = new Date(Date.now() - 1_000);
    utimesSync(lockDir, old, old);

    const moduleUrl = pathToFileURL(resolve('src/utils/lock.ts')).href;
    const startAt = Date.now() + 1_000;
    const script = `
      import lockModule from ${JSON.stringify(moduleUrl)};
      const { acquireLock } = lockModule;
      setTimeout(() => {
        const acquired = acquireLock(${JSON.stringify(testDir)}, { metadataGraceMs: 0 });
        process.stdout.write(String(acquired));
        if (acquired) setTimeout(() => {}, 1000);
      }, Math.max(0, ${startAt} - Date.now()));
    `;

    const contenders = Array.from({ length: 4 }, () => new Promise<boolean>((done, reject) => {
      const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
        cwd: process.cwd(),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => { stdout += String(chunk); });
      child.stderr.on('data', (chunk) => { stderr += String(chunk); });
      child.on('error', reject);
      child.on('exit', (code) => {
        if (code !== 0) reject(new Error(stderr || `contender exited ${code}`));
        else done(stdout === 'true');
      });
    }));

    const results = await Promise.all(contenders);
    expect(results.filter(Boolean)).toHaveLength(1);
  }, 10_000);
});
