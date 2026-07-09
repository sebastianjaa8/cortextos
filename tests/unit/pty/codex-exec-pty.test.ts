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
    stdin: { end: ReturnType<typeof vi.fn> };
    kill: ReturnType<typeof vi.fn>;
  };
  child.pid = 321;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { end: vi.fn() };
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
});

describe('CodexExecPTY', () => {
  it('runs a fresh codex exec turn through stdin and persists the session id', async () => {
    const child = makeMockChildProcess();
    childProcessMocks.spawn.mockReturnValue(child);

    const pty = new CodexExecPTY(mockEnv, { model: 'gpt-5.5', dangerously_skip_permissions: false });
    await pty.spawn('fresh', 'hello codex');

    expect(childProcessMocks.spawn).toHaveBeenCalledWith(
      'codex',
      ['exec', '--skip-git-repo-check', '--model', 'gpt-5.5', '-'],
      expect.objectContaining({
        cwd: mockEnv.agentDir,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      }),
    );
    expect(child.stdin.end).toHaveBeenCalledWith('hello codex');

    child.stdout.emit('data', Buffer.from(`session id: ${sessionId}\nOK\n`));
    child.emit('exit', 0, null);

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
    pty.injectMessage('queued prompt');

    expect(childProcessMocks.spawn).toHaveBeenNthCalledWith(
      1,
      'codex',
      ['exec', 'resume', '--skip-git-repo-check', '--model', 'gpt-5.5', sessionId, '-'],
      expect.any(Object),
    );
    expect(first.stdin.end).toHaveBeenCalledWith('boot prompt');
    expect(childProcessMocks.spawn).toHaveBeenCalledTimes(1);

    first.emit('exit', 0, null);

    expect(childProcessMocks.spawn).toHaveBeenNthCalledWith(
      2,
      'codex',
      ['exec', 'resume', '--skip-git-repo-check', '--model', 'gpt-5.5', sessionId, '-'],
      expect.any(Object),
    );
    expect(second.stdin.end).toHaveBeenCalledWith('queued prompt');
  });

  it('reports session continuity from codex-exec state', () => {
    fsMocks.existsSync.mockImplementation((path) => path === sessionPath);
    expect(codexExecSessionExists(mockEnv.ctxRoot, mockEnv.agentName)).toBe(true);
  });
});
