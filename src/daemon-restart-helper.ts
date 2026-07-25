import { homedir } from 'os';
import { join } from 'path';
import { atomicWriteDurableSync, ensureDir } from './utils/atomic.js';
import { acquireLock, releaseLock } from './utils/lock.js';
import {
  daemonRestartResultPath,
  performDaemonRestart,
  type DaemonRestartResult,
} from './cli/restart.js';
import { validateInstanceId } from './utils/validate.js';

function optionValue(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

function applyEnvironment(encoded: string): void {
  const parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as Record<string, unknown>;
  const allowed = [
    'PATH', 'PATHEXT', 'PM2_HOME', 'CTX_INSTANCE_ID', 'CTX_ROOT',
    'CTX_FRAMEWORK_ROOT', 'CTX_PROJECT_ROOT', 'CTX_ORG',
  ];
  for (const key of allowed) {
    const value = parsed[key];
    if (typeof value === 'string' && value.length > 0) process.env[key] = value;
  }
}

function writeResult(
  instance: string,
  requestId: string,
  result: Omit<DaemonRestartResult, 'requestId' | 'helperPid' | 'completedAt'>,
): void {
  atomicWriteDurableSync(daemonRestartResultPath(instance, requestId), JSON.stringify({
    ...result,
    requestId,
    helperPid: process.pid,
    completedAt: new Date().toISOString(),
  }));
}

async function main(): Promise<void> {
  const instance = optionValue('--instance');
  const requestId = optionValue('--request-id');
  applyEnvironment(optionValue('--environment'));
  validateInstanceId(instance);
  daemonRestartResultPath(instance, requestId);
  const lockDir = join(homedir(), '.cortextos', instance, 'state', 'daemon-restart');
  ensureDir(lockDir);
  if (!acquireLock(lockDir, { staleAfterMs: 10 * 60_000 })) {
    writeResult(instance, requestId, {
      success: false,
      error: 'Another daemon restart helper already owns the restart lock',
    });
    process.exitCode = 1;
    return;
  }

  let result: Omit<DaemonRestartResult, 'requestId' | 'helperPid' | 'completedAt'>;
  try {
    const { oldPid, newPid } = await performDaemonRestart(instance);
    result = { success: true, oldPid, newPid };
  } catch (err) {
    result = { success: false, error: (err as Error).message };
  }

  const released = releaseLock(lockDir);
  if (released.status !== 'ok' && released.status !== 'not-owned') {
    result = {
      success: false,
      error: `Restart completed but the ownership lock could not be released: ${released.status}`,
    };
  }
  writeResult(instance, requestId, result);
  if (!result.success) process.exitCode = 1;
}

void main();