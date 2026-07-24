import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawn, type ChildProcess } from 'child_process';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AGENT_PROCESS_RECORD,
  AGENT_PROCESS_RECORDS_DIR,
  inspectProcessIdentity,
  processIdentityMatches,
  reconcileRuntimeProcesses,
  removeRuntimeProcessRecord,
  terminateProcessTree,
  writeRuntimeProcessRecord,
  type RuntimeProcessRecord,
} from '../../../src/utils/process-ownership.js';

const tempRoots: string[] = [];
const children: ChildProcess[] = [];

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'cortextos-process-owner-'));
  tempRoots.push(root);
  return root;
}

async function waitForIdentity(pid: number): Promise<NonNullable<ReturnType<typeof inspectProcessIdentity>>> {
  for (let attempt = 0; attempt < 30; attempt++) {
    const identity = inspectProcessIdentity(pid);
    if (identity) return identity;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`Process identity never became observable for PID ${pid}`);
}

afterEach(() => {
  for (const child of children.splice(0)) {
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
  }
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('runtime process ownership', () => {
  it('fences record removal by the 256-bit owner token', () => {
    const stateDir = join(makeRoot(), 'state', 'alice');
    const record = writeRuntimeProcessRecord(stateDir, {
      instanceId: 'test',
      agentName: 'alice',
      runtime: 'test-runtime',
      pid: process.pid,
    });

    expect(removeRuntimeProcessRecord(stateDir, 'b'.repeat(64))).toBe(false);
    const path = join(stateDir, AGENT_PROCESS_RECORDS_DIR, `${record.ownerToken}.json`);
    expect(readFileSync(path, 'utf8')).toContain(record.ownerToken);
    expect(removeRuntimeProcessRecord(stateDir, record.ownerToken)).toBe(true);
  });

  it('keeps and reconciles one ownership record per process generation', () => {
    const stateDir = join(makeRoot(), 'state', 'alice');
    const first = writeRuntimeProcessRecord(stateDir, {
      instanceId: 'test', agentName: 'alice', runtime: 'one', pid: process.pid,
    });
    const second = writeRuntimeProcessRecord(stateDir, {
      instanceId: 'test', agentName: 'alice', runtime: 'two', pid: process.pid,
    });

    const files = readdirSync(join(stateDir, AGENT_PROCESS_RECORDS_DIR));
    expect(files).toContain(`${first.ownerToken}.json`);
    expect(files).toContain(`${second.ownerToken}.json`);
    expect(removeRuntimeProcessRecord(stateDir, first.ownerToken)).toBe(true);
    expect(readdirSync(join(stateDir, AGENT_PROCESS_RECORDS_DIR))).toHaveLength(1);
    expect(readFileSync(
      join(stateDir, AGENT_PROCESS_RECORDS_DIR, `${second.ownerToken}.json`),
      'utf8',
    )).toContain(second.ownerToken);
  });

  it('does not match a reused PID with a different start identity', () => {
    const current = inspectProcessIdentity(process.pid);
    expect(current).not.toBeNull();
    expect(processIdentityMatches({
      pid: process.pid,
      processStartIdentity: `${current!.startIdentity}-reused`,
      executablePath: current!.executablePath,
    }, current)).toBe(false);
  });

  it('quarantines stale records without signaling an unrelated live PID', () => {
    const ctxRoot = makeRoot();
    const stateDir = join(ctxRoot, 'state', 'alice');
    mkdirSync(stateDir, { recursive: true });
    const current = inspectProcessIdentity(process.pid)!;
    const record: RuntimeProcessRecord = {
      version: 1,
      ownerToken: 'c'.repeat(64),
      instanceId: 'test',
      agentName: 'alice',
      runtime: 'test-runtime',
      pid: process.pid,
      processStartIdentity: `${current.startIdentity}-not-this-process`,
      executablePath: current.executablePath,
      daemonPid: 1,
      daemonStartIdentity: 'old-daemon',
      createdAt: new Date().toISOString(),
    };
    writeFileSync(join(stateDir, AGENT_PROCESS_RECORD), JSON.stringify(record));

    const outcomes = reconcileRuntimeProcesses(ctxRoot, 'test');

    expect(outcomes).toEqual([expect.objectContaining({ status: 'stale-record', pid: process.pid })]);
    expect(inspectProcessIdentity(process.pid)).not.toBeNull();
    expect(readdirSync(stateDir).some(name => name.startsWith('agent-process.stale-'))).toBe(true);
  });

  it('terminates the exact orphan process tree before allowing replacement startup', async () => {
    const ctxRoot = makeRoot();
    const stateDir = join(ctxRoot, 'state', 'alice');
    mkdirSync(stateDir, { recursive: true });
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    children.push(child);
    if (!child.pid) throw new Error('Child process has no PID');
    const identity = await waitForIdentity(child.pid);
    const record: RuntimeProcessRecord = {
      version: 1,
      ownerToken: 'd'.repeat(64),
      instanceId: 'test',
      agentName: 'alice',
      runtime: 'test-runtime',
      pid: child.pid,
      processStartIdentity: identity.startIdentity,
      executablePath: identity.executablePath,
      daemonPid: 1,
      daemonStartIdentity: 'old-daemon',
      createdAt: new Date().toISOString(),
    };
    writeFileSync(join(stateDir, AGENT_PROCESS_RECORD), JSON.stringify(record));

    const outcomes = reconcileRuntimeProcesses(ctxRoot, 'test');

    expect(outcomes).toEqual([expect.objectContaining({ status: 'killed-orphan', pid: child.pid })]);
    expect(inspectProcessIdentity(child.pid)).toBeNull();
  }, 20_000);

  it('preserves a child and blocks replacement while its owning daemon generation is live', async () => {
    const ctxRoot = makeRoot();
    const stateDir = join(ctxRoot, 'state', 'alice');
    mkdirSync(stateDir, { recursive: true });
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore', windowsHide: true,
    });
    children.push(child);
    if (!child.pid) throw new Error('Child process has no PID');
    const childIdentity = await waitForIdentity(child.pid);
    const daemonIdentity = await waitForIdentity(process.pid);
    const record: RuntimeProcessRecord = {
      version: 1,
      ownerToken: 'e'.repeat(64),
      instanceId: 'test',
      agentName: 'alice',
      runtime: 'test-runtime',
      pid: child.pid,
      processStartIdentity: childIdentity.startIdentity,
      executablePath: childIdentity.executablePath,
      daemonPid: process.pid,
      daemonStartIdentity: daemonIdentity.startIdentity,
      createdAt: new Date().toISOString(),
    };
    const recordPath = join(stateDir, AGENT_PROCESS_RECORD);
    writeFileSync(recordPath, JSON.stringify(record));

    const outcomes = reconcileRuntimeProcesses(ctxRoot, 'test');

    expect(outcomes).toEqual([expect.objectContaining({
      status: 'failed',
      pid: child.pid,
      detail: expect.stringContaining('daemon generation is still live'),
    })]);
    expect(inspectProcessIdentity(child.pid)).not.toBeNull();
    expect(existsSync(recordPath)).toBe(true);
  });

  it('refuses to terminate a PID whose exact start identity changed', async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore', windowsHide: true,
    });
    children.push(child);
    if (!child.pid) throw new Error('Child process has no PID');
    const identity = await waitForIdentity(child.pid);

    expect(terminateProcessTree(child.pid, {
      pid: child.pid,
      startIdentity: `${identity.startIdentity}-reused`,
    })).toBe(false);
    expect(inspectProcessIdentity(child.pid)).not.toBeNull();
  });
});
