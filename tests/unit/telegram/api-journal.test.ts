/**
 * TelegramAPI journalling must be invisible to every caller that does not ask
 * for it, and must not change what sendMessage throws.
 *
 * Stakes: hook-planmode-telegram.ts:106-112 catches a failed send and calls
 * outputDecision('allow') -- it AUTO-APPROVES a plan Sebastian never saw. If
 * journalling swallowed the error, that catch would stop firing and the hook's
 * behaviour would change silently. If journalling threw its own error, it would
 * turn a delivered message into a failed one. Both are worse than the missing
 * log this feature exists to fix.
 *
 * api.ts is shared by the daemon, the hooks and the CLI, so "existing callers
 * unchanged" is the property that matters most here.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { TelegramAPI } from '../../../src/telegram/api';
import * as journal from '../../../src/telegram/outbound-journal';

// Spy rather than filesystem-check the no-context case. The first version of
// this test asserted "no logs/ dir under the temp root" -- which the API can
// never create anyway, since it is never told that path. It passed under a
// deliberate mutation that journalled unconditionally. Vacuous. Assert the call
// itself, not a side effect the code under test cannot produce.
vi.mock('../../../src/telegram/outbound-journal', async (orig) => {
  const actual = await (orig() as Promise<typeof journal>);
  return { ...actual, recordOutboundDelivery: vi.fn(actual.recordOutboundDelivery) };
});

const journalPath = (root: string) => join(root, 'logs', 'a1', 'outbound-deliveries.jsonl');
const rows = (root: string) =>
  readFileSync(journalPath(root), 'utf-8').trim().split('\n').map((l) => JSON.parse(l));

describe('TelegramAPI journalling', () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'api-j-')); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); vi.unstubAllGlobals(); });

  const okFetch = () =>
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, result: { message_id: 99 } }),
    });

  it('journals nothing at all when no context is supplied (every existing caller)', async () => {
    vi.stubGlobal('fetch', okFetch());
    vi.mocked(journal.recordOutboundDelivery).mockClear();

    await new TelegramAPI('1:t').sendMessage('42', 'hello');

    // The daemon, CLI and other hooks all construct TelegramAPI without a
    // context. For them the journal must not merely write elsewhere -- it must
    // not run. Asserting the call count is what actually pins that down.
    expect(journal.recordOutboundDelivery).not.toHaveBeenCalled();
    expect(existsSync(join(root, 'logs'))).toBe(false);
  });

  it('records delivering then accepted with the real message_id when asked', async () => {
    vi.stubGlobal('fetch', okFetch());
    await new TelegramAPI('1:t', { ctxRoot: root, agentName: 'a1' }).sendMessage('42', 'hello');

    const r = rows(root);
    expect(r.map((x) => x.state)).toEqual(['delivering', 'accepted']);
    expect(r[1].message_id).toBe(99);
    expect(new Set(r.map((x) => x.delivery_id)).size).toBe(1);
  });

  it('rethrows unchanged, so planmode still auto-approves and permission still denies', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: false, description: 'Bad Request: chat not found' }),
    }));
    const api = new TelegramAPI('1:t', { ctxRoot: root, agentName: 'a1' });

    // The throw is the contract those two hooks are built on.
    await expect(api.sendMessage('42', 'hello')).rejects.toThrow(/chat not found/);
    expect(rows(root).at(-1)!.state).toBe('dead-letter');
    expect(rows(root).at(-1)!.error).toMatch(/chat not found/);
  });

  it('records payload size, so a failed multi-chunk send is not read as a clean non-delivery', async () => {
    // sendMessage splits at 4096 and sends chunks sequentially: a failure on a
    // later chunk leaves earlier ones already delivered. bytes is what lets a
    // reader tell that dead-letter apart from a message that never landed.
    vi.stubGlobal('fetch', okFetch());
    const long = 'x'.repeat(9000);
    await new TelegramAPI('1:t', { ctxRoot: root, agentName: 'a1' }).sendMessage('42', long);
    expect(rows(root)[0].bytes).toBe(9000);
  });

  it('a broken journal path never breaks the send', async () => {
    vi.stubGlobal('fetch', okFetch());
    const api = new TelegramAPI('1:t', { ctxRoot: '\0://nope', agentName: 'a1' });
    await expect(api.sendMessage('42', 'hello')).resolves.toBeDefined();
  });
});
