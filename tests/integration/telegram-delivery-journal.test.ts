import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { TelegramPoller } from '../../src/telegram/poller';
import type { TelegramAPI } from '../../src/telegram/api';
import type { TelegramUpdate } from '../../src/types';

function messageUpdate(updateId: number): TelegramUpdate {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      chat: { id: 7, type: 'private' },
      text: 'same body',
    },
  };
}

describe('Telegram durable delivery journal integration', () => {
  const stateDirs: string[] = [];

  afterEach(() => {
    for (const stateDir of stateDirs) rmSync(stateDir, { recursive: true, force: true });
    stateDirs.length = 0;
  });

  it('acknowledges two same-text updates durably and recovers both after restart', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'cortextos-telegram-integration-'));
    stateDirs.push(stateDir);
    const updates = [messageUpdate(100), messageUpdate(101)];
    const firstApi = {
      getUpdates: vi.fn(async (offset: number) => ({
        result: updates.filter((item) => item.update_id >= offset),
      })),
    } as unknown as TelegramAPI;
    const firstPoller = new TelegramPoller(firstApi, stateDir, 1, undefined, {
      agentName: 'eros',
      botId: '123456',
    });
    const firstProcessIds: string[] = [];

    firstPoller.onMessage((_message, delivery) => {
      firstProcessIds.push(delivery.deliveryId);
      // Simulate daemon loss after the durable dispatch handoff but before
      // FastChecker reports PTY acceptance.
    });
    await firstPoller.pollOnce();

    expect(new Set(firstProcessIds).size).toBe(2);
    expect(readFileSync(join(stateDir, '.telegram-offset'), 'utf-8').trim()).toBe('102');
    expect(firstPoller.getDeliveryHealth().counts.delivering).toBe(2);

    const restartedApi = {
      getUpdates: vi.fn(async () => ({ result: [] })),
    } as unknown as TelegramAPI;
    const restartedPoller = new TelegramPoller(restartedApi, stateDir, 1, undefined, {
      agentName: 'eros',
      botId: '123456',
    });
    const recoveredIds: string[] = [];
    restartedPoller.onMessage((_message, delivery) => {
      recoveredIds.push(delivery.deliveryId);
      restartedPoller.markDeliveryAccepted(delivery.deliveryId);
    });

    expect(await restartedPoller.recoverPendingDeliveries()).toBe(2);
    expect(recoveredIds).toEqual(firstProcessIds);
    expect(restartedPoller.getDeliveryHealth()).toMatchObject({
      pending: 0,
      counts: { accepted: 2 },
    });
  });
});
