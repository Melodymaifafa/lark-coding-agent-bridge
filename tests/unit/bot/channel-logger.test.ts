import { afterEach, describe, expect, it, vi } from 'vitest';
import * as channelModule from '../../../src/bot/channel.js';
import { getMissingScopes, resetMissingScopesForTest } from '../../../src/bot/lark-permission.js';
import { log } from '../../../src/core/logger.js';

describe('Lark SDK logger noise filtering', () => {
  it('suppresses optional wiki-node permission failures that fall back to the original file token', () => {
    const shouldSuppress = (
      channelModule as {
        shouldSuppressSdkErrorLog?: (args: unknown[]) => boolean;
      }
    ).shouldSuppressSdkErrorLog;

    expect(
      shouldSuppress?.([
        [
          {
            message: 'Request failed with status code 400',
            config: {
              method: 'get',
              url: 'https://open.feishu.cn/open-apis/wiki/v2/spaces/get_node',
            },
            response: {
              data: {
                code: 99991672,
                msg: 'Access denied. One of the following scopes is required: [wiki:node:read].',
              },
            },
          },
          {
            code: 99991672,
            msg: 'Access denied. One of the following scopes is required: [wiki:node:read].',
          },
        ],
      ]),
    ).toBe(true);
  });

  it('keeps unrelated permission failures visible', () => {
    const shouldSuppress = (
      channelModule as {
        shouldSuppressSdkErrorLog?: (args: unknown[]) => boolean;
      }
    ).shouldSuppressSdkErrorLog;

    expect(
      shouldSuppress?.([
        {
          message: 'Request failed with status code 400',
          config: {
            method: 'post',
            url: 'https://open.feishu.cn/open-apis/im/v1/messages',
          },
          response: {
            data: {
              code: 99991672,
              msg: 'Access denied.',
            },
          },
        },
      ]),
    ).toBe(false);
  });
});

describe('Lark SDK permission errors', () => {
  afterEach(() => {
    resetMissingScopesForTest();
    vi.restoreAllMocks();
  });

  // What node-sdk passes to `logger.error` when application.get is denied at
  // startup (owner refresh), copied from a real bridge log.
  const ownerInfoDenied = [
    [
      {
        message: 'Request failed with status code 400',
        config: {
          method: 'get',
          url: 'https://open.feishu.cn/open-apis/application/v6/applications/cli_x',
        },
        response: {
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
          status: 400,
          statusText: 'Bad Request',
        },
      },
      {
        code: 99991672,
        msg: 'Access denied. One of the following scopes is required: [admin:app.info:readonly, application:application:self_manage].',
      },
    ],
  ];

  it('logs the missing scope once instead of an sdk.error per call', () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    const logger = channelModule.buildQuietLogger();

    logger.error(...ownerInfoDenied);
    logger.error(...ownerInfoDenied);

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('lark-permission', 'scope-missing', {
      scopes: 'admin:app.info:readonly, application:application:self_manage',
      api: 'https://open.feishu.cn/open-apis/application/v6/applications/cli_x',
    });
    expect(getMissingScopes()).toEqual([
      ['admin:app.info:readonly', 'application:application:self_manage'],
    ]);
  });

  it('still logs other SDK errors as sdk.error', () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});

    channelModule.buildQuietLogger().error(new Error('socket hang up'));

    expect(warn).toHaveBeenCalledWith('sdk', 'error', expect.anything());
    expect(getMissingScopes()).toEqual([]);
  });
});
