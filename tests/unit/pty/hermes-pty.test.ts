import { describe, it, expect, vi, beforeEach } from 'vitest';
import { join } from 'path';
import { homedir } from 'os';

const fsMocks = {
  existsSync: vi.fn().mockReturnValue(false),
  writeFileSync: vi.fn(),
};

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    get existsSync() { return fsMocks.existsSync; },
    get writeFileSync() { return fsMocks.writeFileSync; },
  };
});

// Stub node-pty so HermesPTY can be imported without a native addon
vi.mock('node-pty', () => ({
  spawn: vi.fn().mockReturnValue({
    pid: 99,
    write: vi.fn(),
    onData: vi.fn(),
    onExit: vi.fn(),
    kill: vi.fn(),
    resize: vi.fn(),
  }),
}));

const { hermesDbExists, resolveHermesBinary, HermesPTY } = await import('../../../src/pty/hermes-pty.js');

const mockEnv = {
  instanceId: 'test',
  ctxRoot: '/tmp/ctx',
  frameworkRoot: '/tmp/fw',
  agentName: 'hermes-agent',
  agentDir: '/tmp/fw/orgs/acme/agents/hermes-agent',
  org: 'acme',
  projectRoot: '/tmp/fw',
};

beforeEach(() => {
  fsMocks.existsSync.mockReset().mockReturnValue(false);
  fsMocks.writeFileSync.mockReset();
});

describe('hermesDbExists', () => {
  it('returns false when ~/.hermes/state.db does not exist', () => {
    fsMocks.existsSync.mockReturnValue(false);
    expect(hermesDbExists()).toBe(false);
  });

  it('returns true when ~/.hermes/state.db exists', () => {
    const expectedPath = join(homedir(), '.hermes', 'state.db');
    fsMocks.existsSync.mockImplementation((p: string) => p === expectedPath);
    expect(hermesDbExists()).toBe(true);
  });

  it('uses HERMES_HOME override when provided', () => {
    const customHome = '/custom/hermes';
    const expectedPath = join(customHome, 'state.db');
    fsMocks.existsSync.mockImplementation((p: string) => p === expectedPath);
    expect(hermesDbExists(customHome)).toBe(true);
  });

  it('returns false when HERMES_HOME is set but state.db is absent', () => {
    fsMocks.existsSync.mockReturnValue(false);
    expect(hermesDbExists('/custom/hermes')).toBe(false);
  });
});

describe('HermesPTY', () => {
  it('getBinaryName returns "hermes"', () => {
    const pty = new HermesPTY(mockEnv, {});
    // Access protected method via cast
    expect((pty as unknown as { getBinaryName(): string }).getBinaryName())
      .toBe(process.platform === 'win32' ? 'hermes.exe' : 'hermes');
  });

  it('resolves a Windows Hermes executable from PATH directories', () => {
    if (process.platform !== 'win32') return;
    fsMocks.existsSync.mockImplementation((p: string) => p === join('C:\\tools', 'hermes.exe'));
    expect(resolveHermesBinary('C:\\missing;C:\\tools')).toBe(join('C:\\tools', 'hermes.exe'));
  });

  it('buildClaudeArgs pins classic REPL + agent workspace for fresh mode', () => {
    const pty = new HermesPTY(mockEnv, {});
    const args = (pty as unknown as { buildClaudeArgs(m: string, p: string): string[] })
      .buildClaudeArgs('fresh', 'hello');
    expect(args).toEqual(['--cli', '--in', mockEnv.agentDir]);
  });

  it('buildClaudeArgs adds --continue for continue mode (resume scoped by --in)', () => {
    const pty = new HermesPTY(mockEnv, {});
    const args = (pty as unknown as { buildClaudeArgs(m: string, p: string): string[] })
      .buildClaudeArgs('continue', 'hello');
    expect(args).toEqual(['--cli', '--in', mockEnv.agentDir, '--continue']);
  });

  it('buildClaudeArgs uses working_directory for --in when configured', () => {
    const pty = new HermesPTY(mockEnv, { working_directory: '/work/dir' });
    const args = (pty as unknown as { buildClaudeArgs(m: string, p: string): string[] })
      .buildClaudeArgs('fresh', 'hello');
    expect(args).toEqual(['--cli', '--in', '/work/dir']);
  });

  it('never passes -m or --yolo', () => {
    const pty = new HermesPTY(mockEnv, {});
    const b = pty as unknown as { buildClaudeArgs(m: string, p: string): string[] };
    for (const mode of ['fresh', 'continue']) {
      const args = b.buildClaudeArgs(mode, 'hello');
      expect(args).not.toContain('-m');
      expect(args).not.toContain('--yolo');
    }
  });

  it('isBootstrapped() fires on "❯" in output', () => {
    const pty = new HermesPTY(mockEnv, {});
    pty.getOutputBuffer().push('⚔ ❯ ');
    expect(pty.getOutputBuffer().isBootstrapped()).toBe(true);
  });

  it('isBootstrapped() does not fire on output without "❯"', () => {
    const pty = new HermesPTY(mockEnv, {});
    pty.getOutputBuffer().push('loading...');
    expect(pty.getOutputBuffer().isBootstrapped()).toBe(false);
  });
});

describe('HermesPTY startup injection', () => {
  type Inj = { waitForPromptThenInject(t?: number): Promise<void>; write(d: string): void };

  it('waits for boot output to settle, types the read line, retries Enter until a turn starts', async () => {
    vi.useFakeTimers();
    try {
      const pty = new HermesPTY(mockEnv, {});
      const writes: string[] = [];
      (pty as unknown as Inj).write = (d: string) => { writes.push(d); };
      pty.getOutputBuffer().push('⚔ ❯ ');
      const p = (pty as unknown as Inj).waitForPromptThenInject();
      await vi.advanceTimersByTimeAsync(500);
      pty.getOutputBuffer().push('⚠ 599 commits behind — run hermes update');  // late boot output
      await vi.advanceTimersByTimeAsync(3000);
      expect(writes[0]).toBe(`Read ${mockEnv.agentDir}/.cortextos-startup.md and follow the instructions there.`);
      // First Enter swallowed (no turn output); second produces a turn.
      await vi.advanceTimersByTimeAsync(4500);
      expect(writes.filter(w => w === '\r').length).toBe(2);
      pty.getOutputBuffer().push('x'.repeat(600));
      await vi.advanceTimersByTimeAsync(10000);
      await p;
      expect(writes.filter(w => w === '\r').length).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('never types before output has settled', async () => {
    vi.useFakeTimers();
    try {
      const pty = new HermesPTY(mockEnv, {});
      const writes: string[] = [];
      (pty as unknown as Inj).write = (d: string) => { writes.push(d); };
      pty.getOutputBuffer().push('⚔ ❯ ');
      void (pty as unknown as Inj).waitForPromptThenInject();
      for (let i = 0; i < 5; i++) {
        pty.getOutputBuffer().push(`boot line ${i}`);
        await vi.advanceTimersByTimeAsync(1000);
      }
      expect(writes).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});
