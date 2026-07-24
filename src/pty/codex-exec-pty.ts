import { existsSync, readFileSync, writeFileSync } from 'fs';
import { delimiter, dirname, join } from 'path';
import { homedir } from 'os';
import { spawn as spawnChildProcess, spawnSync, type ChildProcess } from 'child_process';
import type { AgentConfig, CtxEnv } from '../types/index.js';
import { OutputBuffer } from './output-buffer.js';
import { ensureDir } from '../utils/atomic.js';
import type { DeliveryCallbacks } from './inject.js';
import {
  removeRuntimeProcessRecord,
  terminateProcessTree,
  writeRuntimeProcessRecord,
  type RuntimeProcessRecord,
} from '../utils/process-ownership.js';

interface CodexLaunch {
  command: string;
  args: string[];
  shell: boolean;
}

interface CodexExecSessionState {
  sessionId: string;
  cwd: string;
  updatedAt: string;
}

type ExecMode = 'fresh' | 'continue';
type ExecQueueItem = { mode: ExecMode; prompt: string; delivery?: DeliveryCallbacks };

const BOOTSTRAP_PATTERN = '[codex-exec] ready';
const SESSION_STATE_BASENAME = 'codex-exec-session.json';
const SESSION_ID_RE = /session id:\s*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;
const BRACKETED_PASTE_RE = /\x1b\[200~|\x1b\[201~/g;

export function codexExecSessionExists(ctxRoot: string, agentName: string): boolean {
  return existsSync(join(ctxRoot, 'state', agentName, SESSION_STATE_BASENAME));
}

/**
 * Virtual persistent adapter for `codex exec`.
 *
 * `codex exec` is process-per-turn, but cortextOS expects a resident PTY-like
 * object. This adapter stays alive, serializes inbound messages, and runs one
 * `codex exec` / `codex exec resume` child process per turn. It uses the
 * user's normal Codex CLI auth, so ChatGPT-plan billing works without API keys.
 */
export class CodexExecPTY {
  private _alive = false;
  private _executing = false;
  private _currentProcess: ChildProcess | null = null;
  private _queue: ExecQueueItem[] = [];
  private _writeBuffer = '';
  private _sessionParseBuffer = '';
  private _sessionId: string | null = null;
  private _onExitHandler: ((exitCode: number, signal?: NodeJS.Signals | number) => void) | null = null;
  private _outputBuffer: OutputBuffer;
  private _env: CtxEnv;
  private _config: AgentConfig;
  private _stateDir: string;
  private _sessionStatePath: string;
  private _cwd: string;
  private _runtimeProcessRecord: RuntimeProcessRecord | null = null;

  constructor(env: CtxEnv, config: AgentConfig, logPath?: string) {
    this._env = env;
    this._config = config;
    this._stateDir = join(env.ctxRoot, 'state', env.agentName);
    this._sessionStatePath = join(this._stateDir, SESSION_STATE_BASENAME);
    this._cwd = config.working_directory || env.agentDir || process.cwd();
    this._outputBuffer = new OutputBuffer(1000, logPath, BOOTSTRAP_PATTERN);
  }

  async spawn(mode: ExecMode, prompt: string): Promise<void> {
    if (this._alive) throw new Error('Codex exec runtime already spawned. Kill first.');
    ensureDir(this._stateDir);
    this._alive = true;
    this._sessionId = mode === 'continue' ? this.readSessionId() : null;
    this._outputBuffer.push(`${BOOTSTRAP_PATTERN}\n`);

    if (prompt.trim()) {
      this.enqueueTurn(mode, prompt);
    }
  }

  write(data: string): void {
    if (!this._alive) throw new Error('Codex exec runtime is not spawned');
    this._writeBuffer += data;
    if (!/[\r\n]/.test(data)) return;

    const content = this._writeBuffer
      .replace(BRACKETED_PASTE_RE, '')
      .replace(/\r/g, '\n')
      .trim();
    this._writeBuffer = '';
    if (content) this.injectMessage(content);
  }

  injectMessage(content: string, delivery?: DeliveryCallbacks): void {
    if (!this._alive) {
      const error = new Error('Codex exec runtime is not spawned');
      delivery?.onFailed?.(error);
      throw error;
    }
    this.enqueueTurn('continue', content, delivery);
  }

  kill(): void {
    this._alive = false;
    const error = new Error('Codex exec stopped before queued delivery was submitted');
    for (const queued of this._queue) queued.delivery?.onFailed?.(error);
    this._queue = [];
    this.stopCurrentProcess();
    this._onExitHandler?.(0, undefined);
  }

  isAlive(): boolean {
    return this._alive;
  }

  getPid(): number | null {
    return this._currentProcess?.pid ?? null;
  }

  onExit(handler: (exitCode: number, signal?: NodeJS.Signals | number) => void): void {
    this._onExitHandler = handler;
  }

  getOutputBuffer(): OutputBuffer {
    return this._outputBuffer;
  }

  private enqueueTurn(mode: ExecMode, prompt: string, delivery?: DeliveryCallbacks): void {
    this._queue.push({ mode, prompt, delivery });
    this.drainQueue();
  }

  private drainQueue(): void {
    if (!this._alive || this._executing) return;
    const next = this._queue.shift();
    if (!next) return;
    try {
      this.runTurn(next);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      next.delivery?.onFailed?.(error);
      this._executing = false;
      this.drainQueue();
    }
  }

  private runTurn(item: ExecQueueItem): void {
    this._executing = true;
    const { mode, prompt, delivery } = item;
    let deliverySettled = false;
    let promptSubmitted = false;
    let correlatedOutputSeen = false;
    const acceptDelivery = () => {
      if (deliverySettled) return;
      deliverySettled = true;
      delivery?.onAccepted?.();
    };
    const failDelivery = (error: Error) => {
      if (deliverySettled) return;
      deliverySettled = true;
      delivery?.onFailed?.(error);
    };
    const effectiveMode: ExecMode = mode === 'continue' && this._sessionId ? 'continue' : 'fresh';
    const args = this.buildArgs(effectiveMode);
    const env = this.buildEnv();
    const launch = this.resolveCodexLaunch(env, args);

    this._outputBuffer.push(`[codex-exec] turn started mode=${effectiveMode}\n`);
    const child = spawnChildProcess(launch.command, launch.args, {
      cwd: this._cwd,
      env,
      shell: launch.shell,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this._currentProcess = child;

    if (!child.pid) {
      this._currentProcess = null;
      this._executing = false;
      throw new Error('Codex exec child spawned without a process ID');
    }
    try {
      this._runtimeProcessRecord = writeRuntimeProcessRecord(this._stateDir, {
        instanceId: this._env.instanceId,
        agentName: this._env.agentName,
        runtime: 'codex-exec',
        pid: child.pid,
      });
    } catch (err) {
      this.stopCurrentProcess();
      throw err;
    }

    const handleOutput = (chunk: Buffer | string) => {
      const data = chunk.toString();
      this._outputBuffer.push(data);
      this.captureSessionId(data);
      correlatedOutputSeen = true;
      if (promptSubmitted) acceptDelivery();
    };
    child.stdout?.on('data', handleOutput);
    child.stderr?.on('data', handleOutput);
    child.on('error', (err) => {
      this._outputBuffer.push(`[codex-exec] process error: ${err}\n`);
      failDelivery(err);
      this.finishTurn(child, 1, undefined);
    });
    child.on('exit', (exitCode, signal) => {
      if (!deliverySettled && promptSubmitted && (exitCode ?? 0) === 0) {
        acceptDelivery();
      } else if (!deliverySettled) {
        failDelivery(new Error(`Codex exec exited before prompt submission (code=${exitCode ?? 0})`));
      }
      this.finishTurn(child, exitCode ?? 0, signal ?? undefined);
    });

    try {
      if (!child.stdin) throw new Error('Codex exec child has no stdin');
      child.stdin.once('error', failDelivery);
      child.stdin.end(prompt, () => {
        promptSubmitted = true;
        if (correlatedOutputSeen) acceptDelivery();
      });
    } catch (err) {
      this._outputBuffer.push(`[codex-exec] stdin write failed: ${err}\n`);
      failDelivery(err instanceof Error ? err : new Error(String(err)));
    }
  }

  private buildArgs(mode: ExecMode): string[] {
    const options = ['--skip-git-repo-check'];
    if (this._config.model) {
      options.push('--model', this._config.model);
    }
    if (this._config.dangerously_skip_permissions !== false) {
      options.push('--dangerously-bypass-approvals-and-sandbox');
    }

    if (mode === 'continue' && this._sessionId) {
      return ['exec', 'resume', ...options, this._sessionId, '-'];
    }
    return ['exec', ...options, '-'];
  }

  private finishTurn(child: ChildProcess, exitCode: number, signal?: NodeJS.Signals): void {
    if (this._currentProcess !== child) return;
    this.clearRuntimeProcessRecord();
    this._currentProcess = null;
    this._executing = false;
    this._outputBuffer.push(`[codex-exec] turn completed code=${exitCode} signal=${signal ?? 'none'}\n`);
    if (exitCode === 0 && this._sessionId) {
      this.writeSessionState();
    }
    this.drainQueue();
  }

  private captureSessionId(data: string): void {
    this._sessionParseBuffer = `${this._sessionParseBuffer}${data}`.slice(-4000);
    const match = SESSION_ID_RE.exec(this._sessionParseBuffer);
    if (match?.[1]) {
      this._sessionId = match[1];
    }
  }

  private readSessionId(): string | null {
    if (!existsSync(this._sessionStatePath)) return null;
    try {
      const parsed = JSON.parse(readFileSync(this._sessionStatePath, 'utf-8')) as Partial<CodexExecSessionState>;
      if (typeof parsed.sessionId === 'string' && (!parsed.cwd || parsed.cwd === this._cwd)) {
        return parsed.sessionId;
      }
    } catch {
      // Ignore stale or malformed session state.
    }
    return null;
  }

  private writeSessionState(): void {
    try {
      ensureDir(this._stateDir);
      const state: CodexExecSessionState = {
        sessionId: this._sessionId!,
        cwd: this._cwd,
        updatedAt: new Date().toISOString(),
      };
      writeFileSync(this._sessionStatePath, `${JSON.stringify(state, null, 2)}\n`, 'utf-8');
    } catch {
      // Non-fatal: next boot will start a fresh codex exec session.
    }
  }

  private stopCurrentProcess(): void {
    const child = this._currentProcess;
    this._currentProcess = null;
    this._executing = false;
    const record = this._runtimeProcessRecord;
    if (record) {
      if (terminateProcessTree(record.pid, {
        pid: record.pid,
        startIdentity: record.processStartIdentity,
      })) {
        this.clearRuntimeProcessRecord();
      } else {
        this._outputBuffer.push(`[codex-exec] owned process ${record.pid} survived termination; record retained\n`);
      }
      return;
    }
    if (!child?.pid) return;

    try {
      if (process.platform === 'win32') {
        spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
          stdio: 'ignore',
          windowsHide: true,
        });
      } else {
        child.kill();
      }
    } catch {
      // Ignore shutdown errors.
    }
  }

  private clearRuntimeProcessRecord(): void {
    const record = this._runtimeProcessRecord;
    if (!record) return;
    if (removeRuntimeProcessRecord(this._stateDir, record.ownerToken)) {
      this._runtimeProcessRecord = null;
    }
  }

  private resolveCodexCommand(env: Record<string, string>): string {
    if (process.platform !== 'win32') return 'codex';
    const pathVar = env['PATH'] || process.env['PATH'] || '';
    for (const dir of pathVar.split(delimiter)) {
      if (!dir) continue;
      for (const ext of ['.cmd', '.exe', '.bat']) {
        const candidate = join(dir, `codex${ext}`);
        if (existsSync(candidate)) return candidate;
      }
    }
    return 'codex';
  }

  private resolveCodexLaunch(env: Record<string, string>, args: string[]): CodexLaunch {
    const command = this.resolveCodexCommand(env);
    if (process.platform !== 'win32') return { command, args, shell: false };

    if (/\.(cmd|bat)$/i.test(command)) {
      const codexJs = join(dirname(command), 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
      if (existsSync(codexJs)) {
        return { command: process.execPath, args: [codexJs, ...args], shell: false };
      }
    }

    if (/\.exe$/i.test(command)) return { command, args, shell: false };
    return { command, args, shell: true };
  }

  private buildEnv(): Record<string, string> {
    const env: Record<string, string> = {};
    const keepVars = [
      'PATH', 'HOME', 'USER', 'SHELL', 'TERM', 'LANG', 'LC_ALL', 'TMPDIR',
      'TEMP', 'TMP', 'NODE_PATH', 'COMSPEC', 'USERPROFILE',
      'SystemDrive', 'SystemRoot', 'windir', 'APPDATA', 'LOCALAPPDATA',
      'ProgramData', 'ALLUSERSPROFILE', 'ProgramFiles', 'ProgramFiles(x86)',
      'ProgramW6432', 'HOMEDRIVE', 'HOMEPATH', 'PUBLIC',
    ];
    for (const key of keepVars) {
      if (process.env[key]) env[key] = process.env[key]!;
    }

    env['CTX_INSTANCE_ID'] = this._env.instanceId;
    env['CTX_ROOT'] = this._env.ctxRoot;
    env['CTX_FRAMEWORK_ROOT'] = this._env.frameworkRoot;
    env['CTX_AGENT_NAME'] = this._env.agentName;
    env['CTX_ORG'] = this._env.org;
    env['CTX_AGENT_DIR'] = this._env.agentDir;
    env['CTX_PROJECT_ROOT'] = this._env.projectRoot;
    env['CRM_AGENT_NAME'] = this._env.agentName;
    env['CRM_TEMPLATE_ROOT'] = this._env.frameworkRoot;

    if (this._env.org && this._env.projectRoot) {
      this.loadEnvFile(join(this._env.projectRoot, 'orgs', this._env.org, 'secrets.env'), env);
    }
    this.loadEnvFile(join(this._env.agentDir, '.env'), env);

    // Use the user's normal Codex home so ChatGPT-plan auth is shared with
    // interactive codex CLI runs instead of stale per-agent CODEX_HOME silos.
    env['CODEX_HOME'] = process.env.CODEX_HOME || join(homedir(), '.codex');

    if (env['CHAT_ID']) env['CTX_TELEGRAM_CHAT_ID'] = env['CHAT_ID'];
    if (this._config.timezone) {
      env['CTX_TIMEZONE'] = this._config.timezone;
      env['TZ'] = this._config.timezone;
    }

    return env;
  }

  private loadEnvFile(path: string, env: Record<string, string>): void {
    if (!existsSync(path)) return;
    try {
      for (const line of readFileSync(path, 'utf-8').split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx > 0) {
          env[trimmed.slice(0, eqIdx).trim()] = trimmed.slice(eqIdx + 1).trim();
        }
      }
    } catch {
      // Ignore env file read errors.
    }
  }
}
