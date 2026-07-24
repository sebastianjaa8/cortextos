import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { inspectRuntimeOwnership } from '../../../src/cli/status.js';
import {
  AGENT_PROCESS_RECORDS_DIR,
  writeRuntimeProcessRecord,
} from '../../../src/utils/process-ownership.js';

const tempRoots: string[] = [];

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'cortextos-status-owner-'));
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('runtime ownership diagnostics', () => {
  it('ignores recognized quarantined records while reporting the active generation', () => {
    const ctxRoot = makeRoot();
    const stateDir = join(ctxRoot, 'state', 'alice');
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(ctxRoot, 'daemon.pid'), String(process.pid));
    const record = writeRuntimeProcessRecord(stateDir, {
      instanceId: 'test',
      agentName: 'alice',
      runtime: 'test-runtime',
      pid: process.pid,
    });
    const recordsDir = join(stateDir, AGENT_PROCESS_RECORDS_DIR);
    const canonicalPath = join(recordsDir, `${record.ownerToken}.json`);
    writeFileSync(
      join(recordsDir, `${record.ownerToken}.stale-1234567890-deadbeef.json`),
      readFileSync(canonicalPath),
    );

    expect(inspectRuntimeOwnership(ctxRoot, 'test')).toEqual([
      expect.objectContaining({ agent: 'alice', status: 'owned', pid: process.pid }),
    ]);
  });

  it('continues to report unexpected JSON in the ownership directory', () => {
    const ctxRoot = makeRoot();
    const recordsDir = join(ctxRoot, 'state', 'alice', AGENT_PROCESS_RECORDS_DIR);
    mkdirSync(recordsDir, { recursive: true });
    writeFileSync(join(recordsDir, 'unexpected.json'), '{}');

    expect(inspectRuntimeOwnership(ctxRoot, 'test')).toEqual([
      expect.objectContaining({ agent: 'alice', status: 'invalid', detail: 'invalid unexpected.json' }),
    ]);
  });
});
