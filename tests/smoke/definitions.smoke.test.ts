/**
 * @fileoverview Smoke coverage for every registered definition, on the paths
 * that need no upstream call.
 * @module tests/smoke/definitions.smoke.test
 */

import { z } from '@cyanheads/mcp-ts-core';
import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it } from 'vitest';
import { grantsgovGetOpportunity } from '@/mcp-server/tools/definitions/grantsgov-get-opportunity.tool.js';
import { grantsgovListReference } from '@/mcp-server/tools/definitions/grantsgov-list-reference.tool.js';
import { grantsgovSearchOpportunities } from '@/mcp-server/tools/definitions/grantsgov-search-opportunities.tool.js';
import { allToolDefinitions } from '@/mcp-server/tools/definitions/index.js';

describe('definition smoke test', () => {
  it('advertises string-or-array lists and the search acceptance ceiling', () => {
    for (const [definition, fields] of [
      [
        grantsgovSearchOpportunities,
        ['statuses', 'agencies', 'eligibilities', 'funding_categories', 'funding_instruments'],
      ],
      [grantsgovGetOpportunity, ['opportunity_ids', 'opportunity_numbers']],
    ] as const) {
      const json = z.toJSONSchema(definition.input, { io: 'input' });
      for (const name of fields) {
        const property = json.properties?.[name];
        expect(JSON.stringify(property)).toContain('"type":"string"');
        expect(JSON.stringify(property)).toContain('"type":"array"');
        expect(JSON.stringify(property)).not.toContain('maxItems');
      }
    }
    expect(grantsgovSearchOpportunities.input.parse({ limit: 1000 }).limit).toBe(1000);
    expect(grantsgovSearchOpportunities.input.safeParse({ limit: 1001 }).success).toBe(false);
  });
  it('registers every tool through the barrel', () => {
    expect(allToolDefinitions.map((definition) => definition.name)).toEqual([
      'grantsgov_search_opportunities',
      'grantsgov_get_opportunity',
      'grantsgov_list_reference',
    ]);
  });

  it('rejects a conflicting search before any upstream call', async () => {
    const ctx = createMockContext({ errors: grantsgovSearchOpportunities.errors });
    const input = grantsgovSearchOpportunities.input.parse({
      keyword: '',
      statuses: ['Closed'],
      closing_within_days: '7',
    });

    await expect(grantsgovSearchOpportunities.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'filter_conflict' },
    });
  });

  it('rejects a get with no identifiers before any upstream call', async () => {
    const ctx = createMockContext({ errors: grantsgovGetOpportunity.errors });
    const input = grantsgovGetOpportunity.input.parse({
      opportunity_ids: [],
      opportunity_numbers: [' '],
    });

    await expect(grantsgovGetOpportunity.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'no_identifiers' },
    });
  });

  it('accepts independent bounded-detail continuation arguments', () => {
    expect(
      grantsgovGetOpportunity.input.parse({
        opportunity_ids: [347858],
        attachment_offset: 30,
        description_offset: 12_000,
      }),
    ).toMatchObject({
      opportunity_ids: [347858],
      attachment_offset: 30,
      description_offset: 12_000,
    });
  });

  it('lists a static reference topic and renders it', async () => {
    const ctx = createMockContext({ errors: grantsgovListReference.errors });
    const result = await grantsgovListReference.handler(
      grantsgovListReference.input.parse({
        topic: 'keyword_syntax',
        name_contains: '',
        parent_code: '',
      }),
      ctx,
    );
    const [block] = grantsgovListReference.format?.(result) ?? [];

    expect(result).toEqual(expect.schemaMatching(grantsgovListReference.output));
    expect(result.entries.length).toBeGreaterThan(0);
    expect(result.snapshot_date).toBeUndefined();
    expect(getEnrichment(ctx)).toMatchObject({ totalCount: result.entries.length });
    expect(block).toMatchObject({
      type: 'text',
      text: expect.stringContaining('| Code | Label | Notes |'),
    });
  });
});
