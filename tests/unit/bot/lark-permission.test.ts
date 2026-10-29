import { afterEach, describe, expect, it, vi } from 'vitest';
import { log } from '../../../src/core/logger.js';
import {
  getMissingScopes,
  isPermissionDenied,
  missingScopes,
  resetMissingScopesForTest,
  warnMissingScopesOnce,
} from '../../../src/bot/lark-permission.js';

/**
 * Shapes copied from real bridge logs: node-sdk rethrows the AxiosError, so
 * Feishu's body sits at `response.data`; `permission_violations` lists the
 * scopes, any one of which would let the call through.
 */
function axiosError(data: unknown): Error {
  return Object.assign(new Error('Request failed with status code 400'), {
    config: { method: 'get', url: 'https://open.feishu.cn/open-apis/im/v1/chats/oc_x' },
    response: { status: 400, statusText: 'Bad Request', data },
  });
}

const CHAT_GET_DENIED = axiosError({
  code: 99991672,
  msg:
    'Access denied. One of the following scopes is required: [im:chat:readonly, im:chat, im:chat:read].' +
    '应用尚未开通所需的应用身份权限：[im:chat:readonly, im:chat, im:chat:read]，点击链接申请并开通任一权限即可：' +
    'https://open.feishu.cn/app/cli_x/auth?q=im:chat:readonly,im:chat,im:chat:read&op_from=openapi&token_type=tenant',
  error: {
    message: 'Refer to the documentation to fix the error: https://open.feishu.cn/document/uAjLw4CM/ugTN1YjL4UTN24CO1UjN/trouble-shooting/how-to-fix-the-99991672-error',
    log_id: '2026100209465767E302336A737460B54E',
    permission_violations: [
      { type: 'action_scope_required', subject: 'im:chat:readonly' },
      { type: 'action_scope_required', subject: 'im:chat' },
      { type: 'action_scope_required', subject: 'im:chat:read' },
    ],
  },
});

const REACTION_DENIED_MSG_ONLY = axiosError({
  code: 99991672,
  msg: 'Access denied. One of the following scopes is required: [im:message, im:message.reactions:write_only].',
});

const DENIED_WITHOUT_SCOPES = axiosError({ code: 99991672, msg: 'Access denied.' });

const NOT_FOUND = axiosError({ code: 232011, msg: 'chat not found' });

const NETWORK = Object.assign(new Error('getaddrinfo ENOTFOUND open.feishu.cn'), { code: 'ENOTFOUND' });

const TIMEOUT = Object.assign(new Error('timeout of 30000ms exceeded'), { code: 'ECONNABORTED' });

describe('isPermissionDenied', () => {
  it('flags Feishu scope errors', () => {
    expect(isPermissionDenied(CHAT_GET_DENIED)).toBe(true);
    expect(isPermissionDenied(REACTION_DENIED_MSG_ONLY)).toBe(true);
    expect(isPermissionDenied(DENIED_WITHOUT_SCOPES)).toBe(true);
  });

  it('flags the plain Feishu body the SDK logger also passes along', () => {
    expect(isPermissionDenied({ code: 99991672, msg: 'Access denied.' })).toBe(true);
  });

  it('leaves unrelated errors alone', () => {
    expect(isPermissionDenied(NOT_FOUND)).toBe(false);
    expect(isPermissionDenied(NETWORK)).toBe(false);
    expect(isPermissionDenied(TIMEOUT)).toBe(false);
    expect(isPermissionDenied(undefined)).toBe(false);
    expect(isPermissionDenied('Access denied')).toBe(false);
  });
});

describe('missingScopes', () => {
  it('reads scope names from permission_violations', () => {
    expect(missingScopes(CHAT_GET_DENIED)).toEqual(['im:chat:readonly', 'im:chat', 'im:chat:read']);
  });

  it('falls back to the scope list in msg', () => {
    expect(missingScopes(REACTION_DENIED_MSG_ONLY)).toEqual([
      'im:message',
      'im:message.reactions:write_only',
    ]);
  });

  it('returns [] when no scope name is given', () => {
    expect(missingScopes(DENIED_WITHOUT_SCOPES)).toEqual([]);
    expect(missingScopes(NOT_FOUND)).toEqual([]);
    expect(missingScopes(NETWORK)).toEqual([]);
  });
});

describe('warnMissingScopesOnce', () => {
  afterEach(() => {
    resetMissingScopesForTest();
    vi.restoreAllMocks();
  });

  it('logs each missing scope set once per process and lists it for /status', () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});

    warnMissingScopesOnce(['im:chat:readonly', 'im:chat'], 'im.v1.chat.get');
    warnMissingScopesOnce(['im:chat', 'im:chat:readonly'], 'im.v1.chat.get');
    warnMissingScopesOnce(['im:message.reactions:write_only'], 'im.v1.message.reaction.create');

    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenNthCalledWith(1, 'lark-permission', 'scope-missing', {
      scopes: 'im:chat:readonly, im:chat',
      api: 'im.v1.chat.get',
    });
    expect(warn.mock.calls[1]?.[2]).toMatchObject({ scopes: 'im:message.reactions:write_only' });
    expect(getMissingScopes()).toEqual([
      ['im:chat:readonly', 'im:chat'],
      ['im:message.reactions:write_only'],
    ]);
  });

  it('drops a scope set that granting a smaller one already fixes', () => {
    vi.spyOn(log, 'warn').mockImplementation(() => {});

    warnMissingScopesOnce(['im:chat:readonly', 'im:chat', 'im:chat.group_info:readonly', 'im:chat:read'], 'chats');
    warnMissingScopesOnce(['im:chat:readonly', 'im:chat', 'im:chat:read'], 'chat');

    expect(getMissingScopes()).toEqual([['im:chat:readonly', 'im:chat', 'im:chat:read']]);
  });

  it('logs a denial without scope names once but keeps it off /status', () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});

    warnMissingScopesOnce([], 'x');
    warnMissingScopesOnce([], 'x');

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[2]).toMatchObject({ scopes: 'unknown' });
    expect(getMissingScopes()).toEqual([]);
  });
});
