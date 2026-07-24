import { mkdtempSync, rmSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createConnection, createServer } from 'net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IPCClient, IPCServer } from '../../../src/daemon/ipc-server.js';
import { getIpcPath } from '../../../src/utils/paths.js';

const servers: IPCServer[] = [];
const roots: string[] = [];

function uniqueInstance(): string {
  return `ipc-test-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
}

function fakeManager(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    getAllStatuses: () => [],
    getAgentNames: () => [],
    discoverAndStart: async () => {},
    inspectAgentOp: () => ({ ok: true }),
    startAgent: async () => {},
    stopAgent: async () => {},
    restartAgent: async () => {},
    getFastChecker: () => null,
    spawnWorker: async () => {},
    terminateWorker: async () => {},
    listWorkers: () => [],
    injectWorker: () => false,
    injectAgentDetailed: () => ({ ok: true }),
    injectAgent: () => true,
    reloadCrons: () => {},
    ...overrides,
  };
}

async function rawRequest(instanceId: string, payload: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(getIpcPath(instanceId), () => socket.write(payload));
    let data = '';
    socket.on('data', chunk => { data += chunk.toString(); });
    socket.on('end', () => {
      try { resolve(JSON.parse(data)); } catch (err) { reject(err); }
    });
    socket.on('error', reject);
  });
}

afterEach(() => {
  for (const server of servers.splice(0)) server.stop();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('IPC control-plane security', () => {
  it('authenticates the official client with a per-instance credential', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cortextos-ipc-auth-'));
    roots.push(root);
    const instance = uniqueInstance();
    const server = new IPCServer(fakeManager() as never, instance, root);
    servers.push(server);
    await server.start();

    const response = await new IPCClient(instance, root).send({ type: 'status', source: 'test' });

    expect(response).toEqual({ success: true, data: [] });
  });

  it('rejects unauthenticated local named-pipe requests before dispatch', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cortextos-ipc-unauth-'));
    roots.push(root);
    const instance = uniqueInstance();
    const server = new IPCServer(fakeManager() as never, instance, root);
    servers.push(server);
    await server.start();

    const response = await rawRequest(instance, JSON.stringify({ type: 'status' }));

    expect(response).toEqual(expect.objectContaining({ success: false, code: 'UNAUTHORIZED' }));
  });

  it('buffers a JSON request split across socket data events', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cortextos-ipc-fragment-'));
    roots.push(root);
    const instance = uniqueInstance();
    const server = new IPCServer(fakeManager() as never, instance, root);
    servers.push(server);
    await server.start();

    const response = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const socket = createConnection(getIpcPath(instance), () => {
        const payload = JSON.stringify({ type: 'status' });
        socket.write(payload.slice(0, 8));
        setImmediate(() => socket.write(payload.slice(8)));
      });
      let data = '';
      socket.on('data', chunk => { data += chunk.toString(); });
      socket.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (err) { reject(err); }
      });
      socket.on('error', reject);
    });

    expect(response).toEqual(expect.objectContaining({ success: false, code: 'UNAUTHORIZED' }));
  });

  it('preserves a UTF-8 request split inside a multibyte code point', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cortextos-ipc-utf8-request-'));
    roots.push(root);
    const instance = uniqueInstance();
    const injectAgentDetailed = vi.fn(() => ({ ok: true }));
    const server = new IPCServer(fakeManager({ injectAgentDetailed }) as never, instance, root);
    servers.push(server);
    await server.start();
    const auth = readFileSync(join(root, 'config', 'ipc-token'), 'utf8').trim();

    const response = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const socket = createConnection(getIpcPath(instance), () => {
        const payload = Buffer.from(JSON.stringify({
          type: 'inject-agent', agent: 'alice', data: { text: 'hello 😀' }, auth,
        }), 'utf8');
        const emojiStart = payload.indexOf(Buffer.from('😀', 'utf8'));
        socket.write(payload.subarray(0, emojiStart + 2));
        setImmediate(() => socket.write(payload.subarray(emojiStart + 2)));
      });
      let data = '';
      socket.on('data', chunk => { data += chunk.toString(); });
      socket.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (err) { reject(err); }
      });
      socket.on('error', reject);
    });

    expect(response.success).toBe(true);
    expect(injectAgentDetailed).toHaveBeenCalledWith('alice', 'hello 😀');
  });

  it('preserves a UTF-8 response split inside a multibyte code point', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cortextos-ipc-utf8-response-'));
    roots.push(root);
    const instance = uniqueInstance();
    const socketPath = getIpcPath(instance);
    const rawServer = createServer((socket) => {
      let replied = false;
      socket.on('data', () => {
        if (replied) return;
        replied = true;
        const payload = Buffer.from(JSON.stringify({ success: true, data: 'ready 😀' }), 'utf8');
        const emojiStart = payload.indexOf(Buffer.from('😀', 'utf8'));
        socket.write(payload.subarray(0, emojiStart + 1));
        setImmediate(() => socket.end(payload.subarray(emojiStart + 1)));
      });
    });
    await new Promise<void>((resolve, reject) => {
      rawServer.once('error', reject);
      rawServer.listen(socketPath, resolve);
    });
    try {
      await expect(new IPCClient(instance, root).send({ type: 'status' }))
        .resolves.toEqual({ success: true, data: 'ready 😀' });
    } finally {
      await new Promise<void>((resolve) => rawServer.close(() => resolve()));
    }
  });

  it('bounds request memory before parsing', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cortextos-ipc-size-'));
    roots.push(root);
    const instance = uniqueInstance();
    const server = new IPCServer(fakeManager() as never, instance, root);
    servers.push(server);
    await server.start();

    const response = await rawRequest(instance, 'x'.repeat(1024 * 1024 + 1));

    expect(response).toEqual(expect.objectContaining({ success: false, code: 'PAYLOAD_TOO_LARGE' }));
  });

  it('does not acknowledge lifecycle completion before the manager finishes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cortextos-ipc-await-'));
    roots.push(root);
    const instance = uniqueInstance();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const server = new IPCServer(fakeManager({ startAgent: () => gate }) as never, instance, root);
    servers.push(server);
    await server.start();
    const client = new IPCClient(instance, root);

    let settled = false;
    const pending = client.send({ type: 'start-agent', agent: 'alice' }).then(response => {
      settled = true;
      return response;
    });
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(settled).toBe(false);

    release();
    await expect(pending).resolves.toEqual({ success: true, data: 'Started alice' });
  });

  it('awaits start-all discovery before acknowledging completion', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cortextos-ipc-start-all-'));
    roots.push(root);
    const instance = uniqueInstance();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const server = new IPCServer(fakeManager({ discoverAndStart: () => gate }) as never, instance, root);
    servers.push(server);
    await server.start();
    const pending = new IPCClient(instance, root).send({ type: 'start-all-agents' });
    release();
    await expect(pending).resolves.toEqual({ success: true, data: [] });
  });
});
