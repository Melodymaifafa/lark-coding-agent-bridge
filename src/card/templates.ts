import { COMMAND_REGISTRY, type CommandSpec } from '../commands/registry';
import type { SkillSpec } from '../skills/registry';

interface ButtonSpec {
  text: string;
  value: Record<string, unknown>;
  style?: 'primary' | 'danger' | 'default';
}

function button(spec: ButtonSpec): object {
  return {
    tag: 'button',
    text: { tag: 'plain_text', content: spec.text },
    type: spec.style ?? 'default',
    value: spec.value,
  };
}

function divMd(content: string): object {
  return { tag: 'div', text: { tag: 'lark_md', content } };
}

function actions(buttons: ButtonSpec[]): object {
  return { tag: 'action', actions: buttons.map(button) };
}

const HR: object = { tag: 'hr' };

function shell(title: string, elements: object[]): object {
  return {
    config: { wide_screen_mode: true, update_multi: true },
    header: { title: { tag: 'plain_text', content: title } },
    elements,
  };
}

export function workspacesCard(current: string | undefined, named: Record<string, string>): object {
  const entries = Object.entries(named);
  const elements: object[] = [];

  elements.push(divMd(`当前 cwd：\`${escapeCode(current ?? '(未设置)')}\``));

  if (entries.length === 0) {
    elements.push(HR);
    elements.push(divMd('暂无命名工作目录。'));
    elements.push(
      divMd('💡 发送 `/ws save <name>` 把当前 cwd 存为命名工作目录'),
    );
  } else {
    elements.push(HR);
    entries.forEach(([name, path], i) => {
      const marker = path === current ? '  ← 当前' : '';
      elements.push(divMd(`**${escapeMd(name)}** → \`${escapeCode(path)}\`${marker}`));
      elements.push(
        actions([
          { text: '切换到此处', value: { cmd: 'ws.use', name }, style: 'primary' },
          { text: '删除', value: { cmd: 'ws.remove', name }, style: 'danger' },
        ]),
      );
      if (i < entries.length - 1) elements.push(HR);
    });
  }

  return shell('📂 工作目录', elements);
}

export interface StatusInfo {
  profileName: string;
  cwd?: string;
  sessionId?: string;
  emptySessionText?: string;
  sessionStale: boolean;
  agentName: string;
  runtimeAccess: {
    label: string;
    value: string;
  };
  larkCliStatus?: 'app' | 'user-ready' | 'user-missing' | 'check-failed';
  activeRun: boolean;
  activeCommentScopes?: string[];
  queue?: { active: number; waiting: number; cap: number };
  ownerState: string;
  /** Session scope (= chatId or chatId:threadId in topic groups). */
  scope: string;
  /** Chat mode — used to label scope. */
  chatMode: 'p2p' | 'group' | 'topic';
}

export function statusCard(info: StatusInfo): object {
  const sessionLine = info.sessionId
    ? `\`${info.sessionId.slice(0, 8)}…\`${info.sessionStale ? ' ⚠️ 旧 cwd，下一条会新建' : ''}`
    : (info.emptySessionText ?? '(无)');
  // For topic groups, surface that the scope is per-topic so the user
  // knows /cd / /new only affect this topic.
  const scopeLine =
    info.chatMode === 'topic'
      ? `\`${escapeCode(info.scope)}\` _（话题独立 session）_`
      : `\`${escapeCode(info.scope)}\``;
  const cwdLine = info.cwd ? `\`${escapeCode(info.cwd)}\`` : '(未设置)';
  const queueLine = info.queue
    ? `${info.queue.active}/${info.queue.cap} active, ${info.queue.waiting} waiting`
    : 'unknown';
  const lines = [
    `🧭 **scope**: ${scopeLine}`,
    `🧩 **profile**: ${escapeMd(info.profileName)}`,
    `📁 **cwd**: ${cwdLine}`,
    `🔗 **session**: ${sessionLine}`,
    `🤖 **agent**: ${escapeMd(info.agentName)}`,
    `🛡 **${escapeMd(info.runtimeAccess.label)}**: ${escapeMd(info.runtimeAccess.value)}`,
    ...(info.larkCliStatus ? [`🔐 **lark-cli**: ${info.larkCliStatus}`] : []),
    `🏃 **active run**: ${info.activeRun ? 'yes' : 'no'}`,
    ...(info.activeCommentScopes && info.activeCommentScopes.length > 0
      ? [
          `📝 **comment runs**: ${info.activeCommentScopes.map((scope) => `\`${escapeCode(scope)}\``).join(', ')}`,
        ]
      : []),
    `🚦 **queue**: ${queueLine}`,
    `👤 **owner API**: ${escapeMd(info.ownerState)}`,
  ];
  return shell('📊 当前状态', [
    divMd(lines.join('\n')),
    HR,
    actions([
      { text: '🆕 新会话', value: { cmd: 'new' }, style: 'primary' },
      { text: '🔁 恢复会话', value: { cmd: 'resume' } },
      { text: '📂 工作目录', value: { cmd: 'ws.list' } },
      { text: '💡 帮助', value: { cmd: 'help' } },
    ]),
  ]);
}

export interface ResumeEntry {
  sessionId: string;
  displayId?: string;
  preview: string;
  relTime: string;
  lineCount?: number;
  detail?: string;
  current?: boolean;
}

export function resumeCard(cwd: string, entries: ResumeEntry[]): object {
  const elements: object[] = [];
  elements.push(divMd(`当前 cwd：\`${escapeCode(cwd)}\``));

  if (entries.length === 0) {
    elements.push(HR);
    elements.push(divMd('此 cwd 下没有历史会话。'));
    return shell('🔁 恢复历史会话', elements);
  }

  elements.push(HR);
  entries.forEach((e, i) => {
    const marker = e.current ? '  ← 当前' : '';
    const detail = e.detail ?? `${e.lineCount ?? 0} 条`;
    const displayId = e.displayId ?? e.sessionId;
    elements.push(
      divMd(
        `**${i + 1}.** ${escapeMd(e.preview)}${marker}\n\`${displayId.slice(0, 8)}…\` · ${e.relTime} · ${escapeMd(detail)}`,
      ),
    );
    elements.push(
      actions([
        {
          text: e.current ? '已是当前会话' : '▸ 恢复此会话',
          value: { cmd: 'resume.use', arg: e.sessionId },
          style: e.current ? 'default' : 'primary',
        },
      ]),
    );
    if (i < entries.length - 1) elements.push(HR);
  });

  return shell('🔁 恢复历史会话', elements);
}

/**
 * One markdown bullet per command, generated from the registry. `admin`
 * commands get a 🔒 marker. `aliases` are folded into the command's own line
 * (`/new` `/reset`) so the list stays one entry per real command.
 */
function commandBullet(spec: CommandSpec): string {
  const tokens = [spec.name, ...(spec.aliases ?? [])].map((t) => `\`/${t}\``).join(' ');
  const lock = spec.admin ? ' 🔒' : '';
  return `- ${tokens}${lock} — ${spec.summary}`;
}

export function helpCard(agentName = 'Agent'): object {
  const escapedAgentName = escapeMd(agentName);
  return shell('💡 使用帮助', [
    divMd(
      [
        '**命令列表**（🔒 = 仅管理员）',
        '',
        ...COMMAND_REGISTRY.map(commandBullet),
        '',
        `其他内容直接交给 ${escapedAgentName}。`,
      ].join('\n'),
    ),
    HR,
    actions([
      { text: '📊 状态', value: { cmd: 'status' }, style: 'primary' },
      { text: '🔁 恢复会话', value: { cmd: 'resume' } },
      { text: '📂 工作目录', value: { cmd: 'ws.list' } },
      { text: '🆕 新会话', value: { cmd: 'new' } },
    ]),
  ]);
}

/**
 * Discovery card for a `/he`-style partial. Lists every command whose name or
 * alias prefix-matches `partial`, each with a clickable button that runs it.
 * Commands needing arguments (`/cd`, `/ws`, `/account`, `/config`, `/timeout`,
 * `/exit`, `/invite`, `/remove`) don't auto-run — clicking them would fail or
 * open the wrong default — so they show a "查看用法" hint instead of a run
 * button. Argument-free commands get a "▸ 运行" button that dispatches直接.
 */
const NEEDS_ARGS = new Set(['cd', 'ws', 'account', 'config', 'timeout', 'exit', 'invite', 'remove']);

export function commandMatchCard(partial: string, matches: CommandSpec[]): object {
  const needle = partial.replace(/^\//, '');
  const elements: object[] = [
    divMd(`输入 \`/${escapeMd(needle)}\` 匹配到 **${matches.length}** 个命令（🔒 = 仅管理员）：`),
    HR,
  ];
  matches.forEach((spec, i) => {
    const lock = spec.admin ? ' 🔒' : '';
    elements.push(divMd(`\`/${spec.name}\`${lock} — ${spec.summary}`));
    if (NEEDS_ARGS.has(spec.name)) {
      elements.push(divMd(`_需要参数，发送 \`/${spec.name}\` 查看用法_`));
    } else {
      elements.push(
        actions([
          { text: `▸ 运行 /${spec.name}`, value: { cmd: spec.name }, style: i === 0 ? 'primary' : 'default' },
        ]),
      );
    }
    if (i < matches.length - 1) elements.push(HR);
  });
  return shell('🔍 命令匹配', elements);
}

/**
 * Agent-skill card (`/skills`). Distinct from `commandMatchCard`, which
 * lists the BRIDGE's own commands: this one lists what Claude Code can do
 * in the current cwd. Three shapes, because "no skills" and "couldn't ask"
 * must never look the same:
 *
 * - `ok` — the real list, capped so the card stays readable.
 * - `unsupported` — the running agent has no skill mechanism (Codex).
 * - `failed` — the lookup itself broke; says so, with the reason.
 */
export type SkillsCardInput =
  | {
      status: 'ok';
      /** Everything that matched, before the display cap. */
      matches: readonly SkillSpec[];
      /** Size of the whole catalog, so a filtered view can say "of N". */
      total: number;
      /** The `/skills <query>` filter, empty when unfiltered. */
      query: string;
      cwd: string;
      agentName: string;
    }
  | { status: 'unsupported'; agentName: string }
  | { status: 'failed'; agentName: string; reason: string };

/** Entries rendered per card. Past this, the user filters instead. */
export const SKILLS_CARD_LIMIT = 10;

const SKILLS_CARD_TITLE = '🧠 Agent 技能';

function skillLine(spec: SkillSpec): string {
  const origin = spec.origin === 'builtin' ? ' _(内置)_' : '';
  const summary = spec.summary
    ? escapeMd(spec.summary)
    : '_无说明（Claude Code 内置技能，说明不在本机文件里）_';
  return `\`/${escapeMd(spec.name)}\`${origin} — ${summary}`;
}

export function skillsCard(input: SkillsCardInput): object {
  if (input.status === 'unsupported') {
    return shell(SKILLS_CARD_TITLE, [
      divMd(
        `当前 agent 是 **${escapeMd(input.agentName)}**，它没有 skills 机制，所以没有可列的技能。`,
      ),
    ]);
  }
  if (input.status === 'failed') {
    return shell(SKILLS_CARD_TITLE, [
      divMd(`⚠️ **取不到技能列表**（不是「没有技能」）。`),
      divMd(`原因：${escapeMd(input.reason)}`),
      HR,
      divMd('先随便发一句话让 agent 跑一轮，再试 `/skills`；或用 `/status` 确认 agent 和工作目录。'),
    ]);
  }

  const { matches, total, query, cwd, agentName } = input;
  const shown = matches.slice(0, SKILLS_CARD_LIMIT);
  const elements: object[] = [];

  const head = query
    ? `\`${escapeMd(query)}\` 匹配到 **${matches.length}** 个技能（共 ${total} 个）`
    : `**${agentName}** 当前有 **${total}** 个技能`;
  elements.push(divMd(`${head}\n📁 \`${escapeCode(cwd)}\``));
  elements.push(HR);

  if (shown.length === 0) {
    elements.push(divMd(`没有名字或说明包含 \`${escapeMd(query)}\` 的技能。`));
    return shell(SKILLS_CARD_TITLE, elements);
  }

  shown.forEach((spec, i) => {
    elements.push(divMd(skillLine(spec)));
    elements.push(
      actions([
        {
          text: `▸ 运行 /${spec.name}`,
          value: { cmd: 'skills.run', arg: spec.name },
          style: i === 0 ? 'primary' : 'default',
        },
      ]),
    );
    if (i < shown.length - 1) elements.push(HR);
  });

  if (matches.length > shown.length) {
    elements.push(HR);
    elements.push(
      divMd(
        `还有 **${matches.length - shown.length}** 个没显示 — 用 \`/skills <关键词>\` 缩小范围。`,
      ),
    );
  } else if (!query && total > shown.length) {
    elements.push(HR);
    elements.push(divMd('用 `/skills <关键词>` 按名字或说明搜索。'));
  }

  return shell(SKILLS_CARD_TITLE, elements);
}

function escapeMd(s: string): string {
  return s.replace(/([*_`\\])/g, '\\$1');
}

function escapeCode(s: string): string {
  return s.replace(/`/g, "'");
}
