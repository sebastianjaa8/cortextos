import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createHmac } from 'crypto';
import { sendMessage, checkInbox } from '../../../src/bus/message';
import { generateAgentKey, loadAgentKey, clearAgentKeyCache } from '../../../src/bus/keys';
import type { BusPaths } from '../../../src/types';

const ENV_VARS = [
  'CTX_FRAMEWORK_ROOT',
  'CTX_AGENT_DIR',
  'CTX_PROJECT_ROOT',
  'CTX_ORG',
  'CTX_AGENT_NAME',
  'CTX_ROOT',
  'CTX_INSTANCE_ID',
];

function hmac(key: string, msgId: string, from: string, to: string, text: string): string {
  return createHmac('sha256', key).update(`${msgId}:${from}:${to}:${text}`).digest('hex');
}

describe('Per-agent message signing', () => {
  let testDir: string;
  let frameworkRoot: string;
  let paths: BusPaths;
  const savedEnv: Record<string, string | undefined> = {};

  function agentDir(name: string): string {
    return join(frameworkRoot, 'orgs', 'test_org', 'agents', name);
  }

  function writeInboxMessage(
    msg: { id: string; from: string; to: string; text: string; sig?: string },
  ): void {
    mkdirSync(paths.inbox, { recursive: true });
    const filename = `2-${Date.now()}-from-${msg.from}-abcde.json`;
    writeFileSync(
      join(paths.inbox, filename),
      JSON.stringify({
        id: msg.id,
        from: msg.from,
        to: msg.to,
        priority: 'normal',
        timestamp: new Date().toISOString(),
        text: msg.text,
        reply_to: null,
        ...(msg.sig ? { sig: msg.sig } : {}),
      }),
    );
  }

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'cortextos-signing-test-'));
    frameworkRoot = join(testDir, 'framework');
    mkdirSync(join(frameworkRoot, 'orgs', 'test_org', 'agents'), { recursive: true });

    for (const v of ENV_VARS) {
      savedEnv[v] = process.env[v];
      delete process.env[v];
    }
    process.env.CTX_FRAMEWORK_ROOT = frameworkRoot;
    clearAgentKeyCache();

    const ctxRoot = join(testDir, 'ctx');
    paths = {
      ctxRoot,
      inbox: join(ctxRoot, 'inbox', 'receiver'),
      inflight: join(ctxRoot, 'inflight', 'receiver'),
      processed: join(ctxRoot, 'processed', 'receiver'),
      logDir: join(ctxRoot, 'logs', 'receiver'),
      stateDir: join(ctxRoot, 'state', 'receiver'),
      taskDir: join(ctxRoot, 'tasks'),
      approvalDir: join(ctxRoot, 'approvals'),
      analyticsDir: join(ctxRoot, 'analytics'),
      deliverablesDir: join(ctxRoot, 'orgs', 'test_org', 'deliverables'),
    };
    mkdirSync(ctxRoot, { recursive: true });
  });

  afterEach(() => {
    clearAgentKeyCache();
    for (const v of ENV_VARS) {
      if (savedEnv[v] === undefined) delete process.env[v];
      else process.env[v] = savedEnv[v];
    }
    vi.restoreAllMocks();
    rmSync(testDir, { recursive: true, force: true });
  });

  describe('generateAgentKey', () => {
    it('creates a 64-hex-char key and is idempotent', () => {
      const dir = agentDir('sender');
      const key1 = generateAgentKey(dir);
      expect(key1).toMatch(/^[0-9a-f]{64}$/);
      const key2 = generateAgentKey(dir);
      expect(key2).toBe(key1);
    });
  });

  describe('loadAgentKey', () => {
    it('finds a provisioned key by agent name', () => {
      const key = generateAgentKey(agentDir('sender'));
      expect(loadAgentKey('sender')).toBe(key);
    });

    it('returns null for unknown agents', () => {
      expect(loadAgentKey('nobody')).toBeNull();
    });
  });

  it('accepts a message signed with the sender\'s own key', () => {
    generateAgentKey(agentDir('sender'));
    sendMessage(paths, 'sender', 'receiver', 'normal', 'hello');

    const messages = checkInbox(paths);
    expect(messages.length).toBe(1);
    expect(messages[0].text).toBe('hello');
    expect(messages[0].sig).toBeTruthy();
  });

  it('rejects a message signed with a DIFFERENT agent\'s key to inbox/.errors', () => {
    generateAgentKey(agentDir('sender'));
    const attackerKey = generateAgentKey(agentDir('attacker'));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    // Forgery: claims from='sender' but signed with attacker's key.
    writeInboxMessage({
      id: 'msg-forged',
      from: 'sender',
      to: 'receiver',
      text: 'forged',
      sig: hmac(attackerKey, 'msg-forged', 'sender', 'receiver', 'forged'),
    });

    const messages = checkInbox(paths);
    expect(messages.length).toBe(0);
    const errDir = join(paths.inbox, '.errors');
    expect(existsSync(errDir)).toBe(true);
    expect(readdirSync(errDir).length).toBe(1);
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('SECURITY'));
  });

  it('flags but accepts a message from an unknown sender with no key on file', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    sendMessage(paths, 'cortextos', 'receiver', 'normal', 'infra work');
    const messages = checkInbox(paths);

    expect(messages.length).toBe(1);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("'cortextos'"));
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('SECURITY'));
  });

  it('flags but accepts an unsigned message when the sender has a key on file', () => {
    generateAgentKey(agentDir('sender'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    writeInboxMessage({ id: 'msg-unsigned', from: 'sender', to: 'receiver', text: 'no sig' });
    const messages = checkInbox(paths);

    expect(messages.length).toBe(1);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Unsigned message msg-unsigned'),
    );
  });

  it('accepts a legacy shared-key-signed message with a transition warning', () => {
    generateAgentKey(agentDir('sender'));
    // Provision the old shared key.
    const sharedKey = 'a'.repeat(64);
    mkdirSync(join(paths.ctxRoot, 'config'), { recursive: true });
    writeFileSync(join(paths.ctxRoot, 'config', 'bus-signing-key'), sharedKey);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    writeInboxMessage({
      id: 'msg-legacy',
      from: 'sender',
      to: 'receiver',
      text: 'pre-migration',
      sig: hmac(sharedKey, 'msg-legacy', 'sender', 'receiver', 'pre-migration'),
    });

    const messages = checkInbox(paths);
    expect(messages.length).toBe(1);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('legacy shared-key signature'),
    );
  });

  it('rejects a shared-key message with a tampered payload (no per-agent key)', () => {
    const sharedKey = 'b'.repeat(64);
    mkdirSync(join(paths.ctxRoot, 'config'), { recursive: true });
    writeFileSync(join(paths.ctxRoot, 'config', 'bus-signing-key'), sharedKey);
    vi.spyOn(console, 'error').mockImplementation(() => {});

    writeInboxMessage({
      id: 'msg-tampered',
      from: 'stranger',
      to: 'receiver',
      text: 'tampered',
      sig: hmac(sharedKey, 'msg-tampered', 'stranger', 'receiver', 'original'),
    });

    const messages = checkInbox(paths);
    expect(messages.length).toBe(0);
    expect(readdirSync(join(paths.inbox, '.errors')).length).toBe(1);
  });
});
