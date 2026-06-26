/**
 * Single source of truth for the bridge's slash commands.
 *
 * Both the command dispatcher (`handlers` map in ./index) and every
 * user-facing command listing (help card, partial-match discovery card)
 * derive from this array — the command list is NEVER hand-copied. Add a
 * command here once and it shows up everywhere automatically.
 */
export interface CommandSpec {
  /** Primary command name WITHOUT the leading slash, e.g. `new`. */
  name: string;
  /** Extra names that route to the same handler, e.g. `reset` for `/new`. */
  aliases?: string[];
  /** Short one-line usage shown in the help / match cards. */
  summary: string;
  /** Admin-gated (mutates creds / lifecycle / filesystem reach). */
  admin?: boolean;
}

/**
 * Ordered so the help card reads top-to-bottom in rough "everyday → admin"
 * priority. `summary` is the user-facing description; keep it one line.
 */
export const COMMAND_REGISTRY: readonly CommandSpec[] = [
  { name: 'new', aliases: ['reset'], summary: '清空当前 chat 的会话（`/new chat [name]` 新建群+新会话）' },
  { name: 'resume', summary: '列出并恢复历史会话（`/resume [N]` 最多 N 条）' },
  { name: 'status', summary: '查看当前状态（profile / cwd / session / 队列）' },
  { name: 'help', summary: '显示命令列表（本帮助）' },
  { name: 'stop', summary: '结束当前正在跑的任务' },
  { name: 'timeout', summary: '当前 session 的探活分钟数（`/timeout [N|off|default]`）' },
  { name: 'cd', summary: '切换工作目录（会重置 session）', admin: true },
  { name: 'ws', summary: '工作目录别名（`/ws list|save|use|remove <name>`）', admin: true },
  { name: 'account', summary: '查看当前应用；`/account change` 换 appId/secret 并重连', admin: true },
  { name: 'config', summary: '调整偏好、访问控制和 lark-cli 身份策略', admin: true },
  { name: 'invite', summary: '把用户/群加入响应名单（`/invite user|admin|group`）', admin: true },
  { name: 'remove', summary: '把用户/群移出响应名单（`/remove user|admin|group`）', admin: true },
  { name: 'ps', summary: '列出本机所有 bot，标识当前正在回复的那个', admin: true },
  { name: 'exit', summary: '关掉指定 bot（`/exit <id|#>`，用 `/ps` 看 id）', admin: true },
  { name: 'reconnect', summary: '强制重连 WebSocket（网络抖动后 bot 没反应时用）', admin: true },
  { name: 'doctor', summary: '把日志和描述交给 agent 自助诊断', admin: true },
] as const;

/** All command names a user can type, with leading slash, deduped. */
export function allCommandTokens(): string[] {
  const tokens = new Set<string>();
  for (const spec of COMMAND_REGISTRY) {
    tokens.add(`/${spec.name}`);
    for (const alias of spec.aliases ?? []) tokens.add(`/${alias}`);
  }
  return [...tokens];
}

/**
 * Commands whose name OR any alias starts with `partial` (a `/he`-style
 * prefix, leading slash optional). Empty or whitespace `partial` matches
 * nothing — callers should treat that as "not a command-discovery query".
 */
export function matchCommands(partial: string): CommandSpec[] {
  const needle = partial.replace(/^\//, '').trim().toLowerCase();
  if (!needle) return [];
  return COMMAND_REGISTRY.filter((spec) =>
    [spec.name, ...(spec.aliases ?? [])].some((token) => token.toLowerCase().startsWith(needle)),
  );
}
