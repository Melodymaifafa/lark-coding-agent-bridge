import { describe, expect, it } from 'vitest';
import { skillsCard } from '../../../src/card/templates.js';
import type { SkillSpec } from '../../../src/skills/registry.js';

/** The `lark_md` lines of a `/skills` card, in order. */
function lines(specs: readonly SkillSpec[]): string[] {
  const card = skillsCard({
    status: 'ok',
    matches: specs,
    total: specs.length,
    query: '',
    cwd: '/tmp/x',
    agentName: 'Claude Code',
  }) as { elements: Array<{ tag: string; text?: { content: string } }> };
  return card.elements
    .filter((el) => el.tag === 'div' && el.text)
    .map((el) => el.text?.content ?? '');
}

describe('skills card origin labels', () => {
  it('labels an account-synced skill 账号同步, leaving a plain skill unlabeled', () => {
    const shown = lines([
      { name: 'anthropic-skills:pdf', summary: 'Work with PDF files.', origin: 'synced' },
      { name: 'handoff', summary: 'Write a handoff note.', origin: 'user' },
    ]);
    expect(shown).toContain('`/anthropic-skills:pdf` _(账号同步)_ — Work with PDF files.');
    expect(shown).toContain('`/handoff` — Write a handoff note.');
  });

  it('does not call a summary-less synced skill a Claude Code built-in', () => {
    const shown = lines([
      { name: 'anthropic-skills:schedule', origin: 'synced' },
      { name: 'dataviz', origin: 'builtin' },
    ]);
    expect(shown).toContain('`/anthropic-skills:schedule` _(账号同步)_ — _无说明_');
    expect(shown).toContain(
      '`/dataviz` _(内置)_ — _无说明（Claude Code 内置技能，说明不在本机文件里）_',
    );
  });
});
