/**
 * @fileoverview MCPB dependency agent-doc filtering preserves runtime modules.
 * @module tests/scripts/agent-doc-entries.test
 */
import { describe, expect, it } from 'vitest';
import {
  AGENT_DOC_ENTRY as cleanerPattern,
  filterAgentDocEntries,
} from '../../scripts/clean-mcpb.js';
import {
  checkBundleEntries,
  AGENT_DOC_ENTRY as linterPattern,
} from '../../scripts/lint-packaging.js';

describe('MCPB dependency agent docs', () => {
  it('strips dependency-root guidance and stray SKILL.md at every dependency depth', () => {
    const docs = [
      'node_modules/example/skills/guide/SKILL.md',
      'node_modules/@scope/example/framework-skills/add-tool/SKILL.md',
      'node_modules/example/.claude/settings.json',
      'node_modules/@scope/example/.agents/skills/guide/reference.md',
      'node_modules/example/docs/SKILL.md',
      'node_modules/example/AGENTS.md',
      'node_modules/@scope/example/CLAUDE.md',
      'node_modules/example/node_modules/child/AGENTS.md',
      'node_modules/@scope/example/node_modules/@other/child/CLAUDE.md',
      'node_modules/example/node_modules/child/skills/guide/reference.md',
      'node_modules/@scope/example/node_modules/@other/child/framework-skills/api/SKILL.md',
      'node_modules/example/node_modules/child/.claude/settings.json',
      'node_modules/example/node_modules/child/node_modules/@scope/leaf/.agents/config.json',
      'node_modules/example/node_modules/child/dist/nested/SKILL.md',
    ];
    const runtime = ['skills/grantsgov-guide/SKILL.md', 'node_modules/example/dist/index.js'];

    expect(filterAgentDocEntries([...docs, ...runtime])).toEqual(docs);
    expect(checkBundleEntries(docs, 'fixture.mcpb')).toHaveLength(1);
    expect(checkBundleEntries(runtime, 'fixture.mcpb')).toEqual([]);
  });

  it('keeps cleaner and linter patterns identical', () => {
    expect(cleanerPattern.source).toBe(linterPattern.source);
    expect(cleanerPattern.flags).toBe(linterPattern.flags);
  });

  it('preserves SDK skill runtime modules and other non-root skills directories', () => {
    const runtime = [
      'node_modules/@modelcontextprotocol/server/dist/ext/skills/index.mjs',
      'node_modules/@modelcontextprotocol/server/dist/ext/skills/node.mjs',
      'node_modules/example/node_modules/@modelcontextprotocol/server/dist/ext/skills/index.mjs',
      'node_modules/@scope/parent/node_modules/child/node_modules/@modelcontextprotocol/server/dist/ext/skills/node.mjs',
      'node_modules/example/dist/skills/index.js',
      'node_modules/example/dist/framework-skills/index.js',
      'node_modules/example/dist/.claude/index.js',
      'node_modules/example/dist/.agents/index.js',
    ];

    expect(filterAgentDocEntries(runtime)).toEqual([]);
    expect(checkBundleEntries(runtime, 'fixture.mcpb')).toEqual([]);
  });
});
