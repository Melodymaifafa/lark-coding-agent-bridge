import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { log } from '../../../src/core/logger.js';
import { isCreator, type RuntimeControls } from '../../../src/policy/access.js';
import {
  createOwnerRefreshController,
  OWNER_REFRESH_INTERVAL_MS,
  refreshOwnerControls,
  resetOwnerRefreshDenialsForTest,
  type AppInfoSource,
} from '../../../src/policy/owner.js';

const THREE_HOURS = 3 * 60 * 60 * 1000;

/** What node-sdk throws when application.get is denied, copied from a real bridge log. */
function appInfoDenied(): Error {
  return Object.assign(new Error('Request failed with status code 400'), {
    config: {
      method: 'get',
      url: 'https://open.feishu.cn/open-apis/application/v6/applications/cli_x',
    },
    response: {
      status: 400,
      statusText: 'Bad Request',
      data: {
        code: 99991672,
        msg: 'Access denied. One of the following scopes is required: [admin:app.info:readonly, application:application:self_manage].',
        error: {
          permission_violations: [
            { type: 'action_scope_required', subject: 'admin:app.info:readonly' },
            { type: 'action_scope_required', subject: 'application:application:self_manage' },
          ],
        },
      },
    },
  });
}

function networkError(): Error {
  return Object.assign(new Error('getaddrinfo ENOTFOUND open.feishu.cn'), { code: 'ENOTFOUND' });
}

function fakeSource(next: () => string | Error): AppInfoSource & { calls: number } {
  return {
    calls: 0,
    async getAppInfo() {
      this.calls += 1;
      const result = next();
      if (result instanceof Error) throw result;
      return { ownerId: result };
    },
  };
}

function ownerFailures(warn: ReturnType<typeof vi.spyOn>): unknown[][] {
  return warn.mock.calls.filter((c: unknown[]) => c[0] === 'access' && c[1] === 'owner_refresh_failed');
}

describe('owner refresh when the app lacks the app-info scope', () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    resetOwnerRefreshDenialsForTest();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('logs one line naming the scope and stops the 30-minute refresh', async () => {
    const controls: RuntimeControls = { ownerRefreshState: 'unknown' };
    const source = fakeSource(appInfoDenied);
    const controller = createOwnerRefreshController({ controls, source, appId: 'cli_x' });

    await controller.start();
    await vi.advanceTimersByTimeAsync(THREE_HOURS);

    expect(source.calls).toBe(1);
    expect(ownerFailures(warn)).toEqual([
      [
        'access',
        'owner_refresh_failed',
        {
          appId: 'cli_x',
          error: 'Request failed with status code 400',
          missingScopes: 'admin:app.info:readonly, application:application:self_manage',
          retry: 'off until restart',
        },
      ],
    ]);
    expect(vi.getTimerCount()).toBe(0);
    controller.stop();
  });

  it('stops the timer when a later refresh is denied', async () => {
    const controls: RuntimeControls = { ownerRefreshState: 'unknown' };
    const results: Array<string | Error> = ['ou_owner', appInfoDenied()];
    const source = fakeSource(() => results.shift() ?? 'ou_unexpected');
    const controller = createOwnerRefreshController({ controls, source, appId: 'cli_x' });

    await controller.start();
    await vi.advanceTimersByTimeAsync(THREE_HOURS);

    expect(source.calls).toBe(2);
    expect(ownerFailures(warn)).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
    controller.stop();
  });

  it('keeps retrying every 30 minutes on a network error', async () => {
    const controls: RuntimeControls = { ownerRefreshState: 'unknown' };
    const source = fakeSource(networkError);
    const controller = createOwnerRefreshController({ controls, source, appId: 'cli_x' });

    await controller.start();
    await vi.advanceTimersByTimeAsync(THREE_HOURS);

    expect(source.calls).toBe(1 + THREE_HOURS / OWNER_REFRESH_INTERVAL_MS);
    expect(ownerFailures(warn)).toHaveLength(source.calls);
    expect(ownerFailures(warn)[0]).toEqual([
      'access',
      'owner_refresh_failed',
      { appId: 'cli_x', error: 'getaddrinfo ENOTFOUND open.feishu.cn' },
    ]);
    expect(vi.getTimerCount()).toBe(1);
    controller.stop();
  });

  it('leaves callers a closed owner path without asking Feishu again', async () => {
    const controls: RuntimeControls = { ownerRefreshState: 'unknown' };
    const source = fakeSource(appInfoDenied);
    await createOwnerRefreshController({ controls, source, appId: 'cli_x' }).start();

    // /config refreshes on demand; an in-process reconnect builds fresh controls.
    const fresh: RuntimeControls = { ownerRefreshState: 'unknown' };
    await expect(refreshOwnerControls(controls, source, 'cli_x')).resolves.toBeUndefined();
    await expect(refreshOwnerControls(fresh, source, 'cli_x')).resolves.toBeUndefined();

    expect(source.calls).toBe(1);
    expect(ownerFailures(warn)).toHaveLength(1);
    for (const c of [controls, fresh]) {
      expect(c.ownerRefreshState).toBe('failed');
      expect(c.ownerRefreshError).toBe('Request failed with status code 400');
      expect(c.botOwnerId).toBeUndefined();
      expect(isCreator(c, 'ou_owner')).toBe(false);
    }
  });

  it('tries again once after a restart, so granting the scope recovers', async () => {
    const denied = fakeSource(appInfoDenied);
    await createOwnerRefreshController({
      controls: { ownerRefreshState: 'unknown' },
      source: denied,
      appId: 'cli_x',
    }).start();

    resetOwnerRefreshDenialsForTest(); // a new process starts with no memory
    const controls: RuntimeControls = { ownerRefreshState: 'unknown' };
    const granted = fakeSource(() => 'ou_owner');
    const controller = createOwnerRefreshController({ controls, source: granted, appId: 'cli_x' });
    await controller.start();

    expect(granted.calls).toBe(1);
    expect(controls.ownerRefreshState).toBe('ok');
    expect(isCreator(controls, 'ou_owner')).toBe(true);
    expect(vi.getTimerCount()).toBe(1);
    controller.stop();
  });
});
