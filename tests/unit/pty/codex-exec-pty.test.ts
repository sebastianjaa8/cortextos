import { EventEmitter } from 'events';
import { join } from 'path';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const fsMocks = {
  existsSync: vi.fn().mockReturnValue(false),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  appendFileSync: vi.fn(),
  statSync: vi.fn(),
};

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    get existsSync() { return fsMocks.existsSync; },
    get readFileSync() { return fsMocks.readFileSync; },
    get writeFileSync() { return fsMocks.writeFileSync; },
    get appendFileSync() { return fsMocks.appendFileSync; },
    get statSync() { return fsMocks.statSync; },
  };
});

const childProcessMocks = {
  spawn: vi.fn(),
  spawnSync: vi.fn(),
};

vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    spawn: childProcessMocks.spawn,
    spawnSync: childProcessMocks.spawnSync,
  };
});

vi.mock('../../../src/utils/atomic.js', () => ({
  ensureDir: vi.fn(),
}));

const ownershipMocks = vi.hoisted(() => ({
  write: vi.fn((_stateDir, input) => ({
    ...input,
    ownerToken: 'a'.repeat(64),
    processStartIdentity: 'start-321',
  })),
  remove: vi.fn(() => true),
  terminate: vi.fn(() => true),
}));

vi.mock('../../../src/utils/process-ownership.js', () => ({
  writeRuntimeProcessRecord: ownershipMocks.write,
  removeRuntimeProcessRecord: ownershipMocks.remove,
  terminateProcessTree: ownershipMocks.terminate,
}));

const { CodexExecPTY, codexExecSessionExists } = await import('../../../src/pty/codex-exec-pty.js');

const mockEnv = {
  instanceId: 'test',
  ctxRoot: '/tmp/ctx',
  frameworkRoot: '/tmp/fw',
  agentName: 'codex-exec-agent',
  agentDir: '/tmp/fw/orgs/acme/agents/codex-exec-agent',
  org: 'acme',
  projectRoot: '/tmp/fw',
};

const sessionPath = join(mockEnv.ctxRoot, 'state', mockEnv.agentName, 'codex-exec-session.json');
const sessionId = '019f44da-81cd-7880-9466-ef5e54dcccb6';

function makeMockChildProcess() {
  const child = new EventEmitter() as EventEmitter & {
    pid: number;
    stdout: EventEmitter;
    stderr: EventEmitter;
    stdin: EventEmitter & { end: ReturnType<typeof vi.fn> };
    kill: ReturnType<typeof vi.fn>;
  };
  child.pid = 321;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  const stdin = new EventEmitter() as EventEmitter & { end: ReturnType<typeof vi.fn> };
  stdin.end = vi.fn((_prompt: string, callback?: () => void) => callback?.());
  child.stdin = stdin;
  child.kill = vi.fn();
  return child;
}

beforeEach(() => {
  fsMocks.existsSync.mockReset().mockReturnValue(false);
  fsMocks.readFileSync.mockReset();
  fsMocks.writeFileSync.mockReset();
  fsMocks.appendFileSync.mockReset();
  fsMocks.statSync.mockReset();
  childProcessMocks.spawn.mockReset();
  childProcessMocks.spawnSync.mockReset();
  ownershipMocks.write.mockClear();
  ownershipMocks.remove.mockClear();
  ownershipMocks.terminate.mockClear();
});

describe('CodexExecPTY', () => {
  it('runs a fresh codex exec turn through stdin and persists the session id', async () => {
    const child = makeMockChildProcess();
    childProcessMocks.spawn.mockReturnValue(child);

    const pty = new CodexExecPTY(mockEnv, { model: 'gpt-5.5', dangerously_skip_permissions: false });
    await pty.spawn('fresh', 'hello codex');

    expect(childProcessMocks.spawn).toHaveBeenCalledWith(
      'codex',
      [
        '-c',
        'approval_policy="never"',
        ...(process.platform === 'win32' ? ['-c', 'windows.sandbox="elevated"'] : []),
        '--sandbox',
        'workspace-write',
        '--add-dir',
        mockEnv.ctxRoot,
        'exec',
        '--skip-git-repo-check',
        '--model',
        'gpt-5.5',
        '-',
      ],
      expect.objectContaining({
        cwd: mockEnv.agentDir,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      }),
    );
    expect(child.stdin.end).toHaveBeenCalledWith('hello codex', expect.any(Function));
    expect(ownershipMocks.write).toHaveBeenCalledWith(
      join(mockEnv.ctxRoot, 'state', mockEnv.agentName),
      expect.objectContaining({
        instanceId: mockEnv.instanceId,
        agentName: mockEnv.agentName,
        runtime: 'codex-exec',
        pid: 321,
      }),
    );

    child.stdout.emit('data', Buffer.from(`session id: ${sessionId}\nOK\n`));
    child.emit('exit', 0, null);

    expect(ownershipMocks.remove).toHaveBeenCalledWith(
      join(mockEnv.ctxRoot, 'state', mockEnv.agentName),
      'a'.repeat(64),
    );

    expect(fsMocks.writeFileSync).toHaveBeenCalledWith(
      sessionPath,
      expect.stringContaining(`"sessionId": "${sessionId}"`),
      'utf-8',
    );
    expect(pty.isAlive()).toBe(true);
    expect(pty.getOutputBuffer().getRecent()).toContain('[codex-exec] turn completed code=0');
  });

  it('resumes stored sessions and drains queued injected turns serially', async () => {
    const first = makeMockChildProcess();
    const second = makeMockChildProcess();
    childProcessMocks.spawn
      .mockReturnValueOnce(first)
      .mockReturnValueOnce(second);
    fsMocks.existsSync.mockImplementation((path) => path === sessionPath);
    fsMocks.readFileSync.mockImplementation((path) => {
      if (path === sessionPath) {
        return JSON.stringify({ sessionId, cwd: mockEnv.agentDir, updatedAt: '2026-07-09T00:00:00Z' });
      }
      return '';
    });

    const pty = new CodexExecPTY(mockEnv, { model: 'gpt-5.5', dangerously_skip_permissions: false });
    await pty.spawn('continue', 'boot prompt');
    const onAccepted = vi.fn();
    pty.injectMessage('queued prompt', { onAccepted });
    expect(onAccepted).not.toHaveBeenCalled();

    expect(childProcessMocks.spawn).toHaveBeenNthCalledWith(
      1,
      'codex',
      [
        '-c',
        'approval_policy="never"',
        ...(process.platform === 'win32' ? ['-c', 'windows.sandbox="elevated"'] : []),
        '--sandbox',
        'workspace-write',
        '--add-dir',
        mockEnv.ctxRoot,
        'exec',
        'resume',
        '--skip-git-repo-check',
        '--model',
        'gpt-5.5',
        sessionId,
        '-',
      ],
      expect.any(Object),
    );
    expect(first.stdin.end).toHaveBeenCalledWith('boot prompt', expect.any(Function));
    expect(childProcessMocks.spawn).toHaveBeenCalledTimes(1);

    first.emit('exit', 0, null);

    expect(childProcessMocks.spawn).toHaveBeenNthCalledWith(
      2,
      'codex',
      [
        '-c',
        'approval_policy="never"',
        ...(process.platform === 'win32' ? ['-c', 'windows.sandbox="elevated"'] : []),
        '--sandbox',
        'workspace-write',
        '--add-dir',
        mockEnv.ctxRoot,
        'exec',
        'resume',
        '--skip-git-repo-check',
        '--model',
        'gpt-5.5',
        sessionId,
        '-',
      ],
      expect.any(Object),
    );
    expect(second.stdin.end).toHaveBeenCalledWith('queued prompt', expect.any(Function));
    second.stdout.emit('data', Buffer.from('queued turn started\n'));
    expect(onAccepted).toHaveBeenCalledTimes(1);
    expect(ownershipMocks.write).toHaveBeenCalledTimes(2);
    expect(ownershipMocks.remove).toHaveBeenCalledTimes(1);
  });

  it('terminates and token-clears the currently owned turn on kill', async () => {
    const child = makeMockChildProcess();
    childProcessMocks.spawn.mockReturnValue(child);

    const pty = new CodexExecPTY(mockEnv, { dangerously_skip_permissions: false });
    await pty.spawn('fresh', 'hello');
    pty.kill();

    expect(ownershipMocks.terminate).toHaveBeenCalledWith(321, {
      pid: 321,
      startIdentity: 'start-321',
    });
    expect(ownershipMocks.remove).toHaveBeenCalledWith(
      join(mockEnv.ctxRoot, 'state', mockEnv.agentName),
      'a'.repeat(64),
    );
  });

  it('preserves explicit full-bypass mode without safe-mode overrides', async () => {
    const child = makeMockChildProcess();
    childProcessMocks.spawn.mockReturnValue(child);

    const pty = new CodexExecPTY(mockEnv, { dangerously_skip_permissions: true });
    await pty.spawn('fresh', 'hello');

    expect(childProcessMocks.spawn).toHaveBeenCalledWith(
      'codex',
      ['exec', '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox', '-'],
      expect.any(Object),
    );
  });

  it('reports session continuity from codex-exec state', () => {
    fsMocks.existsSync.mockImplementation((path) => path === sessionPath);
    expect(codexExecSessionExists(mockEnv.ctxRoot, mockEnv.agentName)).toBe(true);
  });
});
