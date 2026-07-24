import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../src/utils/process-ownership.js', () => ({
  writeRuntimeProcessRecord: vi.fn((_stateDir, input) => ({ ...input, ownerToken: 'a'.repeat(64) })),
  removeRuntimeProcessRecord: vi.fn(() => true),
  terminateProcessTree: vi.fn(() => true),
}));

let capturedOnExit: ((exitCode: number, signal?: number) => void) | null = null;
let mockCodexExecPty: MockCodexExecPTY;
const mockCodexExecSessionExists = vi.fn().mockReturnValue(false);
const mockSharedInject = vi.fn();

class MockCodexExecPTY {
  spawn = vi.fn().mockResolvedValue(undefined);
  kill = vi.fn();
  write = vi.fn();
  injectMessage = vi.fn();
  getPid = vi.fn().mockReturnValue(24680);
  isAlive = vi.fn().mockReturnValue(true);
  onExit = vi.fn().mockImplementation((cb: (exitCode: number, signal?: number) => void) => {
    capturedOnExit = cb;
  });
  getOutputBuffer = vi.fn().mockReturnValue({
    isBootstrapped: vi.fn().mockReturnValue(true),
    getTotalBytes: vi.fn().mockReturnValue(0),
  });

  constructor() {
    mockCodexExecPty = this;
  }
}

const mockAgentPty = {
  spawn: vi.fn().mockResolvedValue(undefined),
  kill: vi.fn(),
  write: vi.fn(),
  getPid: vi.fn().mockReturnValue(12345),
  isAlive: vi.fn().mockReturnValue(true),
  onExit: vi.fn(),
  getOutputBuffer: vi.fn().mockReturnValue({ isBootstrapped: vi.fn().mockReturnValue(true), getTotalBytes: vi.fn().mockReturnValue(0) }),
  setTelegramHandle: vi.fn(),
};

vi.mock('../../../src/pty/agent-pty.js', () => ({
  AgentPTY: function AgentPTY() { return mockAgentPty; },
}));

vi.mock('../../../src/pty/codex-app-server-pty.js', () => ({
  CodexAppServerPTY: function CodexAppServerPTY() { return mockAgentPty; },
}));

vi.mock('../../../src/pty/codex-exec-pty.js', () => ({
  CodexExecPTY: MockCodexExecPTY,
  codexExecSessionExists: (...args: unknown[]) => mockCodexExecSessionExists(...args),
}));

vi.mock('../../../src/pty/hermes-pty.js', () => ({
  HermesPTY: function HermesPTY() { return mockAgentPty; },
  hermesDbExists: vi.fn().mockReturnValue(false),
}));

vi.mock('../../../src/pty/opencode-pty.js', () => ({
  OpencodePTY: function OpencodePTY() { return mockAgentPty; },
  opencodeSessionExists: vi.fn().mockReturnValue(false),
}));

vi.mock('../../../src/pty/inject.js', () => ({
  injectMessage: (...args: unknown[]) => mockSharedInject(...args),
  MessageDedup: class { isDuplicate() { return false; } },
}));

vi.mock('../../../src/utils/atomic.js', () => ({
  ensureDir: vi.fn(),
  atomicWriteSync: vi.fn(),
}));

vi.mock('../../../src/utils/env.js', () => ({
  writeCortextosEnv: vi.fn(),
  resolveEnv: vi.fn().mockReturnValue({ instanceId: 'test', ctxRoot: '/tmp/test' }),
}));

vi.mock('../../../src/bus/reminders.js', () => ({
  getOverdueReminders: vi.fn().mockReturnValue([]),
}));

vi.mock('../../../src/utils/paths.js', () => ({
  resolvePaths: vi.fn().mockReturnValue({}),
}));

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
    mkdirSync: vi.fn(),
    unlinkSync: vi.fn(),
    get existsSync() { return fsMocks.existsSync; },
    get readFileSync() { return fsMocks.readFileSync; },
    get writeFileSync() { return fsMocks.writeFileSync; },
    get appendFileSync() { return fsMocks.appendFileSync; },
    get statSync() { return fsMocks.statSync; },
  };
});

const { AgentProcess } = await import('../../../src/daemon/agent-process.js');
const { writeRuntimeProcessRecord } = await import('../../../src/utils/process-ownership.js');

const mockEnv = {
  instanceId: 'test',
  ctxRoot: '/tmp/test-ctx',
  frameworkRoot: '/tmp/fw',
  agentName: 'codex-exec-agent',
  agentDir: '/tmp/fw/orgs/acme/agents/codex-exec-agent',
  org: 'acme',
  projectRoot: '/tmp/fw',
};

beforeEach(() => {
  capturedOnExit = null;
  mockCodexExecSessionExists.mockReset().mockReturnValue(false);
  mockSharedInject.mockReset();
  fsMocks.existsSync.mockReset().mockReturnValue(false);
  fsMocks.readFileSync.mockReset();
  fsMocks.writeFileSync.mockReset();
  fsMocks.appendFileSync.mockReset();
  fsMocks.statSync.mockReset();
  vi.mocked(writeRuntimeProcessRecord).mockClear();
});

describe('AgentProcess codex-exec runtime', () => {
  it('selects CodexExecPTY for runtime codex-exec', async () => {
    const ap = new AgentProcess('codex-exec-agent', mockEnv, { runtime: 'codex-exec' });
    await ap.start();

    expect(mockCodexExecPty.spawn).toHaveBeenCalledWith('fresh', expect.any(String));
    expect(ap.getStatus().pid).toBe(24680);
    expect(writeRuntimeProcessRecord).not.toHaveBeenCalled();
  });

  it('uses codex-exec session state for continue mode', async () => {
    mockCodexExecSessionExists.mockReturnValue(true);
    const ap = new AgentProcess('codex-exec-agent', mockEnv, { runtime: 'codex-exec' });
    await ap.start();

    expect(mockCodexExecSessionExists).toHaveBeenCalledWith('/tmp/test-ctx', 'codex-exec-agent');
    expect(mockCodexExecPty.spawn).toHaveBeenCalledWith('continue', expect.any(String));
  });

  it('routes injected messages directly to CodexExecPTY', async () => {
    const ap = new AgentProcess('codex-exec-agent', mockEnv, { runtime: 'codex-exec' });
    await ap.start();

    const result = ap.injectMessageDetailed('hello');

    expect(result).toEqual({ ok: true });
    expect(mockCodexExecPty.injectMessage).toHaveBeenCalledWith('hello');
    expect(mockSharedInject).not.toHaveBeenCalled();
  });
});
