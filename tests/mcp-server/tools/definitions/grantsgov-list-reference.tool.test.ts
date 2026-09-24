/**
 * @fileoverview Tests for grantsgov_list_reference: static and snapshot-backed
 * topics, the agency tree views, blank form-field inputs, each declared error
 * reason, the production success envelope (output.extend(enrichment) parse) via
 * runToolContract, and format().
 * @module tests/mcp-server/tools/definitions/grantsgov-list-reference.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  createFetchMock,
  createMockContext,
  type FetchMockHarness,
  getEnrichment,
  runToolContract,
} from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { grantsgovListReference } from '@/mcp-server/tools/definitions/grantsgov-list-reference.tool.js';
import {
  getGrantsGovService,
  initGrantsGovService,
} from '@/services/grants-gov/grants-gov-service.js';
import { json, referenceRoute, SEARCH2_URL } from '../../../fixtures/grants-gov.js';

const tool = grantsgovListReference;
type Input = Parameters<typeof tool.input.parse>[0];

let http: FetchMockHarness;

beforeEach(() => {
  http = createFetchMock();
  http.install();
  initGrantsGovService();
});

afterEach(() => {
  getGrantsGovService().dispose();
  http.restore();
});

async function run(raw: Input) {
  const ctx = createMockContext({ errors: tool.errors });
  const result = await tool.handler(tool.input.parse(raw), ctx);
  expect(result).toEqual(expect.schemaMatching(tool.output));
  return { result, enrichment: getEnrichment(ctx) };
}

async function failure(raw: Input) {
  const ctx = createMockContext({ errors: tool.errors });
  try {
    await tool.handler(tool.input.parse(raw), ctx);
  } catch (err) {
    return err as { code: number; message: string; data: Record<string, unknown> };
  }
  throw new Error('Expected the handler to throw');
}

const codes = (entries: { code: string }[]) => entries.map((entry) => entry.code);

describe('static topics', () => {
  it('lists sort options with no upstream call and no snapshot date', async () => {
    const { result, enrichment } = await run({ topic: 'sort_options' });
    expect(codes(result.entries)).toEqual([
      'relevance',
      'open_date_desc',
      'open_date_asc',
      'close_date_asc',
      'close_date_desc',
      'opportunity_number_asc',
      'opportunity_number_desc',
      'agency_asc',
      'agency_desc',
    ]);
    expect(result.snapshot_date).toBeUndefined();
    expect(enrichment).toEqual({ totalCount: 9 });
    expect(http.calls).toHaveLength(0);
  });

  it('lists keyword syntax and filters it with name_contains', async () => {
    const { result, enrichment } = await run({ topic: 'keyword_syntax', name_contains: 'phrase' });
    expect(codes(result.entries)).toEqual(['"phrase"']);
    expect(enrichment).toEqual({ totalCount: 1 });
    expect(http.calls).toHaveLength(0);
  });
});

describe('snapshot-backed topics', () => {
  beforeEach(() => {
    http.route(referenceRoute());
  });

  it('lists statuses with all-status counts and the snapshot date', async () => {
    const { result } = await run({ topic: 'statuses' });
    expect(result.entries.map(({ code, total_count }) => [code, total_count])).toEqual([
      ['forecasted', 591],
      ['posted', 940],
      ['closed', 8700],
      ['archived', 73220],
    ]);
    expect(result.entries.every((entry) => entry.description)).toBe(true);
    expect(result.snapshot_date).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('lists eligibilities with open and total counts', async () => {
    const { result, enrichment } = await run({ topic: 'eligibilities' });
    expect(codes(result.entries)).toEqual(['07', '12', '25', '99']);
    expect(result.entries.find((entry) => entry.code === '12')).toMatchObject({
      open_count: 883,
      total_count: 29418,
    });
    expect(enrichment).toEqual({ totalCount: 4 });
  });

  it('lists funding categories and instruments', async () => {
    expect(codes((await run({ topic: 'funding_categories' })).result.entries)).toEqual([
      'AG',
      'ED',
      'HL',
      'ST',
    ]);
    expect(codes((await run({ topic: 'funding_instruments' })).result.entries)).toEqual([
      'CA',
      'G',
      'O',
      'PC',
    ]);
  });

  it('builds the snapshot once across calls', async () => {
    await run({ topic: 'eligibilities' });
    await run({ topic: 'agencies' });
    expect(http.calls).toHaveLength(2);
  });
});

describe('agencies', () => {
  beforeEach(() => {
    http.route(referenceRoute());
  });

  it('lists top-level agencies by default, without parent codes', async () => {
    const { result } = await run({ topic: 'agencies' });
    expect(codes(result.entries)).toEqual(['DOC', 'DOT', 'HHS', 'NSF', 'USDA']);
    expect(result.entries.find((entry) => entry.code === 'HHS')).toEqual({
      code: 'HHS',
      label: 'Department of Health and Human Services',
      has_children: true,
      open_count: 940,
      total_count: 23899,
    });
    expect(result.entries.find((entry) => entry.code === 'NSF')?.has_children).toBe(false);
  });

  it('searches every code, sub-agencies included, when name_contains is set', async () => {
    const { result } = await run({ topic: 'agencies', name_contains: 'faa coe' });
    expect(codes(result.entries)).toEqual([
      'DOT-FAA-FAA COE',
      'DOT-FAA-FAA COE-AJFE',
      'DOT-FAA-FAA COE-FAA JAMS',
      'DOT-FAA-FAA COE-GACOE',
    ]);
    expect(result.entries[0]).toMatchObject({ parent_code: 'DOT-FAA', has_children: true });
  });

  it('matches name_contains ignoring case, accents, and punctuation', async () => {
    const { result } = await run({ topic: 'agencies', name_contains: 'NATIONAL Institutés' });
    expect(codes(result.entries)).toEqual(['HHS-NIH11']);
    const hyphenated = await run({ topic: 'agencies', name_contains: 'hhs-nih11' });
    expect(codes(hyphenated.result.entries)).toEqual(['HHS-NIH11']);
  });

  it('returns an empty list with a notice when name_contains matches nothing', async () => {
    const { result, enrichment } = await run({ topic: 'agencies', name_contains: 'zzzz' });
    expect(result.entries).toEqual([]);
    expect(enrichment).toEqual({
      totalCount: 0,
      notice:
        'No agencies entry matched "zzzz". Try a shorter name or a single distinctive word, or call grantsgov_list_reference with topic agencies and no name_contains to browse the full list.',
    });
  });

  it('lists every code under a parent, at any depth, normalizing the case', async () => {
    const { result, enrichment } = await run({ topic: 'agencies', parent_code: ' dot-faa ' });
    expect(codes(result.entries)).toEqual([
      'DOT-FAA-AIP',
      'DOT-FAA-FAA ARG',
      'DOT-FAA-FAA COE',
      'DOT-FAA-FAA COE-AJFE',
      'DOT-FAA-FAA COE-FAA JAMS',
      'DOT-FAA-FAA COE-GACOE',
    ]);
    expect(result.entries.every((entry) => entry.parent_code !== undefined)).toBe(true);
    expect(enrichment).toEqual({ totalCount: 6 });
  });

  it('counts a mid-level agency over its subtree, matching an agencies search on it', async () => {
    const { result } = await run({ topic: 'agencies', parent_code: 'HHS' });
    expect(result.entries.find((entry) => entry.code === 'HHS-CDC')).toEqual({
      code: 'HHS-CDC',
      label: 'Centers for Disease Control and Prevention',
      parent_code: 'HHS',
      has_children: true,
      open_count: 0,
      total_count: 1728 + 139,
    });
    expect(result.entries.find((entry) => entry.code === 'HHS-CDC-NCCDPHP')).toMatchObject({
      has_children: false,
      total_count: 139,
    });
  });

  it('accepts the topic in any case', async () => {
    const { result } = await run({ topic: ' Agencies ' });
    expect(result.topic).toBe('agencies');
  });

  it('includes a " - "-joined child under its parent (DOT-FTA - TPM)', async () => {
    const { result } = await run({ topic: 'agencies', parent_code: 'DOT-FTA' });
    expect(result.entries).toEqual([
      expect.objectContaining({ code: 'DOT-FTA - TPM', parent_code: 'DOT-FTA' }),
    ]);
  });

  it('lists the codes under a non-code prefix (HHS-OS)', async () => {
    const { result } = await run({ topic: 'agencies', parent_code: 'HHS-OS' });
    expect(codes(result.entries)).toEqual([
      'HHS-OS-ASPE',
      'HHS-OS-ASPR',
      'HHS-OS-OCIIO',
      'HHS-OS-ONC',
    ]);
  });

  it('combines parent_code with name_contains', async () => {
    const { result } = await run({
      topic: 'agencies',
      parent_code: 'HHS',
      name_contains: 'disease',
    });
    expect(codes(result.entries)).toEqual(['HHS-CDC', 'HHS-CDC-NCCDPHP']);
  });

  it('explains a parent with no sub-agencies', async () => {
    const { result, enrichment } = await run({ topic: 'agencies', parent_code: 'NSF' });
    expect(result.entries).toEqual([]);
    expect(enrichment).toEqual({
      totalCount: 0,
      notice:
        'NSF has no sub-agencies. Pass it directly as an agencies filter to grantsgov_search_opportunities.',
    });
  });

  it('explains a parent with no sub-agencies even when name_contains is set', async () => {
    const { enrichment } = await run({
      topic: 'agencies',
      parent_code: 'NSF',
      name_contains: 'science',
    });
    expect(enrichment.notice).toBe(
      'NSF has no sub-agencies. Pass it directly as an agencies filter to grantsgov_search_opportunities.',
    );
  });

  it('reads blank form-client fields as unset', async () => {
    const { result } = await run({ topic: 'agencies', name_contains: '', parent_code: '   ' });
    expect(codes(result.entries)).toEqual(['DOC', 'DOT', 'HHS', 'NSF', 'USDA']);
  });
});

describe('input schema', () => {
  it('rejects a malformed parent_code at the schema', () => {
    expect(() => tool.input.parse({ topic: 'agencies', parent_code: 'HHS*' })).toThrow();
    expect(() => tool.input.parse({ topic: 'agencies', parent_code: '-HHS' })).toThrow();
  });

  it('rejects an unknown topic and an overlong name_contains', () => {
    expect(() => tool.input.parse({ topic: 'agency' })).toThrow();
    expect(() => tool.input.parse({ topic: 'AGENCY' })).toThrow();
    expect(() => tool.input.parse({ topic: 'agencies', name_contains: 'x'.repeat(101) })).toThrow();
  });
});

describe('error contract', () => {
  it('throws unknown_parent_code (NotFound) for a code outside the vocabulary', async () => {
    http.route(referenceRoute());
    const error = await failure({ topic: 'agencies', parent_code: 'xyz' });
    expect(error.code).toBe(JsonRpcErrorCode.NotFound);
    expect(error.message).toContain('"XYZ"');
    expect(error.data).toMatchObject({
      reason: 'unknown_parent_code',
      parentCode: 'XYZ',
      recovery: { hint: expect.stringContaining('name_contains set to the agency name') },
    });
  });

  it('throws filter_not_applicable before any upstream call when parent_code meets another topic', async () => {
    const error = await failure({ topic: 'eligibilities', parent_code: 'HHS' });
    expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(error.data).toMatchObject({
      reason: 'filter_not_applicable',
      recovery: { hint: expect.stringContaining('Remove parent_code') },
    });
    expect(http.calls).toHaveLength(0);
  });

  it('surfaces upstream_route_unavailable with this tool’s recovery hint on a cold 403', async () => {
    http.route({
      method: 'POST',
      match: SEARCH2_URL,
      respond: json({ message: 'Missing Authentication Token' }, 403),
    });
    const error = await failure({ topic: 'agencies' });
    expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(error.data).toMatchObject({
      reason: 'upstream_route_unavailable',
      retryable: false,
      recovery: {
        hint: 'The Grants.gov search API route is not answering; the legacy API may have been retired, so report this to the server maintainer.',
      },
    });
  });

  it('surfaces upstream_unavailable with this tool’s recovery hint on a cold 5xx', async () => {
    http.route({
      method: 'POST',
      match: SEARCH2_URL,
      respond: json({ message: 'Internal server error' }, 502),
    });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const pending = failure({ topic: 'funding_categories' });
      await vi.runAllTimersAsync();
      const error = await pending;
      expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
      expect(error.data).toMatchObject({
        reason: 'upstream_unavailable',
        retryAttempts: 3,
        recovery: {
          hint: 'Grants.gov is not responding; wait a minute and call grantsgov_list_reference again.',
        },
      });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('production envelope (runToolContract)', () => {
  beforeEach(() => {
    http.route(referenceRoute());
  });

  it('parses a zero-result page against output + enrichment', async () => {
    const result = await runToolContract(tool, { topic: 'agencies', name_contains: 'zzzz' });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      topic: 'agencies',
      entries: [],
      totalCount: 0,
      notice: expect.stringContaining('No agencies entry matched "zzzz"'),
    });
    const text = result.content
      .map((block) => (block.type === 'text' ? block.text : ''))
      .join('\n');
    expect(text).toContain('No entries.');
    expect(text).toContain('No agencies entry matched');
  });

  it('parses an under-cap page against output + enrichment', async () => {
    const result = await runToolContract(tool, { topic: 'eligibilities' });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ topic: 'eligibilities', totalCount: 4 });
    expect(result.structuredContent).not.toHaveProperty('notice');
  });

  it('parses a static topic page', async () => {
    const result = await runToolContract(tool, { topic: 'sort_options', name_contains: '' });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ totalCount: 9 });
  });

  it('returns the dual-surface error envelope for a declared failure', async () => {
    const result = await runToolContract(tool, { topic: 'statuses', parent_code: 'HHS' });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.ValidationError,
        data: { reason: 'filter_not_applicable' },
      },
    });
    const [block] = result.content;
    expect(block?.type === 'text' && block.text).toContain('Recovery: Remove parent_code');
  });
});

describe('format', () => {
  const render = (result: Parameters<NonNullable<typeof tool.format>>[0]) => {
    const blocks = tool.format?.(result) ?? [];
    const [block] = blocks;
    if (block?.type !== 'text') throw new Error('Expected one text block');
    return block.text;
  };

  it('renders a table with only the columns the entries carry', () => {
    const text = render({
      topic: 'agencies',
      entries: [
        {
          code: 'DOT-FAA-FAA COE',
          label: 'DOT - FAA Centers of Excellence',
          parent_code: 'DOT-FAA',
          has_children: true,
          open_count: 0,
          total_count: 4,
        },
        {
          code: 'DOT-FAA-AIP',
          label: 'Airport Improvement Program',
          parent_code: 'DOT-FAA',
          has_children: false,
        },
      ],
      snapshot_date: '2026-09-24T13:00:00.000Z',
    });
    expect(text).toContain('## Grants.gov reference: agencies');
    expect(text).toContain('Live vocabulary fetched 2026-09-24T13:00:00.000Z.');
    expect(text).toContain('| Code | Label | Parent | Has sub-agencies | Open | All statuses |');
    expect(text).toContain(
      '| `DOT-FAA-FAA COE` | DOT - FAA Centers of Excellence | `DOT-FAA` | yes | 0 | 4 |',
    );
    expect(text).toContain(
      '| `DOT-FAA-AIP` | Airport Improvement Program | `DOT-FAA` | no |  |  |',
    );
    expect(text).not.toContain('Notes');
  });

  it('renders static-topic notes and omits the snapshot line', () => {
    const text = render({
      topic: 'sort_options',
      entries: [
        { code: 'relevance', label: 'Best keyword match', description: 'Needs a keyword.' },
      ],
    });
    expect(text).toContain('| Code | Label | Notes |');
    expect(text).toContain('| `relevance` | Best keyword match | Needs a keyword. |');
    expect(text).not.toContain('Live vocabulary');
  });

  it('keeps agency-authored labels inside their cell (| escaped, line breaks flattened)', () => {
    const text = render({
      topic: 'eligibilities',
      entries: [
        {
          code: '25',
          label: 'Others | see text\r\n## Injected heading',
          open_count: 1,
          total_count: 2,
        },
      ],
    });
    expect(text).toContain('| `25` | Others \\| see text ## Injected heading | 1 | 2 |');
    expect(text.split('\n').some((line) => line.startsWith('## Injected'))).toBe(false);
  });

  it('says so when there are no entries', () => {
    const text = render({
      topic: 'agencies',
      entries: [],
      snapshot_date: '2026-09-24T13:00:00.000Z',
    });
    expect(text).toContain('No entries.');
    expect(text).not.toContain('| Code |');
  });
});
